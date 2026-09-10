import { test } from "node:test";
import assert from "node:assert/strict";

import { hashContent, readGeneration, storeConfigured, writeGeneration } from "../lib/store.ts";

test("the content hash is stable and distinguishes files", () => {
  // What change detection will compare, so it has to be both.
  assert.equal(hashContent("# Acme\n"), hashContent("# Acme\n"));
  assert.notEqual(hashContent("# Acme\n"), hashContent("# Acme.\n"));
  assert.equal(hashContent("x").length, 32);
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
