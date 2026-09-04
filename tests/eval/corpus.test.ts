/**
 * Corpus eval: run the generator against a cohort of real sites from the
 * llmstxt.site directory and score each one against that site's OWN published
 * llms.txt.
 *
 * Every site in that directory has published an llms.txt, which makes it the
 * closest thing to a labelled dataset this problem has: a human decided which
 * pages of their site matter, and we can check how much of that we
 * rediscovered without any judgment call.
 *
 * Design decisions that matter:
 *
 *   The cohort is SEEDED, not random. An aggregate score that moves because
 *   the sample changed tells you nothing; with a fixed EVAL_SEED the same
 *   sites are drawn every run, so a drop in median recall is attributable to
 *   a code change. Bump the seed deliberately to refresh the cohort.
 *
 *   Assertions are on AGGREGATES, not per-site. Individual live sites go
 *   down, rate-limit, or ship a broken sitemap; failing the build on one of
 *   those is noise. A drop in the median across the cohort is signal. The
 *   one exception is spec validity, which is asserted per-site because
 *   emitting a malformed llms.txt is our bug on any input.
 *
 *   Sites are crawled in parallel, and a site that cannot be crawled at all
 *   is recorded as an error rather than throwing — an unreachable third
 *   party is not a regression in this code, but a cohort where suddenly half
 *   the sites fail is.
 *
 * Env:
 *   EVAL_SITES        cohort size (default 8)
 *   EVAL_SEED         cohort selection seed (default 1)
 *   EVAL_CONCURRENCY  sites crawled in parallel (default 3)
 *   EVAL_JUDGE=1      additionally run the LLM judge on every site (slow, costs money)
 *   EVAL_REPORT       path to write a JSON report for run-over-run comparison
 */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { crawlSite } from "../../lib/crawler";
import { buildLlmsTxt } from "../../lib/buildLlmsTxt";
import { enhanceLlmsTxt, isAiConfigured } from "../../lib/ai";
import { judgeLlmsTxt } from "../../lib/judge";
import { validateLlmsTxt } from "../../lib/validate";
import {
  extractUrls,
  fetchText,
  mapWithConcurrency,
  mean,
  measureLinkLiveness,
  measureRecall,
  median,
  isSameHostEntry,
  parseDirectory,
  seededShuffle,
  type DirectoryEntry,
} from "../helpers/evalMetrics";

const DIRECTORY_URL = "https://llmstxt.site";
const COHORT_SIZE = Number(process.env.EVAL_SITES ?? 8);
const SEED = Number(process.env.EVAL_SEED ?? 1);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 3);
/**
 * The denominator for "attainable" recall — deliberately a FIXED constant of
 * the benchmark, not the crawler's live MAX_CRAWL_PAGES.
 *
 * It was briefly the latter, which quietly made the metric useless: shrinking
 * the page budget shrank the denominator by the same factor, so a crawl
 * capped at 5 pages still scored 80% "attainable recall" while its raw recall
 * collapsed to 25%. A benchmark whose denominator moves with the thing under
 * test cannot detect a regression in that thing. Changing this number changes
 * what past scores mean, so treat it as a versioned part of the eval.
 */
const EVAL_PAGE_BUDGET = 100;
const RUN_JUDGE = process.env.EVAL_JUDGE === "1" && isAiConfigured();
// Oversample: some directory entries are dead, parked, or serve no llms.txt.
const OVERSAMPLE = 3;
const TEST_TIMEOUT_MS = 120_000 + COHORT_SIZE * 90_000;

// --- Aggregate thresholds. Deliberately loose: these catch "something broke
// across the board", not "one site regressed by a point". ---
const MIN_CRAWL_SUCCESS_RATE = 0.6;
const MIN_MEDIAN_ATTAINABLE_RECALL = 0.5;
const MIN_MEDIAN_LIVENESS = 0.9;

interface SiteResult {
  homepage: string;
  ok: boolean;
  error?: string;
  pages?: number;
  validationIssues?: string[];
  recall?: number;
  attainableRecall?: number;
  referenceUrls?: number;
  reachableUrls?: number;
  liveness?: number;
  livenessChecked?: number;
  deadLinks?: string[];
  /** Why this site contributes no recall number (rather than a misleading 0%). */
  excluded?: string;
  aiStatus?: string;
  judgeBefore?: number;
  judgeAfter?: number;
}

