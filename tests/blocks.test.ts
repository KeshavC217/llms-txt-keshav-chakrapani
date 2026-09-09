import { test } from "node:test";
import assert from "node:assert/strict";

import { detectBlock, explain } from "../lib/blocks.ts";

const headers = (values: Record<string, string> = {}) => new Headers(values);

test("a Cloudflare challenge is recognised by its header", () => {
  // Exactly what openai.com returns: 403, cf-mitigated: challenge.
  const block = detectBlock(403, headers({ "cf-mitigated": "challenge", server: "cloudflare" }), "<html></html>");
  assert.equal(block?.kind, "bot-challenge");
  // Asking again as a browser returns the same challenge; only a browser that
  // can run it helps.
  assert.equal(block?.retryAsBrowser, false);
});

test("a challenge is recognised by its body when the header is absent", () => {
  // g2.com and medium.com send no cf-mitigated header, only the script.
  for (const body of [
    '<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></html>',
    "<html><title>Attention Required! | Cloudflare</title></html>",
    "<html><body>Just a moment...</body></html>",
    "<html><body>Enable JavaScript and cookies to continue</body></html>",
  ]) {
    assert.equal(detectBlock(403, headers(), body)?.kind, "bot-challenge", body.slice(0, 40));
  }
});

test("a plain refusal is worth retrying as a browser", () => {
  // zillow.com: 403 to our agent, 200 to a browser's, same page.
  const block = detectBlock(403, headers({ server: "CloudFront" }), "<html><body>Access Denied</body></html>");
  assert.equal(block?.kind, "forbidden");
  assert.equal(block?.retryAsBrowser, true);
});

test("a sign-in wall is not mistaken for a bot filter", () => {
  const block = detectBlock(403, headers(), "<html><body>Please sign in to continue</body></html>");
  assert.equal(block?.kind, "login-required");
  assert.equal(block?.retryAsBrowser, false);
});

test("rate limiting is its own answer", () => {
  assert.equal(detectBlock(429, headers(), "slow down")?.kind, "rate-limited");
});

test("an ordinary page is not a block", () => {
  assert.equal(detectBlock(200, headers({ server: "cloudflare" }), "<html><h1>Hello</h1></html>"), null);
  // 404 and 500 are the site failing, not the site refusing us.
  assert.equal(detectBlock(404, headers(), "<html>Not found</html>"), null);
  assert.equal(detectBlock(500, headers(), "<html>Server error</html>"), null);
});

test("the word 'challenge' in ordinary prose does not trip detection", () => {
  // The markers are script paths and verification copy, not the English word.
  assert.equal(detectBlock(200, headers(), "<p>The challenge of scaling teams</p>"), null);
});

test("each block explains itself in terms of what to do", () => {
  const challenge = detectBlock(403, headers({ "cf-mitigated": "challenge" }), "")!;
  assert.match(explain(challenge, "https://openai.com/"), /openai\.com/);
  assert.match(explain(challenge, "https://openai.com/"), /RENDER_ENDPOINT/);

  const limited = detectBlock(429, headers(), "")!;
  assert.match(explain(limited, "https://example.com/"), /rate limiting/i);
});
