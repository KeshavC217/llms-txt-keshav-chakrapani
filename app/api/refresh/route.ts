import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { generateLlmsTxt, normalizeUrl } from "@/lib/generate";
import { summarizeDiff } from "@/lib/diff";
import { dueSites, getSiteByUrl, isStoreConfigured, markFailed, recordGeneration, type TrackedSite } from "@/lib/store";

/**
 * The monitoring endpoint: re-crawls sites whose next check is due, stores a
 * snapshot only when the result actually changed, and reschedules.
 *
 * Called by a scheduler (GitHub Actions on a cron, or Vercel Cron). It is
 * deliberately a plain authenticated HTTP endpoint rather than platform-
 * specific glue, so moving hosts is a change of caller, not of code.
 */

export const maxDuration = 300;

/** Total wall-clock budget for one refresh run, leaving room under maxDuration. */
const RUN_BUDGET_MS = Number(process.env.REFRESH_RUN_BUDGET_MS ?? 240_000);
/** Per-site budget, so one slow site cannot consume the whole run. */
const SITE_BUDGET_MS = Number(process.env.REFRESH_SITE_BUDGET_MS ?? 60_000);
const MAX_SITES_PER_RUN = Number(process.env.REFRESH_MAX_SITES ?? 10);

/**
 * Constant-time comparison. A plain `===` on a secret leaks its length and
 * prefix through timing, and this endpoint is the only thing standing between
 * the open internet and an unbounded crawl trigger.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorize(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  // Vercel Cron sends the secret as a Bearer token; GitHub Actions can send
  // either. Accept a query parameter too, for schedulers that cannot set
  // headers — it is no weaker, since both travel over TLS.
  const query = new URL(request.url).searchParams.get("secret");
  return secretMatches(bearer ?? query, expected);
}

interface SiteOutcome {
  url: string;
  status: "changed" | "unchanged" | "failed";
  pageCount?: number;
  changeSummary?: string;
  error?: string;
}

async function refreshSite(site: TrackedSite): Promise<SiteOutcome> {
  try {
    const result = await generateLlmsTxt(site.url, {
      useAi: site.useAi,
      budgetMs: SITE_BUDGET_MS,
    });
    const recorded = await recordGeneration(site, result.llmsTxt, {
      pageCount: result.pageCount,
      aiStatus: result.aiStatus,
    });

    return {
      url: site.url,
      status: recorded.changed ? "changed" : "unchanged",
      pageCount: result.pageCount,
      changeSummary: recorded.diff ? summarizeDiff(recorded.diff) : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Record the failure so the site backs off and eventually pauses, rather
    // than the scheduler retrying a dead host on every run forever.
    await markFailed(site, message).catch(() => {});
    return { url: site.url, status: "failed", error: message };
  }
}

async function run(request: Request) {
  if (!isStoreConfigured()) {
    return NextResponse.json({ error: "Monitoring is not configured." }, { status: 503 });
  }
  if (!authorize(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const startedAt = Date.now();
  const url = new URL(request.url);

  try {
    // A single named site (the UI's "Check now"), or everything due.
    //
    // The lookup must normalize first: sites are stored under the normalized
    // URL, so querying with a trailing slash difference — or a bare hostname —
    // would silently match nothing and report "not tracked" for a site that
    // plainly is.
    const requested = url.searchParams.get("url");
    const single = requested ? normalizeUrl(requested) : null;
    if (requested && !single) {
      return NextResponse.json({ error: "Invalid url parameter." }, { status: 400 });
    }

    const sites = single
      ? [await getSiteByUrl(single)].filter((s): s is TrackedSite => s !== null)
      : await dueSites(MAX_SITES_PER_RUN);

    if (sites.length === 0) {
      return NextResponse.json({ checked: 0, results: [], note: single ? "That site is not tracked." : "Nothing due." });
    }

    const results: SiteOutcome[] = [];
    for (const site of sites) {
      // Sequential on purpose: these are independent third-party sites, and
      // running them in parallel multiplies our outbound load for no benefit
      // when the whole run is already bounded.
      if (Date.now() - startedAt > RUN_BUDGET_MS - SITE_BUDGET_MS) {
        // Leave the rest due; the next run picks them up in the same order.
        break;
      }
      results.push(await refreshSite(site));
    }

    return NextResponse.json({
      checked: results.length,
      remaining: sites.length - results.length,
      elapsedMs: Date.now() - startedAt,
      results,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Refresh failed." }, { status: 500 });
  }
}

// GET so Vercel Cron (which issues GETs) and a browser can both reach it;
// POST for schedulers that prefer it.
export const GET = run;
export const POST = run;
