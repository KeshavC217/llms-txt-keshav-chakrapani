import natural from "natural";
import type { PageInfo } from "./types";

// The characters sites use to glue a brand suffix onto a page <title>.
// Beyond the obvious "-" / "|" / ":", real sites in the wild use a backslash
// ("Research \ Anthropic"), an en/em dash, a middot, a bullet, and guillemets.
const SEPARATOR_REGEX = /\s+[-|:·•—–~»\\]\s+/;
const MIN_TERM_LENGTH = 3;
const MIN_CLUSTER_SIZE = 2;
const STOPWORDS = new Set(natural.stopwords);
const GENERIC_TITLE_WORDS = new Set([
  "overview",
  "introduction",
  "index",
  "home",
  "docs",
  "documentation",
  "getting started",
]);
const SITE_SUFFIX_WORDS = new Set(["docs", "documentation", "doc"]);
const KNOWN_ACRONYMS = new Set([
  "api",
  "sdk",
  "cli",
  "ui",
  "ux",
  "url",
  "html",
  "css",
  "json",
  "xml",
  "sql",
  "ai",
  "ml",
  "rsc",
  "ssr",
  "csr",
  "cdn",
  "dns",
  "vpc",
  "iot",
  "mcp",
]);

const MIN_SUFFIX_SAMPLE = 2;

interface TitleSplit {
  prefix: string;
  suffixRaw: string;
  suffixWords: string[];
}

function splitTitle(title: string): TitleSplit | null {
  const parts = title.split(SEPARATOR_REGEX).map((p) => p.trim());
  if (parts.length < 2) return null;

  const suffixRaw = parts[parts.length - 1];
  const prefix = parts.slice(0, -1).join(" - ").trim();
  const suffixWords = suffixRaw
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= MIN_TERM_LENGTH && /^[a-z]+$/.test(w));

  return { prefix, suffixRaw, suffixWords };
}

/**
 * Page <title> tags almost always append a site-name suffix ("Foo - Docker
 * Docs", "Overview · Cloudflare Workers docs"). We strip that trailing
 * boilerplate so titles read cleanly like the ones in curated llms.txt files
 * ("Foo", "Workers") rather than raw <title> dumps.
 *
 * Rather than guess the brand from the hostname (which breaks the moment the
 * domain spells the brand differently than the page content does — e.g.
 * "claracars.pt" vs. the displayed "Clara Carros", "cars" vs "carros"), this
 * detects the boilerplate directly from the crawled titles themselves: any
 * word that shows up in the trailing segment of most titles (site name,
 * "docs", etc.) is treated as boilerplate, regardless of the URL.
 *
 * Some sites (Cloudflare included) put the actually-distinguishing word
 * *inside* that suffix instead of the prefix, reusing a generic prefix like
 * "Overview" across every product page. When the prefix is one of those
 * generic words, we pull the distinguishing word(s) out of the suffix
 * instead (whatever's left after removing the detected boilerplate words).
 */
export function cleanTitles(pages: PageInfo[]): PageInfo[] {
  const withSuffix = pages
    .map((page) => ({ page, split: splitTitle(page.title) }))
    .filter((x): x is { page: PageInfo; split: TitleSplit } => x.split !== null);

  if (withSuffix.length < MIN_SUFFIX_SAMPLE) return pages;

  const documentFrequency = new Map<string, number>();
  for (const { split } of withSuffix) {
    for (const word of new Set(split.suffixWords)) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }

  const threshold = Math.max(MIN_SUFFIX_SAMPLE, Math.ceil(withSuffix.length * 0.5));
  const brandWords = new Set(
    Array.from(documentFrequency.entries())
      .filter(([, count]) => count >= threshold)
      .map(([word]) => word)
  );

  if (brandWords.size === 0) return pages;

  const isBoilerplate = (word: string) => brandWords.has(word) || SITE_SUFFIX_WORDS.has(word);

  return pages.map((page) => {
    const split = splitTitle(page.title);
    if (!split) return page;

    const { prefix, suffixRaw, suffixWords } = split;

    if (suffixWords.length > 0 && suffixWords.every(isBoilerplate)) {
      return { ...page, title: prefix || page.title };
    }

    if (GENERIC_TITLE_WORDS.has(prefix.toLowerCase())) {
      const distinguishing = suffixRaw
        .split(/\s+/)
        .filter((word) => !isBoilerplate(word.toLowerCase()))
        .join(" ")
        .trim();
      if (distinguishing) return { ...page, title: distinguishing };
    }

    return { ...page, title: prefix || page.title };
  });
}

