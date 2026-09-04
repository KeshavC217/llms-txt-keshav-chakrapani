import { NextResponse } from "next/server";
import { crawlSite } from "@/lib/crawler";
import { buildLlmsTxt } from "@/lib/buildLlmsTxt";
import { enhanceLlmsTxt, isAiConfigured } from "@/lib/ai";
import { formatIssues, validateLlmsTxt } from "@/lib/validate";

// Generous enough to cover the homepage's mandatory browser render plus a
// render fallback on several thin/SPA pages (15s each, see
// lib/browserRender.ts) without timing out a site that happens to need it;
// sites that don't need rendering finish in a couple seconds regardless.
const OVERALL_TIMEOUT_MS = 60000;
// Must comfortably exceed lib/openrouter.ts's own request timeout, or this
// race cuts the model off before its own deadline and we lose the reply.
const AI_TIMEOUT_MS = 65000;

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

export async function POST(request: Request) {
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
    const result = await withTimeout(crawlSite(normalizedUrl, { signal: abort.signal }), OVERALL_TIMEOUT_MS, abort);
    const deterministic = buildLlmsTxt(result);
    let llmsTxt = deterministic;

    // Reported to the UI so a silently-degraded result is never presented as
    // a normal one: "off" (not requested), "unavailable" (no API key),
    // "applied", "no-changes" (model had nothing to change), "failed".
    let aiStatus: "off" | "unavailable" | "applied" | "no-changes" | "failed" = "off";
    if (Boolean(body.useAi) && !isAiConfigured()) aiStatus = "unavailable";

    if (useAi) {
      try {
        const enhanced = await withTimeout(enhanceLlmsTxt(result, deterministic), AI_TIMEOUT_MS);
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
