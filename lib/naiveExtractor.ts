/**
 * Builds an llms.txt from one fetched page, following TEMPLATE.txt.
 *
 * Naive in that it sees a single document - no crawl, no model, no fetching
 * the pages it links to. Everything here is inference from structure and word
 * overlap: which text is navigation, which links are the same page twice,
 * which nearby sentence describes a link without merely restating it.
 *
 * Where a slot cannot be filled honestly it is left out (TEMPLATE.txt rule 7).
 */

import {
  ElementNode,
  ancestors,
  attrsOf,
  cleanText,
  isElement,
  linkDensity,
  parseHtml,
  walk,
} from "./dom";
import { coverage, humanize, sentences, similarity, stripBrandSuffix, titleCase } from "./nlp";

export interface LinkEntry {
  url: string;
  title: string;
  note?: string;
}

export interface Section {
  name: string;
  links: LinkEntry[];
}

export interface Extraction {
  siteName: string;
  summary?: string;
  prose: string[];
  sections: Section[];
  optional: LinkEntry[];
  /** The page arrived as a near-empty shell that builds itself in the browser. */
  clientRendered: boolean;
}

/** Chrome that is navigation or furniture, never content. */
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside", "form"]);
const CHROME_PATTERN =
  /\b(nav|navbar|menu|header|footer|sidebar|side-?bar|breadcrumb|cookie|consent|banner|social|share|skip|toolbar|topbar|subscribe|newsletter|modal|popup|widget|pagination|toc|table-of-contents|on-this-page|related|advert|ads?)\b/;

/** Pages that exist but are rarely what an agent came for (rule: ## Optional). */
const OPTIONAL_PATTERN =
  /\b(privacy|terms|tos|legal|cookie|gdpr|imprint|impressum|disclaimer|accessibility|careers?|jobs|press|media-?kit|changelog|archive|sitemap|login|log-?in|signin|sign-?up|register|account|cart|checkout|rss|feed)\b/;

/** Not pages: assets, downloads, feeds. */
const NON_PAGE = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|rss|atom|zip|gz|tgz|pdf|docx?|xlsx?|pptx?|mp[34]|webm|mov|woff2?|ttf|eot)$/i;

/**
 * Curation limits (TEMPLATE.txt rule 1: a curated file beats an exhaustive
 * one). Without them a Wikipedia article yields 238 links and a link farm
 * yields thousands, which is a sitemap - the thing llms.txt exists not to be.
 */
/** Locale segments name an audience, not a section: /docs/en/... is not "En". */
const LOCALE_SEGMENT = /^(en|fr|de|es|it|ja|zh|ko|pt|ru|nl|pl|tr|vi|id|hi|ar|sv|da|no|fi|cs|el|he|th|uk)([-_][a-z]{2})?$/i;

const MAX_LINKS_PER_SECTION = 25;
const MAX_TOTAL_LINKS = 150;
const MAX_SECTIONS = 12;

const GENERIC_LABEL = /^(home|menu|more|links?|pages?|site|main|other|misc|navigation|explore)$/i;

/**
 * Anchor text that points rather than names: "this guide", "read more", "here".
 * It reads as a title but identifies nothing once the surrounding sentence is
 * gone, so the slug is the better name (rule: {{link_title}}).
 */
const DEICTIC_LABEL =
  /^((this|that|these|those|the|our|it|here)\b|(read|learn|find out|see|click|get started|start|continue|view|browse)\b.{0,20}$|.{0,12}(here|more|link)$)/i;

function isChrome(node: ElementNode): boolean {
  if (CHROME_TAGS.has(node.tag)) return true;
  if (node.attrs.role === "navigation" || node.attrs.role === "banner") return true;
  return CHROME_PATTERN.test(attrsOf(node));
}

/** True when the node sits anywhere inside page chrome. */
function inChrome(node: ElementNode): boolean {
  return isChrome(node) || ancestors(node).some(isChrome);
}

/**
 * The element holding the article. <main> and <article> say so outright; when
 * a page marks nothing, the best candidate is the block with the most text
 * that is not mostly links (TEMPLATE.txt rule 4).
 */
function findMain(root: ElementNode): ElementNode {
  for (const element of walk(root)) {
    if ((element.tag === "main" || element.attrs.role === "main") && cleanText(element).length > 200) {
      return element;
    }
  }

  let best: ElementNode = root;
  let bestScore = 0;
  for (const element of walk(root)) {
    if (!["article", "section", "div", "body"].includes(element.tag)) continue;
    if (inChrome(element)) continue;

    const length = cleanText(element).length;
    if (length < 200) continue;

    // Text that is not link text, so a nav-heavy wrapper cannot win on bulk.
    const score = length * (1 - linkDensity(element));
    if (score > bestScore) {
      best = element;
      bestScore = score;
    }
  }
  return best;
}

