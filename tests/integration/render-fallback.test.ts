/**
 * Integration test for the curl-then-Playwright escalation, against a real
 * server exhibiting the two cases that justify it:
 *
 *   /spa     — HTTP 200 with an empty shell whose content only appears after
 *              client-side JS runs.
 *   /walled  — HTTP 403 to plain fetch(), real content to a real browser
 *              (the fixture keys off Sec-Fetch-* headers, which browsers send
 *              and node's fetch does not — the same shape as a bot wall).
 *
 * Both are asserted from the OUTSIDE (did the finished llms.txt get the real
 * title and description?) rather than by spying on which code path ran, so
 * the test stays true if the escalation is reorganized.
 *
 * Skipped automatically when the Playwright browser binary isn't installed
 * (`npx playwright install chromium`), since that's an environment gap, not a
 * regression.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawlSite } from "../../lib/crawler";
import { buildLlmsTxt } from "../../lib/buildLlmsTxt";
import { launchBrowser } from "../../lib/browserRender";
import { validateLlmsTxt, formatIssues } from "../../lib/validate";
import { startFixtureServer, type FixtureServer } from "../helpers/fixtureServer";
import type { CrawlResult } from "../../lib/types";

process.env.ALLOW_PRIVATE_CRAWL_TARGETS = "1";

// Resolved at module load (not in beforeAll) so the suite can be genuinely
// SKIPPED rather than passing vacuously when the browser is missing — a
// "skipped" line in the report is honest; four green checks that asserted
// nothing are not.
const browserAvailable = await (async () => {
  if (process.env.SKIP_BROWSER_TESTS === "1") return false;
  const browser = await launchBrowser();
  await browser?.close().catch(() => {});
  if (!browser) {
    console.log("Playwright chromium not installed (npx playwright install chromium) — skipping render-fallback tests.");
  }
  return browser !== null;
})();

let server: FixtureServer;
let result: CrawlResult;
let llmsTxt = "";

beforeAll(async () => {
  server = await startFixtureServer({ includeRenderPages: true });
  result = await crawlSite(server.url);
  llmsTxt = buildLlmsTxt(result);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe.runIf(browserAvailable)("browser render fallback", () => {
  it("recovers a client-rendered page's real title and description", () => {
    const spa = result.pages.find((p) => p.url.endsWith("/spa"));
    expect(spa, "the /spa page was dropped entirely").toBeTruthy();
    expect(spa!.title).toBe("Dashboard - Acme");
    expect(spa!.description).toContain("Watch every widget run in real time");
  });

  it("recovers a page that bot-walls plain fetch but serves a real browser", () => {
    const walled = result.pages.find((p) => p.url.endsWith("/walled"));
    expect(walled, "the bot-walled /walled page was dropped entirely").toBeTruthy();
    expect(walled!.title).toBe("Changelog - Acme");
  });

  it("recovers a JS app whose shell already has more text than the thin-content bar", () => {
    // The thin-content heuristic only escalates on a nearly-empty shell, but
    // real JS apps ship a nav and a footer and then fetch their content on
    // mount. Those pages sail past the threshold and get indexed with a
    // generic title and no description, which is silently wrong rather than
    // visibly broken.
    const dash = result.pages.find((p) => p.url.endsWith("/dashboard"));
    expect(dash, "the /dashboard page was dropped entirely").toBeTruthy();
    expect(dash!.title).toBe("Analytics Dashboard - Acme");
    expect(dash!.description).toContain("Track widget throughput");
  });

  it("never publishes a loading-placeholder title", () => {
    expect(llmsTxt).not.toMatch(/Loading|Just a moment/i);
  });

  it("still produces a spec-valid document with rendered pages mixed in", () => {
    const issues = validateLlmsTxt(llmsTxt);
    expect(issues, `llms.txt failed validation:\n${formatIssues(issues)}`).toEqual([]);
  });
});
