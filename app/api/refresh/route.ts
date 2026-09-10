import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { enhance } from "@/lib/ai/enhance";
import { fetchPage, USER_AGENT } from "@/lib/fetchPage";
import { fetchSitemap, sitemapCandidates } from "@/lib/crawl/sitemap";
import { fetchRobots } from "@/lib/crawl/robots";
import { generate } from "@/lib/generate";
import { extract } from "@/lib/naiveExtractor";
import { generationsToCheck, recordCheck, storeConfigured } from "@/lib/store";
import { isDue, nextInterval, sitemapHash, structureHash } from "@/lib/monitor";
import { validateLlmsTxt } from "@/lib/spec";

/**
 * Re-checks stored sites and updates the ones that have moved.
 *
 * Called on a schedule by .github/workflows/monitor.yml. Work is done cheapest
 * first: a site's sitemap costs one request and usually settles the question,
 * and only a site that looks changed is crawled and re-generated.
 */

export const maxDuration = 60;

/*
 * A run is bounded by time and by expense, not by a count of sites.
 *
 * Checks cost wildly different amounts. A sitemap that has not moved settles a
 * site in about half a second and one request; a site whose page list changed
 * costs a nine-second crawl; a site that genuinely changed costs a further
 * twenty or so to rewrite. Capping "sites per run" at a single number is
 * therefore both too cautious for the cheap case - five sitemap checks use
 * three seconds of a fifty-second budget - and too reckless for the expensive
 * one, where two regenerations already overrun.
 *
 * So: look at many, rewrite few, and stop on the clock.
 */
const MAX_CHECKS = Number(process.env.MONITOR_CHECKS_PER_RUN ?? 20);
const MAX_REGENERATIONS = Number(process.env.MONITOR_REGENERATIONS_PER_RUN ?? 2);
const DEADLINE_MS = 45_000;

/**
 * A regeneration is a crawl plus two model passes, and takes about thirty
 * seconds. The deadline above cannot interrupt one that has started, so a run
 * declines to begin one it has not the time to finish: the first live run took
 * 69 seconds and would have been killed by the function limit mid-write.
 */
const REGENERATION_MS = 35_000;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const offered = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(secret);

  // Compared in constant time, and only when the lengths match, since
  // timingSafeEqual throws on a mismatch and the throw itself would leak.
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!storeConfigured()) {
    return NextResponse.json({ error: "No store is configured, so there is nothing to monitor." }, { status: 503 });
  }

  const started = Date.now();
  const due = (await generationsToCheck(MAX_CHECKS * 2)).filter((row) =>
    isDue(row.lastCheckedAt ?? null, row.checkIntervalHours ?? 24),
  );

  const checked: Record<string, string>[] = [];
  let regenerations = 0;

  for (const row of due.slice(0, MAX_CHECKS)) {
    if (Date.now() - started > DEADLINE_MS) break;

    try {
      // Once this run has rewritten its share, remaining sites are still
      // checked - the cheap tiers cost almost nothing - but a site found to
      // have changed is left for the next run rather than rushed.
      const timeLeft = DEADLINE_MS - (Date.now() - started);
      const outcome = await check(
        row.url,
        row.structureHash ?? null,
        row.sitemapHash ?? null,
        regenerations < MAX_REGENERATIONS && timeLeft > REGENERATION_MS,
      );
      // Only a rewrite counts against the budget. Taking a first fingerprint
      // costs a crawl and no model call, and the deadline covers that.
      if (outcome.result === "changed") regenerations += 1;
      /*
       * A deferral is not a check. Writing last_checked_at would push the row
       * out by its own interval, so a change this run found and declined to
       * act on would wait an hour rather than being taken up by the next run -
       * which is the whole point of deferring rather than skipping.
       *
       * Nothing is recorded, so the row keeps its place at the front of the
       * queue, ordered by least recently checked.
       */
      if (outcome.result === "deferred") {
        checked.push({ url: row.url, result: outcome.result, next: "next run" });
        continue;
      }

      // A check that could not reach a verdict is not evidence that the site
      // is quiet, so it must not widen the interval towards weekly.
      const inconclusive = outcome.result === "skipped" || outcome.result === "baseline";
      const interval = inconclusive
        ? (row.checkIntervalHours ?? 24)
        : nextInterval(row.checkIntervalHours ?? 24, outcome.changed);

      await recordCheck(row.url, {
        structureHash: outcome.structureHash ?? row.structureHash ?? "",
        sitemapHash: outcome.sitemapHash ?? row.sitemapHash ?? undefined,
        checkIntervalHours: interval,
        changed: outcome.changed,
        changeCount: (row.changeCount ?? 0) + (outcome.changed ? 1 : 0),
        llmsTxt: outcome.llmsTxt,
      });

      checked.push({ url: row.url, result: outcome.result, next: `${interval}h` });
    } catch (error) {
      // One site's failure must not end the run: the others are still due.
      checked.push({ url: row.url, result: "error", detail: String(error).slice(0, 80) });
    }
  }

  return NextResponse.json({ checked, considered: due.length, ms: Date.now() - started });
}