function metaContent(root: ElementNode, names: string[]): string | undefined {
  for (const name of names) {
    for (const element of walk(root)) {
      if (element.tag !== "meta") continue;
      const key = (element.attrs.name ?? element.attrs.property ?? "").toLowerCase();
      const content = element.attrs.content?.trim();
      if (key === name && content) return content.replace(/\s+/g, " ");
    }
  }
  return undefined;
}

function firstText(root: ElementNode, tag: string): string | undefined {
  for (const element of walk(root)) {
    if (element.tag === tag) {
      const text = cleanText(element);
      if (text) return text;
    }
  }
  return undefined;
}

function siteNameOf(root: ElementNode, url: string): string {
  const brand = metaContent(root, ["og:site_name", "application-name"]);
  if (brand) return brand;

  const title = firstText(root, "title") ?? metaContent(root, ["og:title"]);
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  if (!title) return firstText(root, "h1") ?? hostname;

  // A CMS welds the brand onto every page title; the brand is the part shared
  // with the hostname, so prefer what is left once that is removed.
  const bare = hostname.split(".")[0];
  const parts = title.split(/\s+[|–—·•-]\s+/).map((part) => part.trim()).filter(Boolean);
  const branded = parts.find((part) => similarity(part, bare) > 0.4);
  return branded ?? stripBrandSuffix(title);
}

/** The page's one-line summary, or nothing if the page never states one. */
function summaryOf(root: ElementNode, main: ElementNode, siteName: string): string | undefined {
  const meta = metaContent(root, ["description", "og:description", "twitter:description"]);
  if (meta && meta.length > 20) return sentences(meta)[0] ?? meta;

  // Failing that, the first real sentence of the article - long enough to say
  // something, and not just the site's own name again.
  for (const element of walk(main)) {
    if (element.tag !== "p" || inChrome(element)) continue;
    const text = cleanText(element);
    if (text.length < 40) continue;

    const sentence = sentences(text)[0] ?? text;
    if (sentence.split(/\s+/).length >= 6 && similarity(sentence, siteName) < 0.8) return sentence;
  }
  return undefined;
}

/**
 * Orienting paragraphs: what a reader needs before the link lists make sense.
 * Kept deliberately short, and skipped entirely when it would only echo the
 * summary - the template asks for omission over padding.
 */
function proseOf(main: ElementNode, summary: string | undefined): string[] {
  const kept: string[] = [];

  for (const element of walk(main)) {
    if (element.tag !== "p" || inChrome(element)) continue;
    if (linkDensity(element) > 0.5) continue;

    const text = cleanText(element);
    if (text.length < 60 || text.split(/\s+/).length < 12) continue;
    if (summary && coverage(text, summary) > 0.7) continue;
    if (kept.some((existing) => similarity(existing, text) > 0.6)) continue;

    kept.push(text);
    if (kept.length === 2) break;
  }
  return kept;
}

/** Collapses the ways one page is written as several URLs. */
function canonicalUrl(href: string, base: URL): URL | null {
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.host !== base.host) return null;
  if (NON_PAGE.test(url.pathname)) return null;

  url.hash = "";
  url.protocol = base.protocol;
  url.search = url.search === "?" ? "" : url.search;
  url.pathname = url.pathname.replace(/\/index\.(html?|php)$/i, "/").replace(/(.)\/$/, "$1");
  return url;
}

/**
 * Card and tile text arrives as fragments run together - "Opus 5 Complex
 * projects Agents Coding" is four labels, not a sentence. Real prose almost
 * always contains a function word; a pile of labels almost never does.
 */
const FUNCTION_WORD = /\b(the|a|an|and|or|to|for|with|of|in|on|that|your|you|it|is|are|from|by|as)\b/i;

function readsAsProse(text: string): boolean {
  const words = text.split(/\s+/);
  return words.length < 4 || FUNCTION_WORD.test(text);
}

/**
 * A note for a link, taken from what the page already says next to it: a title
 * attribute, or the description sitting beside it in a card or list item.
 *
 * The container has to hold exactly one link. A nav list also "contains" text
 * near the link, but that text is the other nav items - which is how this read
 * "Changes" as being described by every sibling entry in the menu.
 */
