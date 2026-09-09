/**
 * Getting the HTML a browser would see, when a fetch is not enough.
 *
 * Two situations need this, and they are not the same:
 *
 *   1. A page whose content is assembled by JavaScript. docs.convex.dev answers
 *      200 with a 4KB shell and one anchor. Nothing is refusing us; there is
 *      simply nothing in the response yet. A browser fixes this completely.
 *
 *   2. An anti-bot challenge. openai.com, g2.com, medium.com and indeed.com all
 *      answer 403 with a script that must run before the real page is served. A
 *      browser is necessary here but often not sufficient: these services also
 *      fingerprint the TLS handshake and look for the marks of automation, and
 *      a plain headless Chrome is recognisable on both counts.
 *
 * Why a remote browser rather than Playwright in the bundle: this deploys to
 * Vercel functions, where Chromium does not comfortably fit, and a browser is
 * needed on a small fraction of requests. So the browser lives behind an HTTP
 * endpoint - Browserless, Browserbase, or anything speaking the same shape -
 * and this file is a fetch call. No dependency, no cold-start penalty on the
 * requests that do not need it, and swapping the provider is an env var.
 *
 * Unset RENDER_ENDPOINT and everything below is inert: rendering is skipped and
 * the caller keeps the plain response.
 */

const RENDER_TIMEOUT_MS = 25_000;

export const renderConfigured = () => Boolean(process.env.RENDER_ENDPOINT);

export interface RenderResult {
  html: string;
  ms: number;
}

/**
 * Asks the configured browser service for the page as rendered.
 *
 * The shape is Browserless's /content: POST {url} and get HTML back. Services
 * that differ can be adapted with a token in RENDER_ENDPOINT; nothing here
 * depends on a particular vendor.
 */
export async function renderPage(url: string): Promise<RenderResult | null> {
  const endpoint = process.env.RENDER_ENDPOINT;
  if (!endpoint) return null;

  const started = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.RENDER_TOKEN ? { Authorization: `Bearer ${process.env.RENDER_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        url,
        // Wait for the page to settle rather than for load: the content we came
        // for is what arrives after the framework has run.
        gotoOptions: { waitUntil: "networkidle2", timeout: RENDER_TIMEOUT_MS },
      }),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const html = await response.text();
    // Whether this helped is not a question of size, and the caller is the one
    // who can answer it: it compares what the rendered HTML extracts to what it
    // already had. An empty body is the only thing rejected here.
    return html.trim() ? { html, ms: Date.now() - started } : null;
  } catch {
    // A rendering service being down is not a reason to fail the request: the
    // plain response is still there, and is what this falls back to.
    return null;
  }
}
