/**
 * One clock for the whole request.
 *
 * Every step here had its own timeout and nothing bounded their sum. Each
 * number was defensible alone - 10s to fetch a page, 8s for a sitemap, 20s of
 * crawling, 35s of models - and together they were about twice the sixty
 * seconds a Vercel function is allowed. On a slow site the platform killed the
 * process partway through, which is the worst of the available outcomes:
 *
 *  - the caller gets Vercel's own timeout page rather than JSON, so the
 *    interface can only say "something went wrong";
 *  - nothing is stored, because the write is the last line of a handler that
 *    was never reached;
 *  - and since nothing is stored, the next attempt starts from the beginning
 *    and times out in exactly the same place. A site slow enough to trip this
 *    could never acquire a file at all, however many times anyone asked.
 *
 * That last one is why this is a bug rather than a slow path. So: one clock,
 * started when the request arrives and passed down, and every step asks how
 * much is left instead of consulting a constant. A step's own cap still
 * applies - it is the shorter of the two that wins - so nothing waits longer
 * than it ever should, and on a slow site the later steps are squeezed rather
 * than the whole request being lost.
 *
 * What comes back when the clock runs out is a thin file rather than no file:
 * the pages that were read, marked as incomplete and deliberately not stored.
 */
export class Deadline {
  private readonly endsAt: number;

  constructor(totalMs: number, startedAt: number = Date.now()) {
    this.endsAt = startedAt + totalMs;
  }

  /** Milliseconds left, never negative. */
  remaining(now: number = Date.now()): number {
    return Math.max(0, this.endsAt - now);
  }

  expired(now: number = Date.now()): boolean {
    return this.remaining(now) === 0;
  }

  /**
   * Whether a step expected to cost this much can still be started.
   *
   * The question a loop has to ask before taking another item. Asking "has the
   * budget elapsed" instead is what let the crawler overrun its own valve by
   * up to fourteen seconds: a worker that passed the check with a tenth of a
   * second to spare still had a pacer wait and a full page timeout ahead of
   * it.
   */
  allows(costMs: number, now: number = Date.now()): boolean {
    return this.remaining(now) > costMs;
  }

  /**
   * A signal for one network call: whichever is sooner, the call's own cap or
   * what is left of the request.
   */
  signal(capMs: number, now: number = Date.now()): AbortSignal {
    return AbortSignal.timeout(Math.min(capMs, this.remaining(now)));
  }

  /** A nested clock: the earlier of this deadline and `capMs` from now. */
  limit(capMs: number, now: number = Date.now()): Deadline {
    return new Deadline(Math.min(capMs, this.remaining(now)), now);
  }
}

/**
 * How long the whole of `POST /api/generate` may take.
 *
 * This was fifty seconds, ten under a function ceiling of sixty that the
 * project recorded as "not negotiable". It is not sixty any more: Vercel's
 * duration limits now put Hobby at 300s by default with fluid compute, so the
 * constraint the whole design was folded around had quietly gone away. resy.com
 * is what surfaced it - 32 of 35 pages, cut off mid-crawl.
 *
 * Not 290, though. The budget is sized to the work rather than to the ceiling:
 * a fifty-page crawl at about a second a page, a render of up to 25s, and two
 * model passes come to roughly a hundred seconds at the worst, so 150 leaves
 * half as much again in hand. The rest of the platform's allowance stays as
 * headroom rather than as permission to keep somebody waiting five minutes,
 * and the ceiling in the route is what stops a runaway request instead.
 *
 * The margin between this and the route's maxDuration covers what this clock
 * cannot see: a cold start before the handler runs, and serialising a file
 * that can be tens of kilobytes after it returns. Being killed by the platform
 * remains the one outcome worth this much trouble to avoid, because it stores
 * nothing and leaves the next attempt to die identically.
 */
export const REQUEST_BUDGET_MS = Number(process.env.REQUEST_BUDGET_MS ?? 150_000);
