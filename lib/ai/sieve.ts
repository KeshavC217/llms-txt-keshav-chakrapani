import type { Extraction, LinkEntry } from "../naiveExtractor.ts";
import { coverage, similarity, titleCase } from "../nlp.ts";

/**
 * What the model proposes, and what is allowed through.
 *
 * The model is treated as an unreliable narrator with good ideas. Every
 * proposal is checked against something we already know to be true - the links
 * we actually extracted, the title a note is meant to describe, the grammar the
 * file has to satisfy - and anything that fails is dropped rather than fixed.
 *
 * Dropping is always safe here, because every slot the model fills is optional
 * in the spec. A rejected note leaves a link with no note, which is a worse
 * file and still a valid one.
 */

/** Same threshold the deterministic path uses, for the same reason. */
const RESTATEMENT = 0.75;
const MAX_NOTE_WORDS = 12;
const MAX_SUMMARY_CHARS = 200;
const MAX_SECTION_NAME_CHARS = 40;

const LOCALE = /^(en|fr|de|es|it|ja|zh|ko|pt|ru|nl|pl|tr|vi|id|hi|ar)([-_][a-z]{2})?$/i;

export interface SieveReport {
  notesAccepted: number;
  notesRejected: number;
  summaryReplaced: boolean;
  sectionsRenamed: number;
  chunksFailed: number;
}

/**
 * A note has to say something about the page, in a sentence's worth of words,
 * without repeating the title it sits next to.
 */
export function acceptNote(note: unknown, title: string): string | null {
  if (typeof note !== "string") return null;

  const cleaned = note.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  if (cleaned.length < 10) return null;
  if (cleaned.split(/\s+/).length > MAX_NOTE_WORDS) return null;

  // Markdown syntax inside a note would break the line it is rendered into.
  if (/[\n\r]|\]\(/.test(cleaned)) return null;

  // The same rule the extractor applies to notes it finds on the page: a note
  // that only repeats its own title has told the reader nothing.
  if (coverage(cleaned, title) > RESTATEMENT) return null;

  return cleaned;
}

/** A summary describes the site in one sentence, and is not a link or a slogan of two words. */
export function acceptSummary(summary: unknown, siteName: string): string | null {
  if (typeof summary !== "string") return null;

  const cleaned = summary.replace(/\s+/g, " ").trim();
  if (cleaned.length < 20 || cleaned.length > MAX_SUMMARY_CHARS) return null;
  if (/https?:\/\//.test(cleaned)) return null;

  // "Corvid" is the title, already directly above; repeating it is not a summary.
  if (similarity(cleaned, siteName) > 0.8) return null;

  return cleaned;
}

/**
 * A section name replaces one the extractor derived from a path. It has to be
 * short, has to read as a name rather than a slug, and must not collide with a
 * section already called that - two identical H2s split one list in half.
 */
export function acceptSectionName(name: unknown, taken: Set<string>): string | null {
  if (typeof name !== "string") return null;

  const cleaned = name.replace(/\s+/g, " ").trim();
  if (cleaned.length < 2 || cleaned.length > MAX_SECTION_NAME_CHARS) return null;
  if (LOCALE.test(cleaned)) return null;
  if (/[\n\r#[\]()]/.test(cleaned)) return null;

  const titled = titleCase(cleaned);
  if (taken.has(titled.toLowerCase())) return null;

  return titled;
}

/**
 * Applies whatever survived onto a copy of the extraction. Notes attach by
 * looking each URL up among the links we already have, so a URL the model
 * invented has nowhere to land and simply does not appear.
 */
export function applyProposals(
  extraction: Extraction,
  proposals: { summary?: unknown; sections?: Record<string, unknown>; notes?: Record<string, unknown> },
  report: SieveReport,
): Extraction {
  const sections = extraction.sections.map((section) => ({ ...section, links: section.links.map((l) => ({ ...l })) }));
  const optional = extraction.optional.map((l) => ({ ...l }));

  const byUrl = new Map<string, LinkEntry>();
  for (const link of [...sections.flatMap((s) => s.links), ...optional]) byUrl.set(link.url, link);

  for (const [url, note] of Object.entries(proposals.notes ?? {})) {
    const link = byUrl.get(url);
    if (!link) {
      report.notesRejected += 1; // A URL we never extracted: invented, or altered.
      continue;
    }

    const accepted = acceptNote(note, link.title);
    if (!accepted) {
      report.notesRejected += 1;
      continue;
    }

    link.note = accepted;
    report.notesAccepted += 1;
  }

  const taken = new Set(sections.map((section) => section.name.toLowerCase()));
  for (const section of sections) {
    // Keyed by the name the extractor gave the section, which is what the
    // guide was shown - sections carry no other stable identifier.
    const proposed = proposals.sections?.[section.name];
    if (proposed === undefined) continue;

    taken.delete(section.name.toLowerCase());
    const accepted = acceptSectionName(proposed, taken);
    if (accepted && accepted !== section.name) {
      section.name = accepted;
      report.sectionsRenamed += 1;
    }
    taken.add(section.name.toLowerCase());
  }

  const summary = acceptSummary(proposals.summary, extraction.siteName);
  if (summary) report.summaryReplaced = true;

  return { ...extraction, summary: summary ?? extraction.summary, sections, optional };
}

export const emptyReport = (): SieveReport => ({
  notesAccepted: 0,
  notesRejected: 0,
  summaryReplaced: false,
  sectionsRenamed: 0,
  chunksFailed: 0,
});
