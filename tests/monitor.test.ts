import { test } from "node:test";
import assert from "node:assert/strict";

import { RunBudget, intervalAfter, isDue, nextInterval, sitemapHash, structureHash } from "../lib/monitor.ts";
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

test("a site that changes is watched more closely, one that does not is left alone", () => {
  assert.ok(nextInterval(24, true) < 24);
  assert.ok(nextInterval(24, false) > 24);
});

test("the interval stays within bounds however long it goes either way", () => {
  // A quiet site drifts to weekly in about five checks; a changing one drops
  // to hourly in about the same. Neither runs away.
  let quiet = 24;
  for (let i = 0; i < 40; i += 1) quiet = nextInterval(quiet, false);
  assert.equal(quiet, 24 * 7, `${quiet} hours is too long to ignore a site`);

  let busy = 24;
  for (let i = 0; i < 40; i += 1) busy = nextInterval(busy, true);
  assert.equal(busy, 1, `${busy} hours is too patient for a site that keeps moving`);
});

test("a row that has never been checked is due", () => {
  // Otherwise a newly stored site would wait for a timestamp it does not have.
  assert.equal(isDue(null, 24), true);
  assert.equal(isDue("not a date", 24), true);
});

test("due-ness is measured against the interval the row carries", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

  assert.equal(isDue(hoursAgo(5), 6, now), false);
  assert.equal(isDue(hoursAgo(7), 6, now), true);
  // The same timestamp, a longer interval: a quiet site is left alone.
  assert.equal(isDue(hoursAgo(7), 24, now), false);
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

/* --- what a check does to the interval ---------------------------------- */

test("a check that could not tell leaves the interval alone", () => {
  // Treating "we could not read it" as "nothing changed" would widen the
  // interval of exactly the sites that are hardest to read, until they were
  // barely checked at all.
  for (const result of ["skipped", "baseline"]) {
    assert.equal(intervalAfter(24, { result, changed: false }), 24, result);
  }
});

test("a conclusive check moves the interval", () => {
  assert.equal(intervalAfter(24, { result: "changed", changed: true }), 12);
  assert.equal(intervalAfter(24, { result: "unchanged", changed: false }), 36);
  assert.equal(intervalAfter(24, { result: "unchanged-sitemap", changed: false }), 36);
});

test("a site just generated is not immediately due for a check", () => {
  // writeGeneration records the moment as the row's first check, because
  // generating a site is looking at it. Without that the next scheduled run
  // spends a check asking whether the site changed since we built it.
  const now = Date.parse("2026-09-10T12:00:00Z");

  assert.equal(isDue(new Date(now - 1_000).toISOString(), 24, now), false);
  // A row that genuinely has never been checked still is.
  assert.equal(isDue(null, 24, now), true);
});
