/**
 * Telling apart the ways a model call fails.
 *
 * Before this, every failure landed in one catch and produced one outcome: the
 * chunk contributed nothing and the file came back thinner. "Out of credits",
 * "every provider is saturated" and "that model was slow" looked identical to
 * anyone reading the response, though the first needs a payment, the second
 * needs patience and the third needs nothing at all.
 */

export type FailureKind =
  /** 402. Out of credits. Retrying cannot help and neither can waiting. */
  | "credits"
  /** 429. A platform limit, or every provider for the model at capacity. */
  | "rate-limited"
  /** 401/403. The key is missing, wrong, or not allowed this model. */
  | "auth"
  /** 5xx, or the provider returned nonsense. Worth one retry. */
  | "upstream"
  /** Our own deadline fired. Retrying inside it is pointless. */
  | "timeout"
  /**
   * The model answered, and the answer was not usable JSON. Not retried: the
   * temperature is zero, so asking again asks for the same reply.
   */
  | "unparseable"
  | "unknown";

export class ModelError extends Error {
  // Declared and assigned rather than written as constructor parameter
  // properties: Node runs these files by stripping types, and a parameter
  // property is not a type to strip - it generates an assignment, which
  // strip-only mode refuses.
  readonly kind: FailureKind;
  /** From a Retry-After header, in ms, when the provider gave one. */
  readonly retryAfterMs?: number;

  constructor(kind: FailureKind, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ModelError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retrying a 402 just spends the same failure twice. */
export function isRetryable(kind: FailureKind): boolean {
  return kind === "rate-limited" || kind === "upstream";
}

/**
 * A 402 means the account cannot pay, which is not a per-chunk problem: every
 * other chunk is about to fail the same way, and the person deserves to be
 * told rather than handed a quietly emptier file.
 */
export function isFatal(kind: FailureKind): boolean {
  return kind === "credits" || kind === "auth";
}

export function classify(status: number): FailureKind {
  if (status === 402) return "credits";
  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "upstream";
  return "unknown";
}

/**
 * Retry-After is seconds or an HTTP date. Honoured when present, because a
 * provider that says when to come back knows better than our own guess.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - Date.now(), 0), 30_000);
}
