import { extractInternalLinks, extractMetadata, isPlaceholderTitle } from "./extract";
import { extractNavCategories } from "./nav";
import { isImprovedContent, isThinContent, launchBrowser, renderPage } from "./browserRender";
import { EMPTY_ROBOTS, isAllowedByRobots, parseRobotsTxt, type RobotsRules } from "./robots";
import { assertPublicUrl } from "./urlGuard";
import type { CrawlResult, PageInfo } from "./types";

// Page budget. The old value of 20 was a recall ceiling, not a natural limit:
// a site's own published llms.txt commonly lists 90+ URLs. Measured against
// beeclue.com, whose real llms.txt lists 91:
//   cap=20,  conc=5    2.1s   20% URL recall
//   cap=50,  conc=10   2.5s   51%
//   cap=100, conc=8    ~4s    97%
// Four seconds for 97% instead of 20% is not a close call. Env-overridable so
// the trade-off stays tunable per deployment.
const MAX_PAGES = Number(process.env.MAX_CRAWL_PAGES ?? 100);
// 8 keeps a 100-page crawl to a few seconds while staying well short of
// hammering a small site — this is a one-off, user-initiated crawl, not a
// continuous spider.
const MAX_CONCURRENCY = Number(process.env.MAX_CRAWL_CONCURRENCY ?? 8);
const MAX_SITEMAP_URLS = 200;
const MAX_NESTED_SITEMAPS = 3;
const FETCH_TIMEOUT_MS = 6000;
const USER_AGENT_TOKEN = "llms-txt-generator";
const USER_AGENT = `${USER_AGENT_TOKEN}/0.1 (+https://llmstxt.org)`;

// Path extensions that are never an HTML page worth indexing. Fetching these
// wastes the MAX_PAGES budget and (worse) used to trigger a pointless
// Playwright render, since a non-HTML content-type looked identical to a
// failed fetch to the escalation logic.
const NON_HTML_EXTENSION = /\.(pdf|zip|tar|gz|rar|7z|dmg|exe|pkg|deb|rpm|png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|mp[34]|m4[av]|wav|ogg|webm|mov|avi|mkv|css|js|mjs|map|json|xml|rss|atom|txt|csv|tsv|xlsx?|docx?|pptx?|woff2?|ttf|eot)$/i;

// Paths that exist on nearly every site and carry nothing an LLM reader needs.
const JUNK_PATH = /(^|\/)(login|signin|sign-in|signup|sign-up|register|logout|signout|cart|checkout|account|admin|wp-admin|wp-login|wp-json|cdn-cgi|search)(\/|$)/i;

interface FetchResult {
  html: string | null;
  status?: number;
  /** True when the server answered fine but with something that isn't HTML (a PDF, an image). */
  nonHtml?: boolean;
}

export interface CrawlOptions {
  /** Aborts in-flight work and stops escalating to the browser (e.g. the request's overall timeout fired). */
  signal?: AbortSignal;
}

/**
 * Collapses entries that are the same page reached by different URLs.
 *
 * Two passes, both conservative:
 *   - Exact URL match after trailing-slash normalization (a canonical tag can
 *     point several crawled URLs at one target).
 *   - Identical title AND identical non-empty description. Requiring a real
 *     description is what keeps this safe: a site whose pages all share one
 *     boilerplate description still has distinct titles, and a site whose
 *     pages share a title but have no descriptions is left alone rather than
 *     collapsed down to a single link.
 *
 * The shortest URL wins, which reliably picks /amenities over /amenities.htm
 * and a clean path over a query-string variant.
 */
