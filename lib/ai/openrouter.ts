import type { ModelSpec } from "./models.ts";
import { ModelError, classify, isRetryable, parseRetryAfter } from "./errors.ts";

/**
 * One call to OpenRouter, and nothing else. No SDK: this is a POST with a JSON
 * body, and a dependency would be more surface than saving.
 *
 * `fetchImpl` is injectable so the sieve can be tested without a network. The
 * tests need to produce a hallucinated URL, malformed JSON and a timeout on
 * demand, none of which a real model can be asked for reliably.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

/**
 * Exponential backoff with full jitter.
 *
 * The jitter is the point, not a refinement. Chunks are dispatched together, so
 * they meet a rate limit together; a fixed delay would send the whole batch back
 * in step and reproduce the burst that caused the limit. Randomising across the
 * window spreads the retries out.
 */
function backoffMs(attempt: number): number {
  return Math.round(Math.random() * BASE_BACKOFF_MS * 2 ** attempt);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new ModelError("timeout", "The deadline passed while waiting to retry."));
    }, { once: true });
  });

export type Transport = (model: ModelSpec, messages: Message[], signal: AbortSignal) => Promise<string>;

export interface Message {
  role: "system" | "user";
  content: string;
}

export const openRouter =
  (maxTokens: number): Transport =>
  async (model, messages, signal) => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new ModelError("auth", "OPENROUTER_API_KEY is not set.");

    let lastError = new ModelError("unknown", "The model call did not run.");

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (signal.aborted) throw new ModelError("timeout", "The deadline passed before the call was made.");

      try {
        return await once(key, model, messages, maxTokens, signal);
      } catch (error) {
        const failure =
          error instanceof ModelError
            ? error
            : new ModelError(signal.aborted ? "timeout" : "upstream", String(error).slice(0, 160));

        // A 402 or a bad key will fail identically on every chunk; a deadline
        // cannot be waited out from inside itself.
        if (!isRetryable(failure.kind) || attempt === MAX_ATTEMPTS - 1) throw failure;

        lastError = failure;
        await sleep(failure.retryAfterMs ?? backoffMs(attempt), signal);
      }
    }

    throw lastError;
  };

async function once(
  key: string,
  model: ModelSpec,
  messages: Message[],
  maxTokens: number,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      messages,
      max_tokens: maxTokens,
      // Deterministic: two runs over one page should not differ, and there is
      // nothing creative being asked for here.
      temperature: 0,
      ...model.options,
    }),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new ModelError(
      classify(response.status),
      `OpenRouter ${response.status}: ${body}`,
      // OpenRouter forwards the provider's own hint when it has one, and it
      // knows when to come back better than a guess does.
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }

  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content ?? "";
}

/**
 * Pulls the JSON object out of a reply.
 *
 * Models fence their output, or preface it, however firmly the prompt asks
 * them not to. Rather than trust the instruction, take the outermost braces
 * and parse those.
 */
export function parseJson<T>(reply: string): T | null {
  if (!reply) return null;

  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(reply.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
