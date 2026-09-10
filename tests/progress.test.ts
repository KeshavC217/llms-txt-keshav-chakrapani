import { test } from "node:test";
import assert from "node:assert/strict";

import { describeProgress } from "../lib/progress.ts";

test("percent only ever grows within a stage as the count rises", () => {
  const at = (fetched: number) => describeProgress({ stage: "crawling", fetched, planned: 10 }).percent;

  assert.ok(at(0) < at(5));
  assert.ok(at(5) < at(10));
  assert.equal(at(10), at(20), "the fraction is clamped, not allowed past its own stage's ceiling");
});

test("a stage with no internal count still moves the bar while it runs", () => {
  // A caller watching "Fetching the page" for a stretch with no percentage
  // moving at all would look stuck, so a countless stage still advances.
  const { percent, label } = describeProgress({ stage: "fetching" });
  assert.ok(percent > 0);
  assert.equal(label, "Fetching the page");
});

test("crawling and annotating name the counts, other stages just their label", () => {
  assert.equal(describeProgress({ stage: "crawling", fetched: 3, planned: 50 }).label, "Crawling the site - 3 of 50 pages");
  assert.equal(
    describeProgress({ stage: "annotating", completed: 2, total: 8 }).label,
    "Writing a note for each link - 2 of 8 groups",
  );
  assert.equal(describeProgress({ stage: "saving" }).label, "Saving the result");
});

test("a stage whose count has not arrived yet does not divide by zero", () => {
  // crawl.ts fires one event at 0 of 0 before robots.txt and the sitemap have
  // even been fetched, since discovery itself can take a couple of seconds.
  const { percent, label } = describeProgress({ stage: "crawling", fetched: 0, planned: 0 });
  assert.equal(Number.isFinite(percent), true);
  assert.equal(label, "Crawling the site");
});

test("later stages always read higher than earlier ones", () => {
  // The property the whole bar depends on: it must never visibly go backwards,
  // whichever stages a given site happens to need.
  const order = [
    { stage: "fetching" as const },
    { stage: "checking-published" as const },
    { stage: "crawling" as const, fetched: 50, planned: 50 },
    { stage: "summarizing" as const },
    { stage: "annotating" as const, completed: 8, total: 8 },
    { stage: "saving" as const },
  ];

  const percents = order.map((event) => describeProgress(event).percent);
  for (let i = 1; i < percents.length; i += 1) {
    assert.ok(percents[i] > percents[i - 1], `${order[i].stage} (${percents[i]}) did not exceed ${order[i - 1].stage} (${percents[i - 1]})`);
  }

  // "saving" is itself a countless stage, so even fully underway it reads as
  // half its own band rather than 100 - the caller snaps to 100 on the result
  // line, which is the actual end of the request and needs no count of its
  // own to know it arrived.
  assert.ok(percents.at(-1)! < 100 && percents.at(-1)! > 90);
});
