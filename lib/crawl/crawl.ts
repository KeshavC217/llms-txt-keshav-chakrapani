/**
 * The crawl: discovery, budgets, and the decision to stop.
 *
 * Four things end a crawl, whichever comes first. Three are ours - a page
 * ceiling from the requested effort, a time budget so a slow site cannot run
 * out the function, and diminishing returns when new pages stop telling us
 * anything new. The fourth belongs to the site: the pacer widens on every
 * refusal or slowdown, and when it reaches its ceiling the crawl ends there.
 */

import { readPage, type PageMeta } from "../pageMeta.ts";
import { Frontier } from "./frontier.ts";
import { Pacer } from "./pacer.ts";
import { fetchRobots, isAllowed, type Robots } from "./robots.ts";
import { fetchSitemap, sitemapCandidates } from "./sitemap.ts";

/**
 * One ceiling for every crawl.
 *
 * An effort level was tried and dropped: it made the same URL produce different
 * files, so the stored answer for a site depended on which effort happened to
 * ask first. Choosing between them would have meant an option in the cache key,
 * a control in the UI and an explanation for both. Fifty pages takes six to
 * nine seconds on the sites measured, and the adaptive stops below end most
 * crawls before it anyway.
 */
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES ?? 50);

const TIME_BUDGET_MS = Number(process.env.CRAWL_TIME_BUDGET_MS ?? 20_000);
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY ?? 4);
const PAGE_TIMEOUT_MS = 12_000;

/**
 * How many consecutive pages may add nothing before the crawl is done.
 *
 * Judged on the first two path segments rather than the first: with one, every
 * page under /docs looks like the same discovery and a documentation site stops
 * being crawled after a dozen pages.
 */
const STALE_LIMIT = 20;

export interface CrawlResult {
  pages: PageMeta[];
  /** Why it ended, reported rather than inferred. */
  stoppedBy: "pages" | "time" | "exhausted-frontier" | "diminishing-returns" | "site-pushback";
  fetched: number;
  robotsDisallowed: number;
  fromSitemap: number;
}

export interface CrawlOptions {
  userAgent: string;
  include?: string[];
  exclude?: string[];
  /** The page already fetched by the caller, so it is not fetched twice. */
  seed: { url: string; html: string };
  brand?: string;
}

export async function crawl(origin: string, options: CrawlOptions): Promise<CrawlResult> {
  const started = Date.now();
  const maxPages = MAX_PAGES;

  const robots: Robots = await fetchRobots(origin, options.userAgent);
  const pacer = new Pacer(robots.crawlDelayMs);

  let robotsDisallowed = 0;
  const frontier = new Frontier({
    origin,
    include: options.include,
    exclude: options.exclude,
    isAllowed: (pathname) => {
      const allowed = isAllowed(robots, pathname);
      if (!allowed) robotsDisallowed += 1;
      return allowed;
    },
  });

  // The page the caller already has, read rather than re-fetched.
  const seed = readPage(options.seed.html, options.seed.url, options.brand);
  const pages: PageMeta[] = [seed];
  frontier.add(options.seed.url, origin, 0);

  // Sitemap first: it finds what nothing links to, which is most of a site.
  let fromSitemap = 0;
  for (const candidate of sitemapCandidates(origin, robots.sitemaps)) {
    const entries = await fetchSitemap(candidate, options.userAgent);
    for (const entry of entries) {
      if (frontier.add(entry.url, origin, 1)) fromSitemap += 1;
    }
    if (fromSitemap > 0) break;
  }

  // Then whatever the seed page links to, which is how a site with no sitemap
  // is discovered at all.
  for (const href of seed.links) frontier.add(href, options.seed.url, 1);

  const known = new Set<string>();
  let stale = 0;
  let fetched = 0;
  let stoppedBy: CrawlResult["stoppedBy"] = "exhausted-frontier";

  const done = () => {
    if (pages.length >= maxPages) return (stoppedBy = "pages");
    if (Date.now() - started > TIME_BUDGET_MS) return (stoppedBy = "time");
    if (stale >= STALE_LIMIT) return (stoppedBy = "diminishing-returns");
    if (pacer.exhausted) return (stoppedBy = "site-pushback");
    return null;
  };

  async function worker() {
    while (!done()) {
      const item = frontier.next();
      if (!item) return;
      if (item.url === seed.url) continue;

      await pacer.wait();
      if (done()) return;

      const at = Date.now();
      try {
        const response = await fetch(item.url, {
          headers: { "User-Agent": options.userAgent, Accept: "text/html,application/xhtml+xml" },
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        });
        fetched += 1;
        pacer.observe(Date.now() - at);

        if (response.status === 429 || response.status === 503) {
          pacer.refused();
          continue;
        }
        if (!response.ok) continue;
        if (!/html/i.test(response.headers.get("content-type") ?? "")) continue;

        const page = readPage(await response.text(), item.url, options.brand);
        pages.push(page);

        // "New" means a section we had not seen. A hundred blog posts are one
        // discovery, and the hundred-and-first is not worth a request.
        const segment = new URL(page.url).pathname.split("/").filter(Boolean).slice(0, 2).join("/");
        if (known.has(segment)) stale += 1;
        else {
          known.add(segment);
          stale = 0;
        }

        // Links from deeper pages, so a site without a sitemap still opens up.
        if (item.depth < 2) for (const href of page.links) frontier.add(href, page.url, item.depth + 1);
      } catch {
        fetched += 1;
        pacer.observe(PAGE_TIMEOUT_MS);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, maxPages) }, worker));
  done();

  return { pages, stoppedBy, fetched, robotsDisallowed, fromSitemap };
}
