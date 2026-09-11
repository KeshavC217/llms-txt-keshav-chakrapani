/**
 * The screenshots in the README, taken from the live deployment.
 *
 * Committed so they can be retaken rather than re-staged by hand: the UI moves,
 * and a screenshot nobody can reproduce is one nobody updates. Uses the Chrome
 * already on the machine through playwright-core, which the renderer depends on
 * anyway.
 *
 *   node scripts/screenshots.mjs                      # the live deployment
 *   SHOT_URL=http://localhost:3000 node scripts/...   # a local dev server
 *
 * Signed-in states are not here. They need credentials this script has no
 * business holding, so the two that only appear behind an account - the
 * progress bar mid-crawl and the prompt when a file already exists - are
 * captured by hand.
 */
import { chromium } from "playwright-core";

const SITE = process.env.SHOT_URL ?? "https://llms-txt-keshav-chakrapani.vercel.app";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
const CHROME = process.env.CHROMIUM_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const shot = async (name) => {
  // The page is short and the viewport is not; a full-viewport shot is mostly
  // empty paper. main is the content.
  await page.locator("main").screenshot({ path: `${OUT}/${name}.png` });
  console.log("wrote", name);
};

await page.goto(SITE, { waitUntil: "load" });
await page.waitForTimeout(1200);
await shot("01-generate");

await page.getByRole("tab", { name: /Catalog/ }).click();
await page.waitForTimeout(400);
await shot("02-catalog");

await page.getByLabel("Filter the catalog by address").fill("docs");
await page.waitForTimeout(400);
await shot("03-catalog-filtered");

await page.getByLabel("Filter the catalog by address").fill("");
await page.waitForTimeout(300);
await page.getByRole("button", { name: "docs.convex.dev" }).click();
await page.waitForTimeout(3000);
await shot("04-result");

await browser.close();
