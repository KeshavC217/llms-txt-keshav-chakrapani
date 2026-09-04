import { cleanTitles, clusterByKeyword, titleCase } from "./nlp";
import { navSectionFor } from "./nav";
import type { CrawlResult, PageInfo } from "./types";

const MIN_PATH_GROUP_SIZE = 3;

const KNOWN_SECTIONS: Record<string, string> = {
  docs: "Docs",
  doc: "Docs",
  documentation: "Docs",
  blog: "Blog",
  news: "News",
  api: "API",
  guides: "Guides",
  guide: "Guides",
  tutorial: "Tutorials",
  tutorials: "Tutorials",
  help: "Help",
  support: "Support",
  about: "About",
  pricing: "Pricing",
};

const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/i;

/**
 * Returns the first path segment that isn't a locale/language prefix (e.g.
 * skips "en" in /en/carros to get "carros"), since many international sites
 * prefix every URL with a locale code — treating that as the content
 * category would group the entire site under one meaningless "En" section.
 */
function contentPathSegment(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const startIndex = LOCALE_SEGMENT.test(segments[0]) && segments.length > 1 ? 1 : 0;
  return segments[startIndex]?.toLowerCase() || null;
}

/**
 * Buckets a page into a section name based on its URL's first (non-locale)
 * path segment, when that segment is a recognized one (docs, blog, api,
 * ...). Returns null for anything else, which the caller then clusters
 * semantically instead of lumping it all into one generic bucket.
 */
function knownSectionFor(page: PageInfo): string | null {
  try {
    const segment = contentPathSegment(new URL(page.url).pathname);
    if (segment && KNOWN_SECTIONS[segment]) {
      return KNOWN_SECTIONS[segment];
    }
  } catch {
    // fall through
  }

  return null;
}

function firstPathSegment(url: string): string | null {
  try {
    return contentPathSegment(new URL(url).pathname);
  } catch {
    return null;
  }
}

/**
 * Groups pages sharing a first URL path segment that repeats often enough
 * (e.g. /car/alfa-romeo, /car/bmw, /car/citroen -> "Car") to be a site's own
 * content taxonomy, even when that segment isn't in our hardcoded
 * KNOWN_SECTIONS list. This matters for templated/inventory-style sites
 * (e-commerce listings, product pages) where every item page repeats similar
 * marketing copy ("taxes included", "in stock") — that shared boilerplate
 * would otherwise fool keyword clustering into grouping unrelated pages (or
 * a tax calculator with a car listing) just because they use the same stock
 * phrase. URL structure is a much stronger, unambiguous signal than
 * incidental shared vocabulary, so this runs before keyword clustering.
 */
function groupByRepeatedPathSegment(pages: PageInfo[]): {
  grouped: Map<string, PageInfo[]>;
  ungrouped: PageInfo[];
} {
  const bySegment = new Map<string, PageInfo[]>();
  const ungrouped: PageInfo[] = [];

  for (const page of pages) {
    const segment = firstPathSegment(page.url);
    if (!segment) {
      ungrouped.push(page);
      continue;
    }
    if (!bySegment.has(segment)) bySegment.set(segment, []);
    bySegment.get(segment)!.push(page);
  }

  const grouped = new Map<string, PageInfo[]>();
  for (const [segment, group] of bySegment) {
    if (group.length >= MIN_PATH_GROUP_SIZE) {
      grouped.set(titleCase(segment), group);
    } else {
      ungrouped.push(...group);
    }
  }

  return { grouped, ungrouped };
}

/**
 * Drops a description from every page that shares it with another page, or
 * with the site summary.
 *
 * Templated sites hand the same <meta name="description"> to dozens of pages
 * (every /playground/<model> page on ai-sdk.dev carries the identical SDK
 * blurb), and a description repeated on ten links tells a reader nothing
 * about any of them while crowding out the ones that do. The spec treats
 * descriptions as optional, so dropping is strictly better than repeating.
 *
 * Done deterministically here rather than left to the AI copyedit pass: it's
 * an exact-match check, it costs nothing, and it must still happen when the
 * AI pass is off or unavailable.
 */
function dropRepeatedDescriptions(pages: PageInfo[], siteDescription?: string): PageInfo[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const key = normalizeDescription(page.description);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const siteKey = normalizeDescription(siteDescription);

  return pages.map((page, index) => {
    const key = normalizeDescription(page.description);
    if (!key) return page;
    // The homepage is allowed to restate the site summary — it IS the site.
    const echoesSiteSummary = key === siteKey && index !== 0;
    if ((counts.get(key) ?? 0) > 1 || echoesSiteSummary) {
      return { ...page, description: undefined };
    }
    return page;
  });
}

function normalizeDescription(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function formatLink(page: PageInfo): string {
  const url = sanitizeLinkUrl(page.url);
  const title = sanitizeLinkText(page.title) || url;
  const description = sanitize(page.description);
  return description ? `- [${title}](${url}): ${description}` : `- [${title}](${url})`;
}

function sanitize(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/[\r\n]+/g, " ").replace(/\|/g, "-").trim();
}

