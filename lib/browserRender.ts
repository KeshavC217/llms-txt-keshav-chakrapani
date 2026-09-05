import { chromium, type Browser } from "playwright";
import * as cheerio from "cheerio";

const RENDER_TIMEOUT_MS = 15000;
const THIN_CONTENT_THRESHOLD = 200;
/**
 * How long to let the page settle after "load" before snapshotting it.
 * A JS app typically fetches its data on mount, so its content appears
 * strictly after load — capturing immediately returns the shell we already
 * had. Kept short and always caught, because many sites (analytics beacons,
 * chat widgets, polling) never reach networkidle at all.
 */
const SETTLE_TIMEOUT_MS = 3000;

/**
 * Elements frameworks mount into. An empty one is a client-rendered page
 * whose content simply is not in the HTML — a far more reliable signal than
 * counting characters, because a real app ships a nav and a footer around
 * that empty div and so never looks "thin".
 */
const APP_ROOT_SELECTOR = "#root, #app, #__next, #__nuxt, [data-reactroot], [ng-version], [data-server-rendered]";
const USER_AGENT = "llms-txt-generator/0.1 (+https://llmstxt.org)";

function visibleTextLength(html: string): number {
  return visibleTextLengthOf(cheerio.load(html));
}

function visibleTextLengthOf($: cheerio.CheerioAPI): number {
  const $body = $("body").clone();
  $body.find("script, style, noscript").remove();
  return $body.text().replace(/\s+/g, " ").trim().length;
}

/**
 * A page whose initial HTML has almost no visible text is usually a
 * client-rendered SPA shell (an empty <div id="root">, filled in by JS after
 * load) rather than a genuinely short page — plain `fetch()` only sees that
 * empty shell, so we treat it as a signal to retry with a real browser.
 */
export function isThinContent(html: string): boolean {
  return visibleTextLength(html) < THIN_CONTENT_THRESHOLD;
}

/** Whether the page mounts a framework root that the server left empty. */
function hasEmptyAppRoot($: cheerio.CheerioAPI): boolean {
  const roots = $(APP_ROOT_SELECTOR).toArray();
  if (roots.length === 0) return false;
  return roots.some((el) => $(el).text().replace(/\s+/g, "").length === 0);
}

/** Whether the page tells a non-JS visitor it needs JavaScript. */
function demandsJavaScript($: cheerio.CheerioAPI): boolean {
  return /enable\s+javascript|requires\s+javascript|doesn't work properly without javascript/i.test($("noscript").text());
}

/**
 * Whether a fetched page is worth re-fetching through a real browser.
 *
 * The original test was thin content alone, which only catches a page that is
 * *nothing but* an empty shell. Real JS apps are not like that: they ship a
 * nav, a footer and a cookie banner around an empty mount point, sail past
 * any character threshold, and get indexed with whatever generic <title> the
 * server sent and no description at all — silently wrong rather than visibly
 * broken. Checking for the empty mount point itself catches those.
 *
 * A false positive here costs one render, never a wrong result: whatever
 * comes back is still only adopted if isImprovedContent() says it recovered
 * more text than we already had.
 */
export type ClientRenderSignal = "strong" | "weak" | null;

/**
 * How strongly a fetched page suggests its content is only available after JS.
 *
 * The two signals are not equally trustworthy, and collapsing them into one
 * boolean made the caller unable to spend its render budget sensibly:
 *
 *   "strong" — an empty framework mount point, or a <noscript> demanding
 *   JavaScript. These are near-certain: the server shipped a container with
 *   nothing in it. Worth a render every time.
 *
 *   "weak" — the page is simply short. Often a genuine JS shell, but equally
 *   often a legitimately brief server-rendered page (a contact page, a stub),
 *   where rendering recovers nothing and costs seconds.
 */
export function clientRenderSignal(html: string): ClientRenderSignal {
  // One parse for all three checks — this runs on every crawled page.
  const $ = cheerio.load(html);
  if (hasEmptyAppRoot($) || demandsJavaScript($)) return "strong";
  if (visibleTextLengthOf($) < THIN_CONTENT_THRESHOLD) return "weak";
  return null;
}

/**
 * Whether a rendered page is worth using over the original. Deliberately a
 * relative comparison (more text than before) rather than re-applying the
 * same absolute THIN_CONTENT_THRESHOLD used to decide whether to attempt
 * rendering in the first place — a render that recovers real (if short)
 * content is still strictly better than an empty SPA shell, even if it
 * doesn't clear that bar on its own.
 */
export function isImprovedContent(renderedHtml: string, originalHtml: string): boolean {
  return visibleTextLength(renderedHtml) > visibleTextLength(originalHtml);
}

/**
 * Renders a page in a real (headless) browser and returns the resulting
 * HTML, for pages whose content only appears after client-side JS runs.
 * Returns null on any failure (timeout, crash, etc.) so callers can fall
 * back to the original thin HTML.
 */
export async function renderPage(browser: Browser, url: string): Promise<string | null> {
  let context;
  try {
    context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();
    // "load" rather than "networkidle": many sites (analytics beacons,
    // chat widgets, polling) never go fully idle, which would otherwise
    // time out the render even though the page itself finished loading.
    await page.goto(url, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    // Give data fetched on mount a chance to land. Deliberately best-effort:
    // "networkidle" is the right signal but plenty of sites never reach it,
    // so a short timeout that we swallow beats either waiting forever or not
    // waiting at all.
    await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    return await page.content();
  } catch {
    return null;
  } finally {
    await context?.close().catch(() => {});
  }
}

/**
 * Obtains a browser, from whichever provider this deployment has.
 *
 * Three ways to get one, chosen by environment rather than by code, so
 * changing hosts is configuration:
 *
 *   BROWSER_WS_ENDPOINT — connect to a remote browser over CDP (Browserless,
 *   Browserbase, or a browser container you run). Officially supported by
 *   Playwright and the only option on a host that cannot ship a binary.
 *
 *   PLAYWRIGHT_EXECUTABLE_PATH — launch a Chromium that lives somewhere other
 *   than Playwright's own cache, which is how serverless Chromium builds
 *   (@sparticuz/chromium and friends) are used.
 *
 *   Neither — launch Playwright's bundled Chromium. Local dev, and any
 *   container built on the official Playwright image.
 *
 * Returns null on any failure rather than throwing: rendering is a fallback,
 * and a deployment without a browser should degrade to fetch-only rather than
 * fail every crawl. The cost of that is silent, so the reason is logged.
 */
export async function launchBrowser(): Promise<Browser | null> {
  const wsEndpoint = process.env.BROWSER_WS_ENDPOINT;
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;

  try {
    if (wsEndpoint) return await chromium.connectOverCDP(wsEndpoint);
    return await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  } catch (err) {
    console.warn(
      `[browser] unavailable, falling back to fetch-only crawling: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}
