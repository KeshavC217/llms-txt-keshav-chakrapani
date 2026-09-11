/**
 * Noticing that a site has changed, and keeping its file current.
 *
 * Two hashes, and the difference between them is the whole design.
 *
 * `content_hash` fingerprints the file we serve, which is AI-assisted: models
 * are asked at temperature zero but are not promised to be identical run to
 * run, so a change in that hash proves nothing about the site.
 *
 * `structure_hash` fingerprints the site itself - the URLs and titles a
 * deterministic crawl finds, with no model involved. Since the crawler plans
 * before it fetches, an unchanged site produces the same structure hash every
 * time. That is the comparison worth making, and the reason the crawl was made
 * reproducible before this was built.
 */

import type { Extraction } from "./naiveExtractor.ts";
import { hashContent } from "./store.ts";

/**
 * How long a site is left alone between checks.
 *
 * One number for every site, and it used to be a per-site interval that
 * halved on a change and grew by half on a quiet check. That adapted the
 * cheap half of the system: a check is usually one request, because the
 * sitemap hash settles it and only a site whose page list moved is crawled,
 * and the expensive half - the crawl, the two model passes - is already gated
 * on evidence that something changed. So the backoff was throttling the tier
 * that costs almost nothing, and buying, at its ceiling, up to seven days of
 * a file being wrong about a site that had moved. That is the one thing this
 * tool exists not to do.
 *
 * Six hours, fixed, is four checks a day per site: at four hundred sites,
 * sixteen hundred mostly-single-request checks spread across the day, which
 * the budget does not notice. What it buys is a bound anyone can state
 * without reading the code - nothing here is ever more than six hours behind
 * the site it describes.
 */
export const CHECK_INTERVAL_HOURS = Number(process.env.MONITOR_INTERVAL_HOURS ?? 6);

/**
 * A fingerprint of what the crawl found: which pages exist and what they are
 * called. Sorted, so it does not depend on ordering, and free of notes and
 * summaries, which the models touch.
 */
export function structureHash(extraction: Extraction): string {
  const entries = [...extraction.sections.flatMap((section) => section.links), ...extraction.optional]
    .map((link) => `${link.url}\t${link.title}`)
    .sort();

  return hashContent([extraction.siteName, ...entries].join("\n"));
}

export function isDue(lastCheckedAt: string | null, intervalHours: number = CHECK_INTERVAL_HOURS, now = Date.now()): boolean {
  // Never checked is always due; that is a row this has not seen before.
  if (!lastCheckedAt) return true;

  const last = Date.parse(lastCheckedAt);
  if (!Number.isFinite(last)) return true;

  return now - last >= intervalHours * 3_600_000;
}

/**
 * The cheap first look: the set of URLs a sitemap lists.
 *
 * One request, and it catches what an llms.txt cares about most - pages
 * appearing and disappearing. Sorted for the same reason as above. Sites that
 * publish no sitemap skip this tier and go straight to a crawl.
 */
export function sitemapHash(urls: string[]): string {
  return hashContent([...urls].sort().join("\n"));
}

/**
 * What one run may still afford.
 *
 * This was arithmetic inside the refresh loop's worker, closed over two
 * mutable counters, which made the one part of monitoring most worth testing
 * the one part that could not be. The rules are small and the failure modes
 * are all off-by-one, so they belong somewhere they can be exercised directly.
 *
 * Checks and regenerations are budgeted apart because they cost two orders of
 * magnitude apart: a sitemap that has not moved settles a site in half a
 * second, a rewrite takes about thirty. One "sites per run" number is too
 * cautious for the first and reckless for the second.
 */
export class RunBudget {
  private regenerations = 0;
  private readonly maxRegenerations: number;
  private readonly deadlineMs: number;
  private readonly regenerationMs: number;
  private readonly startedAt: number;

  constructor(options: {
    maxRegenerations: number;
    /** How long the whole run may take. */
    deadlineMs: number;
    /** How long one regeneration takes, at worst. */
    regenerationMs: number;
    startedAt?: number;
  }) {
    this.maxRegenerations = options.maxRegenerations;
    this.deadlineMs = options.deadlineMs;
    this.regenerationMs = options.regenerationMs;
    this.startedAt = options.startedAt ?? Date.now();
  }

  /** True once the run has spent its time and should stop taking rows. */
  expired(now = Date.now()): boolean {
    return now - this.startedAt > this.deadlineMs;
  }

  /**
   * Takes a regeneration slot if there is one, returning whether it was taken.
   *
   * Claimed BEFORE the check runs rather than after, because the check is
   * awaited: two workers that each looked at the count first would both see
   * the last slot free and both take it. Claiming up front can waste a slot on
   * a check that turns out not to need one, which is the cheaper mistake -
   * `release` hands those back - where the alternative is three rewrites in a
   * run built to afford two.
   *
   * A run also declines to *begin* a regeneration it has not the time to
   * finish: the deadline cannot interrupt one that has started, and the first
   * live run took 69 seconds and would have been killed mid-write.
   */
  claim(now = Date.now()): boolean {
    const timeLeft = this.deadlineMs - (now - this.startedAt);
    if (this.regenerations >= this.maxRegenerations || timeLeft <= this.regenerationMs) return false;

    this.regenerations += 1;
    return true;
  }

  /** Hands back a claim the check did not use. */
  release(): void {
    this.regenerations = Math.max(0, this.regenerations - 1);
  }

  get spent(): number {
    return this.regenerations;
  }
}

