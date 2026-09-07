import { NextResponse } from "next/server";
import { launchBrowser } from "@/lib/browserRender";
import { isStoreConfigured } from "@/lib/store";

/**
 * Deployment diagnostics. Exists because the browser fallback fails *silently*
 * by design — launchBrowser() returns null so a host without a browser
 * degrades to fetch-only rather than failing every crawl. That is the right
 * runtime behaviour and a terrible deployment story: a broken browser looks
 * exactly like a site that never needed one, and the only symptom is quietly
 * worse output on JS-rendered sites.
 *
 * CI already proves Chromium launches inside the image. It cannot prove it
 * launches inside the *host's* sandbox, which is a different question —
 * seccomp policy, /dev/shm size and the memory ceiling all differ there. This
 * endpoint asks that question against the real deployment.
 */

export const maxDuration = 60;

export async function GET() {
  const browser = await launchBrowser();
  let browserOk = false;
  let browserError: string | null = null;

  if (browser) {
    try {
      // Launching is not enough: a browser that starts and then dies on the
      // first page is the failure mode a bare launch check misses.
      const page = await browser.newPage();
      await page.setContent("<h1>ok</h1>");
      browserOk = (await page.textContent("h1")) === "ok";
    } catch (err) {
      browserError = err instanceof Error ? err.message : String(err);
    } finally {
      await browser.close().catch(() => {});
    }
  } else {
    browserError = "launchBrowser() returned null; see logs for the reason";
  }

  return NextResponse.json({
    ok: true,
    browser: { available: browserOk, error: browserError },
    store: { configured: isStoreConfigured() },
    ai: { configured: Boolean(process.env.OPENROUTER_API_KEY) },
  });
}
