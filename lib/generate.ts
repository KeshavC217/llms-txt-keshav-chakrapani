/**
 * One page in, a crawled Extraction out.
 *
 * Both endpoints do the same thing up to this point, and the only difference
 * between them is what happens afterwards - so the crawl lives here rather than
 * being written twice and drifting.
 */

import { crawl } from "./crawl/crawl.ts";
import { buildFromCrawl } from "./buildFromCrawl.ts";
import { type Extraction, extract, linkCount } from "./naiveExtractor.ts";
import { USER_AGENT } from "./fetchPage.ts";

export interface GenerateOptions {
  include?: string[];
  exclude?: string[];
  /** The seed page, already extracted, so a large page is not parsed twice. */
  seed?: Extraction;
}

export interface GenerateResult {
  extraction: Extraction;
  crawl?: { pages: number; fetched: number; stoppedBy: string; fromSitemap: number; robotsDisallowed: number };
}

/**
 * The single page is still read first: it supplies the site name, the summary
 * and the orienting prose, and it is the fallback if the crawl finds nothing.
 */
export async function generate(html: string, url: string, options: GenerateOptions = {}): Promise<GenerateResult> {
  const single = options.seed ?? extract(html, url);

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { extraction: single };
  }

  const result = await crawl(origin, {
    userAgent: USER_AGENT,
    include: options.include,
    exclude: options.exclude,
    seed: { url, html },
    brand: single.siteName,
  });

  // buildFromCrawl merges rather than replaces, so this cannot come back with
  // less than the single page gave us; the comparison is a guard against a bug,
  // not a routine fallback.
  const crawled = buildFromCrawl(result.pages, single, url);
  const extraction = linkCount(crawled) >= linkCount(single) ? crawled : single;

  return {
    extraction,
    crawl: {
      pages: result.pages.length,
      fetched: result.fetched,
      stoppedBy: result.stoppedBy,
      fromSitemap: result.fromSitemap,
      robotsDisallowed: result.robotsDisallowed,
    },
  };
}
