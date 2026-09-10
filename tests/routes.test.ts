/**
 * The API routes, exercised as functions.
 *
 * Everything else in this directory tests library code, which left the routes
 * themselves - the auth gate, the two short circuits, the cron comparison -
 * checked only by hand against the deployment. These are unit tests: the
 * network and the store are stubbed, and what is being asserted is the
 * handler's own decisions rather than Supabase's behaviour or a site's.
 *
 * Env is set before the imports below because lib/supabase/config.ts reads it
 * at module load, so a value assigned inside a test would arrive too late.
 */
process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_stub";
process.env.SUPABASE_SECRET_KEY = "sb_secret_stub";
process.env.CRON_SECRET = "correct-horse-battery-staple";
// The SSRF guard resolves DNS, which a unit test must not do. Everything the
// stub serves is fictional anyway.
process.env.ALLOW_PRIVATE_CRAWL_TARGETS = "1";

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const lib = (name: string) => new URL(`../lib/${name}.ts`, import.meta.url).href;

/*
 * Two mutable stand-ins, so one mocked module can serve every test.
 *
 * A route binds its imports once, when it is first imported, and the module
 * registry then hands back that same instance. Re-mocking between tests would
 * therefore change nothing the route can see. Mocking once and letting the
 * tests move these variables is what makes each case independent.
 */
let currentUser: { id: string } | null = null;
let savedRow: Record<string, unknown> | null = null;
let savedList: Record<string, unknown>[] = [];
let queued: string[] = [];

mock.module(lib("supabase/server"), {
  namedExports: {
    getUser: async () => currentUser,
    createClient: async () => {
      throw new Error("a route under test must not open a Supabase client");
    },
  },
});

mock.module(lib("store"), {
  namedExports: {
    // Real, because lib/monitor.ts fingerprints with it and a stub that
    // returned a constant would make two different sites look identical.
    hashContent: (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32),
    storeConfigured: () => Boolean(process.env.SUPABASE_SECRET_KEY),
    readGeneration: async () => savedRow,
    listGenerations: async () => savedList,
    generationsToCheck: async () => [],
    recordCheck: async () => true,
    enqueue: async (url: string) => {
      queued.push(url);
      return true;
    },
  },
});

// The dispatch is an optimisation - a queued row is collected by the schedule
// either way - so it must never decide whether the request succeeds.
let dispatchWorks = true;
mock.module(lib("dispatch"), {
  namedExports: {
    dispatchConfigured: () => dispatchWorks,
    requestCrawl: async () => dispatchWorks,
  },
});

const { POST: generate } = await import("../app/api/generate/route.ts");
const { GET: saved } = await import("../app/api/saved/route.ts");

