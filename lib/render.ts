/**
 * Reading a page the way a browser would.
 *
 * Some sites deliver an empty shell and build themselves in the browser:
 * resy.com answers with 5KB and one anchor, docs.convex.dev with 3.7KB and
 * none. A single fetch sees nothing to describe, and a generated file for
 * either would truthfully say the site contains no pages.
 *
 * Neither embeds its state in the HTML - no __NEXT_DATA__, no __NUXT__, no
 * JSON-LD - so the only thing that reads them is something that runs their
 * JavaScript.
 *
 * This is the second attempt. The first was an HTTP hook for a Browserless-
 * style service, configured in no environment, so it never ran; it was deleted
 * as dead code. The lesson taken was the wrong one. What was wrong with it was
 * that it was never wired up, not that the problem was unreal.
 */
import type { Browser } from "playwright-core";

/**
 * How long to let a page build itself.
 *
 * `load` rather than `networkidle`. Waiting for the network to go quiet is the
 * obvious choice and it fails on exactly the sites this exists for: resy.com
 * holds connections open for analytics, so idle never arrives and the render
 * times out after thirty seconds having produced nothing. Measured on resy:
 * networkidle timed out, domcontentloaded gave 85 links, and load gave 222.
 */
const SETTLE_MS = 2_500;
const NAVIGATION_TIMEOUT_MS = 20_000;

/** Where Chrome is, which differs between a laptop and a serverless function. */
const LOCAL_CHROME = [
  process.env.CHROMIUM_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter((path): path is string => Boolean(path));

const onServerless = () => Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL);

/**
 * Rendering is off unless it can be done. Deliberately not an env var to set:
 * the last version was a switch nobody turned on, and a capability that has to
 * be remembered is one that is not there.
 */
export const renderConfigured = () => process.env.DISABLE_RENDER !== "1";

async function launch(): Promise<Browser | null> {
  const { chromium } = await import("playwright-core");

  if (onServerless()) {
    // The bundled build, which is the only Chrome a function has.
    const serverless = (await import("@sparticuz/chromium")).default;
    return chromium.launch({
      args: serverless.args,
      executablePath: await serverless.executablePath(),
      headless: true,
    });
  }

  for (const executablePath of LOCAL_CHROME) {
    try {
      return await chromium.launch({ executablePath, headless: true });
    } catch {
      // Try the next path; a laptop may have any of them or none.
    }
  }
  return null;
}

export interface Rendered {
  html: string;
  /** Where we ended up, which a client-side router may have changed. */
  url: string;
}

/**
 * Returns the page as a browser sees it, or null if it could not be rendered.
 *
 * Null rather than throwing: rendering is an improvement on the plain fetch,
 * and a caller that cannot have it should carry on with what it already has.
 */
export async function renderPage(url: string): Promise<Rendered | null> {
  if (!renderConfigured()) return null;

  let browser: Browser | null = null;
  try {
    browser = await launch();
    if (!browser) return null;

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    // The app has loaded; give it a moment to mount and put its links in.
    await page.waitForTimeout(SETTLE_MS);

    return { html: await page.content(), url: page.url() };
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
