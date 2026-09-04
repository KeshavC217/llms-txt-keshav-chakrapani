import { NextResponse } from "next/server";
import { crawlSite } from "@/lib/crawler";
import { buildLlmsTxt } from "@/lib/buildLlmsTxt";
import { enhanceLlmsTxt, isAiConfigured } from "@/lib/ai";
import { formatIssues, validateLlmsTxt } from "@/lib/validate";

/**
 * Vercel terminates a Hobby function at 60s. Everything this handler does must
 * therefore fit inside ONE budget, not two independent ones — the crawl and
 * the copyedit used to have separate 60s and 65s timeouts, so a slow site
 * could reach 125s and get killed by the platform. That failure is the worst
 * possible one: an opaque 504 with no body, so the user sees neither an error
 * message nor the perfectly good deterministic document we were holding.
 *
 * 55s leaves headroom under maxDuration for response serialization.
 */
const REQUEST_BUDGET_MS = 55_000;

/**
 * Don't start the copyedit pass with less than this left. It measures ~3s, so
 * this is generous — but a pass that gets cut off mid-flight wastes tokens and
 * returns nothing, whereas skipping it returns the deterministic document with
 * an honest reason.
 */
const MIN_AI_BUDGET_MS = 10_000;

/** Kept in reserve so we always have time to serialize and send the response. */
const RESPONSE_RESERVE_MS = 3_000;

// Errors from lib/urlGuard.ts and the URL parser are the user's input being
// wrong, not the upstream site being down — they deserve a 400, not a 502.
const CLIENT_ERROR_PATTERNS = [/publicly reachable/i, /Only http and https/i, /Could not resolve/i, /valid URL/i];

function normalizeUrl(input: string): string | null {
  let candidate = input.trim();
  if (!candidate) return null;

  // A scheme we don't support must be rejected, not defaulted: blindly
  // prefixing "https://" turns "ftp://example.com/x" into
  // "https://ftp://example.com/x", which URL happily parses as the host
  // "ftp" — so an unsupported scheme would sail past the protocol check and
  // fail later as an opaque upstream error instead of a clear 400.
  const scheme = candidate.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !/^https?$/i.test(scheme[1])) return null;
  if (!scheme) candidate = `https://${candidate}`;

  try {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// Vercel reads this to size the function. 60 is the Hobby ceiling; on a plan
// that allows more, raise this and REQUEST_BUDGET_MS together.
export const maxDuration = 60;

export async function POST(request: Request) {
  const startedAt = Date.now();
  const remainingBudget = () => REQUEST_BUDGET_MS - (Date.now() - startedAt);
  let body: { url?: string; useAi?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const normalizedUrl = normalizeUrl(body.url ?? "");
  if (!normalizedUrl) {
    return NextResponse.json({ error: "Please enter a valid URL." }, { status: 400 });
  }

  const useAi = Boolean(body.useAi) && isAiConfigured();

  // Handed to the crawler so a timeout actually stops the in-flight fetches
  // and browser renders, instead of leaving them running (and holding a
  // headless Chromium open) after we've already given up on the response.
  const abort = new AbortController();

  try {
    // The crawl may use the whole budget when no copyedit is wanted; when one
    // is, hold back enough that it can actually run.
    const crawlBudget = useAi ? REQUEST_BUDGET_MS - MIN_AI_BUDGET_MS : REQUEST_BUDGET_MS;
    const result = await withTimeout(crawlSite(normalizedUrl, { signal: abort.signal }), crawlBudget, abort);
    const deterministic = buildLlmsTxt(result);
    let llmsTxt = deterministic;

    // Reported to the UI so a silently-degraded result is never presented as
    // a normal one: "off" (not requested), "unavailable" (no API key),
    // "applied", "no-changes" (model had nothing to change), "failed",
    // "skipped" (the crawl used the request budget).
    let aiStatus: "off" | "unavailable" | "applied" | "no-changes" | "failed" | "skipped" = "off";
    if (Boolean(body.useAi) && !isAiConfigured()) aiStatus = "unavailable";

    const aiBudget = remainingBudget() - RESPONSE_RESERVE_MS;
    if (useAi && aiBudget < MIN_AI_BUDGET_MS) {
      aiStatus = "skipped";
      console.warn(`[generate] skipping AI copyedit: only ${aiBudget}ms of the request budget left`);
    } else if (useAi) {
      try {
        const enhanced = await withTimeout(enhanceLlmsTxt(result, deterministic), aiBudget);
        // The copyedit pass splices model-written text into a document we
        // built; a regression there (a mangled link line, a section left
        // empty by an Optional move) should never reach the user when we
        // still hold a known-good deterministic version.
        const issues = validateLlmsTxt(enhanced.llmsTxt);
        if (issues.length > 0) {
          console.error(`[generate] discarding AI copyedit, output failed validation:\n${formatIssues(issues)}`);
          aiStatus = "failed";
        } else {
          aiStatus = enhanced.status;
          llmsTxt = enhanced.llmsTxt;
        }
      } catch {
        // AI polish is best-effort — fall back to the deterministic output.
        aiStatus = "failed";
      }
    }

    return NextResponse.json({
      llmsTxt,
      pageCount: result.pages.length,
      aiStatus,
      aiApplied: aiStatus === "applied",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate llms.txt.";
    const status = CLIENT_ERROR_PATTERNS.some((p) => p.test(message)) ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  } finally {
    abort.abort();
  }
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
