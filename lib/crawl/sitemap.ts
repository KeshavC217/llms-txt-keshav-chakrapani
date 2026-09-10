import { Deadline } from "../deadline.ts";

/**
 * Sitemaps: the list of pages a site wants known.
 *
 * The best discovery source there is, when it exists - it finds pages nothing
 * links to from the front door, which is most of a site. But it cannot be the
 * only route: react.dev answers 404 for /sitemap.xml, and plenty of sites
 * never publish one.
 *
 * Parsed with regex rather than an XML parser. The shape being read is two
 * tags deep and the alternative is a dependency; a malformed file yields
 * fewer URLs, which is the same outcome as a missing one.
 */

/** Larger than a robots.txt - docs.stripe.com lists 4,693 URLs - but not 12s larger. */
const FETCH_TIMEOUT_MS = 8_000;

/** A sitemap index can name dozens; enough to be useful, bounded to be sane. */
const MAX_INDEX_CHILDREN = 5;
const MAX_URLS = 5_000;

export interface SitemapEntry {
  url: string;
  /** Sitemap order is a weak signal of importance, and the only one here. */
  position: number;
}

function extract(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, "gi"))].map((match) =>
    match[1].replace(/&amp;/g, "&").trim(),
  );
}

async function fetchXml(url: string, userAgent: string, deadline?: Deadline): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent, Accept: "application/xml,text/xml,*/*" },
      signal: deadline ? deadline.signal(FETCH_TIMEOUT_MS) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return null;
    const text = await response.text();
    return text.includes("<loc") ? text : null;
  } catch {
    return null;
  }
}

/**
 * Reads a sitemap, following an index one level down.
 *
 * One level, not arbitrarily deep: nesting past that is rare, and each level
 * multiplies the fetches before a single page has been read.
 */
export async function fetchSitemap(
  sitemapUrl: string,
  userAgent: string,
  deadline?: Deadline,
): Promise<SitemapEntry[]> {
  const xml = await fetchXml(sitemapUrl, userAgent, deadline);
  if (!xml) return [];

  if (/<sitemapindex/i.test(xml)) {
    const children = extract(xml, "loc").slice(0, MAX_INDEX_CHILDREN);
    const pages = await Promise.all(children.map((child) => fetchXml(child, userAgent, deadline)));

    return pages
      .filter((page): page is string => Boolean(page))
      .flatMap((page) => extract(page, "loc"))
      .slice(0, MAX_URLS)
      .map((url, position) => ({ url, position }));
  }

  return extract(xml, "loc")
    .slice(0, MAX_URLS)
    .map((url, position) => ({ url, position }));
}

/**
 * Where to look. The Sitemap: lines in robots.txt are authoritative when
 * present, since a site that has moved its sitemap says so there; /sitemap.xml
 * is the convention to fall back on.
 */
export function sitemapCandidates(origin: string, declared: string[]): string[] {
  const candidates = declared.length > 0 ? [...declared] : [];
  const conventional = new URL("/sitemap.xml", origin).toString();
  if (!candidates.includes(conventional)) candidates.push(conventional);
  return candidates.slice(0, 3);
}
