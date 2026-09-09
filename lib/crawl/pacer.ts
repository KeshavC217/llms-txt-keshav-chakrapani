/**
 * How fast we are allowed to ask.
 *
 * Politeness here is not only manners, it is faster. Measured on getlago.com:
 * four workers with a 150ms gap fetched 30 pages in 2.7s with a p90 of 306ms;
 * eight workers with no gap took 4.3s with a p90 of 2032ms. Asking harder made
 * the site slower to answer, so the burst cost time as well as goodwill.
 *
 * The interval only ever widens within a crawl. A site that has just refused us
 * or slowed down has not recovered by the next request, and narrowing again on
 * one quick response is how a crawler oscillates between hammering and being
 * throttled.
 */

const DEFAULT_INTERVAL_MS = Number(process.env.CRAWL_MIN_REQUEST_INTERVAL_MS ?? 150);
const MAX_INTERVAL_MS = Number(process.env.CRAWL_MAX_REQUEST_INTERVAL_MS ?? 2_000);

export class Pacer {
  private interval: number;
  private nextSlot = 0;
  private baseline?: number;
  private recent: number[] = [];

  /** True once the site has been asked to be left alone. */
  exhausted = false;

  constructor(intervalMs = DEFAULT_INTERVAL_MS) {
    this.interval = Math.max(0, intervalMs);
  }

  get intervalMs(): number {
    return this.interval;
  }

  /** Resolves when this worker's turn comes round. */
  async wait(now = () => Date.now()): Promise<void> {
    const current = now();
    const slot = Math.max(current, this.nextSlot);
    this.nextSlot = slot + this.interval;

    const delay = slot - current;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /** A refusal is unambiguous: back off hard. */
  refused(): void {
    this.widen(2);
  }

  /**
   * A slowdown is the softer version of the same message. Compared against the
   * first few responses rather than an absolute threshold, because "slow" for
   * one site is normal for another.
   */
  observe(latencyMs: number): void {
    this.recent.push(latencyMs);
    if (this.recent.length <= 3) {
      this.baseline = this.recent.reduce((total, value) => total + value, 0) / this.recent.length;
      return;
    }

    const window = this.recent.slice(-3);
    const median = [...window].sort((a, b) => a - b)[1];
    if (this.baseline && median > this.baseline * 2 && median > 500) this.widen(1.5);
  }

  private widen(factor: number): void {
    if (this.interval >= MAX_INTERVAL_MS) {
      // Already as slow as we are willing to go, and still being pushed back:
      // the site has said enough.
      this.exhausted = true;
      return;
    }
    this.interval = Math.min(Math.max(this.interval * factor, 100), MAX_INTERVAL_MS);
  }
}