const post = (url: string, body: unknown) =>
  new Request(`http://test/api${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const realFetch = globalThis.fetch;

/** Any request at all fails the test: these paths must not touch the network. */
function forbidNetwork() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`unexpected network request to ${String(input)}`);
  }) as typeof fetch;
}

beforeEach(() => {
  currentUser = null;
  savedRow = null;
  savedList = [];
  queued = [];
  dispatchWorks = true;
  process.env.SUPABASE_SECRET_KEY = "sb_secret_stub";
  forbidNetwork();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* --- POST /api/generate ------------------------------------------------- */

test("generate rejects a body that is not JSON before doing anything else", async () => {
  const response = await generate(post("/generate", "{not json"));
  assert.equal(response.status, 400);
});

test("generate rejects a URL it cannot use", async () => {
  // Checked before the auth gate: the caller's mistake is cheaper to report
  // than a sign-in they do not need in order to be told the URL is wrong.
  for (const url of ["", "   ", "ftp://example.com", "not a url at all"]) {
    const response = await generate(post("/generate", { url }));
    assert.equal(response.status, 400, url);
  }
});

test("generate refuses a signed-out caller before touching the site", async () => {
  // The gate is checked before the fetch on purpose: refusing after fifteen
  // seconds on someone else's server would spend their bandwidth to tell us
  // nothing. forbidNetwork is what proves the order.
  currentUser = null;

  const response = await generate(post("/generate", { url: "example.com" }));
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Sign in/);
});

test("generate serves a stored file without crawling", async () => {
  currentUser = { id: "u1" };
  savedRow = {
    url: "https://example.com/",
    llmsTxt: "# Example\n\n> A stored file\n",
    generatedAt: "2026-09-09T00:00:00.000Z",
    source: "generated",
    status: "ready",
  };

  const response = await generate(post("/generate", { url: "example.com" }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.saved, true, "the interface has to be able to say this was not fresh");
  assert.equal(body.generatedAt, "2026-09-09T00:00:00.000Z");
  assert.match(body.llmsTxt, /A stored file/);
  assert.equal(queued.length, 0, "a file that already exists must not be rebuilt");
});

test("regenerate skips the stored file and queues a fresh crawl", async () => {
  // The bug this covers shipped once: "Generate one anyway" returned the saved
  // copy, so the button did nothing and looked like it had worked.
  currentUser = { id: "u1" };
  savedRow = {
    url: "https://example.com/",
    llmsTxt: "# Stale\n",
    generatedAt: "2026-09-09T00:00:00.000Z",
    status: "ready",
  };

  const body = await (await generate(post("/generate", { url: "example.com", regenerate: true }))).json();

  assert.equal(body.status, "queued");
  assert.deepEqual(queued, ["https://example.com/"]);
});

test("a site still being crawled is queued rather than served empty", async () => {
  // A row exists before its file does. Serving it as though it were an answer
  // would hand back an empty llms.txt and call it finished.
  currentUser = { id: "u1" };
  savedRow = { url: "https://example.com/", llmsTxt: "", generatedAt: "2026-09-09T00:00:00.000Z", status: "crawling" };

  const body = await (await generate(post("/generate", { url: "example.com" }))).json();
  assert.equal(body.status, "queued");
});

test("a failed dispatch does not fail the request", async () => {
  // The schedule collects the row either way, so a GitHub outage must not stop
  // someone asking for a site.
  currentUser = { id: "u1" };
  dispatchWorks = false;

  const response = await generate(post("/generate", { url: "example.com" }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "queued");
  assert.equal(body.dispatched, false, "but it says so, so a silent queue is visible");
  assert.deepEqual(queued, ["https://example.com/"]);
});

test("asking for a site never touches the site", async () => {
  // The whole point of the change: the request writes a row and returns. The
  // fetching, the crawl and the models happen in scripts/worker.ts, where
  // nothing is waiting on them. forbidNetwork is what proves it - any request
  // at all throws.
  currentUser = { id: "u1" };

  const response = await generate(post("/generate", { url: "example.com" }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "queued");
  assert.deepEqual(queued, ["https://example.com/"]);
});

/* --- GET /api/saved ----------------------------------------------------- */

test("saved lists what has been generated, to anyone", async () => {
  savedList = [{ url: "https://example.com/", generatedAt: "2026-09-09T00:00:00.000Z", source: "generated" }];

  const response = await saved(new Request("http://test/api/saved"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).saved.length, 1);
});

test("saved distinguishes an unconfigured store from an unknown site", async () => {
  // Not a nicety: this is the difference between "this deployment stores
  // nothing" and "nobody has asked about that site yet", and reading the two
  // apart is how an empty list gets diagnosed from outside.
  savedRow = null;
  const unknown = await saved(new Request("http://test/api/saved?url=example.com"));
  assert.equal(unknown.status, 404);

  delete process.env.SUPABASE_SECRET_KEY;
  const unconfigured = await saved(new Request("http://test/api/saved?url=example.com"));
  assert.equal(unconfigured.status, 200);
  assert.deepEqual(await unconfigured.json(), { saved: [] });
});

test("saved returns one file, with where it came from", async () => {
  savedRow = {
    url: "https://example.com/",
    llmsTxt: "# Example\n",
    generatedAt: "2026-09-09T00:00:00.000Z",
    source: "published",
    publishedAt: "https://example.com/llms.txt",
  };

  const body = await (await saved(new Request("http://test/api/saved?url=example.com"))).json();
  assert.equal(body.source, "published");
  assert.equal(body.publishedAt, "https://example.com/llms.txt");
  assert.equal(body.saved, true);
});

test("saved rejects a URL it cannot use", async () => {
  const response = await saved(new Request("http://test/api/saved?url=ftp://example.com"));
  assert.equal(response.status, 400);
});

