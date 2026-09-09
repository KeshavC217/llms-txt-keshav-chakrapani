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
  /** Whether presenting as a browser is likely to change the answer. */
  retryAsBrowser: boolean;
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

export function detectBlock(status: number, headers: Headers, body: string): Block | null {
  const sample = body.slice(0, 4000).toLowerCase();
  const challenged =
    headers.get("cf-mitigated") === "challenge" || CHALLENGE_MARKERS.some((marker) => sample.includes(marker));

  if (challenged) {
    return {
      kind: "bot-challenge",
      // Solving it needs a real browser to run the script and hold the cookie,
      // which is a different tool from a fetch, not a header away.
      detail: "The site answered with an anti-bot challenge rather than the page.",
      retryAsBrowser: false,
    };
  }

  if (status === 401 || (status === 403 && /sign in|log ?in|unauthorized/i.test(sample))) {
    return { kind: "login-required", detail: "The page is behind a sign-in.", retryAsBrowser: false };
  }

  if (status === 403) {
    return {
      kind: "forbidden",
      // No challenge to solve, so this is a filter on who is asking - which is
      // the one case where asking differently is worth a try.
      detail: "The site refused the request.",
      retryAsBrowser: true,
    };
  }

  if (status === 429) {
    return { kind: "rate-limited", detail: "The site is rate limiting requests.", retryAsBrowser: false };
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
      return `${host} is behind an anti-bot challenge, so it serves a verification page instead of its content. Running the challenge needs a real browser; set RENDER_ENDPOINT to use one.`;
    case "login-required":
      return `${host} keeps that page behind a sign-in, so there is nothing public to read.`;
    case "rate-limited":
      return `${host} is rate limiting us. Waiting a little and trying again usually works.`;
    case "forbidden":
      return `${host} refused the request even when asked as a browser would.`;
  }
}
