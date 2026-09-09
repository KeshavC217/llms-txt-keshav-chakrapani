/**
 * Crawled pages into the shape everything downstream already expects.
 *
 * The architectural decision of this feature, in one file: the crawler produces
 * an `Extraction`, exactly as the single-page path does, so render(), the AI
 * sieve, the spec validator and the store all work untouched. The crawl changes
 * where pages come from, not what happens to them afterwards.
 *
 * The gain is in what a link carries. The single-page path had to name a page
 * from its slug and describe it from whatever text sat nearby - "Sso", "Learn
 * more about the Okta integration". Here each entry is the page's own title and
 * its own description: "Single Sign-On (SSO)", said by the page itself.
 */

import type { Extraction, LinkEntry, Section } from "./naiveExtractor.ts";
import type { PageMeta } from "./pageMeta.ts";
import { chooseDepth, curate, groupKeyFor, pathSegments, tidyLabel } from "./grouping.ts";
import { coverage, humanize } from "./nlp.ts";

/** Pages that exist but are rarely what an agent came for. */
const OPTIONAL_PATTERN =
  /\b(privacy|terms|tos|legal|cookie|gdpr|imprint|impressum|disclaimer|accessibility|careers?|jobs|press|media-?kit|changelog|archive|sitemap|login|log-?in|signin|sign-?up|register|account|cart|checkout|rss|feed)\b/;

const MAX_NOTE_CHARS = 160;

/**
 * Descriptions a site repeats across many pages.
 *
 * Plenty of sites set one description in a template and serve it everywhere:
 * on getlago.com, /docs/guide/security/sso and its neighbours all claim to be
 * "Developer documentation for Lago's API-first billing platform". Used as a
 * note that is worse than useless - it is the same sentence under every link,
 * and it displaces the specific one the home page had.
 */
function boilerplate(pages: PageMeta[]): Set<string> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const description = page.description?.trim();
    if (description) counts.set(description, (counts.get(description) ?? 0) + 1);
  }

  const threshold = Math.max(3, Math.ceil(pages.length * 0.2));
  return new Set([...counts].filter(([, count]) => count >= threshold).map(([description]) => description));
}

/** A description worth keeping: present, and not one the site serves everywhere. */
function usable(description: string | undefined, repeated: Set<string>): string | undefined {
  const trimmed = description?.trim();
  return trimmed && !repeated.has(trimmed) ? trimmed : undefined;
}

/** A page's own description, trimmed to a note - unless it only repeats the title. */
function noteFrom(page: PageMeta, repeated: Set<string>): string | undefined {
  const description = page.description?.replace(/\s+/g, " ").trim();
  if (!description || description.length < 15) return undefined;
  if (repeated.has(page.description!.trim())) return undefined;

  const note = description.length > MAX_NOTE_CHARS ? `${description.slice(0, MAX_NOTE_CHARS).trimEnd()}…` : description;

  // Sites commonly set one description for every page. Repeating the title back
  // is the same failure the single-page path guards against.
  return coverage(note, page.title) > 0.75 ? undefined : note;
}

function entryFor(page: PageMeta, repeated: Set<string>): LinkEntry | null {
  const segments = pathSegments(page.url);
  const slug = segments[segments.length - 1] ?? "";
  const title = page.title || humanize(slug);
  if (!title) return null;

  return { url: page.url, title, note: noteFrom(page, repeated) };
}

/**
 * Builds the file's structure from crawled pages, keeping the home page's own
 * summary and prose - the crawl improves the links, not the introduction.
 */
export function buildFromCrawl(pages: PageMeta[], base: Extraction, homeUrl: string): Extraction {
  /*
   * Crawled pages are added to what the home page already gave us, never
   * substituted for it.
   *
   * The first version compared the two and kept whichever had more links, which
   * threw away a whole crawl whenever the home page happened to link more
   * pages than the crawl had budget to fetch - on getlago.com, 68 links beat 27
   * crawled pages and the crawl was discarded entirely. The two sources answer
   * different questions: the home page knows what a site points at, and the
   * crawl knows what those pages actually are.
   */
  const upgraded = new Map<string, PageMeta>();
  for (const page of pages) upgraded.set(page.url.replace(/\/$/, ""), page);

  const repeated = boilerplate(pages);
  const home = (() => {
    try {
      return new URL(homeUrl).toString();
    } catch {
      return homeUrl;
    }
  })();

  const optional: LinkEntry[] = [];
  const grouped = new Map<string, LinkEntry[]>();
  const segmentsByGroup = new Map<string, string[]>();

  // Everything the home page linked, plus everything the crawl reached.
  const linked = [...base.sections.flatMap((section) => section.links), ...base.optional];
  const merged = new Map<string, PageMeta>();

  for (const link of linked) {
    const key = link.url.replace(/\/$/, "");
    const crawled = upgraded.get(key);
    merged.set(key, {
      url: link.url,
      // A crawled page's own title and description beat a name guessed from a
      // slug and a note borrowed from adjacent text.
      title: crawled?.title || link.title,
      // The home page's note stays unless the crawled page offers something of
      // its own. A description the site repeats everywhere is not something of
      // its own, and would displace a specific note with a generic one.
      description: usable(crawled?.description, repeated) ?? link.note,
      links: [],
    });
  }

  for (const page of pages) {
    const key = page.url.replace(/\/$/, "");
    if (!merged.has(key)) merged.set(key, page);
  }

  const candidates = [...merged.values()]
    .filter((page) => page.url !== home)
    .map((page) => ({ page, segments: pathSegments(page.url) }));
  const depth = chooseDepth(candidates.map(({ segments }) => segments));

  const seen = new Set<string>();

  for (const { page, segments } of candidates) {
    const entry = entryFor(page, repeated);
    if (!entry || seen.has(entry.url)) continue;
    seen.add(entry.url);

    const path = new URL(entry.url).pathname.toLowerCase();
    if (OPTIONAL_PATTERN.test(path) || OPTIONAL_PATTERN.test(entry.title.toLowerCase())) {
      optional.push(entry);
      continue;
    }

    const key = groupKeyFor(segments, depth);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(entry);
    else {
      grouped.set(key, [entry]);
      segmentsByGroup.set(key, segments);
    }
  }

  const sections: Section[] = [];
  for (const [key, links] of grouped) {
    sections.push({ name: key ? tidyLabel(humanize(key), humanize(key), base.siteName) : "Pages", links });
  }

  // Biggest sections first, but the ungrouped catch-all never leads.
  sections.sort((a, b) => (a.name === "Pages" ? 1 : b.name === "Pages" ? -1 : b.links.length - a.links.length));

  return {
    ...base,
    sections: curate(sections),
    optional: optional.slice(0, 25),
  };
}
