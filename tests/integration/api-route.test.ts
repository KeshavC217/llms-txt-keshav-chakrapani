/**
 * Integration test for the HTTP surface: the actual route handler, invoked
 * with a real Request, against the real fixture site.
 *
 * Covers the contract the browser UI depends on (shape of the JSON, status
 * codes for bad input) plus the guard that a caller can't turn this endpoint
 * into an SSRF proxy for internal addresses.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateLlmsTxt, formatIssues } from "../../lib/validate";
import { startFixtureServer, type FixtureServer } from "../helpers/fixtureServer";

let server: FixtureServer;

// Imported after the env flag is set, so the module-level guard sees it.
process.env.ALLOW_PRIVATE_CRAWL_TARGETS = "1";
const { POST } = await import("../../app/api/generate/route");

function post(body: unknown, init: RequestInit = {}): Request {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

beforeAll(async () => {
  server = await startFixtureServer();
}, 30_000);

afterAll(async () => {
  await server?.close();
});

describe("POST /api/generate", () => {
  it("returns a spec-valid llms.txt and a page count", async () => {
    const res = await POST(post({ url: server.url }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.pageCount).toBeGreaterThan(1);
    expect(data.aiApplied).toBe(false);

    const issues = validateLlmsTxt(data.llmsTxt);
    expect(issues, `llms.txt failed validation:\n${formatIssues(issues)}`).toEqual([]);
  }, 60_000);

  it("accepts a bare hostname without a scheme", async () => {
    const res = await POST(post({ url: server.url.replace(/^https?:\/\//, "http://") }));
    expect(res.status).toBe(200);
  }, 60_000);

  it("rejects a malformed body with 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/generate", { method: "POST", body: "not json" })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it("rejects an empty or invalid URL with 400", async () => {
    for (const url of ["", "   ", "ftp://example.com/x", "http://"]) {
      const res = await POST(post({ url }));
      expect(res.status, `expected 400 for ${JSON.stringify(url)}`).toBe(400);
    }
  });

  it("refuses to crawl private/internal addresses", async () => {
    const original = process.env.ALLOW_PRIVATE_CRAWL_TARGETS;
    delete process.env.ALLOW_PRIVATE_CRAWL_TARGETS;
    try {
      for (const url of ["http://localhost:6379", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/"]) {
        const res = await POST(post({ url }));
        expect(res.status, `expected 400 for ${url}`).toBe(400);
        expect((await res.json()).error).toMatch(/publicly reachable/i);
      }
    } finally {
      process.env.ALLOW_PRIVATE_CRAWL_TARGETS = original;
    }
  });

  it("returns 502 when the target site is unreachable", async () => {
    const res = await POST(post({ url: "http://127.0.0.1:1/" }));
    expect(res.status).toBe(502);
  }, 30_000);
});
