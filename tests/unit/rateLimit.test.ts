import { describe, expect, it } from "vitest";
import { HostRateLimiter, RateLimiterRegistry, parseRetryAfter } from "../../lib/rateLimit";

/** Drives the limiter on a controllable clock so tests assert spacing, not wall time. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter(" 0 ")).toBe(0);
  });

  it("reads an HTTP-date", () => {
    const inTen = new Date(Date.now() + 10_000).toUTCString();
    expect(parseRetryAfter(inTen)).toBeGreaterThan(8000);
    expect(parseRetryAfter(inTen)).toBeLessThanOrEqual(11_000);
  });

  it("clamps an absurd value rather than stalling the crawl", () => {
    expect(parseRetryAfter("86400")).toBe(30_000);
  });

  it("returns null for a missing or unparseable header", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("HostRateLimiter", () => {
  it("spaces concurrent callers instead of letting them fire together", async () => {
    // The bug this prevents: N workers all read the same "now", all see no
    // wait, and all fire at once — which is how bounded concurrency still
    // produces a burst against a single host. Asserted on observed completion
    // times rather than internal state, so it stays true if the scheduling
    // changes shape.
    const limiter = new HostRateLimiter(40, 2000);
    const started = Date.now();
    const elapsed = await Promise.all(
      Array.from({ length: 4 }, async () => {
        await limiter.acquire();
        return Date.now() - started;
      })
    );

    expect(elapsed).toHaveLength(4);
    const sorted = [...elapsed].sort((a, b) => a - b);
    // Four requests at 40ms spacing: the last must be ~120ms behind the first,
    // and each must be strictly after the one before it.
    expect(sorted[3] - sorted[0]).toBeGreaterThanOrEqual(100);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBeGreaterThan(sorted[i - 1]);
    }
  });

  it("widens the interval permanently after a throttle signal", () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter(100, 2000, clock.now);
    expect(limiter.currentIntervalMs).toBe(100);

    limiter.noteThrottled();
    // Not per-request: a server that just said "too fast" will say it again
    // if the other in-flight workers keep the old rate.
    expect(limiter.currentIntervalMs).toBe(200);

    limiter.noteThrottled();
    expect(limiter.currentIntervalMs).toBe(400);
    expect(limiter.timesThrottled).toBe(2);
  });

  it("honours a server's Retry-After over its own backoff", () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter(100, 5000, clock.now);
    limiter.noteThrottled(1500);
    expect(limiter.currentIntervalMs).toBe(1500);
  });

  it("never widens past the ceiling", () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter(100, 500, clock.now);
    for (let i = 0; i < 10; i++) limiter.noteThrottled();
    expect(limiter.currentIntervalMs).toBe(500);
  });

  it("actually waits on the real clock", async () => {
    const limiter = new HostRateLimiter(40, 2000);
    const started = Date.now();
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    // Three requests at 40ms spacing: the third waits ~80ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it("stops waiting when the crawl is aborted", async () => {
    const limiter = new HostRateLimiter(5000, 10_000);
    const controller = new AbortController();
    await limiter.acquire();
    const started = Date.now();
    const pending = limiter.acquire(controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("RateLimiterRegistry", () => {
  it("keeps one limiter per host and reuses it", () => {
    const registry = new RateLimiterRegistry();
    const a = registry.for("https://example.com/one");
    const b = registry.for("https://example.com/two");
    const c = registry.for("https://other.com/");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("treats host case-insensitively", () => {
    const registry = new RateLimiterRegistry();
    expect(registry.for("https://Example.COM/a")).toBe(registry.for("https://example.com/b"));
  });

  it("totals throttle signals across hosts for reporting", () => {
    const registry = new RateLimiterRegistry();
    registry.for("https://a.test/").noteThrottled();
    registry.for("https://b.test/").noteThrottled();
    registry.for("https://b.test/").noteThrottled();
    expect(registry.totalThrottled).toBe(3);
  });
});
