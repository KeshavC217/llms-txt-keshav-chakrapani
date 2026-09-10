/**
 * Telling "the site refused us" apart from "the site has nothing there".
 *
 * Both used to arrive as an error or an empty file, and they call for opposite
 * responses: a refusal might be worked around, an empty page cannot. The
 * markers below are taken from what these services actually send, captured
 * from live responses rather than assumed:
 *
 *   openai.com   403  cf-mitigated: challenge   9.9KB  _cf_chl, challenge-platform
 *   g2.com       403  server: cloudflare        1.7KB  challenge-platform
 *   medium.com   403  server: cloudflare        5.0KB  Attention Required
 *   zillow.com   403  server: CloudFront               refuses our agent, serves a browser
 */

export type BlockKind =
  /** An interactive challenge. The page is a puzzle, not the site. */
  | "bot-challenge"
  /** Refused outright, with no challenge to solve. */
  | "forbidden"
  /** Too many requests, from us or from this address generally. */
  | "rate-limited"
  /** The content is behind a sign-in. */
  | "login-required";

export interface Block {
  kind: BlockKind;
  /** What to tell the person who typed the URL. */
  detail: string;
}

/** Body text a challenge page carries and an ordinary page does not. */
const CHALLENGE_MARKERS = [
  "challenge-platform",
  "_cf_chl",
  "cf-browser-verification",
  "just a moment",
  "attention required",
  "enable javascript and cookies",
  "checking your browser",
  "px-captcha",
  "/_incapsula_",
  "captcha-delivery",
];

/** Statuses that mean the site declined to serve the page. */
const REFUSED = new Set([401, 403, 429, 503]);

export function detectBlock(status: number, headers: Headers, body: string): Block | null {
  const sample = body.slice(0, 4000).toLowerCase();

  /*
   * Body markers only count when the status says we were refused.
   *
   * Cloudflare leaves its scripts in the pages it protects, so a perfectly good
   * response carries them too: crunchbase.com answers 200 with 128KB of real
   * content and the challenge-platform script in it, and ticketmaster.com
   * answers 200 with the words "Just a Moment" somewhere in half a megabyte of
   * page. Trusting the body alone fails both of those sites, which work.
   */
  const challenged =
    headers.get("cf-mitigated") === "challenge" ||
    (REFUSED.has(status) && CHALLENGE_MARKERS.some((marker) => sample.includes(marker)));

  if (challenged) {
    return {
      kind: "bot-challenge",
      // Solving it needs a real browser to run the script and hold the cookie,
      // which is a different tool from a fetch, not a header away.
      detail: "The site answered with an anti-bot challenge rather than the page.",
    };
  }

  if (status === 401 || (status === 403 && /sign in|log ?in|unauthorized/i.test(sample))) {
    return { kind: "login-required", detail: "The page is behind a sign-in." };
  }

  if (status === 403) {
    return { kind: "forbidden", detail: "The site refused the request." };
  }

  if (status === 429) {
    return { kind: "rate-limited", detail: "The site is rate limiting requests." };
  }

  return null;
}

/**
 * A second look, once extraction has found nothing.
 *
 * Status is not enough in either direction. crunchbase.com answers 200 with a
 * real page and Cloudflare's scripts in it, so markers alone cry wolf; but
 * nature.com answers 200 with a page titled "Client Challenge" and no content
 * at all, so status alone misses a refusal that is plainly a refusal. What
 * separates them is whether anything was actually delivered: a challenge has
 * the markers AND nothing to read.
 *
 * Called only when the extractor found no links, so it cannot misjudge a page
 * that worked.
 */
export function classifyEmpty(body: string): Block | null {
  const sample = body.slice(0, 4000).toLowerCase();

  if (CHALLENGE_MARKERS.some((marker) => sample.includes(marker)) || /client challenge|are you a robot/i.test(sample)) {
    return {
      kind: "bot-challenge",
      detail: "The site answered with a verification page instead of the page.",
    };
  }
  return null;
}

/** What the person who typed the URL should be told, and what they can do. */
export function explain(block: Block, url: string): string {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "that site";
    }
  })();

  switch (block.kind) {
    case "bot-challenge":
      return `${host} is behind an anti-bot challenge, so it serves a verification page instead of its content. A site that went to that trouble cannot be read by a program, and the challenge page is not something to describe as if it were the site.`;
    case "login-required":
      return `${host} keeps that page behind a sign-in, so there is nothing public to read.`;
    case "rate-limited":
      return `${host} is rate limiting us. Waiting a little and trying again usually works.`;
    case "forbidden":
      return `${host} refused the request even when asked as a browser would.`;
  }
}