function noteFor(anchor: ElementNode, title: string, pageTitles: string[]): string | undefined {
  const candidates: string[] = [];

  const described = anchor.attrs.title || anchor.attrs["aria-label"];
  if (described) candidates.push(described);

  if (!inChrome(anchor)) {
    const container = ancestors(anchor).find((parent) => {
      if (CHROME_TAGS.has(parent.tag) || parent.tag === "#root" || parent.tag === "body") return false;
      if (cleanText(parent).length <= title.length + 40) return false;
      return [...walk(parent)].filter((node) => node.tag === "a" && node.attrs.href).length === 1;
    });

    if (container) {
      for (const child of container.children) {
        if (isElement(child) && child.tag === "a") continue;
        const text = cleanText(child);
        if (text.length > 20) candidates.push(text);
      }
    }
  }

  for (const candidate of candidates) {
    const note = sentences(candidate.replace(/\s+/g, " "))[0]?.replace(/[.\s]+$/, "");
    if (!note || note.length < 15 || note.length > 160) continue;
    if (coverage(note, title) > 0.75) continue;
    if (!readsAsProse(note)) continue;
    // The page's own title or summary describes the page, not the link.
    if (pageTitles.some((text) => similarity(note, text) > 0.6)) continue;
    return note;
  }
  return undefined;
}

/**
 * Every same-site link, named and grouped. Navigation is where the links are,
 * so unlike prose it is read rather than discarded (rule 4).
 */
function collectLinks(
  root: ElementNode,
  base: URL,
  pageTitles: string[],
): Map<string, { entry: LinkEntry; segments: string[] }> {
  const found = new Map<string, { entry: LinkEntry; segments: string[] }>();

  for (const anchor of walk(root)) {
    if (anchor.tag !== "a" || !anchor.attrs.href) continue;

    const url = canonicalUrl(anchor.attrs.href, base);
    if (!url) continue;

    const key = url.toString();
    if (key === base.toString()) continue;

    const anchorText = cleanText(anchor);
    const segments = url.pathname.split("/").filter(Boolean).filter((segment) => !LOCALE_SEGMENT.test(segment));
    const slug = segments[segments.length - 1] ?? "";

    // Anchor text when it names the page; the slug when it is an icon, a bare
    // arrow, or boilerplate like "read more" (rule: {{link_title}}).
    const usable =
      anchorText.length >= 3 &&
      anchorText.length <= 90 &&
      !GENERIC_LABEL.test(anchorText) &&
      !DEICTIC_LABEL.test(anchorText);
    const title = usable ? anchorText : humanize(slug) || anchorText || url.pathname;
    if (!title) continue;

    const existing = found.get(key);
    // Rule 3: the same page twice keeps the shorter, plainer title.
    if (existing && existing.entry.title.length <= title.length) continue;

    found.set(key, { entry: { url: key, title, note: noteFor(anchor, title, pageTitles) }, segments });
  }
  return found;
}

/**
 * Section names come from the page's own words: the nav or heading label above
 * a group of links, else the path segment they share. Never a fixed list -
 * across the sampled files, section names were almost entirely site-specific.
 */
function labelForGroup(root: ElementNode, group: string, urls: Set<string>, base: URL): string {
  if (!group) return "Pages";

  let best: string | undefined;
  for (const element of walk(root)) {
    if (!/^(h[1-6]|summary|strong|legend|button)$/.test(element.tag)) continue;

    const label = cleanText(element);
    if (!label || label.length > 40 || GENERIC_LABEL.test(label)) continue;

    // Does this heading sit above a block whose links are mostly this group?
    const container = element.parent;
    if (!container) continue;

    let hits = 0;
    let total = 0;
    for (const anchor of walk(container)) {
      if (anchor.tag !== "a" || !anchor.attrs.href) continue;
      const url = canonicalUrl(anchor.attrs.href, base);
      if (!url) continue;
      total += 1;
      if (urls.has(url.toString())) hits += 1;
    }
    // The match has to hold both ways: most of this heading's links belong to
    // the group, AND the heading accounts for most of the group. Without the
    // second test a heading sitting above a handful of a large group's links
    // gets to name the whole thing.
    const namesTheGroup = total >= 2 && hits / total >= 0.6 && hits >= 0.6 * urls.size;
    if (namesTheGroup && (!best || label.length < best.length)) best = label;
  }

  // Nav labels are written as instructions to a visitor ("Explore Services
  // Pages"); a section name only wants the noun.
  const label = (best ?? humanize(group))
    .replace(/^(explore|browse|view|see|discover|all|our|the)\s+/i, "")
    .replace(/\s+(pages?|links?|menu|section|navigation)$/i, "")
    .trim();

  return titleCase(label || humanize(group) || group);
}

