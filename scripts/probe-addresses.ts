/**
 * Does crawling from a CI address meet more refusals than crawling from ours?
 *
 * .github/workflows/monitor.yml states that it does, and that is the load-
 * bearing assumption behind leaving the crawling on the deployment. It was
 * never measured. This runs the real fetcher over a fixed list and reports what
 * each site answered, so the same script can be run from a laptop and from a
 * runner and the two compared.
 *
 * Throwaway: delete with the workflow once the answer is recorded.
 */
import { fetchPage } from "../lib/fetchPage.ts";

const SITES = [
  // Ordinary sites the crawler is expected to handle.
  "vercel.com", "modal.com", "nytimes.com", "airbnb.com", "en.wikipedia.org", "news.ycombinator.com",
  // Known refusers, from the table in the README. These should fail either way;
  // what matters is whether anything in the first group joins them.
  "openai.com", "medium.com", "g2.com", "zillow.com",
];

let readable = 0;
for (const site of SITES) {
  try {
    const page = await fetchPage(`https://${site}`);
    const verdict = page.block ? `BLOCKED ${page.block.kind}` : `ok ${page.status} ${page.body.length}b`;
    if (!page.block) readable += 1;
    console.log(`${site.padEnd(24)} ${verdict}`);
  } catch (error) {
    console.log(`${site.padEnd(24)} THREW ${String(error).slice(0, 70)}`);
  }
}
console.log(`\n${readable}/${SITES.length} readable from this address.`);
