import { test } from "node:test";
import assert from "node:assert/strict";

import { hashContent, isFresh, readGeneration, storeConfigured, writeGeneration } from "../lib/store.ts";

test("the content hash is stable and distinguishes files", () => {
  // What change detection will compare, so it has to be both.
  assert.equal(hashContent("# Acme\n"), hashContent("# Acme\n"));
  assert.notEqual(hashContent("# Acme\n"), hashContent("# Acme.\n"));
  assert.equal(hashContent("x").length, 32);
});

test("freshness is judged against the stored timestamp", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const at = (hours: number) => new Date(now - hours * 3600_000).toISOString();

  assert.equal(isFresh(at(1), now), true);
  assert.equal(isFresh(at(23), now), true);
  assert.equal(isFresh(at(25), now), false);
});

test("a timestamp that cannot be read is not fresh", () => {
  // A row we cannot date is one we should not serve; regenerating is cheap
  // beside handing back something of unknown age.
  assert.equal(isFresh("not a date"), false);
  assert.equal(isFresh(""), false);
});

test("a clock skewed into the future does not count as fresh", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const future = new Date(now + 3600_000).toISOString();
  assert.equal(isFresh(future, now), false);
});

test("without configuration the store is inert rather than broken", async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SECRET_KEY;

  try {
    assert.equal(storeConfigured(), false);
    // Storage is an optimisation. Unconfigured, reads miss and writes decline,
    // and the endpoint carries on generating exactly as it did before.
    assert.equal(await readGeneration("https://example.com/"), null);
    assert.equal(await writeGeneration("https://example.com/", "# Example\n"), false);
  } finally {
    if (url) process.env.SUPABASE_URL = url;
    if (key) process.env.SUPABASE_SECRET_KEY = key;
  }
});
