/**
 * Deciding what to crawl, before anything is fetched.
 *
 * The crawler used to let the race decide: four workers pulled from a queue
 * until fifty pages had come back, so the fifty were whichever answered
 * fastest. Two runs against an unchanged site produced different files -
 * vercel.com and docs.stripe.com each drifted by a link - which makes a
 * content hash useless for noticing that a site has actually changed, and
 * quietly biases the result towards whatever a site serves quickest.
 *
 * So selection happens here, as a pure function of things the site publishes:
 * its sitemap, in file order, and the links on the page we were given, in
 * document order. Ranking is a total order with no ties, so the same inputs
 * always yield the same list. Fetching comes afterwards and cannot change it.
 */

export interface Candidate {
  url: string;
  /** Position in the sitemap, or Infinity for a link found on the page. */
  sitemapPosition: number;
  segments: string[];
}

export interface PlannedCrawl {
  urls: string[];
  sections: number;
}

/** The section a URL belongs to: its first path segment, or "" for the root. */
const sectionOf = (segments: string[]) => segments[0] ?? "";

/**
 * A total order within a section: shallower first, then earlier in the
 * sitemap, then alphabetically. The last clause exists only to break ties,
 * which is what makes the whole thing reproducible.
 */
function compare(a: Candidate, b: Candidate): number {
  if (a.segments.length !== b.segments.length) return a.segments.length - b.segments.length;
  if (a.sitemapPosition !== b.sitemapPosition) return a.sitemapPosition - b.sitemapPosition;
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

/**
 * Ranks candidates, giving each section a turn.
 *
 * Round-robin rather than best-first because a site's documentation should not
 * be buried by its blog: getlago.com publishes 282 sitemap URLs and not one
 * /docs page, so ranking purely by depth spends the whole budget on marketing.
 * Sections are visited in sorted order so the rotation itself is reproducible.
 */
export function planCrawl(candidates: Candidate[], limit: number): PlannedCrawl {
  const bySection = new Map<string, Candidate[]>();

  for (const candidate of candidates) {
    const section = sectionOf(candidate.segments);
    const bucket = bySection.get(section);
    if (bucket) bucket.push(candidate);
    else bySection.set(section, [candidate]);
  }

  const sections = [...bySection.keys()].sort();
  for (const section of sections) bySection.get(section)!.sort(compare);

  const urls: string[] = [];
  const cursors = new Map(sections.map((section) => [section, 0]));

  while (urls.length < limit) {
    let took = false;

    for (const section of sections) {
      if (urls.length >= limit) break;

      const bucket = bySection.get(section)!;
      const cursor = cursors.get(section)!;
      if (cursor >= bucket.length) continue;

      urls.push(bucket[cursor].url);
      cursors.set(section, cursor + 1);
      took = true;
    }

    // Every section is exhausted; the site is smaller than the budget.
    if (!took) break;
  }

  return { urls, sections: sections.length };
}