async function evaluateSite(entry: DirectoryEntry): Promise<SiteResult> {
  try {
    const crawlResult = await crawlSite(entry.homepage);
    const deterministic = buildLlmsTxt(crawlResult);
    const reference = await fetchText(entry.llmsTxtUrl);

    const result: SiteResult = {
      homepage: entry.homepage,
      ok: true,
      pages: crawlResult.pages.length,
      validationIssues: validateLlmsTxt(deterministic).map((i) => `${i.code}${i.line ? `:${i.line}` : ""}`),
    };

    let finalTxt = deterministic;
    if (isAiConfigured()) {
      const enhanced = await enhanceLlmsTxt(crawlResult, deterministic);
      result.aiStatus = enhanced.status;
      // Only adopt the AI version if it is still spec-valid, mirroring what
      // the API route does — the eval must score what a user would receive.
      if (validateLlmsTxt(enhanced.llmsTxt).length === 0) finalTxt = enhanced.llmsTxt;
    }

    const urls = extractUrls(finalTxt);
    const liveness = await measureLinkLiveness(urls);
    result.liveness = liveness.ratio;
    result.livenessChecked = liveness.checked;
    result.deadLinks = liveness.dead;

    if (reference) {
      const recall = measureRecall(urls, reference, EVAL_PAGE_BUDGET);
      result.recall = recall.ratio;
      result.attainableRecall = recall.attainableRatio;
      result.referenceUrls = recall.referenceCount;
      result.reachableUrls = recall.reachableCount;
      if (recall.referenceCount === 0) {
        result.excluded = "reference contains no markdown links to compare against";
      } else if (recall.reachableCount === 0) {
        // e.g. xjodoin.github.io's llms.txt links github.com blob URLs for
        // the same pages. Same host for the file, another host for its
        // contents — not something a crawl of this site could ever match.
        result.excluded = "reference lists no URL on a host we crawled";
      }

      if (RUN_JUDGE) {
        const [before, after] = await Promise.all([
          judgeLlmsTxt(entry.homepage, deterministic, reference),
          finalTxt === deterministic ? Promise.resolve(null) : judgeLlmsTxt(entry.homepage, finalTxt, reference),
        ]);
        result.judgeBefore = before?.qualityScore;
        result.judgeAfter = after?.qualityScore ?? before?.qualityScore;
      }
    }

    return result;
  } catch (err) {
    return { homepage: entry.homepage, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

describe("llmstxt.site corpus eval", () => {
  it(
    "generates valid, live, high-recall llms.txt across a cohort of real sites",
    async () => {
      const directoryHtml = await fetchText(DIRECTORY_URL, 15_000);
      expect(directoryHtml, `could not fetch the directory at ${DIRECTORY_URL}`).toBeTruthy();

      const entries = parseDirectory(directoryHtml!);
      expect(entries.length, "no candidate sites parsed from the directory").toBeGreaterThan(COHORT_SIZE);

      // Cross-host pairings can't be scored, so they're removed before
      // sampling rather than dragging the cohort down as 0%.
      const scoreable = entries.filter(isSameHostEntry);
      console.log(
        `directory: ${entries.length} entries, ${entries.length - scoreable.length} excluded for pairing a homepage with an llms.txt on another host`
      );
      const cohort = seededShuffle(scoreable, SEED).slice(0, COHORT_SIZE * OVERSAMPLE);
      const attempted: SiteResult[] = [];

      // Walk the oversampled cohort until COHORT_SIZE sites actually crawl.
      for (let i = 0; i < cohort.length && attempted.filter((r) => r.ok).length < COHORT_SIZE; i += CONCURRENCY) {
        const batch = cohort.slice(i, i + CONCURRENCY);
        attempted.push(...(await mapWithConcurrency(batch, CONCURRENCY, evaluateSite)));
      }

      const results = attempted.filter((r) => r.ok).slice(0, COHORT_SIZE);
      const failures = attempted.filter((r) => !r.ok);

      // ---- Report ----
      console.log(`\n=== llmstxt.site corpus eval (seed=${SEED}, cohort=${results.length}) ===`);
      console.log(
        ["site", "pages", "recall", "attain", "ref", "reach", "live", "ai", RUN_JUDGE ? "judge" : ""].filter(Boolean).join("\t")
      );
      for (const r of results) {
        const judge = RUN_JUDGE ? `\t${r.judgeBefore ?? "-"}->${r.judgeAfter ?? "-"}` : "";
        console.log(
          `${r.homepage.replace(/^https?:\/\//, "").slice(0, 30).padEnd(30)}\t${r.pages}\t` +
            `${r.recall !== undefined ? `${(r.recall * 100).toFixed(0)}%` : "n/a"}\t` +
            `${r.attainableRecall !== undefined ? `${(r.attainableRecall * 100).toFixed(0)}%` : "n/a"}\t` +
            `${r.referenceUrls ?? "-"}\t${r.reachableUrls ?? "-"}\t` +
            `${r.livenessChecked ? `${((r.liveness ?? 1) * 100).toFixed(0)}%` : "n/a"}\t${r.aiStatus ?? "-"}${judge}` +
            (r.excluded ? `\t(${r.excluded})` : "")
        );
      }
      for (const f of failures) console.log(`  (uncrawlable) ${f.homepage}: ${f.error}`);

      const withReference = results.filter((r) => r.recall !== undefined && (r.reachableUrls ?? 0) >= 5);
      const recalls = withReference.map((r) => r.attainableRecall!);
      // Only sites where at least one link could actually be verified: a host
      // that refuses HEAD from our user agent must not read as a perfect score.
      const livenesses = results.filter((r) => (r.livenessChecked ?? 0) > 0).map((r) => r.liveness!);
      const crawlRate = attempted.length === 0 ? 0 : results.length / attempted.length;

      console.log(
        `\nmedian attainable recall ${(median(recalls) * 100).toFixed(0)}%  mean ${(mean(recalls) * 100).toFixed(0)}%` +
          `  (${withReference.length} sites with a usable reference; raw median ${(median(withReference.map((r) => r.recall!)) * 100).toFixed(0)}%)`
      );
      console.log(
        `median liveness ${(median(livenesses) * 100).toFixed(0)}% (${livenesses.length} sites verifiable)` +
          `   crawl success ${(crawlRate * 100).toFixed(0)}%`
      );
      const excluded = results.filter((r) => r.excluded);
      if (excluded.length) console.log(`excluded from recall: ${excluded.map((r) => `${r.homepage} (${r.excluded})`).join("; ")}`);
      if (RUN_JUDGE) {
        const deltas = results.filter((r) => r.judgeBefore !== undefined && r.judgeAfter !== undefined).map((r) => r.judgeAfter! - r.judgeBefore!);
        console.log(`mean judge quality: ${mean(results.map((r) => r.judgeAfter ?? 0)).toFixed(1)}/10, mean AI delta ${mean(deltas) >= 0 ? "+" : ""}${mean(deltas).toFixed(2)}`);
      }
      const aiFailures = results.filter((r) => r.aiStatus === "failed").map((r) => r.homepage);
      if (aiFailures.length) console.log(`AI pass FAILED on: ${aiFailures.join(", ")}`);

      if (process.env.EVAL_REPORT) {
        writeFileSync(process.env.EVAL_REPORT, JSON.stringify({ seed: SEED, generatedAt: new Date().toISOString(), results, failures }, null, 2));
        console.log(`report written to ${process.env.EVAL_REPORT}`);
      }

      // ---- Assertions on aggregates ----
      expect(results.length, "not enough sites in the cohort crawled successfully").toBeGreaterThan(0);

      // Spec validity is per-site: malformed output is our bug on any input.
      for (const r of results) {
        expect(r.validationIssues, `${r.homepage}: output is not a valid llms.txt (${r.validationIssues?.join(", ")})`).toEqual([]);
      }

      expect(crawlRate, `only ${(crawlRate * 100).toFixed(0)}% of attempted sites crawled at all`).toBeGreaterThanOrEqual(
        MIN_CRAWL_SUCCESS_RATE
      );
      if (livenesses.length >= 3) {
        expect(median(livenesses), "median link liveness across the cohort dropped").toBeGreaterThanOrEqual(MIN_MEDIAN_LIVENESS);
      }

      if (withReference.length >= 3) {
        expect(
          median(recalls),
          `median attainable URL recall across ${withReference.length} sites is ${(median(recalls) * 100).toFixed(0)}% — of the reference pages we could have reached within the page budget, we found too few`
        ).toBeGreaterThanOrEqual(MIN_MEDIAN_ATTAINABLE_RECALL);
      }

      // A copyedit call that never returned is our bug (bad model or route),
      // not a property of the site. Tolerate one flake, not a pattern.
      if (isAiConfigured()) {
        expect(aiFailures.length, `AI copyedit failed outright on ${aiFailures.length}/${results.length} sites`).toBeLessThanOrEqual(
          Math.floor(results.length * 0.25)
        );
      }
    },
    TEST_TIMEOUT_MS
  );
});
