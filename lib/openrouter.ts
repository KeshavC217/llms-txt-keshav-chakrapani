// Both callers (the copyedit pass and the eval judge) are mechanical text
// tasks, so this wants a cheap model — but cheap is not the binding
// constraint, THROUGHPUT is. The work is tiny (~2.7k tokens in, ~1k out) and
// entirely bound by how fast the provider emits output tokens.
//
// Measured on the real copyedit prompt, 6 runs each across 3 live sites,
// with judge-scored output quality identical for every model listed:
//   gemma-4-31b-it          0.9s mean   1.5s max    ~$0.0006/run
//   gemini-3.5-flash-lite   2.5s mean   3.0s max    ~$0.0033/run
//   gpt-oss-120b            4.5s mean   9.2s max    ~$0.0003/run  (1/6 truncated)
//   deepseek-v4-flash      12.0s mean  16.6s max
//   deepseek-chat          18.9s mean  32.3s max    (only 2 providers, ~16 tok/s)
//
// gemma-4-31b-it wins on latency by 20x over the previous default at
// comparable cost and no measured quality loss. Override with
// OPENROUTER_MODEL to eval a different one.
const DEFAULT_MODEL = "google/gemma-4-31b-it";
// Overridable so integration tests can point at a fake provider and exercise
// the real request/response handling. Every provider bug this client guards
// against was found in production, not in a test, precisely because nothing
// below requestJson() was reachable without the live API.
const OPENROUTER_URL =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1/chat/completions";
// Measured max on the current default is ~1.5s, so this is ~20x headroom —
// generous enough to absorb a slow route without the pathology this replaced
// (a 20s budget against a ~19s p50, which silently timed out on any site of
// real size and made the AI pass a no-op in production). Two attempts fit
// inside the route's own AI budget, so a retry is never cut short.
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 2;

export function isAiConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export function activeModel(): string {
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

/**
 * Pulls the first balanced JSON object out of a model reply.
 *
 * Models wrap JSON in markdown fences, prefix it with "Here's the JSON:", or
 * append a trailing note — stripping fences alone (the previous approach)
 * handles only one of those, and any of the others made JSON.parse throw,
 * which silently discarded a perfectly good response. Scanning for the first
 * balanced `{...}` (string-aware, so braces inside a description don't
 * miscount) recovers the object regardless of what surrounds it.
 */
export function extractJsonObject(content: string): string | null {
  const start = content.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < content.length; i++) {
    const char = content[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }

  return null;
}

interface Attempt {
  parsed: unknown | null;
  /** Whether retrying could plausibly help (transient error), vs. a hard failure. */
  retryable: boolean;
  /** Which upstream provider served (or failed) this attempt, so a retry can avoid it. */
  provider?: string;
}

async function attempt(
  apiKey: string,
  prompt: string,
  timeoutMs: number,
  excludeProviders: string[] = []
): Promise<Attempt> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter uses these for attribution on its dashboard/rankings.
        "HTTP-Referer": "https://llmstxt.org",
        "X-Title": "llms-txt-generator",
      },
      body: JSON.stringify({
        model: activeModel(),
        messages: [{ role: "user", content: prompt }],
        // Route by throughput, not OpenRouter's default (price-leaning) order.
        // Without this, two identical requests can land on providers an order
        // of magnitude apart — the source of the 17s-vs-57s swings that made
        // this pass look randomly broken. `allow_fallbacks` keeps a slow
        // provider as a last resort rather than failing the request outright.
        provider: {
          sort: "throughput",
          allow_fallbacks: true,
          // Throughput sorting is deterministic, so a plain retry lands on the
          // SAME provider and reproduces the same failure — which made the
          // retry decorative. Excluding the one that just failed is what
          // actually buys a different outcome.
          ...(excludeProviders.length > 0 ? { ignore: excludeProviders } : {}),
        },
        temperature: 0.2,
        // NOT setting response_format: { type: "json_object" }. It reads like
        // free hardening, but across OpenRouter's provider fleet it is a
        // liability: DeepInfra rejects it outright for this model (HTTP 405,
        // "json_object response format is not supported"), and Cerebras
        // honors it by emitting the object escaped INSIDE a JSON string
        // (\"title\": ...), which never terminates and burns the whole
        // max_tokens budget. Measured on one 18-page site: 2 of 3 requests
        // truncated with it, 3 of 3 succeeded in ~1.1k tokens without it.
        // extractJsonObject() already tolerates fences and surrounding prose,
        // which is the job this parameter was supposed to do.
        // Without an explicit cap, a large prompt (many pages) can get a
        // reply truncated mid-JSON by the provider's own default output
        // limit, which then fails to parse and silently discards the whole
        // response. This needs to comfortably fit a full page-edit map for
        // a 20-page site.
        max_tokens: 8000,
      }),
    });

    if (!res.ok) {
      // 429 (rate limit) and 5xx (provider hiccup) are worth one retry;
      // 4xx like a bad API key or an unknown model never will be.
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) {
        console.error(`[openrouter] request failed: HTTP ${res.status}`);
      }
      return { parsed: null, retryable };
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    const content: string | undefined = choice?.message?.content;
    const provider: string = data?.provider ?? "unknown";
    const truncated = choice?.finish_reason === "length";

    // A provider that returns nothing usable is a bad ROUTE, not a bad
    // request: OpenRouter spreads one model across many providers, and they
    // are not equally healthy. Observed in practice — deepseek-v4-flash via
    // Alibaba answering with an empty content field after burning all 8000
    // completion tokens (finish_reason "length"). Retrying gives OpenRouter a
    // chance to land somewhere else; treating it as final, as this used to,
    // silently degraded to the un-copyedited document while still being
    // billed for the wasted tokens.
    if (!content || !content.trim()) {
      console.error(
        `[openrouter] ${activeModel()} via ${provider} returned empty content` +
          `${truncated ? ` after exhausting max_tokens (${data?.usage?.completion_tokens} tokens)` : ""}`
      );
      return { parsed: null, retryable: true, provider };
    }

    const jsonText = extractJsonObject(content);
    if (!jsonText) {
      console.error(
        `[openrouter] ${activeModel()} via ${provider} returned no parseable JSON` +
          `${truncated ? " (truncated by max_tokens)" : ""}`
      );
      // Truncation is worth another route; well-formed prose that simply
      // isn't JSON means the model won't comply, and retrying just burns money.
      return { parsed: null, retryable: truncated, provider };
    }

    try {
      const parsed = JSON.parse(jsonText);
      if (typeof parsed !== "object" || parsed === null) return { parsed: null, retryable: false };
      return { parsed, retryable: false };
    } catch {
      console.error(`[openrouter] ${activeModel()} via ${provider} returned malformed JSON`);
      return { parsed: null, retryable: truncated, provider };
    }
  } catch (err) {
    // A timeout/network blip is worth one retry; an abort we caused is not.
    const aborted = err instanceof Error && err.name === "AbortError";
    return { parsed: null, retryable: !aborted };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sends a single-turn prompt to the configured model and parses its reply as
 * JSON. Returns null on any non-transient failure (no API key, hard HTTP
 * error, malformed reply) so every caller can treat "no AI available" and
 * "AI misbehaved" the same way: fall back to the deterministic result.
 */
export async function requestJson<T>(prompt: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const failedProviders: string[] = [];

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const { parsed, retryable, provider } = await attempt(apiKey, prompt, timeoutMs, failedProviders);
    if (parsed !== null) return parsed as T;
    if (!retryable) return null;
    if (provider && !failedProviders.includes(provider)) failedProviders.push(provider);
  }

  return null;
}
