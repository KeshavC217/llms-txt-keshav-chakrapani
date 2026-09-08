import { test } from "node:test";
import assert from "node:assert/strict";

import { ModelError, classify, isFatal, isRetryable, parseRetryAfter } from "../lib/ai/errors.ts";
import { openRouter } from "../lib/ai/openrouter.ts";
import { enhance } from "../lib/ai/enhance.ts";
import { extract } from "../lib/naiveExtractor.ts";
import { validateLlmsTxt } from "../lib/spec.ts";
import { DOCS_SITE } from "./fixtures.ts";

const URL_ = "https://corvid.dev/docs";
const extraction = () => extract(DOCS_SITE, URL_);

/** Stands in for the network, so a 429 or a 402 can be produced on demand. */
function stubFetch(responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (url: string) => {
    const next = responses[Math.min(calls.length, responses.length - 1)];
    calls.push(String(url));
    return new Response(next.body ?? JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }] }), {
      status: next.status,
      headers: next.headers,
    });
  }) as typeof fetch;

  return { calls, restore: () => void (globalThis.fetch = original) };
}

test("HTTP status maps to the failure it actually is", () => {
  assert.equal(classify(402), "credits");
  assert.equal(classify(429), "rate-limited");
  assert.equal(classify(401), "auth");
  assert.equal(classify(503), "upstream");
});

test("only the failures worth repeating are retried", () => {
  assert.ok(isRetryable("rate-limited"));
  assert.ok(isRetryable("upstream"));
  // Retrying a 402 spends the same failure twice; the deadline cannot be
  // waited out from inside itself; temperature 0 gives back the same bad JSON.
  assert.ok(!isRetryable("credits"));
  assert.ok(!isRetryable("timeout"));
  assert.ok(!isRetryable("unparseable"));
});

test("the account's own problems stop the run rather than repeating per chunk", () => {
  assert.ok(isFatal("credits"));
  assert.ok(isFatal("auth"));
  assert.ok(!isFatal("rate-limited"));
});

test("Retry-After is read as seconds or as a date, and capped", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("not a number"), undefined);
  // A provider asking for an hour would outlast the request several times over.
  assert.equal(parseRetryAfter("3600"), 30_000);

  const soon = parseRetryAfter(new Date(Date.now() + 3000).toUTCString());
  assert.ok(soon !== undefined && soon > 1000 && soon <= 4000);
});

test("a rate limit is retried, and the retry's success is returned", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const stub = stubFetch([
    { status: 429, body: JSON.stringify({ error: "slow down" }), headers: { "retry-after": "0" } },
    { status: 200 },
  ]);

  try {
    const reply = await openRouter(100)({ id: "m" }, [{ role: "user", content: "hi" }], new AbortController().signal);
    assert.equal(reply, '{"ok":1}');
    assert.equal(stub.calls.length, 2, "should have retried exactly once");
  } finally {
    stub.restore();
  }
});

test("an empty account is not retried at all", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const stub = stubFetch([{ status: 402, body: JSON.stringify({ error: "insufficient credits" }) }]);

  try {
    await assert.rejects(
      () => openRouter(100)({ id: "m" }, [{ role: "user", content: "hi" }], new AbortController().signal),
      (error: ModelError) => error.kind === "credits",
    );
    assert.equal(stub.calls.length, 1, "402 must not be retried");
  } finally {
    stub.restore();
  }
});

test("a persistent rate limit gives up after a bounded number of attempts", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const stub = stubFetch([{ status: 429, headers: { "retry-after": "0" } }]);

  try {
    await assert.rejects(
      () => openRouter(100)({ id: "m" }, [{ role: "user", content: "hi" }], new AbortController().signal),
      (error: ModelError) => error.kind === "rate-limited",
    );
    assert.equal(stub.calls.length, 3, "three attempts, then stop");
  } finally {
    stub.restore();
  }
});

test("an aborted deadline is not waited out from inside itself", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const controller = new AbortController();
  controller.abort();
  const stub = stubFetch([{ status: 200 }]);

  try {
    await assert.rejects(
      () => openRouter(100)({ id: "m" }, [{ role: "user", content: "hi" }], controller.signal),
      (error: ModelError) => error.kind === "timeout",
    );
    assert.equal(stub.calls.length, 0, "no call should be made after the deadline");
  } finally {
    stub.restore();
  }
});

test("an out-of-credits account is reported, not served as a thinner file", async () => {
  const credits = async () => {
    throw new ModelError("credits", "402: insufficient credits");
  };

  const result = await enhance(extraction(), URL_, { guide: credits, worker: credits });

  assert.equal(result.enhanced, false);
  assert.equal(result.fatal?.kind, "credits");
  // The deterministic file is still there for the route to fall back on.
  assert.deepEqual(validateLlmsTxt(result.llmsTxt), []);
});

test("a rate limit is counted by kind, and is not fatal", async () => {
  const limited = async () => {
    throw new ModelError("rate-limited", "429: at capacity");
  };

  const result = await enhance(extraction(), URL_, { guide: async () => "{}", worker: limited });

  assert.equal(result.fatal, undefined);
  assert.ok((result.report.failures?.["rate-limited"] ?? 0) > 0);
  assert.deepEqual(validateLlmsTxt(result.llmsTxt), []);
});

test("a fatal worker failure stops the remaining chunks", async () => {
  let calls = 0;
  const credits = async () => {
    calls += 1;
    throw new ModelError("credits", "402: insufficient credits");
  };

  const result = await enhance(extraction(), URL_, { guide: async () => "{}", worker: credits });

  assert.equal(result.fatal?.kind, "credits");
  // Four workers may already be in flight when the first 402 lands; what must
  // not happen is every chunk being tried after the answer is known.
  assert.ok(calls <= 4, `stopped after ${calls} calls`);
});
