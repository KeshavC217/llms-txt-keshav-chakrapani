import { documentTitle, formatLink, groupPagesIntoSections } from "./buildLlmsTxt";
import { requestJson } from "./openrouter";
import type { CrawlResult, PageInfo } from "./types";

export { isAiConfigured } from "./openrouter";

const MAX_TITLE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 220;
const MAX_INTRO_LENGTH = 500;
const OPTIONAL_SECTION = "Optional";

interface EnhancementPlan {
  siteTitle?: string;
  siteDescription?: string;
  siteIntro?: string;
  sectionLabels?: Record<string, string>;
  // A field explicitly set to null means "remove it" (e.g. a description
  // that's identical across pages and therefore carries no information) —
  // distinct from omitting the field, which means "leave it unchanged".
  pageEdits?: Record<string, { title?: string; description?: string | null }>;
  // URLs to demote into a single "## Optional" section — the one narrow,
  // explicit exception to "never move a page between sections" (see the
  // prompt's "may NOT" list). Everything else about page/section placement
  // is fixed by the deterministic crawler.
  optionalUrls?: string[];
}

/**
 * Runs a mechanical copyedit pass over an already-fully-assembled llms.txt:
 * every section, every page, every URL is already final — this only rewords
 * text (and, for a page explicitly flagged as skippable, demotes it into the
 * spec's own "Optional" bucket rather than deleting it). The model gets a
 * fixed procedure to apply line by line (not a goal to plan toward), and its
 * output is a sparse edit map, not a document it regenerates. Every edit is
 * validated against the known page/section set before being spliced into the
 * deterministic output, so the model has no path to add, drop, or re-point a
 * page, or invent a URL — only to rewrite the words already there and choose
 * what's skippable.
 */
export interface EnhancementResult {
  llmsTxt: string;
  /**
   * Why the caller got what it got. "failed" and "no-changes" both hand back
   * the untouched deterministic document, but they mean opposite things — one
   * is the model declining to change anything, the other is the model never
   * answering — and collapsing them into "the text is the same" is what let a
   * broken AI pass look identical to a working one that had nothing to do.
   */
  status: "applied" | "no-changes" | "failed";
}

const MAX_PAGES_PER_CHUNK = 12;
const MAX_PARALLEL_CHUNKS = 6;
const SAMPLE_TITLES_PER_SECTION = 3;

interface Chunk {
  label: string;
  pages: PageInfo[];
}

/**
 * Splits the document into one work item per section, further splitting any
 * section bigger than MAX_PAGES_PER_CHUNK.
 *
 * Sizing is driven by output tokens, which is what actually fails. Measured
 * on the single-call design at the 100-page crawl budget: ~5,200 completion
 * tokens, 65% of the 8,000 cap, with no headroom for a site whose titles run
 * long — and blowing that cap is exactly the truncation that used to make the
 * whole pass silently return the un-copyedited document. A 12-page chunk
 * emits a few hundred tokens, which cannot approach the cap.
 */
