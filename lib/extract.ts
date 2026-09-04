import * as cheerio from "cheerio";
import nlp from "compromise";
import type { AnyNode } from "domhandler";

export interface ExtractedMetadata {
  title: string;
  description?: string;
  /** Same-origin absolute URL from <link rel="canonical">, when the page declares one. */
  canonicalUrl?: string;
}

const MIN_FALLBACK_SENTENCE_LENGTH = 25;
const MAX_DESCRIPTION_LENGTH = 200;
const MIN_PROSE_WORDS = 5;
const MAX_AVG_WORD_LENGTH = 12;

// Titles used by loading spinners / client-side-redirect stubs before their
// real content (or an auth wall) takes over. A page stuck on one of these
// after render is not real content, so callers should drop it rather than
// publish the placeholder into llms.txt.
const PLACEHOLDER_TITLE_PATTERN = /^(loading|redirecting|please wait|just a moment)\.{0,3}$/i;

/** Whether a page's rendered title is a loading/redirect stub rather than real content. */
export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLE_PATTERN.test(title.trim());
}

/**
 * Pulls a best-effort title/description out of a page's HTML using plain
 * heuristics: <title>, then <h1>; <meta name="description">, then og:description,
 * then (if both are absent) the first substantive sentence of the page body.
 */
export function extractMetadata(html: string, fallbackUrl: string): ExtractedMetadata {
  const $ = cheerio.load(html);

  const h1 = $("h1").first();
  const title =
    clean($("title").first().text()) ||
    clean(h1.length ? textWithSpacing($, h1.get(0)!) : "") ||
    fallbackUrl;

  // Capped for every source, not just the prose fallback. Sites routinely ship
  // 800-character meta descriptions (resy.com puts a restaurant's full blurb
  // in one), which the spec's "- [name](url): notes" line is not for — an
  // uncapped description turns the file into prose and crowds out the links.
  const description = truncate(
    clean($('meta[name="description"]').attr("content")) ||
      clean($('meta[property="og:description"]').attr("content")) ||
      extractFallbackDescription($),
    MAX_DESCRIPTION_LENGTH
  );

  return { title, description: description || undefined, canonicalUrl: extractCanonicalUrl($, fallbackUrl) };
}

/**
 * Reads <link rel="canonical">, the page's own statement of which URL is the
 * real one. Sites routinely serve identical content at several paths
 * (/amenities and /amenities.htm, ?utm_source= variants, trailing-slash
 * pairs), and following the canonical collapses those into one entry instead
 * of listing the same page two or three times in llms.txt.
 *
 * Cross-origin canonicals are ignored: a syndicated page pointing at the
 * original publisher would otherwise inject another site's URL into our
 * output for a page we crawled here.
 */
function extractCanonicalUrl($: cheerio.CheerioAPI, pageUrl: string): string | undefined {
  const href = clean($('link[rel="canonical"]').attr("href"));
  if (!href) return undefined;

  try {
    const base = new URL(pageUrl);
    const resolved = new URL(href, base);
    if (resolved.origin !== base.origin) return undefined;
    if (!/^https?:$/.test(resolved.protocol)) return undefined;
    resolved.hash = "";
    return resolved.toString().replace(/\/$/, "") || resolved.toString();
  } catch {
    return undefined;
  }
}

/**
 * When a page has no meta description, we fall back to the first substantive
 * prose sentence found in a <p> tag within the main content (skipping
 * nav/header/footer chrome). We scan actual <p> elements rather than all body
 * text so we don't pick up UI chrome (button labels, card grids) that reads
 * as one long run of concatenated words with no real sentence structure —
 * isProse() sanity-checks each candidate for that. Sentence splitting uses
 * compromise rather than naive regex so we don't cut mid-abbreviation ("e.g.").
 */
function extractFallbackDescription($: cheerio.CheerioAPI): string {
  const contentRoot = $("main, article").first();
  const scope = contentRoot.length ? contentRoot : $("body");

  const paragraphs = scope.find("p").toArray();

  for (const el of paragraphs) {
    const $el = $(el);
    if ($el.closest("nav, header, footer, aside, script, style, noscript").length) continue;

    const text = clean($el.text());
    if (!isProse(text)) continue;

    const sentences = nlp(text).sentences().out("array") as string[];
    const firstSubstantive = sentences.find(
      (s) => s.trim().length >= MIN_FALLBACK_SENTENCE_LENGTH && isProse(s.trim())
    );
    if (firstSubstantive) return truncate(firstSubstantive.trim(), MAX_DESCRIPTION_LENGTH);
  }

  return "";
}

/** Rejects text that's too short, too word-sparse, or full of concatenated non-words (UI chrome). */
function isProse(text: string): boolean {
  if (text.length < MIN_FALLBACK_SENTENCE_LENGTH) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < MIN_PROSE_WORDS) return false;
  const avgWordLength = text.replace(/\s+/g, "").length / words.length;
  return avgWordLength <= MAX_AVG_WORD_LENGTH;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1).trimEnd() + "…";
}

/** Extracts same-origin hrefs from a page, resolved to absolute URLs, deduped. */
export function extractInternalLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
      return;
    }

    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      return;
    }

    if (resolved.origin !== base.origin) return;
    if (!/^https?:$/.test(resolved.protocol)) return;

    resolved.hash = "";
    const normalized = resolved.toString().replace(/\/$/, "") || resolved.toString();

    seen.add(normalized);
  });

  return Array.from(seen);
}

function clean(value: string | undefined | null): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Like cheerio's `.text()`, but inserts a space around each nested element's
 * text instead of concatenating raw text nodes directly against each other.
 * Adjacent sibling elements with no whitespace text node between them in the
 * source (e.g. `<div>Careers</div><div>5</div><p>Shape the future...</p>`)
 * would otherwise collapse into one run-on string ("Careers5Shape the future
 * with us") once tags are stripped. The extra spaces this introduces around
 * genuinely-adjacent inline content (e.g. "$" + "100") are harmless since
 * clean() collapses repeated whitespace anyway.
 */
export function textWithSpacing($: cheerio.CheerioAPI, el: AnyNode): string {
  let text = "";
  $(el)
    .contents()
    .each((_, node) => {
      if (node.type === "text") {
        text += (node as unknown as { data: string }).data;
      } else if (node.type === "tag") {
        text += ` ${textWithSpacing($, node)} `;
      }
    });
  return text;
}
