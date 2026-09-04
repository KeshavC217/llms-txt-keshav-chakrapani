/**
 * Functional eval: grabs random real-world sites from the llmstxt.site
 * directory (a big, varied list of live sites — different frameworks,
 * languages, bot protections, nav markup) and runs the whole generator
 * against them end to end (real network, real Playwright renders), then
 * scores the result three different ways.
 *
 * This complements tests/integration (deterministic, offline, gate-able)
 * rather than replacing it: this one is deliberately non-hermetic, because
 * the bugs it finds are the ones only real markup produces.
 *
 * Three signals, weakest last:
 *
 *   1. SPEC VALIDITY (hard assertion, no network or LLM needed) —
 *      lib/validate.ts. If we emit something that isn't a well-formed
 *      llms.txt, that's a bug on any site, full stop.
 *
 *   2. LINK LIVENESS + RECALL (objective measurements, no LLM) — do the URLs
 *      we emit actually resolve, and how many of the URLs in the site's OWN
 *      published llms.txt did we independently find? Dead links are an
 *      unambiguous defect; recall is a real quality number that needs no
 *      judgment call. Liveness is asserted; recall is reported, since a
 *      hand-written llms.txt often lists pages no crawler could reach.
 *
 *   3. LLM JUDGE (reported, only gates if you ask it to) — lib/judge.ts
 *      scores our output on its own merits and against the site's real
 *      llms.txt. Run on BOTH the deterministic output and the AI-copyedited
 *      one, so the number that matters — does the AI pass actually make
 *      things better? — is visible instead of assumed.
 *
 * Env:
 *   RANDOM_SITE_URL     target one specific site instead of random ones
 *   RANDOM_SITE_COUNT   how many random sites to evaluate (default 1)
 *   JUDGE_MIN_QUALITY   if set, fail when the mean judge quality drops below it
 *   OPENROUTER_API_KEY  enables the AI copyedit pass and the judge
 */
import { describe, expect, it } from "vitest";
import { crawlSite } from "../../lib/crawler";
import { buildLlmsTxt } from "../../lib/buildLlmsTxt";
import { isPlaceholderTitle } from "../../lib/extract";
import { enhanceLlmsTxt, isAiConfigured } from "../../lib/ai";
import { judgeLlmsTxt, type JudgeVerdict } from "../../lib/judge";
import { formatIssues, validateLlmsTxt } from "../../lib/validate";
import {
  extractHeaders,
  extractUrls,
  fetchText,
  measureLinkLiveness,
  measureRecall,
  parseDirectory,
  seededShuffle,
  type DirectoryEntry,
} from "../helpers/evalMetrics";

const DIRECTORY_URL = "https://llmstxt.site";
const MAX_CANDIDATE_ATTEMPTS = 8;
const SITE_COUNT = Number(process.env.RANDOM_SITE_COUNT ?? 1);
const TEST_TIMEOUT_MS = 180_000 * Math.max(1, SITE_COUNT);
// Some live sites 403 a non-browser HEAD, or rate-limit a burst of them, so a
// handful of unverifiable links is expected noise, not a defect in our output.
const MIN_LIVE_LINK_RATIO = 0.8;
// Recall used to be printed and never asserted, on the reasoning that a
// hand-written llms.txt lists pages no crawler can reach. That reasoning was
// wrong in the common case: the number sat at 20% on beeclue.com purely
// because of our own page cap, was logged in plain sight, and nobody acted on
// it. 25% is a floor, not a target — it catches "the crawler stopped early",
// which is what actually happened, without failing on a reference that
// genuinely lists unreachable pages.
const MIN_URL_RECALL = Number(process.env.MIN_URL_RECALL ?? 0.5);
// Fixed benchmark constant, NOT the crawler's live page budget — see the note
// in directory-eval.test.ts. Dividing by the budget under test makes the
// metric blind to a shrinking budget, which is what it exists to catch.
const EVAL_PAGE_BUDGET = 100;
// Below this, the reference is too small for a ratio to mean anything.
const MIN_REFERENCE_URLS_TO_ASSERT = 10;

