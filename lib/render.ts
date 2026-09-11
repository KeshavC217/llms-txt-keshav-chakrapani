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

import { classifyEmpty } from "./blocks.ts";
import type { Deadline } from "./deadline.ts";

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

/**
 * How long to wait for `load`, and how long is left for a second attempt.
 *
 * Twenty seconds was one number for both, and it was chosen against convex,
 * which renders in 4.6s. resy.com takes 10.1s on a laptop with a real Chrome;
 * a function runs a slower CPU and a cold Chromium launch on top of that, so
 * the site this exists for was the one closest to the edge of it.
 *
 * The fallback matters more than the number. A `load` that times out used to
 * throw the whole render away, and the measurement recorded above says
 * `domcontentloaded` on resy is 85 links - worse than the 222 a full load
 * gives, and vastly better than the nothing a timeout returns. So a timeout
 * now retries against the weaker condition rather than giving up.
 */
const NAVIGATION_TIMEOUT_MS = 25_000;
const FALLBACK_TIMEOUT_MS = 10_000;

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
  /** Which wait condition produced this, since one is weaker than the other. */
  waitedFor: "load" | "domcontentloaded";
}

/**
 * Why a render did not produce a better page.
 *
 * This exists because of one silence. resy.com renders on a laptop and not on
 * the deployment, and the project recorded that as an unexplained gap for a
 * fortnight - unexplained because every way of failing arrived as the same
 * `null`. A launch that never found Chromium, a navigation that ran out of
 * time, and an anti-bot service serving a challenge to a datacenter address
 * are three different problems with three different answers, and no amount of
 * staring at a null distinguishes them.
 */
export type RenderFailure =
  /** No browser to drive: no bundled Chromium, no Chrome on this machine. */
  | { reason: "no-browser" }
  /** Neither wait condition arrived in time. */
  | { reason: "timeout"; ms: number }
  /** The browser ran, and what came back was a verification page. */
  | { reason: "challenged"; detail: string }
  /** Something else threw; the message is kept because it is the only clue. */
  | { reason: "error"; detail: string };

export type RenderOutcome = ({ ok: true } & Rendered) | ({ ok: false } & RenderFailure);

/**
 * Returns the page as a browser sees it, or why it could not be had.
 *
 * A failure is reported rather than thrown: rendering is an improvement on the
 * plain fetch, and a caller that cannot have it carries on with what it
 * already has. What is new is that the caller can say which improvement it
 * did not get, which is the difference between "this site needs a browser we
 * do not have" and "this site refuses ours".
 */
export async function renderPage(url: string, deadline?: Deadline): Promise<RenderOutcome> {
  if (!renderConfigured()) return { ok: false, reason: "no-browser" };

  const started = Date.now();
  let browser: Browser | null = null;
  try {
    browser = await launch();
    if (!browser) return { ok: false, reason: "no-browser" };

    const page = await browser.newPage();

    /*
     * The clock the request is already keeping, if it is keeping one. A render
     * that runs past it is worse than no render: the steps after this one -
     * the crawl, the models - are what turn a page into a file, and spending
     * their budget here leaves a rendered page nobody had time to describe.
     */
    const cap = (want: number) => (deadline ? Math.min(want, Math.max(1_000, deadline.remaining() - 5_000)) : want);

    let waitedFor: Rendered["waitedFor"] = "load";
    try {
      await page.goto(url, { waitUntil: "load", timeout: cap(NAVIGATION_TIMEOUT_MS) });
    } catch {
      // `load` never arrived. resy.com holds connections open for analytics,
      // which is exactly the shape of site this is for, so ask for less rather
      // than for nothing.
      waitedFor = "domcontentloaded";
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: cap(FALLBACK_TIMEOUT_MS) });
      } catch {
        return { ok: false, reason: "timeout", ms: Date.now() - started };
      }
    }

    // The app has loaded; give it a moment to mount and put its links in.
    await page.waitForTimeout(Math.min(SETTLE_MS, cap(SETTLE_MS)));

    const html = await page.content();

    /*
     * A browser can be refused too, and it is refused differently: the page
     * arrives, with a challenge in it instead of the site. Checked here rather
     * than left to the caller because a challenge is not a thin render, and
     * telling them apart is the whole point of this function reporting at all.
     */
    const blocked = classifyEmpty(html);
    if (blocked) return { ok: false, reason: "challenged", detail: blocked.detail };

    return { ok: true, html, url: page.url(), waitedFor };
  } catch (error) {
    return { ok: false, reason: "error", detail: String(error).slice(0, 200) };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** One line for a log or a response: what happened, in the fewest words. */
export function describeRenderFailure(failure: RenderFailure): string {
  switch (failure.reason) {
    case "no-browser":
      return "no browser available to render with";
    case "timeout":
      return `the page did not finish loading within ${Math.round(failure.ms / 1000)}s`;
    case "challenged":
      return failure.detail;
    case "error":
      return failure.detail;
  }
}
