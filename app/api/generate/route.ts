import { NextResponse } from "next/server";
import { generateLlmsTxt, normalizeUrl } from "@/lib/generate";
import { getSiteByUrl, isStoreConfigured, latestSnapshot, recordGeneration, upsertSite } from "@/lib/store";

/**
 * Vercel terminates a Hobby function at 300s, but a crawl that takes minutes
 * is a bad interactive experience regardless of what the platform allows.
 * Everything here shares ONE budget rather than holding independent timeouts
 * per stage — two independent timeouts could sum past the platform ceiling
 * and get the function killed, which returns an opaque 504 with no body,
 * losing both the error message and the perfectly good deterministic document
 * we were already holding.
 */
const REQUEST_BUDGET_MS = 55_000;
const MIN_AI_BUDGET_MS = 10_000;

export const maxDuration = 300;

// Errors from lib/urlGuard.ts and the URL parser are the user's input being
// wrong, not the upstream site being down — they deserve a 400, not a 502.
const CLIENT_ERROR_PATTERNS = [/publicly reachable/i, /Only http and https/i, /Could not resolve/i, /valid URL/i];

/** How long a stored snapshot may be served before we crawl again. */
const CACHE_MAX_AGE_MS = Number(process.env.GENERATE_CACHE_MAX_AGE_MS ?? 15 * 60_000);

export async function POST(request: Request) {
  let body: {
    url?: string;
    useAi?: boolean;
    refresh?: boolean;
    includePrefixes?: string[];
    excludePrefixes?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const normalizedUrl = normalizeUrl(body.url ?? "");
  if (!normalizedUrl) {
    return NextResponse.json({ error: "Please enter a valid URL." }, { status: 400 });
  }

  const includePrefixes = toPrefixList(body.includePrefixes);
  const excludePrefixes = toPrefixList(body.excludePrefixes);
  // A scoped crawl is a different question than an unscoped one, so it must
  // not be answered from a cache built without those prefixes.
  const scoped = includePrefixes.length > 0 || excludePrefixes.length > 0;

  // Serve a recent stored result instead of re-crawling. Crawling is slow and
  // hits a third party; repeating it for the same URL within minutes is rude
  // to them and pointless for us.
  if (!body.refresh && !scoped && isStoreConfigured()) {
    try {
      const site = await getSiteByUrl(normalizedUrl);
      const snapshot = site ? await latestSnapshot(site.id) : null;
      if (snapshot && Date.now() - new Date(snapshot.createdAt).getTime() < CACHE_MAX_AGE_MS) {
        return NextResponse.json({
          llmsTxt: snapshot.llmsTxt,
          pageCount: snapshot.pageCount,
          aiStatus: snapshot.aiStatus ?? "off",
          aiApplied: snapshot.aiStatus === "applied",
          cached: true,
          generatedAt: snapshot.createdAt,
          trackedSiteId: site!.id,
        });
      }
    } catch (err) {
      // A storage outage must not take the generator down with it.
      console.error("[generate] cache lookup failed, crawling instead:", err);
    }
  }

  // Handed to the crawler so a timeout actually stops in-flight fetches and
  // browser renders, rather than leaving them running after we have given up.
  const abort = new AbortController();

  try {
    const result = await withTimeout(
      generateLlmsTxt(normalizedUrl, {
        useAi: Boolean(body.useAi),
        signal: abort.signal,
        budgetMs: REQUEST_BUDGET_MS,
        minAiBudgetMs: MIN_AI_BUDGET_MS,
        includePrefixes,
        excludePrefixes,
      }),
      REQUEST_BUDGET_MS,
      abort
    );

    // Persist so the next request for this URL is served from storage rather
    // than re-crawling someone else's site. Best-effort: a storage failure
    // must not lose a document we already generated successfully.
    // A scoped result answers a narrower question, so caching it under the
    // plain URL would serve it to someone who asked for the whole site.
    if (!scoped && isStoreConfigured()) {
      try {
        const site = await upsertSite(normalizedUrl, { useAi: Boolean(body.useAi) });
        await recordGeneration(site, result.llmsTxt, {
          pageCount: result.pageCount,
          aiStatus: result.aiStatus,
        });
      } catch (err) {
        console.error("[generate] could not persist result:", err);
      }
    }

    return NextResponse.json({
      llmsTxt: result.llmsTxt,
      pageCount: result.pageCount,
      aiStatus: result.aiStatus,
      aiApplied: result.aiStatus === "applied",
      cached: false,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate llms.txt.";
    const status = CLIENT_ERROR_PATTERNS.some((p) => p.test(message)) ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  } finally {
    abort.abort();
  }
}

/** Accepts an array or a newline/comma separated string, since the UI sends text. */
function toPrefixList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (typeof value === "string") return value.split(/[\n,]/).map((v) => v.trim()).filter(Boolean);
  return [];
}

function withTimeout<T>(promise: Promise<T>, ms: number, abort?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        abort?.abort();
        reject(new Error("Timed out while crawling that site."));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
