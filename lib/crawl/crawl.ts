/**
 * The crawl: plan first, then fetch.
 *
 * Two phases, and the split is the point. Planning decides exactly which pages
 * belong in the result, from what the site publishes, before a request is made.
 * Fetching then retrieves that list and sorts the results back into plan order,
 * so concurrency affects how long it takes and nothing else.
 *
 * What that buys is a file that is a function of the site. Two runs against an
 * unchanged site produce identical bytes, so a hash of the output means "this
 * site changed" rather than "a packet was slower this time" - which is what
 * monitoring needs in order to be worth anything.
 */

import { readPage, type PageMeta } from "../pageMeta.ts";
import { canonicalize } from "./frontier.ts";
import { type Candidate, planCrawl } from "./plan.ts";
import { Pacer } from "./pacer.ts";
import { fetchRobots, isAllowed, type Robots } from "./robots.ts";
import { fetchSitemap, sitemapCandidates } from "./sitemap.ts";

/**
 * One ceiling for every crawl.
 *
 * An effort level was tried and dropped: it made the same URL produce different
 * files, so the stored answer depended on which effort happened to ask first.
 */
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES ?? 50);

/** A safety valve, not a budget: it should not normally be reached. */
const TIME_BUDGET_MS = Number(process.env.CRAWL_TIME_BUDGET_MS ?? 25_000);
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY ?? 4);
const PAGE_TIMEOUT_MS = 12_000;

export interface CrawlResult {
  pages: PageMeta[];
  planned: number;
  fetched: number;
  failed: number;
  robotsDisallowed: number;
  fromSitemap: number;
  /**
   * True when the safety valve tripped, which is the one thing that makes a
   * result depend on how fast the network was today.
   *
   * Failures deliberately do not count. A page that fails twice is nearly
   * always a stale sitemap entry or a non-HTML response, and it fails the same
   * way on every run: docs.stripe.com loses one page and getlago.com two, and
   * all three runs of each still hash identically. Treating those as partial
   * would mean never storing a result for either site.
   */
  partial: boolean;
}

export interface CrawlOptions {
  userAgent: string;
  include?: string[];
  exclude?: string[];
  /** The page already fetched by the caller, so it is not fetched twice. */
  seed: { url: string; html: string };
  brand?: string;
}

/** Not pages: assets, downloads, feeds. */
const NON_PAGE =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|rss|atom|zip|gz|tgz|pdf|docx?|xlsx?|pptx?|mp[34]|webm|mov|woff2?|ttf|eot)$/i;

export async function crawl(origin: string, options: CrawlOptions): Promise<CrawlResult> {
  const started = Date.now();
  const host = new URL(origin).host;

  const robots: Robots = await fetchRobots(origin, options.userAgent);
  const pacer = new Pacer(robots.crawlDelayMs);

  const seed = readPage(options.seed.html, options.seed.url, options.brand);
  const seedUrl = canonicalize(options.seed.url, origin) ?? options.seed.url;

  let robotsDisallowed = 0;
  const seen = new Set<string>([seedUrl]);
  const candidates: Candidate[] = [];

  const consider = (href: string, base: string, sitemapPosition: number) => {
    const url = canonicalize(href, base);
    if (!url || seen.has(url)) return;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }

    if (parsed.host !== host) return;
    if (NON_PAGE.test(parsed.pathname)) return;

    if (!isAllowed(robots, parsed.pathname)) {
      robotsDisallowed += 1;
      return;
    }

    const path = parsed.pathname;
    if (options.exclude?.some((prefix) => path.startsWith(prefix))) return;
    if (options.include?.length && !options.include.some((prefix) => path.startsWith(prefix))) return;

    seen.add(url);
    candidates.push({ url, sitemapPosition, segments: path.split("/").filter(Boolean) });
  };

  // The sitemap finds what nothing links to, which is most of a site.
  let fromSitemap = 0;
  for (const candidate of sitemapCandidates(origin, robots.sitemaps)) {
    const entries = await fetchSitemap(candidate, options.userAgent);
    for (const entry of entries) {
      const before = candidates.length;
      consider(entry.url, origin, entry.position);
      if (candidates.length > before) fromSitemap += 1;
    }
    if (fromSitemap > 0) break;
  }

  // Then the seed page's own links, in document order, for the sites that
  // publish no sitemap - and for the sections a sitemap leaves out.
  for (const href of seed.links) consider(href, options.seed.url, Number.MAX_SAFE_INTEGER);

  const fetchedPages: PageMeta[] = [];
  let failed = 0;
  let fetched = 0;
  let expired = false;
  let planned = 0;

  async function attempt(url: string): Promise<PageMeta | null> {
    const at = Date.now();
    const response = await fetch(url, {
      headers: { "User-Agent": options.userAgent, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });

    pacer.observe(Date.now() - at);
    if (response.status === 429 || response.status === 503) {
      pacer.refused();
      return null;
    }

    if (!response.ok) return null;
    if (!/html/i.test(response.headers.get("content-type") ?? "")) return null;

    return readPage(await response.text(), url, options.brand);
  }

  /**
   * Fetches one planned wave, in plan order.
   *
   * Concurrency lives inside a wave and cannot leak between them: every page of
   * a wave is in hand before the next is planned, so what gets crawled never
   * depends on which request happened to finish first.
   */
  async function runWave(urls: string[]): Promise<PageMeta[]> {
    const results = new Map<number, PageMeta>();
    let next = 0;

    async function worker() {
      while (next < urls.length) {
        if (Date.now() - started > TIME_BUDGET_MS) {
          expired = true;
          return;
        }

        const index = next++;
        const url = urls[index];
        await pacer.wait();

        try {
          fetched += 1;
          const page = await attempt(url);
          if (page) {
            results.set(index, page);
            continue;
          }
        } catch {
          // Falls through to the retry below.
        }

        // One retry, because a single transient failure would otherwise change
        // the output and make an unchanged site look changed.
        try {
          await pacer.wait();
          fetched += 1;
          const page = await attempt(url);
          if (page) results.set(index, page);
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length || 1) }, worker));

    // Arrival order is discarded here, once per wave: a slow response changes
    // when a page arrives and never whether it is included.
    return [...results.entries()].sort(([a], [b]) => a - b).map(([, page]) => page);
  }

  /*
   * Waves, because a site without a sitemap is only as discoverable as its
   * links. react.dev publishes no sitemap, so one wave sees just the 21 links
   * on its home page; following what those pages link reaches the rest.
   *
   * Each wave is planned from the complete result of the one before, so the
   * whole sequence is still a function of the site.
   */
  const MAX_WAVES = 3;
  for (let wave = 0; wave < MAX_WAVES && !expired; wave += 1) {
    const remaining = MAX_PAGES - 1 - fetchedPages.length;
    if (remaining <= 0) break;

    const plan = planCrawl(candidates, remaining);
    if (plan.urls.length === 0) break;

    planned += plan.urls.length;
    const wavePages = await runWave(plan.urls);
    fetchedPages.push(...wavePages);

    // Anything already planned has been taken; what these pages link to becomes
    // the pool for the next wave.
    const taken = new Set(plan.urls);
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (taken.has(candidates[i].url)) candidates.splice(i, 1);
    }
    for (const page of wavePages) {
      for (const href of page.links) consider(href, page.url, Number.MAX_SAFE_INTEGER);
    }
  }

  const pages = [seed, ...fetchedPages];

  return {
    pages,
    planned,
    fetched,
    failed,
    robotsDisallowed,
    fromSitemap,
    partial: expired,
  };
}
