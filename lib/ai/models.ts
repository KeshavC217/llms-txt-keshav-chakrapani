/**
 * The models this app will talk to, and what each one needs to behave.
 *
 * Two roles. The guide makes one global judgment about the whole site; the
 * worker annotates chunks of links, many times over, so its cost and its slow
 * tail both multiply.
 *
 * Numbers below are measured, not quoted - three runs each through OpenRouter,
 * on this app's own two tasks:
 *
 *   model                        chunk (median)   guide    $/M in -> out
 *   gemini-3.5-flash-lite        1.06s  +-0.05    0.76s    0.30 -> 2.50
 *   gemma-4-31b-it               4.22s            0.51s    0.09 -> 0.34
 *   gpt-oss-120b                 3.77s (16.4 tail) 2.91s   0.037 -> 0.17
 *   deepseek-v4-flash           10.68s           33.28s    0.089 -> 0.177
 *
 * All four returned valid JSON and all four reached the same judgment on the
 * guide task, so the choice is about latency and cost rather than capability.
 * Gemini leads because its variance is near zero; Gemma works the chunks
 * because its output is a third the price and that is what multiplies.
 */

export interface ModelSpec {
  id: string;
  /** Merged into the request body - some models need coaxing. */
  options?: Record<string, unknown>;
}

export const MODELS: Record<string, ModelSpec> = {
  "gemini-3.5-flash-lite": { id: "google/gemini-3.5-flash-lite" },
  "gemma-4-31b-it": { id: "google/gemma-4-31b-it" },

  // Spends reasoning tokens on trivial work: 303 of them to annotate two
  // links. `reasoning: {enabled: false}` is rejected outright (HTTP 400), so
  // low effort is the only lever, and a 16s tail survives it.
  "gpt-oss-120b": { id: "openai/gpt-oss-120b", options: { reasoning: { effort: "low" } } },

  // Kept for comparison rather than use. 33s on the guide task.
  "deepseek-v4-flash": { id: "deepseek/deepseek-v4-flash" },
};

function resolve(name: string | undefined, fallback: string): ModelSpec {
  if (!name) return MODELS[fallback];
  return MODELS[name] ?? { id: name };
}

/** One global call, so consistency matters more than price. */
export const guideModel = () => resolve(process.env.AI_GUIDE_MODEL, "gemini-3.5-flash-lite");

/** Called once per chunk, so price and the slow tail both multiply. */
export const workerModel = () => resolve(process.env.AI_WORKER_MODEL, "gemma-4-31b-it");

export const aiConfigured = () => Boolean(process.env.OPENROUTER_API_KEY);