interface Outcome {
  result: "unchanged-sitemap" | "unchanged" | "changed" | "skipped" | "deferred" | "baseline";
  changed: boolean;
  structureHash?: string;
  sitemapHash?: string;
  llmsTxt?: string;
}

async function check(
  url: string,
  knownStructure: string | null,
  knownSitemap: string | null,
  mayRegenerate: boolean,
): Promise<Outcome> {
  const origin = new URL(url).origin;

  // Tier one: the site's own list of pages, for the price of one request. It
  // catches what matters most - pages appearing and disappearing - and settles
  // most checks without touching anything else.
  const robots = await fetchRobots(origin, USER_AGENT);
  let currentSitemap: string | undefined;

  for (const candidate of sitemapCandidates(origin, robots.sitemaps)) {
    const entries = await fetchSitemap(candidate, USER_AGENT);
    if (entries.length === 0) continue;

    currentSitemap = sitemapHash(entries.map((entry) => entry.url));
    break;
  }

  if (currentSitemap && knownSitemap && currentSitemap === knownSitemap) {
    return { result: "unchanged-sitemap", changed: false, sitemapHash: currentSitemap, structureHash: knownStructure ?? undefined };
  }

  // Tier two: crawl and fingerprint the structure. No model runs here, so this
  // answers "did the site change" without paying to rewrite anything.
  const page = await fetchPage(url);
  // Blocked or not HTML today: record nothing, so a site that recovers is
  // compared against the fingerprints it had before the outage.
  if (page.block || !page.isHtml) return { result: "skipped", changed: false };

  const seed = extract(page.body, page.url);
  const { extraction, crawl } = await generate(page.body, page.url, { seed });

  // A crawl cut short by its safety valve is not a fair comparison, and
  // recording it would make the next check compare against a partial site.
  if (crawl?.partial) return { result: "skipped", changed: false };

  const current = structureHash(extraction);
  if (knownStructure && current === knownStructure) {
    return { result: "unchanged", changed: false, structureHash: current, sitemapHash: currentSitemap };
  }

  /*
   * A row stored before monitoring existed has no fingerprint, so there is
   * nothing to have changed from. Recording the first one is not a change and
   * must not be treated as one: otherwise every existing row halves its
   * interval on the first pass and the site is watched twice as closely for
   * having been here longest.
   */
  if (!knownStructure) {
    return { result: "baseline", changed: false, structureHash: current, sitemapHash: currentSitemap };
  }

  // Tier three, and the only one that costs money: the site moved, so the file
  // it deserves is written afresh. Deferring instead leaves the row's old
  // fingerprint in place, so the next run finds it changed and picks it up.
  /*
   * Deferred, and deliberately forgetful.
   *
   * The new sitemap fingerprint is NOT returned. Recording it would make the
   * next run's cheap tier say "unchanged" and the change we just found would
   * be lost - the row would sit on a stale file until the site moved again.
   * Leaving the old fingerprints in place means the next run finds it exactly
   * as this one did.
   */
  if (!mayRegenerate) return { result: "deferred", changed: false };

  const { llmsTxt, enhanced } = await enhance(extraction, page.url);
  const conforms = validateLlmsTxt(llmsTxt).length === 0;

  return {
    result: "changed",
    changed: true,
    structureHash: current,
    sitemapHash: currentSitemap,
    llmsTxt: enhanced && conforms ? llmsTxt : undefined,
  };
}
