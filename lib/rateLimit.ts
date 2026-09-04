/**
 * Per-host request pacing with adaptive backoff.
 *
 * A crawl points every request at ONE host, so bounded concurrency alone is
 * not politeness: 8 workers against a small site is 8 simultaneous requests
 * sustained for a hundred pages, which is exactly how you generate a wall of
 * 429s and get the crawler blocked. Evidence this is real and not theoretical:
 * the eval's link checker (unbounded, same host) made takeourtours.com shed
 * load with 503s on pages that serve 200 to a polite client.
 *
 * Two mechanisms:
 *
 *   Pacing — requests to a host are spaced by at least `intervalMs`, so total
 *   request rate is bounded independently of how many workers are running.
 *
 *   Adaptive backoff — a 429/503 (or a Retry-After header) widens the interval
 *   for every subsequent request to that host, and it never narrows during a
 *   crawl. Backing off permanently rather than per-request matters: a server
 *   that just told us we are too fast will say it again if we only pause the
 *   one request and let the other seven through at the old rate.
 */

const DEFAULT_INTERVAL_MS = Number(process.env.CRAWL_MIN_REQUEST_INTERVAL_MS ?? 120);
const MAX_INTERVAL_MS = Number(process.env.CRAWL_MAX_REQUEST_INTERVAL_MS ?? 2000);
/** How much a throttle signal widens the interval when the server gives no Retry-After. */
const BACKOFF_FACTOR = 2;
/** Ignore absurd Retry-After values; a crawl cannot honour "come back in an hour". */
const MAX_RETRY_AFTER_MS = 30_000;

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;

  // Either delta-seconds or an HTTP-date (RFC 9110).
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
}

export class HostRateLimiter {
  private nextSlotAt = 0;
  private intervalMs: number;
  private throttleCount = 0;

  constructor(
    private readonly baseIntervalMs = DEFAULT_INTERVAL_MS,
    private readonly maxIntervalMs = MAX_INTERVAL_MS,
    private readonly now: () => number = Date.now
  ) {
    this.intervalMs = baseIntervalMs;
  }

  /** Current spacing, for tests and diagnostics. */
  get currentIntervalMs(): number {
    return this.intervalMs;
  }

  get timesThrottled(): number {
    return this.throttleCount;
  }

  /**
   * Reserves the next slot and resolves when it is due. Slots are claimed
   * synchronously before awaiting, so concurrent callers queue behind one
   * another instead of all reading the same "now" and firing together.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.intervalMs;

    const wait = slot - now;
    if (wait > 0) await delay(wait, signal);
  }

  /**
   * Records that the host asked us to slow down. Widens the interval for
   * everything that follows and pushes the next slot out past the server's
   * own Retry-After when it gave one.
   */
  noteThrottled(retryAfterMs?: number | null): void {
    this.throttleCount++;
    const widened = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : this.intervalMs * BACKOFF_FACTOR;
    this.intervalMs = Math.min(Math.max(this.intervalMs, widened), this.maxIntervalMs);
    this.nextSlotAt = Math.max(this.nextSlotAt, this.now() + (retryAfterMs ?? this.intervalMs));
  }

  /** Resets pacing to the base interval. Only for reuse across crawls. */
  reset(): void {
    this.intervalMs = this.baseIntervalMs;
    this.nextSlotAt = 0;
    this.throttleCount = 0;
  }
}

/** One limiter per host, so a crawl never has to thread it through by hand. */
export class RateLimiterRegistry {
  private readonly limiters = new Map<string, HostRateLimiter>();

  constructor(private readonly make: () => HostRateLimiter = () => new HostRateLimiter()) {}

  for(url: string): HostRateLimiter {
    let host: string;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      host = url;
    }
    let limiter = this.limiters.get(host);
    if (!limiter) {
      limiter = this.make();
      this.limiters.set(host, limiter);
    }
    return limiter;
  }

  /** Total throttle signals seen across all hosts, for reporting to the caller. */
  get totalThrottled(): number {
    let total = 0;
    for (const limiter of this.limiters.values()) total += limiter.timesThrottled;
    return total;
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}