function chunkSections(sections: Map<string, PageInfo[]>, sectionOrder: string[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const label of sectionOrder) {
    const pages = sections.get(label) ?? [];
    for (let i = 0; i < pages.length; i += MAX_PAGES_PER_CHUNK) {
      chunks.push({ label, pages: pages.slice(i, i + MAX_PAGES_PER_CHUNK) });
    }
  }
  return chunks;
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving output order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * A compact, read-only description of the whole document, handed to every
 * chunk worker so a worker editing one section still knows what the site is
 * and what the other sections are called — without paying to resend every
 * page's full text to every worker.
 */
function buildDigest(crawlResult: CrawlResult, sections: Map<string, PageInfo[]>, sectionOrder: string[]): string {
  const lines = sectionOrder.map((label) => {
    const pages = sections.get(label) ?? [];
    const samples = pages
      .slice(0, SAMPLE_TITLES_PER_SECTION)
      .map((p) => p.title)
      .join("; ");
    return `  - "${label}" (${pages.length} page(s)): ${samples}`;
  });

  return [
    `Site title: ${documentTitle(crawlResult, sections) || crawlResult.rootUrl}`,
    `Site summary: ${crawlResult.siteDescription || "(none)"}`,
    "Sections in this document, in order:",
    ...lines,
  ].join("\n");
}

/**
 * Runs a mechanical copyedit pass over an already-fully-assembled llms.txt:
 * every section, every page, every URL is already final — this only rewords
 * text (and, for a page explicitly flagged as skippable, demotes it into the
 * spec's own "Optional" bucket rather than deleting it). Every edit is
 * validated against the known page/section set before being spliced into the
 * deterministic output, so the model has no path to add, drop, or re-point a
 * page, or invent a URL — only to rewrite the words already there.
 *
 * The work is split across one document-level call (title, summary, intro,
 * section names) plus one call per section chunk, run in parallel. Two
 * reasons, both measured rather than assumed:
 *
 *   Headroom. See chunkSections() — a single call for a 90-page site emitted
 *   65% of the output-token cap, and overflowing it silently discarded the
 *   entire pass.
 *
 *   Partial failure. One bad provider response now costs one section's
 *   wording instead of the whole document's.
 *
 * What it deliberately does NOT split is anything needing a global view. The
 * document call owns the title, summary, intro and section names; each chunk
 * owns only its own pages. The one genuinely cross-page decision — dropping a
 * description repeated across many pages — was already moved into
 * deterministic code (dropRepeatedDescriptions in buildLlmsTxt.ts), so no
 * worker needs to see the whole document to make it.
 */
export async function enhanceLlmsTxt(crawlResult: CrawlResult, llmsTxt: string): Promise<EnhancementResult> {
  const { sections, sectionOrder } = groupPagesIntoSections(crawlResult);
  if (sectionOrder.length === 0) return { llmsTxt, status: "no-changes" };

  const pagesByUrl = new Map<string, PageInfo>();
  for (const label of sectionOrder) {
    for (const page of sections.get(label) ?? []) pagesByUrl.set(page.url, page);
  }

  const digest = buildDigest(crawlResult, sections, sectionOrder);
  const chunks = chunkSections(sections, sectionOrder);

  const [documentPlan, chunkPlans] = await Promise.all([
    requestJson<EnhancementPlan>(buildDocumentPrompt(digest, sectionOrder)),
    mapWithConcurrency(chunks, MAX_PARALLEL_CHUNKS, (chunk) =>
      requestJson<EnhancementPlan>(buildChunkPrompt(digest, chunk))
    ),
  ]);

  const answered = [documentPlan, ...chunkPlans].filter((p): p is EnhancementPlan => p !== null);
  // Every single call failed — that is our problem (a bad model or route),
  // not the model choosing to leave the document alone, and the caller must
  // be able to tell those apart.
  if (answered.length === 0) return { llmsTxt, status: "failed" };

  const merged = mergePlans(documentPlan, chunkPlans);
  const applied = applyPlan(llmsTxt, sectionOrder, pagesByUrl, merged);
  return { llmsTxt: applied, status: applied === llmsTxt ? "no-changes" : "applied" };
}

/**
 * Combines the document-level plan with the per-chunk plans. Each chunk may
 * only contribute edits for its own pages, so the maps are disjoint by
 * construction; document-level fields come only from the document call.
 */
function mergePlans(documentPlan: EnhancementPlan | null, chunkPlans: (EnhancementPlan | null)[]): EnhancementPlan {
  const merged: EnhancementPlan = {
    siteTitle: documentPlan?.siteTitle,
    siteDescription: documentPlan?.siteDescription,
    siteIntro: documentPlan?.siteIntro,
    sectionLabels: documentPlan?.sectionLabels,
    pageEdits: {},
    optionalUrls: [],
  };

  for (const plan of chunkPlans) {
    if (!plan) continue;
    if (plan.pageEdits && typeof plan.pageEdits === "object") {
      Object.assign(merged.pageEdits!, plan.pageEdits);
    }
    if (Array.isArray(plan.optionalUrls)) {
      merged.optionalUrls!.push(...plan.optionalUrls.filter((u) => typeof u === "string"));
    }
  }

  return merged;
}

const COPYEDIT_RULES = [
  "1. If a title or summary contains the site's own brand name more than",
  "   once (a common artifact of broken SEO-plugin title templates, e.g.",
  "   'The Workspace for Video Teams - Acme : Acme'), collapse it to a",
  "   single mention of the brand, keeping whichever wording is more",
  "   descriptive.",
  "2. If the description just repeats the title in other words, delete the",
  "   repeated part — a reader already saw the title.",
  "3. Rewrite the description as exactly one sentence, present tense, ending",
  "   in a period.",
  "4. Delete generic marketing filler that carries no information",
  '   ("leading", "industry-leading", "world-class", "innovative",',
  '   "best-in-class", "revolutionary", "seamless", "cutting-edge")',
  "   unless the word is part of the company's own product name.",
  "5. Fix scraping artifacts: words fused together with no space, stray",
  "   HTML/whitespace, inconsistent capitalization.",
  "6. If a title is longer than about 6 words, shorten it to the shortest",
  "   phrase that still identifies what the link is — never change what it",
  "   refers to.",
  "7. Do not add any fact, name, or number that isn't already present in the",
  "   title or description you were given. If you would have to invent",
  "   something to make a sentence read well, leave it as-is instead.",
].join("\n");

/** The one call that owns document-wide fields: title, summary, intro, section names. */
function buildDocumentPrompt(digest: string, sectionOrder: string[]): string {
  return [
    "You are copyediting the header of a machine-generated llms.txt index.",
    "A deterministic crawler already chose every page, every URL and every",
    "section. You are editing ONLY the document's own title, summary, an",
    "optional intro paragraph, and the section NAMES. You are not editing any",
    "page, and you must not invent facts.",
    "",
    "Apply these to the site title and site summary:",
    COPYEDIT_RULES,
    "",
    "Then:",
    "8. Write a short (1-2 sentence) intro paragraph as siteIntro, ONLY if you",
    "   can state it from facts visible below — e.g. naming the product's 2-3",
    "   main parts. If you'd have to guess, or the summary already covers it,",
    "   omit siteIntro entirely rather than pad it with filler.",
    "9. For any section header that is a raw keyword, a path fragment (e.g.",
    '   "Web-design", "Case-studies"), a single word guessed from page content,',
    '   or the catch-all "Pages" — rename it to the shortest phrase (1-3 words,',
    "   title case, no hyphens) a human editor of this specific site would have",
    "   written. Prefer names describing the KIND of question a page answers",
    '   ("Guides", "Pricing", "Case Studies"). Leave every other header',
    "   untouched, byte for byte.",
    "",
    "Leave out any field you would not change.",
    "",
    digest,
    "",
    `The exact section headers you may rename: ${sectionOrder.map((l) => JSON.stringify(l)).join(", ")}`,
    "",
    "Reply with ONLY a JSON object (no markdown fences, no commentary):",
    '{"siteTitle": "... or omit", "siteDescription": "... or omit", "siteIntro": "... or omit", "sectionLabels": {"OldHeader": "NewHeader"}}',
  ].join("\n");
}

/** One call per section chunk. Owns only the link text of its own pages. */
function buildChunkPrompt(digest: string, chunk: Chunk): string {
  const rows = chunk.pages
    .map((p) => `  - url: ${p.url}\n    title: ${p.title}\n    description: ${p.description ?? "(none)"}`)
    .join("\n");

  return [
    `You are copyediting ONE section ("${chunk.label}") of a machine-generated`,
    "llms.txt index. A deterministic crawler already chose these pages and",
    "their URLs; you are only rewording the text. The rest of the document is",
    "summarized below for context — do not edit anything in it.",
    "",
    "=== DOCUMENT CONTEXT (read-only) ===",
    digest,
    "=== END CONTEXT ===",
    "",
    "For every page listed below, apply all of these:",
    COPYEDIT_RULES,
    "",
    "Also:",
    "8. If a page's description says nothing its own title doesn't already",
    "   say, or is generic boilerplate that would read identically on any",
    "   page of this site, set that page's description to JSON null (not an",
    "   empty string). A page with no description is a normal, good outcome —",
    "   the spec treats descriptions as optional. Do not invent a description",
    "   to avoid leaving one null, and never write a description for a page",
    "   whose description is already \"(none)\".",
    "9. If a page's title and description are already clean, correct and",
    "   non-redundant, leave that page out of your answer entirely — do not",
    "   restate unchanged text. Check every page listed before skipping it.",
    "10. In optionalUrls, list any page here a reader could skip under context",
    "    pressure without losing anything essential: personnel/team bios, a",
    "    single dated news/blog/event post, changelogs, acknowledgements.",
    "    Never list a page if it is the only page in this section. Most",
    "    sections will have zero.",
    "",
    "You may NOT change or shorten a URL, or edit any page not listed here.",
    "",
    `Pages in "${chunk.label}":`,
    rows,
    "",
    "Reply with ONLY a JSON object (no markdown fences, no commentary), using",
    "the exact URLs above as keys:",
    '{"pageEdits": {"<url>": {"title": "...", "description": "... or null"}}, "optionalUrls": ["<url>"]}',
  ].join("\n");
}

/**
 * Replaces the first occurrence of a literal substring with another literal
 * substring. Deliberately not `String.prototype.replace(string, string)`: that
 * interprets `$&`, `$\'`, "$`" and `$1` in the REPLACEMENT as substitution
 * patterns, so a crawled page title containing a "$" (prices, shell snippets,
 * "$0 to $1M") would silently corrupt the output line it was spliced into.
 */
function replaceLiteral(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle);
  if (index === -1) return haystack;
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength - 1).trimEnd() + "…";
}