/**
 * Which path segment to group on.
 *
 * The first one is the obvious choice and the wrong one for a documentation
 * site, where every page is /docs/something and the whole file collapses into
 * a single section. So: if one bucket swallows most of the links, go a segment
 * deeper for the pages that have one.
 */
function groupKeyFor(segments: string[], depth: number): string {
  if (segments.length <= 1) return "";
  return segments[Math.min(depth, segments.length - 2)];
}

function chooseDepth(all: string[][]): number {
  const deep = all.filter((segments) => segments.length > 1);
  if (deep.length < 5) return 0;

  const counts = new Map<string, number>();
  for (const segments of deep) {
    const key = groupKeyFor(segments, 0);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const largest = Math.max(...counts.values());
  return largest >= 0.6 * deep.length ? 1 : 0;
}

export function extract(html: string, url: string): Extraction {
  const root = parseHtml(html);
  const base = new URL(url);
  const main = findMain(root);

  const siteName = siteNameOf(root, url);
  const summary = summaryOf(root, main, siteName);
  const pageTitles = [siteName, firstText(root, "h1"), firstText(root, "title"), summary].filter(
    (text): text is string => Boolean(text),
  );
  const links = collectLinks(root, base, pageTitles);
  const depth = chooseDepth([...links.values()].map(({ segments }) => segments));

  const optional: LinkEntry[] = [];
  const groups = new Map<string, LinkEntry[]>();

  for (const { entry, segments } of links.values()) {
    const path = new URL(entry.url).pathname.toLowerCase();
    if (OPTIONAL_PATTERN.test(path) || OPTIONAL_PATTERN.test(entry.title.toLowerCase())) {
      optional.push(entry);
      continue;
    }
    const key = groupKeyFor(segments, depth);
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  const sections: Section[] = [];
  for (const [group, entries] of groups) {
    // Rule 3 again, across entries rather than URLs: near-identical titles are
    // the same page until proven otherwise, and the shortest form wins.
    const deduped: LinkEntry[] = [];
    for (const entry of entries.sort((a, b) => a.title.length - b.title.length)) {
      if (deduped.some((kept) => similarity(kept.title, entry.title) > 0.8)) continue;
      deduped.push(entry);
    }

    if (deduped.length === 0) continue; // Rule 6: empty sections are dropped.
    sections.push({
      name: labelForGroup(root, group, new Set(deduped.map((entry) => entry.url)), base),
      links: deduped,
    });
  }

  // Biggest sections first, but the ungrouped catch-all never leads.
  sections.sort((a, b) => (a.name === "Pages" ? 1 : b.name === "Pages" ? -1 : b.links.length - a.links.length));

  return {
    siteName,
    summary,
    clientRendered: links.size === 0 && cleanText(root).length < 1500,
    prose: proseOf(main, summary),
    sections: curate(sections),
    optional: optional.slice(0, MAX_LINKS_PER_SECTION),
  };
}

/**
 * Trims the result to something a reader can hold: a lone link is not a
 * section, there is a limit to how many sections earn their heading, and a
 * section past a couple of dozen links has stopped being a curated list.
 */
function curate(sections: Section[]): Section[] {
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
    const links = section.links.slice(0, Math.min(MAX_LINKS_PER_SECTION, budget));
    if (links.length === 0) break;
    budget -= links.length;
    result.push({ ...section, links });
  }
  return result;
}

/** Renders the extraction in the order TEMPLATE.txt fixes. */
export function render(extraction: Extraction, url: string): string {
  const out: string[] = [`# ${extraction.siteName}`, ""];

  if (extraction.summary) out.push(`> ${extraction.summary}`, "");
  for (const paragraph of extraction.prose) out.push(paragraph, "");

  const line = (entry: LinkEntry) =>
    `- [${entry.title}](${entry.url})${entry.note ? `: ${entry.note}` : ""}`;

  for (const section of extraction.sections) {
    out.push(`## ${section.name}`, "", ...section.links.map(line), "");
  }
  if (extraction.optional.length > 0) {
    out.push("## Optional", "", ...extraction.optional.map(line), "");
  }

  if (extraction.sections.length === 0 && extraction.optional.length === 0) {
    // Saying which of the two happened matters: an empty site and a page whose
    // links only exist after its JavaScript runs need different fixes.
    out.push(
      extraction.clientRendered
        ? `_${url} returned an application shell; its links are added by JavaScript, which a single fetch does not run._`
        : `_No links to other pages were found on ${url}._`,
      "",
    );
  }
  return out.join("\n");
}

export function buildLlmsTxt(html: string, url: string): string {
  return render(extract(html, url), url);
}
