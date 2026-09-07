/**
 * Integration test for the AI pass against a fake OpenRouter that reproduces
 * how real providers actually misbehave (see tests/helpers/fakeOpenRouter.ts).
 *
 * This is the layer that was missing. The unit tests mock the whole openrouter
 * module, so they never see a request body or a provider response; the other
 * integration tests are offline by design. The result was that a broken AI
 * pass — every request truncating, both attempts landing on the same bad
 * provider, the route silently serving the un-copyedited document — produced a
 * green test suite and a plausible-looking output file. Nothing distinguished
 * "the model declined to change anything" from "the model never answered".
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpenRouter, type FakeOpenRouter } from "../helpers/fakeOpenRouter";
import { startFixtureServer, type FixtureServer } from "../helpers/fixtureServer";

process.env.ALLOW_PRIVATE_CRAWL_TARGETS = "1";
process.env.OPENROUTER_API_KEY = "test-key";
// This suite exercises the AI pass, not crawl politeness — pacing every
// fixture request would just make it slow. tests/integration/pipeline.test.ts
// asserts the real interval.
process.env.CRAWL_MIN_REQUEST_INTERVAL_MS = "0";
// The route answers from the stored snapshot when one is recent enough, which
// makes this file poison itself: the first generate() persists a snapshot, and
// every later case is served from it without ever reaching the fake provider —
// so the request-shape assertions see zero requests and aiStatus reports
// whatever the *cached* run did. It only bites when a developer has Supabase
// configured, so CI (which has no SUPABASE_URL) stayed green while `npm test`
// failed 9 cases on the machine of anyone who followed the README. Each case
// here is meant to be a fresh crawl, so the cache is off for the whole file.
process.env.GENERATE_CACHE_MAX_AGE_MS = "0";

let fake: FakeOpenRouter;
let site: FixtureServer;

beforeAll(async () => {
  fake = await startFakeOpenRouter();
  process.env.OPENROUTER_BASE_URL = fake.url;
  site = await startFixtureServer();
}, 30_000);

afterAll(async () => {
  await fake?.close();
  await site?.close();
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => fake.setScenario("ok"));

async function generate(useAi = true) {
  const { POST } = await import("../../app/api/generate/route");
  const res = await POST(
    new Request("http://localhost/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: site.url, useAi }),
    })
  );
  return { status: res.status, ...(await res.json()) };
}

describe("outbound request shape", () => {
  it("fans the document out into parallel calls instead of one oversized one", { timeout: 30_000 }, async () => {
    // A single call for a 90-page site emitted ~5,200 completion tokens, 65%
    // of the cap, and overflowing that cap silently discarded the whole pass.
    // Chunking is what keeps each call's output small enough that it can't.
    await generate();
    const prompts = fake.requests.map((r) => r.messages[0].content);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.filter((p) => p.includes("copyediting the header")), "exactly one document-level call").toHaveLength(1);
    expect(prompts.filter((p) => p.includes("copyediting ONE section")).length).toBeGreaterThan(0);
  });

  it("gives every chunk the document context but only its own pages to edit", async () => {
    await generate();
    const chunks = fake.requests.map((r) => r.messages[0].content).filter((p) => p.includes("copyediting ONE section"));
    for (const prompt of chunks) {
      expect(prompt, "chunk workers need the whole-site digest for context").toContain("Sections in this document");
    }
    // Each chunk lists a strict subset of pages — no worker sees them all.
    const listed = chunks.map((p) => (p.match(/^  - url: /gm) ?? []).length);
    expect(Math.max(...listed)).toBeLessThanOrEqual(12);
  });

  it("never sends response_format", async () => {
    // Regression guard for the bug that made the AI pass a silent no-op:
    // DeepInfra rejects this parameter with HTTP 405 for our model, and
    // Cerebras honors it by emitting the object escaped inside a string,
    // which never terminates and exhausts max_tokens.
    await generate();
    expect(fake.requests[0]).not.toHaveProperty("response_format");
  });

  it("asks for the fastest provider and caps output length", async () => {
    await generate();
    expect(fake.requests[0].provider?.sort).toBe("throughput");
    expect(fake.requests[0]).toHaveProperty("max_tokens");
  });
});

describe("provider misbehavior", () => {
  // Each is a failure mode observed against the live API, not a hypothetical:
  //   escapedJson  - the object escaped inside a string, cut off at the cap
  //   truncated    - a half-written object
  //   emptyContent - empty content after billing 8001 completion tokens
  it.each(["escapedJson", "truncated", "emptyContent"] as const)(
    "retries on a different provider when one returns %s",
    async (scenario) => {
      fake.failFirstAttemptPerPrompt(scenario);
      const result = await generate();

      expect(result.aiStatus, "a recoverable provider failure should still end applied").toBe("applied");

      const attempts = fake.attemptsByPrompt();
      expect(attempts.length, "expected the fan-out to issue several calls").toBeGreaterThan(1);
      for (const perPrompt of attempts) {
        expect(perPrompt, "each failed call should be retried exactly once").toHaveLength(2);
        expect(perPrompt[0].provider?.ignore).toBeUndefined();
        // The crux: throughput sorting is deterministic, so a retry that
        // doesn't exclude the failed provider lands on it again and fails
        // identically.
        expect(perPrompt[1].provider?.ignore).toEqual([`provider-${scenario}`]);
      }
    }
  );

  it("reports failure rather than silently serving the un-copyedited document", async () => {
    fake.setScenario("truncated");
    const result = await generate();

    expect(result.aiStatus).toBe("failed");
    expect(result.aiApplied).toBe(false);
    // Still a usable document — the deterministic output, not an error.
    expect(result.status).toBe(200);
    expect(result.llmsTxt).toMatch(/^# /);
  });

  it("does not burn a retry when the model replies in prose", async () => {
    fake.setScenario("prose");
    const result = await generate();
    expect(result.aiStatus).toBe("failed");
    for (const perPrompt of fake.attemptsByPrompt()) {
      expect(perPrompt, "a model that won't emit JSON won't emit it on retry either").toHaveLength(1);
    }
  });

  it("retries a 429 and succeeds", async () => {
    fake.failFirstAttemptPerPrompt("rateLimited");
    expect((await generate()).aiStatus).toBe("applied");
    for (const perPrompt of fake.attemptsByPrompt()) expect(perPrompt).toHaveLength(2);
  });

  it("gives up on a hard 4xx without retrying", async () => {
    fake.setScenario("unsupported");
    expect((await generate()).aiStatus).toBe("failed");
    for (const perPrompt of fake.attemptsByPrompt()) expect(perPrompt).toHaveLength(1);
  });

  it("keeps the rest of the document when only some chunks fail", async () => {
    // Partial failure is the other reason to fan out: one bad provider
    // response now costs one section's wording, not the whole pass.
    let seen = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("chat/completions") && seen++ % 2 === 1) {
        return new Response(JSON.stringify({ provider: "p", choices: [{ finish_reason: "stop", message: { content: "not json" } }] }), { status: 200 });
      }
      return realFetch(url, init);
    }) as typeof globalThis.fetch;

    try {
      const result = await generate();
      expect(result.aiStatus, "partial success is still success").toBe("applied");
      expect(result.llmsTxt).toMatch(/^# /);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("request budget", () => {
  it("keeps the whole request inside one budget rather than two independent timeouts", async () => {
    // The crawl and the copyedit once held separate 60s and 65s timeouts, so
    // a slow site could reach 125s against what was then a 60s platform
    // ceiling — an opaque 504 with no body, losing both the error message and
    // the deterministic document we were already holding. They now share one
    // budget, which must sit inside the declared maxDuration.
    const { maxDuration } = await import("../../app/api/generate/route");
    // 300s is the platform ceiling on Vercel's cheapest plan; declaring more
    // than the plan allows fails at deploy time, not at request time.
    expect(maxDuration).toBeLessThanOrEqual(300);

    const started = Date.now();
    await generate();
    expect(Date.now() - started).toBeLessThan(maxDuration * 1000);
  }, 70_000);
});

describe("aiStatus contract the UI depends on", () => {
  it("distinguishes every outcome so none of them look alike", async () => {
    expect((await generate(false)).aiStatus).toBe("off");

    fake.setScenario("ok");
    expect((await generate()).aiStatus).toBe("applied");

    fake.setScenario("truncated");
    expect((await generate()).aiStatus).toBe("failed");

    delete process.env.OPENROUTER_API_KEY;
    expect((await generate()).aiStatus).toBe("unavailable");
    process.env.OPENROUTER_API_KEY = "test-key";
  }, 30_000);
});
