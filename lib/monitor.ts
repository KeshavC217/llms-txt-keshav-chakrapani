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
 * Checked no more often than this, and no less often than that.
 *
 * An hour is affordable because a check is usually one request: the sitemap
 * settles most of them, and only a site whose page list moved is crawled. A
 * fortnight was too patient at the other end - a site that has been quiet for
 * two weeks can still change today.
 */
const MIN_INTERVAL_HOURS = Number(process.env.MONITOR_MIN_INTERVAL_HOURS ?? 1);
const MAX_INTERVAL_HOURS = Number(process.env.MONITOR_MAX_INTERVAL_HOURS ?? 24 * 7);

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

/**
 * When to look again.
 *
 * A site that keeps changing is worth watching closely; one that has not moved
 * in a fortnight is not worth asking about daily. The interval halves on a
 * change and grows by half on a quiet check, which settles quickly in both
 * directions without oscillating.
 */
export function nextInterval(currentHours: number, changed: boolean): number {
  // Halving on a change and growing by half on a quiet check settles quickly
  // in both directions: a site that changes twice drops from a day to six
  // hours, and one that never does drifts to weekly in about five checks.
  const proposed = changed ? currentHours / 2 : currentHours * 1.5;
  return Math.min(Math.max(Math.round(proposed), MIN_INTERVAL_HOURS), MAX_INTERVAL_HOURS);
}

export function isDue(lastCheckedAt: string | null, intervalHours: number, now = Date.now()): boolean {
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
