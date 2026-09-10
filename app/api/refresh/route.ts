import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { enhance } from "@/lib/ai/enhance";
import { fetchPage, USER_AGENT } from "@/lib/fetchPage";
import { findPublished } from "@/lib/published";
import { fetchSitemap, sitemapCandidates } from "@/lib/crawl/sitemap";
import { fetchRobots } from "@/lib/crawl/robots";
import { generate } from "@/lib/generate";
import { extract } from "@/lib/naiveExtractor";
import { generationsToCheck, hashContent, recordCheck, storeConfigured } from "@/lib/store";
import { RunBudget, intervalAfter, isDue, sitemapHash, structureHash } from "@/lib/monitor";

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
 * So: look at many, rewrite few, and stop on the clock. With four checks in
 * flight, thirteen sites took 11.2 seconds of the forty-five available, so the
 * count is what binds now rather than the deadline - which is the right way
 * round, since the deadline is a safety net and not a plan.
 */
const MAX_CHECKS = Number(process.env.MONITOR_CHECKS_PER_RUN ?? 40);
const MAX_REGENERATIONS = Number(process.env.MONITOR_REGENERATIONS_PER_RUN ?? 2);
const DEADLINE_MS = 45_000;

/**
 * Sites are checked several at a time.
 *
 * They are independent - different hosts, no shared state - so the only thing
 * sequential checking bought was a longer run. It cost real capacity: five
 * crawls filled the whole budget, where four at a time fit twenty. Per-host
 * politeness is unaffected, since each site is a different host and the pacer
 * still governs the requests within one crawl.
 */
const CHECK_CONCURRENCY = Number(process.env.MONITOR_CONCURRENCY ?? 4);

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
  const queue = due.slice(0, MAX_CHECKS);
  let next = 0;
  const budget = new RunBudget({
    maxRegenerations: MAX_REGENERATIONS,
    deadlineMs: DEADLINE_MS,
    regenerationMs: REGENERATION_MS,
    startedAt: started,
  });

  async function worker() {
    while (next < queue.length) {
      if (budget.expired()) return;

      const row = queue[next++];
      try {
        const mayRegenerate = budget.claim();

        const outcome =
          row.source === "published"
            ? // Their file, so the check is to read it again: crawling would
              // produce ours, which is not what this row holds.
              await checkPublished(row.publishedAt ?? row.url, row.contentHash)
            : await check(row.url, row.structureHash ?? null, row.sitemapHash ?? null, mayRegenerate);

        // Hand back a claim the check did not use.
        if (mayRegenerate && outcome.result !== "changed") budget.release();

        if (outcome.result === "deferred") {
          checked.push({ url: row.url, result: outcome.result, next: "next run" });
          continue;
        }

        const interval = intervalAfter(row.checkIntervalHours ?? 24, outcome);

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
  }

  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length || 1) }, worker));

  return NextResponse.json({ checked, considered: due.length, ms: Date.now() - started });
}

/**
 * A row holding a site's own llms.txt is checked by re-reading it.
 *
 * One request, no crawl, and no model: if their file changed we keep the new
 * one, and if it has gone we leave what we have rather than silently replacing
 * their curation with our generated guess.
 */
async function checkPublished(publishedUrl: string, knownContent: string): Promise<Outcome> {
  const found = await findPublished(publishedUrl, USER_AGENT);
  if (!found) return { result: "skipped", changed: false };

  if (hashContent(found.llmsTxt) === knownContent) return { result: "unchanged", changed: false };
  return { result: "changed", changed: true, llmsTxt: found.llmsTxt };
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

  const { llmsTxt } = await enhance(extraction, page.url);

  // Written without conditions, as everywhere else: the site changed, so the
  // file it had is out of date whatever the models made of the new one.
  return { result: "changed", changed: true, structureHash: current, sitemapHash: currentSitemap, llmsTxt };
}
