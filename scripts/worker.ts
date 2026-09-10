/**
 * The one place a crawl happens.
 *
 * Crawling used to run inside the request that asked for it, which meant every
 * step had to finish inside a Vercel function's sixty seconds. That single
 * constraint produced the request-wide deadline, the partial-crawl semantics,
 * the regeneration budget in the monitoring endpoint, and a bash loop that
 * called that endpoint twenty times because one call could only manage a slice
 * of the queue. None of it was design; all of it was compensation.
 *
 * Here there is no ceiling worth speaking of - a GitHub runner has six hours -
 * so the work is simply done. `POST /api/generate` writes a row and returns;
 * this claims it and fills it in.
 *
 * Two jobs, in this order, because someone waiting for a site they just asked
 * for should not queue behind a scheduled re-check of a site nobody is looking
 * at:
 *
 *   1. every queued site, until there are none
 *   2. every stored site whose own interval says it is due
 *
 * Run with `npm run worker`. It needs SUPABASE_URL, SUPABASE_SECRET_KEY and
 * OPENROUTER_API_KEY, and nothing else.
 */
import { USER_AGENT, fetchPage } from "../lib/fetchPage.ts";
import { claimNext, completeGeneration, failGeneration, generationsToCheck, hashContent, recordCheck, releaseStaleClaims, storeConfigured } from "../lib/store.ts";
import { enhance } from "../lib/ai/enhance.ts";
import { classifyEmpty, explain } from "../lib/blocks.ts";
import { extract, linkCount } from "../lib/naiveExtractor.ts";
import { fetchRobots } from "../lib/crawl/robots.ts";
import { fetchSitemap, sitemapCandidates } from "../lib/crawl/sitemap.ts";
import { findPublished } from "../lib/published.ts";
import { generate } from "../lib/generate.ts";
import { intervalAfter, isDue, sitemapHash, structureHash } from "../lib/monitor.ts";

/**
 * A stop, not a budget. The runner allows six hours and nothing here should
 * approach that; a pass that does has found a site behaving pathologically, and
 * the next scheduled run will pick up whatever was left.
 */
const RUN_LIMIT_MS = Number(process.env.WORKER_RUN_LIMIT_MS ?? 90 * 60_000);
const started = Date.now();
const outOfTime = () => Date.now() - started > RUN_LIMIT_MS;

const log = (...parts: unknown[]) => console.log(...parts);

/** What a build produced, or why it could not. */
type Built =
  | { ok: true; llmsTxt: string; source: "generated" | "published"; publishedAt?: string; structureHash?: string; crawl?: { pages: number; planned: number; partial: boolean } }
  | { ok: false; reason: string };

/**
 * Builds a site's file from scratch. Shared by a fresh ask and a re-crawl.
 *
 * Exported so it can be tested against a fixture server without a database or
 * a queue: it is the part with the decisions in it.
 */
export async function build(url: string): Promise<Built> {
  const page = await fetchPage(url);
  if (page.block) return { ok: false, reason: explain(page.block, page.url) };
  if (!page.isHtml) return { ok: false, reason: "That URL is not an HTML page, so there is nothing to read." };

  const seed = extract(page.body, page.url);

  // If the site publishes its own, that is the answer: someone there chose what
  // belonged in it, which is more than a crawl can work out.
  const published = await findPublished(page.url, USER_AGENT, seed.existingLlmsTxt);
  if (published) {
    return { ok: true, llmsTxt: published.llmsTxt, source: "published", publishedAt: published.url };
  }

  const { extraction, crawl } = await generate(page.body, page.url, { seed });

  /*
   * Nothing found is worth a second look before writing a file about it.
   *
   * Some sites answer 200 with a verification page, which the status check
   * above cannot see - a challenge page parses perfectly well. Before this,
   * Medium became an llms.txt summarised as "This website is using a security
   * service to protect itself from online attacks": a confident file about
   * Cloudflare. The body markers are only trusted here, where the extractor has
   * already found nothing, so a working page carrying a leftover challenge
   * script cannot be mistaken for one.
   */
  if (linkCount(extraction) === 0) {
    const late = classifyEmpty(page.body);
    if (late) return { ok: false, reason: explain(late, page.url) };
  }

  const { llmsTxt } = await enhance(extraction, page.url);

  return {
    ok: true,
    llmsTxt,
    source: "generated",
    // Withheld for a crawl cut short by its safety valve: which pages it holds
    // depends on how the site behaved today, so a fingerprint taken from one
    // would report a change on every later check.
    structureHash: crawl?.partial ? undefined : structureHash(extraction),
    crawl,
  };
}

