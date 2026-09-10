/**
 * Turning a pile of links into sections.
 *
 * Lifted out of lib/naiveExtractor.ts, unchanged in behaviour, because the
 * crawler needs exactly the same decisions and only the single-page path owned
 * them. Both callers now share one implementation of "which section does this
 * belong to, and what is that section called".
 */

import type { LinkEntry, Section } from "./naiveExtractor.ts";
import { coverage, similarity, titleCase } from "./nlp.ts";

/** Locale segments name an audience, not a section: /docs/en/... is not "En". */
export const LOCALE_SEGMENT =
  /^(en|fr|de|es|it|ja|zh|ko|pt|ru|nl|pl|tr|vi|id|hi|ar|sv|da|no|fi|cs|el|he|th|uk)([-_][a-z]{2})?$/i;

/**
 * Curation limits (TEMPLATE.txt rule 1: a curated file beats an exhaustive
 * one). Without them a large site yields thousands of links, which is a
 * sitemap - the thing llms.txt exists not to be.
 */
export const MAX_LINKS_PER_SECTION = 25;
export const MAX_TOTAL_LINKS = 150;
export const MAX_SECTIONS = 12;

export function pathSegments(url: string): string[] {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).filter((segment) => !LOCALE_SEGMENT.test(segment));
  } catch {
    return [];
  }
}

/**
 * Which path segment to group on.
 *
 * The first one is the obvious choice and the wrong one for a documentation
 * site, where every page is /docs/something and the whole file collapses into a
 * single section. So: if one bucket swallows most of the links, go a segment
 * deeper for the pages that have one.
 */
export function groupKeyFor(segments: string[], depth: number): string {
  if (segments.length <= 1) return "";
  return segments[Math.min(depth, segments.length - 2)];
}

export function chooseDepth(all: string[][]): number {
  const deep = all.filter((segments) => segments.length > 1);
  if (deep.length === 0) return 0;

  const groupCount = (depth: number) => new Set(deep.map((segments) => groupKeyFor(segments, depth))).size;
  const shallow = groupCount(0);
  const deeper = groupCount(1);

  // One bucket holding everything is not a grouping at all; if going a segment
  // deeper actually separates the links, take it however few there are.
  if (shallow <= 1 && deeper > 1) return 1;

  const counts = new Map<string, number>();
  for (const segments of deep) {
    const key = groupKeyFor(segments, 0);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const largest = Math.max(...counts.values());
  return deep.length >= 5 && largest >= 0.6 * deep.length && deeper > shallow ? 1 : 0;
}

/** Nav labels are written as instructions ("Explore Our Services"); a section name wants the noun. */
export function tidyLabel(label: string, fallback: string, siteName?: string): string {
  const cleaned = label
    .replace(/^(?:(?:explore|browse|view|see|discover|all|our|the)\s+)+/i, "")
    .replace(/\s+(pages?|links?|menu|section|navigation)$/i, "")
    .trim();

  // A section named after the whole site tells a reader nothing.
  if (siteName && similarity(cleaned, siteName) > 0.5) return titleCase(fallback);
  return titleCase(cleaned || fallback);
}

/**
 * Trims the result to something a reader can hold: a lone link is not a
 * section, there is a limit to how many sections earn their heading, and a
 * section past a couple of dozen links has stopped being a curated list.
 */
/**
 * One entry per page, where the query string is a variant rather than the page.
 *
 * airbnb.com linked its gift-card page ten times - /gift/buy?card_name=arctic,
 * &baths, &cozy, &dinner - and an entire section of the generated file was one
 * page under ten spellings. Two "Contact us" differing only by ?entry= sat
 * beside them.
 *
 * The query cannot simply be dropped: en.wikipedia.org addresses every article
 * as /w/index.php?title=X, so collapsing on path alone would fold a whole
 * encyclopedia into one link. What separates the two cases is the title, which
 * the crawler has because it fetched the page - ten identical "Airbnb gift
 * cards" against ten different article names. So: same path and same title is
 * one page; same path and different titles is several.
 *
 * The survivor is the one that says the most - a note first, then the shortest
 * URL, which is the one without the variant attached.
 */
/** The address without the query, which is where a variant hides. */
function pathKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Whether two links at the same address are the same page.
 *
 * Not string equality. The same page arrives under a long title and a short
 * one, because one came from the page's own <title> and the other from the
 * text of a link to it: nytimes.com offered both "Connections" and
 * "Connections - Group words that share a common thread". One title being
 * wholly contained in the other is the test, which is the same measure the
 * extractor already uses to collapse "Pricing" and "Our Pricing".
 */
function samePage(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left === right) return true;

  return coverage(left, right) === 1 || coverage(right, left) === 1;
}

/**
 * Which of a set of links survive: one per page, the one that says the most.
 *
 * Grouped by address first and compared by title within the group, so two
 * genuinely different pages that share a path - every Wikipedia article is
 * /w/index.php?title=X - stay two links.
 */
export function survivorsOf(links: LinkEntry[]): Set<LinkEntry> {
  const byPath = new Map<string, LinkEntry[]>();

  for (const link of links) {
    const key = pathKey(link.url);
    const held = byPath.get(key);

    const match = held?.find((kept) => samePage(kept.title, link.title));
    if (!match) {
      if (held) held.push(link);
      else byPath.set(key, [link]);
      continue;
    }

    // The survivor is the one that says the most: a note first, then the
    // shortest URL, which is the one without the variant attached.
    const better =
      (!match.note && link.note) ||
      (Boolean(match.note) === Boolean(link.note) && link.url.length < match.url.length);
    if (better) held![held!.indexOf(match)] = link;
  }

  return new Set([...byPath.values()].flat());
}

/** The same, for a flat list - the Optional section is not a Section. */
export function dedupeLinks(links: LinkEntry[]): LinkEntry[] {
  const survivors = survivorsOf(links);
  return links.filter((link) => survivors.has(link));
}

function dedupeVariants(sections: Section[]): Section[] {
  // Across every section at once, not within each: a site links the same page
  // from more than one part of its navigation.
  const survivors = survivorsOf(sections.flatMap((section) => section.links));

  return sections
    .map((section) => ({ ...section, links: section.links.filter((link) => survivors.has(link)) }))
    .filter((section) => section.links.length > 0);
}

export function curate(input: Section[]): Section[] {
  const sections = dedupeVariants(input);
  const kept: Section[] = [];
  const orphans: LinkEntry[] = [];

  for (const section of sections) {
    if (section.links.length === 1 && section.name !== "Pages") orphans.push(...section.links);
    else kept.push(section);
  }

  const catchAll = kept.find((section) => section.name === "Pages");
  if (orphans.length > 0) {
    if (catchAll) catchAll.links.push(...orphans);
    else kept.push({ name: "Pages", links: orphans });
  }

  const trimmed = kept.slice(0, MAX_SECTIONS);
  let budget = MAX_TOTAL_LINKS;
  const result: Section[] = [];

  for (const section of trimmed) {
    // A link with a note earns its place over one without. Crawled pages that
    // carry no description would otherwise displace home-page links that came
    // with one - which is how react.dev, whose pages have no meta description
    // at all, lost most of its notes when the crawler started reaching more
    // pages. Order is otherwise preserved.
    const ordered = [...section.links].sort((a, b) => Number(Boolean(b.note)) - Number(Boolean(a.note)));
    const links = ordered.slice(0, Math.min(MAX_LINKS_PER_SECTION, budget));
    if (links.length === 0) break;
    budget -= links.length;
    result.push({ ...section, links });
  }
  return result;
}
