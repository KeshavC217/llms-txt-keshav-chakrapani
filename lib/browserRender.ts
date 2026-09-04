import { chromium, type Browser } from "playwright";
import * as cheerio from "cheerio";

const RENDER_TIMEOUT_MS = 15000;
const THIN_CONTENT_THRESHOLD = 200;
const USER_AGENT = "llms-txt-generator/0.1 (+https://llmstxt.org)";

function visibleTextLength(html: string): number {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  return $("body").text().replace(/\s+/g, " ").trim().length;
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
    return await page.content();
  } catch {
    return null;
  } finally {
    await context?.close().catch(() => {});
  }
}

export async function launchBrowser(): Promise<Browser | null> {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return null;
  }
}
