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
  /** How many times the site links to this page; see crawl.ts. */
  inbound: number;
}

export interface PlannedCrawl {
  urls: string[];
  sections: number;
}

/** The section a URL belongs to: its first path segment, or "" for the root. */
const sectionOf = (segments: string[]) => segments[0] ?? "";

/**
 * A total order within a section, most important first.
 *
 * **How often the site links to it** leads, because that is the site itself
 * saying what matters and it needs no judgement from us. react.dev links
 * /learn five times, /reference/react and /blog four - which are exactly its
 * three most important pages. Where the signal is missing it is missing
 * uniformly (docs.convex.dev is a shell whose every candidate came from the
 * sitemap, all with a count of one), so it falls through rather than misleads.
 *
 * **Depth** is next, and is the same idea by a weaker proxy: a site puts what
 * it wants read near the top.
 *
 * Sitemap position and then the URL break what remains. The last clause exists
 * only to make the order total, which is what makes a crawl reproducible and
 * therefore what makes a content hash mean the site changed.
 */
function compare(a: Candidate, b: Candidate): number {
  if (a.inbound !== b.inbound) return b.inbound - a.inbound;
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
/**
 * How many of the budget each section gets.
 *
 * A turn each was the first rule and it treats every section as equally
 * important, which on a documentation site is plainly wrong: docs.convex.dev
 * has 225 candidates under /docs and 2 under /careers, and round-robin gave
 * them two slots each. A file for a docs site that names two documentation
 * pages has missed the point of the site.
 *
 * So: proportional to how much of the site a section is, with a floor of one
 * so nothing is starved. Where the budget cannot even give everyone one - a
 * site with more sections than we have slots - the largest sections get the
 * slots, since taking one page each from eighty sections describes nothing.
 *
 * Allocation is by largest remainder, and every tie is broken by name, so the
 * same input always produces the same quotas.
 */
function allocate(sizes: Map<string, number>, limit: number): Map<string, number> {
  const sections = [...sizes.keys()].sort();
  const quotas = new Map<string, number>();

  if (sections.length >= limit) {
    const ranked = [...sections].sort((a, b) => (sizes.get(b)! - sizes.get(a)!) || (a < b ? -1 : 1));
    for (const section of ranked.slice(0, limit)) quotas.set(section, 1);
    return quotas;
  }

  for (const section of sections) quotas.set(section, 1);

  const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  const share = limit - sections.length;
  if (share <= 0 || total === 0) return quotas;

  // Whole shares first, then what rounding left over to whoever was rounded
  // down hardest - the largest-remainder method, and the reason no fractional
  // slot goes missing.
  const remainders: { section: string; fraction: number }[] = [];
  let given = 0;

  for (const section of sections) {
    const exact = (share * sizes.get(section)!) / total;
    const whole = Math.floor(exact);
    quotas.set(section, quotas.get(section)! + whole);
    given += whole;
    remainders.push({ section, fraction: exact - whole });
  }

  remainders.sort((a, b) => b.fraction - a.fraction || (a.section < b.section ? -1 : 1));
  for (const { section } of remainders.slice(0, share - given)) {
    quotas.set(section, quotas.get(section)! + 1);
  }

  return quotas;
}

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

  const quotas = allocate(new Map(sections.map((s) => [s, bySection.get(s)!.length])), limit);

  const urls: string[] = [];
  const cursors = new Map(sections.map((section) => [section, 0]));

  // Round-robin within the quotas rather than straight down each section, so a
  // budget that runs out early is still spread across the site.
  let taking = true;
  while (urls.length < limit && taking) {
    taking = false;

    for (const section of sections) {
      if (urls.length >= limit) break;

      const bucket = bySection.get(section)!;
      const cursor = cursors.get(section)!;
      if (cursor >= bucket.length || cursor >= (quotas.get(section) ?? 0)) continue;

      urls.push(bucket[cursor].url);
      cursors.set(section, cursor + 1);
      taking = true;
    }
  }

  /*
   * Sections smaller than their quota leave the budget unspent, so whatever is
   * left over goes round again without regard to quota. Without this a site
   * with one huge section and several tiny ones would crawl well under its
   * limit.
   */
  let topping = true;
  while (urls.length < limit && topping) {
    topping = false;

    for (const section of sections) {
      if (urls.length >= limit) break;

      const bucket = bySection.get(section)!;
      const cursor = cursors.get(section)!;
      if (cursor >= bucket.length) continue;

      urls.push(bucket[cursor].url);
      cursors.set(section, cursor + 1);
      topping = true;
    }
  }

  return { urls, sections: sections.length };
}