/**
 * Removes a section's header line from the document if moving pages out of
 * it left it with zero links — i.e. nothing but blank lines between it and
 * the next "## " header (or the end of the document).
 *
 * Runs the (non-global) replace in a loop rather than using a global regex
 * in one pass: two adjacent empty sections would otherwise only have the
 * first one pruned, since consuming its trailing newlines leaves the second
 * header without the leading "\n" its own match requires. Looping re-scans
 * the whole string each time, so cascading empty sections all get removed.
 */
function pruneEmptySections(llmsTxt: string): string {
  let result = llmsTxt;
  let previous: string;
  do {
    previous = result;
    result = result.replace(/\n## [^\n]+\n+(?=## |\s*$)/, "\n");
  } while (result !== previous);
  return result;
}

function applyPlan(
  llmsTxt: string,
  sectionLabels: string[],
  pagesByUrl: Map<string, PageInfo>,
  plan: EnhancementPlan
): string {
  let result = llmsTxt;

  if (typeof plan.siteTitle === "string" && plan.siteTitle.trim()) {
    const newTitle = `# ${truncate(plan.siteTitle, MAX_TITLE_LENGTH)}`;
    result = result.replace(/^# .+$/m, () => newTitle);
  }

  if (plan.sectionLabels && typeof plan.sectionLabels === "object") {
    for (const [oldLabel, newLabel] of Object.entries(plan.sectionLabels)) {
      if (oldLabel === OPTIONAL_SECTION || !sectionLabels.includes(oldLabel) || typeof newLabel !== "string" || !newLabel.trim()) {
        continue;
      }
      const headerLine = `## ${oldLabel}`;
      if (result.includes(headerLine)) {
        result = replaceLiteral(result, headerLine, `## ${truncate(newLabel, 40)}`);
      }
    }
  }

  // Track each page's current (possibly re-edited) line so a later
  // optionalUrls move relocates the edited version, not the original.
  const currentLineByUrl = new Map<string, string>();
  for (const page of pagesByUrl.values()) currentLineByUrl.set(page.url, formatLink(page));

  if (plan.pageEdits && typeof plan.pageEdits === "object") {
    for (const [url, edit] of Object.entries(plan.pageEdits)) {
      const original = pagesByUrl.get(url);
      // Ignore edits for any URL we didn't hand the model — guards against a
      // hallucinated or malformed key ever reaching the output.
      if (!original || typeof edit !== "object" || edit === null) continue;

      const originalLine = currentLineByUrl.get(url)!;
      if (!result.includes(originalLine)) continue;

      const editedTitle = typeof edit.title === "string" && edit.title.trim() ? truncate(edit.title, MAX_TITLE_LENGTH) : original.title;
      const editedDescription =
        edit.description === null
          ? undefined
          : typeof edit.description === "string" && edit.description.trim()
            ? truncate(edit.description, MAX_DESCRIPTION_LENGTH)
            : original.description;

      const newLine = formatLink({ url, title: editedTitle, description: editedDescription });
      result = replaceLiteral(result, originalLine, newLine);
      currentLineByUrl.set(url, newLine);
    }
  }

  if (Array.isArray(plan.optionalUrls) && plan.optionalUrls.length > 0) {
    const movedLines: string[] = [];
    for (const url of plan.optionalUrls) {
      if (typeof url !== "string" || !pagesByUrl.has(url)) continue;
      const line = currentLineByUrl.get(url);
      if (!line) continue;
      const lineWithNewline = `${line}\n`;
      if (!result.includes(lineWithNewline)) continue;
      result = replaceLiteral(result, lineWithNewline, "");
      movedLines.push(line);
    }

    if (movedLines.length > 0) {
      result = pruneEmptySections(result);
      const existingOptionalHeader = `## ${OPTIONAL_SECTION}`;
      if (result.includes(existingOptionalHeader)) {
        result = replaceLiteral(result, existingOptionalHeader, `${existingOptionalHeader}\n${movedLines.join("\n")}`);
      } else {
        result = `${result.trimEnd()}\n\n${existingOptionalHeader}\n\n${movedLines.join("\n")}\n`;
      }
    }
  }

  if (typeof plan.siteDescription === "string" && plan.siteDescription.trim()) {
    const newSummary = `> ${truncate(plan.siteDescription, MAX_DESCRIPTION_LENGTH)}`;
    result = result.replace(/^> .+$/m, () => newSummary);
  }

  if (typeof plan.siteIntro === "string" && plan.siteIntro.trim()) {
    const summaryLine = result.match(/^> .+$/m);
    if (summaryLine) {
      const insertAt = summaryLine.index! + summaryLine[0].length;
      const intro = truncate(plan.siteIntro, MAX_INTRO_LENGTH);
      result = `${result.slice(0, insertAt)}\n\n${intro}${result.slice(insertAt)}`;
    }
  }

  return result;
}
