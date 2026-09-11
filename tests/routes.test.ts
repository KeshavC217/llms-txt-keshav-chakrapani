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
let writes: { url: string; llmsTxt: string; options: Record<string, unknown> }[] = [];

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
    writeGeneration: async (url: string, llmsTxt: string, options = {}) => {
      writes.push({ url, llmsTxt, options });
      return true;
    },
  },
});

const { POST: generate } = await import("../app/api/generate/route.ts");
const { GET: saved } = await import("../app/api/saved/route.ts");
const { POST: refresh } = await import("../app/api/refresh/route.ts");

const post = (url: string, body: unknown) =>
  new Request(`http://test/api${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/**
 * Reads the streamed shape /api/generate uses once it commits to real work:
 * one JSON object per line, the last one `{type:"result", ...}`. Tests read
 * the whole body rather than a live reader, since nothing here needs to watch
 * progress arrive - only that it did, and what the request ended with.
 */
async function readStream(response: Response): Promise<{ progress: Record<string, unknown>[]; result: Record<string, unknown> }> {
  const lines = (await response.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  const result = lines.find((line) => line.type === "result");
  assert.ok(result, "a stream that ends without a result line leaves the caller waiting forever");
  return { progress: lines.filter((line) => line.type === "progress"), result: result! };
}

const realFetch = globalThis.fetch;

/** Any request at all fails the test: these paths must not touch the network. */
function forbidNetwork() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`unexpected network request to ${String(input)}`);
  }) as typeof fetch;
}

/** Serves a fixed set of paths and 404s everything else. */
function serve(routes: Record<string, { body: string; type?: string }>) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);

    const match = routes[new URL(url).pathname];
    if (!match) return new Response("no", { status: 404 });

    return new Response(match.body, {
      status: 200,
      headers: { "content-type": match.type ?? "text/html; charset=utf-8" },
    });
  }) as typeof fetch;
  return seen;
}

beforeEach(() => {
  currentUser = null;
  savedRow = null;
  savedList = [];
  writes = [];
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
  };

  const response = await generate(post("/generate", { url: "example.com" }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.saved, true, "the interface has to be able to say this was not fresh");
  assert.equal(body.generatedAt, "2026-09-09T00:00:00.000Z");
  assert.match(body.llmsTxt, /A stored file/);
});

test("regenerate skips the stored file and goes to the site", async () => {
  // The bug this covers shipped once: 'Generate one anyway' returned the saved
  // copy, so the button did nothing and looked like it had worked.
  currentUser = { id: "u1" };
  savedRow = { url: "https://example.com/", llmsTxt: "# Stale\n", generatedAt: "2026-09-09T00:00:00.000Z" };

  const seen = serve({});
  const response = await generate(post("/generate", { url: "example.com", regenerate: true }));

  // regenerate commits to the real work, so the response is always the
  // streamed shape now - the HTTP status can only say the stream started.
  assert.equal(response.status, 200);
  assert.ok(seen.length > 0, "regenerate has to reach the network");

  const { result } = await readStream(response);
  assert.notEqual(result.llmsTxt, "# Stale\n", "the stored file must not be served");
});

test("a slow site is narrated, not left silent, while it is crawled", async () => {
  // The point of streaming at all: a caller waiting fifty seconds should see
  // why, not stare at a response that has not arrived yet.
  currentUser = { id: "u1" };
  const page = (title: string, links: string[] = []) =>
    `<html><head><title>${title}</title></head><body>${links.map((href) => `<a href="${href}">${href}</a>`).join("")}</body></html>`;

  serve({
    "/": { body: page("Acme", ["/docs/a", "/docs/b"]) },
    "/docs/a": { body: page("A") },
    "/docs/b": { body: page("B") },
    "/robots.txt": { body: "", type: "text/plain" },
  });

  const response = await generate(post("/generate", { url: "example.com" }));
  assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");

  const { progress, result } = await readStream(response);

  assert.ok(progress.some((event) => event.stage === "fetching"));
  assert.ok(progress.some((event) => event.stage === "crawling"), "the crawl has to say it is crawling");
  assert.equal(result.ok, true);
});

test("a site's own llms.txt is served and saved as theirs", async () => {
  currentUser = { id: "u1" };
  const published = "# Lago\n\n> A billing platform\n\n## Docs\n\n- [Guide](https://example.com/docs)\n";
  serve({
    "/": { body: "<html><head><title>Example</title></head><body><a href='/docs'>Docs</a></body></html>" },
    "/llms.txt": { body: published, type: "text/plain" },
  });

  const response = await generate(post("/generate", { url: "example.com" }));
  const { progress, result } = await readStream(response);

  assert.equal(response.status, 200);
  assert.equal(result.source, "published");
  assert.equal(result.publishedAt, "https://example.com/llms.txt");
  assert.equal(result.llmsTxt, published, "their file is served verbatim, not rewritten");
  assert.ok(progress.some((event) => event.stage === "checking-published"));

  // Saved, but labelled - so the list can say which files this project wrote,
  // and so the scheduled check re-reads theirs instead of crawling.
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.source, "published");
  assert.equal(writes[0].options.publishedAt, "https://example.com/llms.txt");
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

/*
 * The interface says how current a file is, and that is the last check rather
 * than the last rewrite - an unchanged site keeps its generatedAt while the
 * scheduled check keeps confirming it, so the two dates diverge by design and
 * only one of them answers "is this still right?".
 */
test("saved reports when the site was last checked, not only when it was written", async () => {
  savedRow = {
    url: "https://example.com/",
    llmsTxt: "# Example\n",
    generatedAt: "2026-08-01T00:00:00.000Z",
    lastCheckedAt: "2026-09-10T00:00:00.000Z",
    source: "generated",
  };

  const body = await (await saved(new Request("http://test/api/saved?url=example.com"))).json();
  assert.equal(body.lastCheckedAt, "2026-09-10T00:00:00.000Z");
  assert.equal(body.generatedAt, "2026-08-01T00:00:00.000Z");
});

test("generate's saved short circuit carries the last check too", async () => {
  currentUser = { id: "u1" };
  savedRow = {
    url: "https://example.com/",
    llmsTxt: "# Example\n",
    generatedAt: "2026-08-01T00:00:00.000Z",
    lastCheckedAt: "2026-09-10T00:00:00.000Z",
  };

  const body = await (await generate(post("/generate", { url: "example.com" }))).json();
  assert.equal(body.lastCheckedAt, "2026-09-10T00:00:00.000Z");
});

test("saved rejects a URL it cannot use", async () => {
  const response = await saved(new Request("http://test/api/saved?url=ftp://example.com"));
  assert.equal(response.status, 400);
});

/* --- POST /api/refresh -------------------------------------------------- */

const withToken = (token: string) =>
  new Request("http://test/api/refresh", { method: "POST", headers: { authorization: `Bearer ${token}` } });

test("refresh refuses everything without the right secret", async () => {
  assert.equal((await refresh(new Request("http://test/api/refresh", { method: "POST" }))).status, 401);

  // Same length as the real secret, so the comparison runs rather than being
  // short-circuited by the length check.
  const wrong = "x".repeat(process.env.CRON_SECRET!.length);
  assert.equal((await refresh(withToken(wrong))).status, 401);

  // Different lengths: timingSafeEqual throws on these, and the throw would
  // itself leak the length, so the guard has to answer 401 rather than 500.
  assert.equal((await refresh(withToken("short"))).status, 401);
  assert.equal((await refresh(withToken("x".repeat(200)))).status, 401);
});

test("refresh answers 503 when there is no store to monitor", async () => {
  delete process.env.SUPABASE_SECRET_KEY;

  const response = await refresh(withToken(process.env.CRON_SECRET!));
  assert.equal(response.status, 503);
});

test("refresh with nothing due does nothing and says so", async () => {
  const response = await refresh(withToken(process.env.CRON_SECRET!));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.checked, []);
  assert.equal(body.considered, 0);
});