function dedupePages(pages: PageInfo[]): PageInfo[] {
  const byUrl = new Map<string, PageInfo>();
  for (const page of pages) {
    const key = page.url.replace(/\/$/, "");
    const existing = byUrl.get(key);
    if (!existing || page.url.length < existing.url.length) byUrl.set(key, page);
  }

  const byContent = new Map<string, PageInfo>();
  const result: PageInfo[] = [];

  for (const page of byUrl.values()) {
    const description = page.description?.trim();
    if (!description) {
      result.push(page);
      continue;
    }

    const key = `${page.title.trim().toLowerCase()}\u0000${description.toLowerCase()}`;
    const existing = byContent.get(key);
    if (!existing) {
      byContent.set(key, page);
      result.push(page);
    } else if (page.url.length < existing.url.length) {
      result[result.indexOf(existing)] = page;
      byContent.set(key, page);
    }
  }

  return result;
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving output order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchHtmlDetailed(url: string, signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    });

    // Redirects are followed, so the response may come from a host we never
    // vetted — a public URL that 302s to 127.0.0.1 or a metadata endpoint.
    // Re-check before reading the body, which is the part that would leak.
    await assertPublicUrl(res.url || url);

    if (!res.ok) {
      return { html: null, status: res.status };
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { html: null, status: res.status, nonHtml: true };
    }

    return { html: await res.text(), status: res.status };
  } catch {
    return { html: null };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

async function fetchText(url: string, signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Whether a discovered link is worth spending a page-budget slot on. */
export function isCrawlableLink(url: string, robots: RobotsRules = EMPTY_ROBOTS): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (NON_HTML_EXTENSION.test(parsed.pathname)) return false;
  if (JUNK_PATH.test(parsed.pathname)) return false;
  return isAllowedByRobots(robots, `${parsed.pathname}${parsed.search}`);
}

async function fetchRobots(rootUrl: string, signal?: AbortSignal): Promise<RobotsRules> {
  try {
    const text = await fetchText(new URL("/robots.txt", rootUrl).toString(), signal);
    return text ? parseRobotsTxt(text, USER_AGENT_TOKEN) : EMPTY_ROBOTS;
  } catch {
    return EMPTY_ROBOTS;
  }
}

/**
 * Reads same-origin page URLs out of a site's sitemap(s).
 *
 * Homepage links alone systematically miss the pages an llms.txt most wants:
 * docs and blog posts are usually reachable only through an index page or a
 * client-rendered sidebar, so a homepage-only crawl indexes the marketing
 * site and nothing else. A sitemap is the site's own machine-readable list of
 * its real content, which is exactly the input this needs.
 *
 * A `<sitemapindex>` is followed one level deep (up to MAX_NESTED_SITEMAPS
 * children) so the common "index of per-section sitemaps" layout works.
 */
async function discoverSitemapUrls(rootUrl: string, robots: RobotsRules, signal?: AbortSignal): Promise<string[]> {
  const origin = new URL(rootUrl).origin;
  const candidates = [
    ...robots.sitemaps.filter((s) => {
      try {
        return new URL(s).origin === origin;
      } catch {
        return false;
      }
    }),
    new URL("/sitemap.xml", rootUrl).toString(),
  ];

  const found: string[] = [];
  const seen = new Set<string>();
  const queue = [...new Set(candidates)];
  let nested = 0;

  while (queue.length > 0 && found.length < MAX_SITEMAP_URLS) {
    const sitemapUrl = queue.shift()!;
    const xml = await fetchText(sitemapUrl, signal);
    if (!xml) continue;

    const locs = Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]);
    const isIndex = /<sitemapindex[\s>]/i.test(xml);

    for (const loc of locs) {
      let parsed: URL;
      try {
        parsed = new URL(decodeXmlEntities(loc));
      } catch {
        continue;
      }
      if (parsed.origin !== origin) continue;

      if (isIndex) {
        if (nested < MAX_NESTED_SITEMAPS && !seen.has(parsed.toString())) {
          seen.add(parsed.toString());
          queue.push(parsed.toString());
          nested++;
        }
        continue;
      }

      parsed.hash = "";
      const normalized = parsed.toString().replace(/\/$/, "") || parsed.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      if (isCrawlableLink(normalized, robots)) found.push(normalized);
      if (found.length >= MAX_SITEMAP_URLS) break;

    }
  }

  // A sitemap is unordered, and a big site's sitemap is mostly deep leaves
  // (/docs/reference/ai-sdk-ui/prune-messages, /playground/<model-slug>).
  // Taking the first MAX_PAGES of that spends the whole crawl budget on
  // long-tail pages while missing the section landing pages a reader
  // actually needs, so rank shallow paths first — depth is a good proxy for
  // "how central is this page to the site".
  return found.sort((a, b) => {
    const depth = pathDepth(a) - pathDepth(b);
    if (depth !== 0) return depth;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });
}