/**
 * Makes a title safe to sit inside a markdown link's `[...]`. Square brackets
 * in a page title ("Pricing Guide [2026 Edition]") close the link early and
 * produce a line no markdown parser reads as a link — seen in the wild in
 * beeclue.com's own published llms.txt. Swapped for parentheses rather than
 * backslash-escaped, since this file is read by models as much as by parsers
 * and "\[2026\]" is noise to a reader.
 */
function sanitizeLinkText(value: string | undefined): string {
  return sanitize(value).replace(/\[/g, "(").replace(/\]/g, ")");
}

/**
 * Percent-encodes the parentheses in a URL, which would otherwise terminate
 * the `(...)` of a markdown link early. Wikipedia-style paths ("/Foo_(bar)")
 * are the common case.
 */
function sanitizeLinkUrl(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function addToSection(sections: Map<string, PageInfo[]>, label: string, page: PageInfo): void {
  if (!sections.has(label)) sections.set(label, []);
  sections.get(label)!.push(page);
}

export interface SectionedPages {
  sections: Map<string, PageInfo[]>;
  sectionOrder: string[];
}

/**
 * Runs the full section-assignment pipeline (nav taxonomy -> known URL
 * segments -> repeated path segments -> keyword clustering) and returns the
 * resulting section->pages grouping plus the display order, without
 * rendering markdown. Exposed separately from buildLlmsTxt so other callers
 * (e.g. the optional AI polish pass) can see exactly which pages ended up
 * under which header, instead of re-deriving or guessing that grouping.
 */
export function groupPagesIntoSections(result: CrawlResult): SectionedPages {
  const { rootUrl, pages: rawPages, navCategories } = result;

  const pages = dropRepeatedDescriptions(cleanTitles(rawPages), result.siteDescription);
  const rootUrlNormalized = rootUrl.replace(/\/$/, "");

  const sections = new Map<string, PageInfo[]>();
  // Sections derived from the site's own nav bar get to keep the nav's order
  // in the final output (it's the taxonomy the site's authors intended),
  // rather than being sorted alphabetically along with our own guesses.
  const navOrder: string[] = [];
  const afterNav: PageInfo[] = [];

  for (const page of pages) {
    if (page.url.replace(/\/$/, "") === rootUrlNormalized) {
      addToSection(sections, "Home", page);
      continue;
    }

    const navLabel = navSectionFor(page.url, navCategories);
    if (navLabel) {
      if (!sections.has(navLabel)) navOrder.push(navLabel);
      addToSection(sections, navLabel, page);
    } else {
      afterNav.push(page);
    }
  }

  const unclustered: PageInfo[] = [];
  for (const page of afterNav) {
    const known = knownSectionFor(page);
    if (known) {
      addToSection(sections, known, page);
    } else {
      unclustered.push(page);
    }
  }

  const { grouped: pathGroups, ungrouped } = groupByRepeatedPathSegment(unclustered);
  for (const [label, group] of pathGroups) {
    for (const page of group) addToSection(sections, label, page);
  }

  for (const [label, group] of clusterByKeyword(ungrouped)) {
    for (const page of group) addToSection(sections, label, page);
  }

  // "Home" first, then nav-bar sections in the site's own order, then our
  // own guessed sections alphabetically, "Pages" (catch-all) last.
  const navRank = new Map(navOrder.map((label, i) => [label, i]));
  const sectionOrder = Array.from(sections.keys()).sort((a, b) => {
    if (a === "Home") return -1;
    if (b === "Home") return 1;
    if (a === "Pages") return 1;
    if (b === "Pages") return -1;
    const aNav = navRank.get(a);
    const bNav = navRank.get(b);
    if (aNav !== undefined && bNav !== undefined) return aNav - bNav;
    if (aNav !== undefined) return -1;
    if (bNav !== undefined) return 1;
    return a.localeCompare(b);
  });

  return { sections, sectionOrder };
}

/** The title of the root page, run through the same boilerplate-suffix cleanup as every other page's title. */
export function documentTitle(result: CrawlResult, sections: Map<string, PageInfo[]>): string {
  return sections.get("Home")?.[0]?.title || result.siteTitle;
}

/** Builds an llms.txt document (per llmstxt.org) from crawl results. */
export function buildLlmsTxt(result: CrawlResult): string {
  const { rootUrl, siteDescription } = result;
  const { sections, sectionOrder } = groupPagesIntoSections(result);

  const lines: string[] = [];
  lines.push(`# ${sanitize(documentTitle(result, sections)) || rootUrl}`);
  lines.push("");
  lines.push(`> ${sanitize(siteDescription) || `Site content crawled from ${rootUrl}.`}`);

  for (const section of sectionOrder) {
    lines.push("");
    lines.push(`## ${section}`);
    lines.push("");
    for (const page of sections.get(section)!) {
      lines.push(formatLink(page));
    }
  }

  return lines.join("\n") + "\n";
}
