import { crawlSite } from "./crawler";
import { buildLlmsTxt } from "./buildLlmsTxt";
import { enhanceLlmsTxt, isAiConfigured } from "./ai";
import { formatIssues, validateLlmsTxt } from "./validate";

/**
 * The whole generation pipeline as one function: crawl, build, optionally
 * copyedit, validate.
 *
 * Extracted so the interactive endpoint and the monitoring cron run exactly
 * the same code. If they diverged, a scheduled re-crawl could produce a
 * different document than the one a user saw when they tracked the site, and
 * every diff after that would be reporting our own inconsistency as a change
 * to their website.
 */

export type AiStatus = "off" | "unavailable" | "applied" | "no-changes" | "failed" | "skipped";

export interface GenerateResult {
  llmsTxt: string;
  pageCount: number;
  aiStatus: AiStatus;
}

export interface GenerateOptions {
  useAi?: boolean;
  signal?: AbortSignal;
  /** Milliseconds left for the whole operation; the copyedit is skipped if too little remains. */
  budgetMs?: number;
  /** Don't start the copyedit with less than this left. */
  minAiBudgetMs?: number;
  /** Restrict the crawl to these path prefixes (the homepage is always included). */
  includePrefixes?: string[];
  /** Skip these path prefixes. */
  excludePrefixes?: string[];
}

const DEFAULT_MIN_AI_BUDGET_MS = 10_000;

export async function generateLlmsTxt(url: string, options: GenerateOptions = {}): Promise<GenerateResult> {
  const {
    useAi = false,
    signal,
    budgetMs = Infinity,
    minAiBudgetMs = DEFAULT_MIN_AI_BUDGET_MS,
    includePrefixes,
    excludePrefixes,
  } = options;
  const startedAt = Date.now();

  const wantsAi = useAi && isAiConfigured();
  const aiUnavailable = useAi && !isAiConfigured();

  const result = await crawlSite(url, { signal, includePrefixes, excludePrefixes });
  const deterministic = buildLlmsTxt(result);

  let aiStatus: AiStatus = aiUnavailable ? "unavailable" : "off";
  let llmsTxt = deterministic;

  if (wantsAi) {
    const remaining = budgetMs === Infinity ? Infinity : budgetMs - (Date.now() - startedAt);
    if (remaining < minAiBudgetMs) {
      aiStatus = "skipped";
      console.warn(`[generate] skipping AI copyedit: only ${Math.round(remaining)}ms of budget left`);
    } else {
      try {
        const enhanced = await enhanceLlmsTxt(result, deterministic);
        // The copyedit splices model-written text into a document we built. A
        // regression there must never reach the caller while we still hold a
        // known-good deterministic version.
        const issues = validateLlmsTxt(enhanced.llmsTxt);
        if (issues.length > 0) {
          console.error(`[generate] discarding AI copyedit, output failed validation:\n${formatIssues(issues)}`);
          aiStatus = "failed";
        } else {
          aiStatus = enhanced.status;
          llmsTxt = enhanced.llmsTxt;
        }
      } catch {
        aiStatus = "failed";
      }
    }
  }

  return { llmsTxt, pageCount: result.pages.length, aiStatus };
}

/**
 * Normalizes a user-supplied URL, or returns null if it is not usable.
 *
 * An unsupported scheme must be rejected, not defaulted: blindly prefixing
 * "https://" turns "ftp://example.com/x" into "https://ftp://example.com/x",
 * which URL happily parses with the host "ftp" — so it would sail past the
 * protocol check and fail later as an opaque upstream error instead of a
 * clear rejection.
 */
export function normalizeUrl(input: string): string | null {
  let candidate = input.trim();
  if (!candidate) return null;

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
