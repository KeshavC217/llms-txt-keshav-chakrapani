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
import { canonicalize } from "./url.ts";
import { type Candidate, planCrawl } from "./plan.ts";
import { Pacer } from "./pacer.ts";
import { fetchRobots, isAllowed, type Robots } from "./robots.ts";
import { fetchSitemap, sitemapCandidates } from "./sitemap.ts";
import { Deadline } from "../deadline.ts";
import type { ProgressEvent } from "../progress.ts";

/**
 * One ceiling for every crawl.
 *
 * An effort level was tried and dropped: it made the same URL produce different
 * files, so the stored answer depended on which effort happened to ask first.
 */
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES ?? 50);

/**
 * A safety valve, not a budget: it should not normally be reached.
 *
 * It is also no longer the only limit. When the caller passes a deadline, the
 * crawl gets whichever of the two expires first, so a crawl that starts late
 * because the site was slow to answer its first page is shortened rather than
 * allowed to run the request past the function's ceiling.
 *
 * It was briefly cut to 20s while the deadline was being added, which cost
 * airbnb.com two pages and nytimes.com seven for nothing: the deadline is what
 * bounds the request now, so this only has to stop one site being crawled
 * forever. The last PAGE_TIMEOUT_MS of it is unusable by design - a worker
 * will not start a page it cannot finish - so the valve has to be the time
 * worth spending plus that reserve.
 */
const TIME_BUDGET_MS = Number(process.env.CRAWL_TIME_BUDGET_MS ?? 25_000);
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY ?? 4);
const PAGE_TIMEOUT_MS = 8_000;

/**
 * The least time worth starting a page with.
 *
 * Not the page timeout, which is what this was first written as and which threw
 * away the last eight seconds of every crawl - airbnb.com lost ten pages to a
 * reserve it never needed. A page started late is not an overrun, because its
 * signal is already the shorter of PAGE_TIMEOUT_MS and what the budget has
 * left: it either arrives inside the budget or is aborted exactly on it. So the
 * only question is whether a second is long enough to be worth the request,
 * rather than whether the whole timeout would fit.
 */
const MIN_ATTEMPT_MS = 1_000;

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
  /** The request's clock. The crawl takes the earlier of this and its valve. */
  deadline?: Deadline;
  brand?: string;
  /** Fires as pages settle, so a caller can narrate "12 of 50" while it waits. */
  onProgress?: (event: Extract<ProgressEvent, { stage: "crawling" }>) => void;
}

/** Not pages: assets, downloads, feeds. */
const NON_PAGE =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|rss|atom|zip|gz|tgz|pdf|docx?|xlsx?|pptx?|mp[34]|webm|mov|woff2?|ttf|eot)$/i;

export async function crawl(origin: string, options: CrawlOptions): Promise<CrawlResult> {
  const host = new URL(origin).host;

  // Fired once up front, at 0 of 0: robots.txt and the sitemap can take a
  // couple of seconds on their own, and a caller narrating this step should
  // not sit on the previous stage's label while that happens.
  options.onProgress?.({ stage: "crawling", fetched: 0, planned: 0 });

  // Whichever expires first: the crawl's own valve, or what the request has
  // left. Discovery is inside it too - a site that takes six seconds to serve
  // robots.txt and its sitemap has six fewer seconds of pages, rather than six
  // more seconds of request.
  const budget = options.deadline ? options.deadline.limit(TIME_BUDGET_MS) : new Deadline(TIME_BUDGET_MS);

  const robots: Robots = await fetchRobots(origin, options.userAgent, budget);
  const pacer = new Pacer(robots.crawlDelayMs);

  const seed = readPage(options.seed.html, options.seed.url, options.brand);
  const seedUrl = canonicalize(options.seed.url, origin) ?? options.seed.url;

  let robotsDisallowed = 0;
  const seen = new Set<string>([seedUrl]);
  const candidates: Candidate[] = [];

  /*
   * How many times the site points at a page, which is the site voting on what
   * matters. react.dev links /learn five times, /reference/react and /blog four
   * - its three most important pages, and its three most-linked. Counted before
   * the seen check, since the second and third mentions are the whole signal.
   */
  const inbound = new Map<string, number>();

  const consider = (href: string, base: string, sitemapPosition: number) => {
    const url = canonicalize(href, base);
    if (!url) return;

    inbound.set(url, (inbound.get(url) ?? 0) + 1);
    if (seen.has(url)) return;

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
    candidates.push({ url, sitemapPosition, segments: path.split("/").filter(Boolean), inbound: 0 });
  };

  /** Fills in the counts, which are only complete once discovery has finished. */
  const withInbound = (list: Candidate[]) =>
    list.map((candidate) => ({ ...candidate, inbound: inbound.get(candidate.url) ?? 0 }));

  // The sitemap finds what nothing links to, which is most of a site.
  let fromSitemap = 0;
  for (const candidate of sitemapCandidates(origin, robots.sitemaps)) {
    // Discovery that leaves no time to fetch anything it found is wasted: the
    // seed page's own links are already in hand and cost nothing.
    if (!budget.allows(PAGE_TIMEOUT_MS)) break;

    const entries = await fetchSitemap(candidate, options.userAgent, budget);
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

  /**
   * How many pages have reached a final state - found or given up on - across
   * every wave so far. Distinct from `fetched`, which counts raw attempts and
   * so double-counts a retry; a caller narrating progress wants "how many of
   * the plan are done", not how many requests were made.
   */
  let settled = 0;
  const settle = () => {
    settled += 1;
    options.onProgress?.({ stage: "crawling", fetched: settled, planned });
  };

  async function attempt(url: string): Promise<PageMeta | null> {
    const at = Date.now();
    const response = await fetch(url, {
      headers: { "User-Agent": options.userAgent, Accept: "text/html,application/xhtml+xml" },
      signal: budget.signal(PAGE_TIMEOUT_MS),
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
        /*
         * Can another page finish, rather than has the budget elapsed.
         *
         * The old check asked the second question, so a worker that passed it
         * with a tenth of a second to spare still had a full page timeout
         * ahead of it. The pacer answers for the wait, since only it knows how
         * many workers are queued ahead of this one.
         */
        if (!budget.allows(MIN_ATTEMPT_MS)) {
          expired = true;
          return;
        }

        const index = next++;
        const url = urls[index];

        // Reserving enough to be worth a request, so a worker does not sleep
        // to the very edge of the budget and fetch nothing with what is left.
        if (!(await pacer.wait(budget, MIN_ATTEMPT_MS))) {
          expired = true;
          return;
        }

        try {
          fetched += 1;
          const page = await attempt(url);
          if (page) {
            results.set(index, page);
            settle();
            continue;
          }
        } catch {
          // Falls through to the retry below.
        }

        /*
         * One retry, because a single transient failure would otherwise change
         * the output and make an unchanged site look changed - but only while
         * there is time for it. Unchecked, this was a second full wait and a
         * second full page timeout past a budget already spent.
         */
        if (!budget.allows(MIN_ATTEMPT_MS) || !(await pacer.wait(budget, MIN_ATTEMPT_MS))) {
          failed += 1;
          settle();
          expired = true;
          return;
        }

        try {
          fetched += 1;
          const page = await attempt(url);
          if (page) results.set(index, page);
          else failed += 1;
        } catch {
          failed += 1;
        }
        settle();
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

    const plan = planCrawl(withInbound(candidates), remaining);
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
