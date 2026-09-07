/**
 * Small text utilities the extractor leans on. Nothing statistical enough to
 * deserve the name "model" — tokenizing, comparing and tidying strings, which
 * is what the template's rules actually need: is this title the same page as
 * that one, does this note restate its link, where does the first sentence end.
 */

/** Function words carry no signal when comparing two short titles. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "from", "by",
  "is", "are", "was", "were", "be", "been", "our", "your", "their", "its", "it", "this", "that",
  "these", "those", "as", "how", "what", "why", "when", "all", "you", "we", "us", "about", "into",
  "more", "get", "getting", "new", "page", "home", "learn", "read",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
}

/**
 * Crude suffix stripping - enough that "integration" and "integrations" collide
 * when comparing titles. It does not relate different forms of a word:
 * "pricing" and "price" stay distinct, which a real stemmer would collapse and
 * which has not been worth the machinery.
 */
export function stem(word: string): string {
  if (word.length <= 3) return word;

  // Plurals first, and by the actual English rules: stripping a blanket "es"
  // turns "guides" into "guid" while "guide" stays whole, so the two forms of
  // one title stop matching - which is the whole point of stemming here.
  if (word.endsWith("ies") && word.length > 4) {
    return word.endsWith("ities") ? `${word.slice(0, -5)}ity` : `${word.slice(0, -3)}y`;
  }
  if (/(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);

  for (const suffix of ["ing", "ed"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  }
  return word;
}

/** Content words only, stemmed — the form everything below compares on. */
export function contentTokens(text: string): string[] {
  return tokenize(text)
    .filter((word) => !STOPWORDS.has(word))
    .map(stem);
}

/** Jaccard overlap of two token sets: 1 identical, 0 disjoint. */
export function similarity(a: string, b: string): number {
  const left = new Set(contentTokens(a));
  const right = new Set(contentTokens(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * How much of `part` is already said by `whole`. Asymmetric on purpose: a note
 * that restates its link title is worthless even when the title says more
 * besides, which a symmetric measure would score as only half-overlapping.
 */
export function coverage(part: string, whole: string): number {
  const tokens = new Set(contentTokens(part));
  if (tokens.size === 0) return 1;

  const reference = new Set(contentTokens(whole));
  let shared = 0;
  for (const token of tokens) if (reference.has(token)) shared += 1;
  return shared / tokens.size;
}

/**
 * Site names arrive welded to the page title by a CMS: "Pricing – Acme",
 * "Docs | Acme". Splits on the usual separators and keeps the longest part,
 * which is the page's own name rather than the brand.
 */
export function stripBrandSuffix(title: string, brand?: string): string {
  const parts = title.split(/\s+[|–—·•-]\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return title.trim();

  if (brand) {
    // Containment, not overlap: "Acme Inc" contains the brand "Acme" but a
    // symmetric measure scores that only 0.5, and the suffix survives.
    const kept = parts.filter((part) => coverage(brand, part) < 0.8);
    if (kept.length > 0) return kept.join(" - ");
  }
  return parts.reduce((longest, part) => (part.length > longest.length ? part : longest));
}

/**
 * Splits on sentence punctuation. Requiring a capital after the break keeps
 * decimals and "e.g." from ending a sentence, at the cost of missing one that
 * starts lowercase - the safer way to be wrong, since a run-on sentence is
 * still usable and a truncated one is not.
 */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"(])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Words that stay lowercase inside a title, but not at the start of one. */
const MINOR_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "nor", "of", "on", "in", "to", "with", "at", "by",
  "from", "as", "per", "via",
]);

/** Title Case, leaving acronyms (API, FAQ) alone: "Agents and Tools". */
export function titleCase(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words
    .map((word, index) => {
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      const lower = word.toLowerCase();
      if (index > 0 && MINOR_WORDS.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/** "getting-started" / "api_reference" -> "Getting Started" / "API Reference". */
export function humanize(slug: string): string {
  const words = slug
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => {
      // Keep acronyms upper, including the plural: "sdks" -> "SDKs", not "SDKS".
      const acronym = word.match(/^(api|faq|sdk|cli|ui|ux|ai|llm|seo|url|css|html|json|rss|cdn|db)(s?)$/i);
      return acronym ? acronym[1].toUpperCase() + acronym[2].toLowerCase() : word;
    });
  return titleCase(words.join(" "));
}