function pathDepth(url: string): number {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Crawls a site starting from rootUrl: fetches the homepage via plain HTTP,
 * extracts its metadata plus same-origin links, merges in URLs from the
 * site's sitemap, then fetches up to MAX_PAGES of those for their own
 * title/description.
 *
 * Every page — homepage included — is fetched via plain HTTP first and only
 * escalated to a real headless browser (Playwright) if that fetch fails
 * outright (e.g. a Cloudflare bot-challenge page) or the fetched body looks
 * like an empty SPA shell. This keeps the common case (static/SSR sites)
 * fast while still recovering client-rendered or bot-walled pages.
 */
export async function crawlSite(rootUrl: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const { signal } = options;
  await assertPublicUrl(rootUrl);

  const browserRef: { current: Promise<import("playwright").Browser | null> | null } = { current: null };
  const getBrowser = () => {
    if (!browserRef.current) browserRef.current = launchBrowser();
    return browserRef.current;
  };

  /** Renders a page with Playwright, or null if the browser isn't available or we're out of time. */
  async function render(url: string): Promise<string | null> {
    if (signal?.aborted) return null;
    const browser = await getBrowser();
    return browser ? renderPage(browser, url) : null;
  }

  /** If fetched content looks like an empty SPA shell, retry with Playwright and keep whichever has more text. */
  async function withRenderFallback(url: string, html: string): Promise<string> {
    if (!isThinContent(html)) return html;
    const rendered = await render(url);
    return rendered && isImprovedContent(rendered, html) ? rendered : html;
  }

  /** Fetches a page via plain HTTP, falling back to Playwright if the fetch fails outright or the content looks thin. */
  async function fetchWithRenderFallback(url: string): Promise<string | null> {
    const result = await fetchHtmlDetailed(url, signal);
    if (result.html) return withRenderFallback(url, result.html);
    // A clean non-HTML response (a PDF served from a link we couldn't filter
    // on extension) isn't a bot wall — rendering it would just waste ~15s.
    if (result.nonHtml) return null;
    return render(url);
  }

  try {
    const robots = await fetchRobots(rootUrl, signal);

    const homepage = await fetchHtmlDetailed(rootUrl, signal);
    const homepageHtml = homepage.html ? await withRenderFallback(rootUrl, homepage.html) : await render(rootUrl);

    if (!homepageHtml) {
      if (homepage.status) {
        throw new Error(`Could not reach that site (HTTP ${homepage.status}).`);
      }
      throw new Error("Could not reach that site (no HTML response).");
    }

    const homepageMeta = extractMetadata(homepageHtml, rootUrl);
    const navCategories = extractNavCategories(homepageHtml, rootUrl);
    const rootNormalized = rootUrl.replace(/\/$/, "");

    const homepageLinks = extractInternalLinks(homepageHtml, rootUrl).filter(
      (link) => link.replace(/\/$/, "") !== rootNormalized && isCrawlableLink(link, robots)
    );
    const sitemapLinks = (await discoverSitemapUrls(rootUrl, robots, signal)).filter(
      (link) => link.replace(/\/$/, "") !== rootNormalized
    );

    // Ranked, best signal first, then deduped:
    //   1. Nav-linked pages — the ones the site's own authors chose to surface.
    //   2. Other homepage links.
    //   3. Sitemap-only URLs — real content the homepage doesn't link to
    //      (docs pages, blog posts), which is exactly what a homepage-only
    //      crawl misses, but ranked last since a sitemap is unordered and
    //      often lists thousands of low-value pages.
    const navHrefs = new Set(navCategories.flatMap((c) => Array.from(c.hrefs)));
    const ordered = [
      ...homepageLinks.filter((l) => navHrefs.has(l)),
      ...homepageLinks.filter((l) => !navHrefs.has(l)),
      ...sitemapLinks,
    ];
    const candidateLinks = Array.from(new Set(ordered)).slice(0, MAX_PAGES);

    const fetchedPages = await mapWithConcurrency(
      candidateLinks,
      MAX_CONCURRENCY,
      async (link): Promise<PageInfo | null> => {
        const rendered = await fetchWithRenderFallback(link);
        if (!rendered) return null;

        const meta = extractMetadata(rendered, link);
        if (isPlaceholderTitle(meta.title)) return null;
        // Prefer the page's own declared canonical URL, so /amenities.htm and
        // /amenities don't both appear as separate entries.
        return { url: meta.canonicalUrl ?? link, title: meta.title, description: meta.description };
      }
    );

    const pages = dedupePages([
      { url: rootUrl, title: homepageMeta.title, description: homepageMeta.description },
      ...fetchedPages.filter((p): p is PageInfo => p !== null),
    ]);

    return {
      rootUrl,
      siteTitle: homepageMeta.title,
      siteDescription: homepageMeta.description,
      pages,
      navCategories,
    };
  } finally {
    const browser = await browserRef.current;
    await browser?.close().catch(() => {});
  }
}