/** Everything anyone has asked for. */
async function drainQueue(): Promise<number> {
  let done = 0;

  for (let site = await claimNext(); site && !outOfTime(); site = await claimNext()) {
    log(`\n[queue] ${site.url}`);
    const at = Date.now();

    try {
      const result = await build(site.url);
      if (!result.ok) {
        await failGeneration(site.url, result.reason);
        log(`  failed: ${result.reason.slice(0, 90)}`);
        continue;
      }

      await completeGeneration(site.url, result.llmsTxt, {
        structureHash: result.structureHash,
        source: result.source,
        publishedAt: result.publishedAt,
      });
      done += 1;
      log(`  ready in ${((Date.now() - at) / 1000).toFixed(1)}s` +
        (result.crawl ? ` - ${result.crawl.pages} of ${result.crawl.planned} pages${result.crawl.partial ? ", partial" : ""}` : " - the site's own file"));
    } catch (error) {
      // One site's failure must not end the run: the others are still waiting.
      const message = error instanceof Error ? error.message : String(error);
      await failGeneration(site.url, message);
      log(`  failed: ${message.slice(0, 90)}`);
    }
  }

  return done;
}

/**
 * Has this site moved? Cheapest question first.
 *
 * Tier one is the site's own list of pages, which costs one request and settles
 * most checks. Tier two crawls and fingerprints without running a model, so it
 * answers "did it change" without paying to rewrite. Tier three rewrites, and
 * is the only one that costs anything.
 */
interface Outcome {
  result: "unchanged-sitemap" | "unchanged" | "changed" | "skipped" | "baseline";
  changed: boolean;
  structureHash?: string;
  sitemapHash?: string;
  llmsTxt?: string;
}

async function check(url: string, knownStructure: string | null, knownSitemap: string | null): Promise<Outcome> {
  const origin = new URL(url).origin;
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

  const page = await fetchPage(url);
  // Blocked or not HTML today: record nothing, so a site that recovers is
  // compared against the fingerprints it had before the outage.
  if (page.block || !page.isHtml) return { result: "skipped", changed: false };

  const seed = extract(page.body, page.url);
  const { extraction, crawl } = await generate(page.body, page.url, { seed });
  if (crawl?.partial) return { result: "skipped", changed: false };

  const current = structureHash(extraction);
  if (knownStructure && current === knownStructure) {
    return { result: "unchanged", changed: false, structureHash: current, sitemapHash: currentSitemap };
  }

  /*
   * Nothing to have changed from. Recording the first fingerprint is not a
   * change and must not be treated as one, or a row would halve its interval
   * for having been here longest.
   */
  if (!knownStructure) {
    return { result: "baseline", changed: false, structureHash: current, sitemapHash: currentSitemap };
  }

  const { llmsTxt } = await enhance(extraction, page.url);
  return { result: "changed", changed: true, structureHash: current, sitemapHash: currentSitemap, llmsTxt };
}

/** A row holding someone else's file is checked by re-reading it, not by crawling. */
async function checkPublished(publishedUrl: string, knownContent: string): Promise<Outcome> {
  const found = await findPublished(publishedUrl, USER_AGENT);
  if (!found) return { result: "skipped", changed: false };
  if (hashContent(found.llmsTxt) === knownContent) return { result: "unchanged", changed: false };
  return { result: "changed", changed: true, llmsTxt: found.llmsTxt };
}

/** Everything whose own interval says it is due. */
async function runDueChecks(): Promise<number> {
  const due = (await generationsToCheck(200)).filter(
    (row) => row.status === "ready" && isDue(row.lastCheckedAt ?? null, row.checkIntervalHours ?? 24),
  );

  log(`\n[checks] ${due.length} due`);
  let done = 0;

  for (const row of due) {
    if (outOfTime()) {
      log("  run limit reached; the rest stay due for the next pass");
      break;
    }

    try {
      const outcome =
        row.source === "published"
          ? await checkPublished(row.publishedAt ?? row.url, row.contentHash)
          : await check(row.url, row.structureHash ?? null, row.sitemapHash ?? null);

      const interval = intervalAfter(row.checkIntervalHours ?? 24, outcome);
      await recordCheck(row.url, {
        structureHash: outcome.structureHash ?? row.structureHash ?? "",
        sitemapHash: outcome.sitemapHash ?? row.sitemapHash ?? undefined,
        checkIntervalHours: interval,
        changed: outcome.changed,
        changeCount: (row.changeCount ?? 0) + (outcome.changed ? 1 : 0),
        llmsTxt: outcome.llmsTxt,
      });

      done += 1;
      log(`  ${row.url} - ${outcome.result}, next in ${interval}h`);
    } catch (error) {
      log(`  ${row.url} - error: ${String(error).slice(0, 90)}`);
    }
  }

  return done;
}

// Only when run as a program. Importing this file - which the tests do, for
// build() - must not start working through somebody's queue.
if (import.meta.main) {
  if (!storeConfigured()) {
    console.error("SUPABASE_URL and SUPABASE_SECRET_KEY are required.");
    process.exit(1);
  }

  const released = await releaseStaleClaims();
  if (released > 0) log(`released ${released} claim(s) from a run that did not finish`);

  const built = await drainQueue();
  const checked = await runDueChecks();

  log(`\nbuilt ${built}, checked ${checked}, in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