const tokenizer = new natural.WordTokenizer();
const stemmer = natural.PorterStemmer;

interface TermOccurrence {
  stem: string;
  surface: string;
}

function extractTerms(text: string): TermOccurrence[] {
  return tokenizer
    .tokenize(text.toLowerCase())
    .filter((t) => t.length >= MIN_TERM_LENGTH && !STOPWORDS.has(t) && /^[a-z]+$/.test(t))
    .map((t) => ({ stem: stemmer.stem(t), surface: t }));
}

/**
 * Groups pages that didn't match a known path-based section (e.g. /docs,
 * /blog) into topical clusters, instead of dumping them all into one
 * undifferentiated "Pages" bucket.
 *
 * Note this deliberately does NOT use TF-IDF's top-scoring term per page:
 * TF-IDF's whole purpose is to *downweight* words that recur across many
 * documents, which is exactly the opposite of what a shared-topic signal
 * looks like (a word repeated across several pages, like a recurring
 * product/technology name, IS the cluster). Instead we compute plain
 * document frequency (via stemmed, stopword-filtered tokens) and group pages
 * around terms that appear on at least two of them — while still excluding
 * near-universal terms (site boilerplate, the brand name) via an upper
 * bound, so we don't just recreate one giant "everything" bucket.
 */
export function clusterByKeyword(pages: PageInfo[]): Map<string, PageInfo[]> {
  if (pages.length < MIN_CLUSTER_SIZE) {
    return new Map(pages.length ? [["Pages", pages]] : []);
  }

  const pageTerms = pages.map((page) => extractTerms(`${page.title} ${page.description ?? ""}`));

  const documentFrequency = new Map<string, number>();
  const surfaceCounts = new Map<string, Map<string, number>>();

  for (const terms of pageTerms) {
    const seenInPage = new Set<string>();
    for (const { stem, surface } of terms) {
      if (!seenInPage.has(stem)) {
        seenInPage.add(stem);
        documentFrequency.set(stem, (documentFrequency.get(stem) ?? 0) + 1);
      }
      if (!surfaceCounts.has(stem)) surfaceCounts.set(stem, new Map());
      const surfaces = surfaceCounts.get(stem)!;
      surfaces.set(surface, (surfaces.get(surface) ?? 0) + 1);
    }
  }

  const maxDocFrequency = Math.max(MIN_CLUSTER_SIZE, Math.floor(pages.length * 0.5));

  const rawGroups = new Map<string, PageInfo[]>();
  const leftovers: PageInfo[] = [];

  pages.forEach((page, i) => {
    const uniqueStems = Array.from(new Set(pageTerms[i].map((t) => t.stem)));
    const candidates = uniqueStems
      .filter((stem) => {
        const df = documentFrequency.get(stem) ?? 0;
        return df >= MIN_CLUSTER_SIZE && df <= maxDocFrequency;
      })
      .sort((a, b) => (documentFrequency.get(b) ?? 0) - (documentFrequency.get(a) ?? 0));

    const chosen = candidates[0];
    if (!chosen) {
      leftovers.push(page);
      return;
    }
    if (!rawGroups.has(chosen)) rawGroups.set(chosen, []);
    rawGroups.get(chosen)!.push(page);
  });

  const result = new Map<string, PageInfo[]>();

  for (const [stem, group] of rawGroups) {
    if (group.length >= MIN_CLUSTER_SIZE) {
      result.set(labelForStem(stem, surfaceCounts), group);
    } else {
      leftovers.push(...group);
    }
  }

  if (leftovers.length) result.set("Pages", leftovers);

  return result;
}

/** Picks the most common original-case surface form of a stem to use as a readable section label. */
function labelForStem(stem: string, surfaceCounts: Map<string, Map<string, number>>): string {
  const surfaces = surfaceCounts.get(stem);
  if (!surfaces || surfaces.size === 0) return titleCase(stem);

  let best = stem;
  let bestCount = -1;
  for (const [surface, count] of surfaces) {
    if (count > bestCount) {
      best = surface;
      bestCount = count;
    }
  }
  return titleCase(best);
}

/** Title-cases a single word, upper-casing it in full when it's a known acronym (e.g. "api" -> "API"). */
export function titleCase(word: string): string {
  if (KNOWN_ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}
