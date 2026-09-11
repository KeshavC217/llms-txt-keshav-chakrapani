import { test } from "node:test";
import assert from "node:assert/strict";

import { displayUrl, matchesAddress } from "../lib/catalog.ts";

test("an address is shown the way a person would say it", () => {
  assert.equal(displayUrl("https://docs.convex.dev/"), "docs.convex.dev");
  assert.equal(displayUrl("http://x.com/docs/guide"), "x.com/docs/guide");
});

test("a filter matches what is on the screen, not what is in the database", () => {
  // Nobody types the scheme, and the stored form is the only place it appears.
  assert.ok(matchesAddress("https://docs.convex.dev/", "docs.c"));
  assert.ok(matchesAddress("https://docs.convex.dev/", "CONVEX"));
  assert.ok(!matchesAddress("https://docs.convex.dev/", "https"));
});

test("terms match in any order, since a filter is not a phrase", () => {
  assert.ok(matchesAddress("https://docs.convex.dev/", "convex docs"));
  assert.ok(matchesAddress("https://docs.convex.dev/", "docs convex"));
  assert.ok(!matchesAddress("https://docs.convex.dev/", "docs stripe"));
});

test("an empty filter is not a filter", () => {
  for (const query of ["", "   "]) {
    assert.ok(matchesAddress("https://x.com/", query), JSON.stringify(query));
  }
});
