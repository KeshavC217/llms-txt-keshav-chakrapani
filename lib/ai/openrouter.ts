import type { ModelSpec } from "./models.ts";

/**
 * One call to OpenRouter, and nothing else. No SDK: this is a POST with a JSON
 * body, and a dependency would be more surface than saving.
 *
 * `fetchImpl` is injectable so the sieve can be tested without a network. The
 * tests need to produce a hallucinated URL, malformed JSON and a timeout on
 * demand, none of which a real model can be asked for reliably.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type Transport = (model: ModelSpec, messages: Message[], signal: AbortSignal) => Promise<string>;

export interface Message {
  role: "system" | "user";
  content: string;
}

export const openRouter =
  (maxTokens: number): Transport =>
  async (model, messages, signal) => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set.");

    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        messages,
        max_tokens: maxTokens,
        // Deterministic: two runs over one page should not differ, and there
        // is nothing creative being asked for here.
        temperature: 0,
        ...model.options,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const payload = await response.json();
    return payload?.choices?.[0]?.message?.content ?? "";
  };

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
