/**
 * What the worker decides, without a database or a queue.
 *
 * `build()` is the part with the decisions in it: read the page, prefer the
 * site's own file if it publishes one, otherwise crawl and write one, and say
 * so plainly when the site refuses to be read. The queue around it is three
 * Supabase calls and is exercised against the real table instead.
 */
process.env.ALLOW_PRIVATE_CRAWL_TARGETS = "1";
// No key, so the model passes decline and the deterministic file is used. That
// is the same path a deployment without OPENROUTER_API_KEY takes.
delete process.env.OPENROUTER_API_KEY;

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { build } from "../scripts/worker.ts";

function site(pages: Record<string, { body: string; type?: string }>) {
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    const match = pages[path];
    if (!match) {
      response.writeHead(404).end("no");
      return;
    }
    response.writeHead(200, { "content-type": match.type ?? "text/html" }).end(match.body);
  });

  return new Promise<{ origin: string; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

const page = (title: string, links: string[] = []) =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1>${links
    .map((href) => `<a href="${href}">${href}</a>`)
    .join("")}</body></html>`;

test("a site that publishes its own llms.txt gets that back, untouched", async () => {
  const published = "# Acme\n\n> A billing platform\n\n## Docs\n\n- [Guide](https://acme.test/docs)\n";
  const server = await site({
    "/": { body: page("Acme", ["/docs"]) },
    "/docs": { body: page("Docs") },
    "/llms.txt": { body: published, type: "text/plain" },
  });

  try {
    const result = await build(`${server.origin}/`);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.source, "published");
    assert.equal(result.llmsTxt, published, "someone chose what belonged in it; we do not rewrite it");
    assert.match(result.publishedAt ?? "", /\/llms\.txt$/);
  } finally {
    server.close();
  }
});

test("a site without one is crawled, and the file describes what was found", async () => {
  const server = await site({
    "/": { body: page("Acme", ["/docs/guide", "/docs/api", "/pricing"]) },
    "/docs/guide": { body: page("Guide") },
    "/docs/api": { body: page("API reference") },
    "/pricing": { body: page("Pricing") },
    "/robots.txt": { body: "", type: "text/plain" },
  });

  try {
    const result = await build(`${server.origin}/`);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.source, "generated");
    assert.match(result.llmsTxt, /^# Acme/);
    assert.match(result.llmsTxt, /Guide/);
    assert.match(result.llmsTxt, /API reference/);
    // A complete crawl is fingerprinted; a truncated one deliberately is not.
    assert.equal(result.crawl?.partial, false);
    assert.ok(result.structureHash, "a complete crawl is what a later check compares against");
  } finally {
    server.close();
  }
});

test("a site that refuses to be read says why, rather than becoming a file about the refusal", async () => {
  // Before challenges were detected, this produced an llms.txt summarised as
  // "This website is using a security service to protect itself from online
  // attacks" - a confident file about Cloudflare.
  const server = await site({
    "/": {
      body: '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/x.js"></script></body></html>',
    },
  });

  try {
    const result = await build(`${server.origin}/`);
    assert.equal(result.ok, false);
    if (result.ok) return;

    assert.match(result.reason, /challenge/i);
  } finally {
    server.close();
  }
});

test("a response that is not HTML has nothing to read", async () => {
  const server = await site({ "/": { body: '{"not":"html"}', type: "application/json" } });

  try {
    const result = await build(`${server.origin}/`);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /not an HTML page/);
  } finally {
    server.close();
  }
});

after(() => {
  delete process.env.ALLOW_PRIVATE_CRAWL_TARGETS;
});