interface CrawledCandidate {
  entry: DirectoryEntry;
  crawlResult: Awaited<ReturnType<typeof crawlSite>>;
  reference: string | null;
}

async function crawlFirstWorkingCandidate(entries: DirectoryEntry[], skip: Set<string>): Promise<CrawledCandidate | null> {
  for (const entry of entries) {
    if (skip.has(entry.homepage)) continue;
    try {
      const crawlResult = await crawlSite(entry.homepage);
      const reference = await fetchText(entry.llmsTxtUrl);
      return { entry, crawlResult, reference };
    } catch {
      // Candidate site itself is unreachable/broken — try the next one, not our bug.
      continue;
    }
  }
  return null;
}

describe("single-site eval", () => {
  it(
    "generates a sane, spec-valid llms.txt for random live sites",
    async () => {
      const explicitUrl = process.env.RANDOM_SITE_URL;

      let pool: DirectoryEntry[];
      if (explicitUrl) {
        pool = [{ homepage: explicitUrl, llmsTxtUrl: `${explicitUrl.replace(/\/$/, "")}/llms.txt` }];
      } else {
        const directoryHtml = await fetchText(DIRECTORY_URL);
        expect(directoryHtml, `could not fetch directory page: ${DIRECTORY_URL}`).toBeTruthy();
        const entries = parseDirectory(directoryHtml!);
        expect(entries.length, "found no candidate sites on the directory page").toBeGreaterThan(0);
        pool = seededShuffle(entries, Math.floor(Math.random() * 1e9)).slice(0, MAX_CANDIDATE_ATTEMPTS * SITE_COUNT);
      }

      const qualityScores: number[] = [];
      const evaluated = new Set<string>();

      for (let siteIndex = 0; siteIndex < SITE_COUNT; siteIndex++) {
        const result = await crawlFirstWorkingCandidate(pool, evaluated);
        expect(result, `none of ${pool.length} candidate site(s) crawled successfully`).toBeTruthy();
        const { entry, crawlResult, reference } = result!;
        evaluated.add(entry.homepage);

        const deterministic = buildLlmsTxt(crawlResult);
        let llmsTxt = deterministic;

        // --- Signal 1: spec validity (hard) ---
        const headers = extractHeaders(llmsTxt);
        console.log(
          `\n[${entry.homepage}] crawled ${crawlResult.pages.length} page(s); sections: ${headers.join(", ")}`
        );

        expect(crawlResult.pages.length, "crawled zero pages").toBeGreaterThan(0);
        const issues = validateLlmsTxt(llmsTxt);
        expect(issues, `${entry.homepage}: output is not a valid llms.txt:\n${formatIssues(issues)}\n\n${llmsTxt}`).toEqual([]);

        const placeholderHeaders = headers.filter(isPlaceholderTitle);
        expect(placeholderHeaders, "placeholder/loading titles leaked into output").toEqual([]);

        // Catches the "Careers5Shape the future with us" class of bug: a digit
        // sandwiched directly between letters with no space, from concatenating
        // adjacent DOM text nodes without a separator.
        const junkRun = headers.find((h) => /\p{L}\d\p{L}/u.test(h));
        expect(junkRun, "possible run-on/concatenated text in a header").toBeUndefined();

        // --- Signal 2: objective measurements, no LLM involved ---
        const ourUrls = extractUrls(llmsTxt);
        const { ratio: liveRatio, dead } = await measureLinkLiveness(ourUrls);
        console.log(`  link liveness: ${(liveRatio * 100).toFixed(0)}% of ${ourUrls.length} link(s)`);
        if (dead.length > 0) console.log(`  dead links:\n    - ${dead.join("\n    - ")}`);
        expect(liveRatio, `too many published links don't resolve:\n  ${dead.join("\n  ")}`).toBeGreaterThanOrEqual(
          MIN_LIVE_LINK_RATIO
        );

        if (reference) {
          const { attainableRatio: ratio, referenceCount, reachableCount } = measureRecall(ourUrls, reference, EVAL_PAGE_BUDGET);
          console.log(
            `  URL recall vs the site's own llms.txt: ${(ratio * 100).toFixed(0)}% attainable (${reachableCount} reachable of ${referenceCount} reference URL(s))`
          );
          if (reachableCount >= MIN_REFERENCE_URLS_TO_ASSERT) {
            expect(
              ratio,
              `${entry.homepage}: found only ${(ratio * 100).toFixed(0)}% of the reference URLs reachable within the page budget — the crawl is stopping short`
            ).toBeGreaterThanOrEqual(MIN_URL_RECALL);
          }
        }

        // --- Signal 3: optional LLM judge (only with OPENROUTER_API_KEY) ---
        if (!isAiConfigured()) {
          console.log("  OPENROUTER_API_KEY not set — skipping AI copyedit + judge eval.");
          continue;
        }

        const { llmsTxt: enhanced, status: aiStatus } = await enhanceLlmsTxt(crawlResult, deterministic);
        const enhancedIssues = validateLlmsTxt(enhanced);
        expect(
          enhancedIssues,
          `${entry.homepage}: the AI copyedit pass produced an invalid llms.txt:\n${formatIssues(enhancedIssues)}\n\n${enhanced}`
        ).toEqual([]);
        llmsTxt = enhanced;
        console.log(`  AI copyedit pass: ${aiStatus}`);
        // "failed" means the model never returned a usable plan. That is a
        // defect in our client (or the route we picked), not a property of
        // the site, so it should fail the eval rather than quietly scoring
        // the un-copyedited document — the exact way a broken AI pass hid
        // behind an output that merely looked unchanged.
        expect(aiStatus, `${entry.homepage}: the AI copyedit call failed outright`).not.toBe("failed");

        if (!reference) {
          console.log(`  no reference llms.txt at ${entry.llmsTxtUrl} — skipping judge eval.`);
          continue;
        }

        // Judging both versions is the point: a single score can't tell you
        // whether the AI pass helped, hurt, or did nothing.
        const [before, after] = await Promise.all([
          judgeLlmsTxt(entry.homepage, deterministic, reference),
          enhanced === deterministic ? Promise.resolve(null) : judgeLlmsTxt(entry.homepage, enhanced, reference),
        ]);

        const report = (label: string, verdict: JudgeVerdict | null) => {
          if (!verdict) return;
          console.log(`  ${label}: quality=${verdict.qualityScore}/10, similarity=${verdict.similarityScore}/10`);
          if (verdict.issues.length > 0) console.log(`    issues:\n      - ${verdict.issues.join("\n      - ")}`);
        };
        report("deterministic", before);
        report("after AI copyedit", after);

        const final = after ?? before;
        if (final) qualityScores.push(final.qualityScore);
        if (before && after) {
          const delta = after.qualityScore - before.qualityScore;
          console.log(`  AI copyedit quality delta: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`);
        }
      }

      // Only gates when you explicitly ask it to: a judge score on one random
      // site is noisy, so treating it as a build gate by default would make
      // the suite flaky for no benefit. Set JUDGE_MIN_QUALITY (with a larger
      // RANDOM_SITE_COUNT) to run it as a real regression gate.
      const minQuality = Number(process.env.JUDGE_MIN_QUALITY ?? 0);
      if (minQuality > 0 && qualityScores.length > 0) {
        const mean = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
        console.log(`\nMean judge quality across ${qualityScores.length} site(s): ${mean.toFixed(2)}/10`);
        expect(mean, `mean judge quality below JUDGE_MIN_QUALITY=${minQuality}`).toBeGreaterThanOrEqual(minQuality);
      }
    },
    TEST_TIMEOUT_MS
  );
});
