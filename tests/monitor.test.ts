import { test } from "node:test";
import assert from "node:assert/strict";

import { CHECK_INTERVAL_HOURS, RunBudget, isDue, sitemapHash, structureHash } from "../lib/monitor.ts";
import type { Extraction } from "../lib/naiveExtractor.ts";

const extraction = (links: [string, string][], siteName = "Acme"): Extraction => ({
  siteName,
  summary: "A summary",
  prose: [],
  clientRendered: false,
  sections: [{ name: "Docs", links: links.map(([url, title]) => ({ url, title })) }],
  optional: [],
});

test("the structure hash ignores everything a model touches", () => {
  // The stored file is AI-assisted and its wording can shift between runs. The
  // site's fingerprint must not, or every check would report a change.
  const a = extraction([["https://x.com/a", "A"]]);
  const b: Extraction = {
    ...a,
    summary: "An entirely different summary written by a model",
    prose: ["New orienting prose."],
    sections: [{ name: "Docs", links: [{ url: "https://x.com/a", title: "A", note: "a fresh note" }] }],
  };

  assert.equal(structureHash(a), structureHash(b));
});

test("the structure hash notices pages and titles", () => {
  const base = extraction([["https://x.com/a", "A"]]);
  assert.notEqual(structureHash(base), structureHash(extraction([["https://x.com/a", "A renamed"]])));
  assert.notEqual(
    structureHash(base),
    structureHash(extraction([["https://x.com/a", "A"], ["https://x.com/b", "B"]])),
  );
});

test("the structure hash does not depend on ordering", () => {
  const forward = extraction([["https://x.com/a", "A"], ["https://x.com/b", "B"]]);
  const reversed = extraction([["https://x.com/b", "B"], ["https://x.com/a", "A"]]);
  assert.equal(structureHash(forward), structureHash(reversed));
});

test("a renamed site is a changed site", () => {
  const links: [string, string][] = [["https://x.com/a", "A"]];
  assert.notEqual(structureHash(extraction(links, "Acme")), structureHash(extraction(links, "Acme Corp")));
});

test("the sitemap hash sees added and removed pages, not order", () => {
  const a = sitemapHash(["https://x.com/1", "https://x.com/2"]);
  assert.equal(a, sitemapHash(["https://x.com/2", "https://x.com/1"]));
  assert.notEqual(a, sitemapHash(["https://x.com/1", "https://x.com/2", "https://x.com/3"]));
  assert.notEqual(a, sitemapHash(["https://x.com/1"]));
});

test("every site is on the same interval, and it is the stated one", () => {
  // The number is the promise: nothing here is ever further behind the site
  // it describes than this. It is worth a test precisely because it is a
  // constant - the previous design's ceiling was seven days, and nobody
  // reading the code could say so without simulating the recurrence.
  assert.equal(CHECK_INTERVAL_HOURS, 6);
});

test("a row that has never been checked is due", () => {
  // Otherwise a newly stored site would wait for a timestamp it does not have.
  assert.equal(isDue(null), true);
  assert.equal(isDue("not a date"), true);
});

test("due-ness is measured against the interval, whoever supplies it", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

  assert.equal(isDue(hoursAgo(5), 6, now), false);
  assert.equal(isDue(hoursAgo(7), 6, now), true);

  // The caller passes nothing, which is how the route calls it: six hours.
  assert.equal(isDue(hoursAgo(5), undefined, now), false);
  assert.equal(isDue(hoursAgo(7), undefined, now), true);
});

/* --- what one run may spend -------------------------------------------- */

const budget = (over: Partial<{ maxRegenerations: number; deadlineMs: number; regenerationMs: number }> = {}) =>
  new RunBudget({ maxRegenerations: 2, deadlineMs: 45_000, regenerationMs: 35_000, startedAt: 0, ...over });

test("a run rewrites no more sites than it can pay for", () => {
  const run = budget();
  assert.equal(run.claim(0), true);
  assert.equal(run.claim(0), true);
  assert.equal(run.claim(0), false, "a third rewrite is beyond the budget");
  assert.equal(run.spent, 2);
});

test("a claim the check did not use goes back", () => {
  // Claimed before the check runs, because the check is awaited and two
  // workers reading the count first would both take the last slot. The cost is
  // that a cheap check can hold a slot it never needed.
  const run = budget();
  assert.equal(run.claim(0), true);
  run.release();
  assert.equal(run.spent, 0);

  assert.equal(run.claim(0), true);
  assert.equal(run.claim(0), true);
  assert.equal(run.claim(0), false);
});

test("a rewrite is not begun that the run cannot finish", () => {
  // The deadline cannot interrupt one that has started: the first live run
  // took 69 seconds against a 60-second function and would have been killed
  // mid-write.
  const run = budget();
  assert.equal(run.claim(9_000), true, "36s left, a rewrite takes 35");
  assert.equal(run.claim(11_000), false, "34s left is not enough to start one");
  assert.equal(run.spent, 1, "the refused claim must not be counted");
});

test("release cannot push the count below nothing", () => {
  const run = budget();
  run.release();
  run.release();
  assert.equal(run.spent, 0);
  assert.equal(run.claim(0), true);
});

test("a run stops taking rows once its time is spent", () => {
  const run = budget();
  assert.equal(run.expired(44_999), false);
  assert.equal(run.expired(45_001), true);
});

test("a site just generated is not immediately due for a check", () => {
  // writeGeneration records the moment as the row's first check, because
  // generating a site is looking at it. Without that the next scheduled run
  // spends a check asking whether the site changed since we built it.
  const now = Date.parse("2026-09-10T12:00:00Z");

  assert.equal(isDue(new Date(now - 1_000).toISOString(), undefined, now), false);
  // A row that genuinely has never been checked still is.
  assert.equal(isDue(null, undefined, now), true);
});
