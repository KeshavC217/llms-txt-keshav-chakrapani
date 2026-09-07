import type { Extraction } from "../naiveExtractor.ts";
import { type Transport, parseJson } from "./openrouter.ts";
import { guideModel } from "./models.ts";

/**
 * Stage one: one call, one global judgment.
 *
 * The whole skeleton goes in - what the site is called, what it says about
 * itself, and every section with the links under it - and a summary and better
 * section names come back. This is the part a stronger model earns its keep on,
 * and it happens once regardless of how many links the page has.
 */

const SYSTEM = [
  "You are naming the parts of an llms.txt file: a curated map of a website for AI agents.",
  "You are given a skeleton extracted from a single page.",
  "Return a one-sentence summary of what the site is, and a better name for each section.",
  "Section names come from the site's own vocabulary, in Title Case, at most three words.",
  "Keep a section's name if it is already right. Never invent sections or links.",
  'Reply with JSON only: {"summary":"...","sections":{"<current name>":"<better name>"}}',
].join(" ");

export interface GuideProposal {
  summary?: unknown;
  sections?: Record<string, unknown>;
}

function skeleton(extraction: Extraction): string {
  const lines = [`Site name: ${extraction.siteName}`];
  if (extraction.summary) lines.push(`The page describes itself as: ${extraction.summary}`);

  lines.push("", "Sections and the pages under them:");
  for (const section of extraction.sections) {
    // Six links is enough to show what a section is about; sending forty of
    // them costs tokens without changing the name it deserves.
    const sample = section.links.slice(0, 6).map((link) => link.title).join(", ");
    lines.push(`  ${section.name}: ${sample}${section.links.length > 6 ? ", ..." : ""}`);
  }
  return lines.join("\n");
}

export async function runGuide(
  extraction: Extraction,
  transport: Transport,
  signal: AbortSignal,
): Promise<GuideProposal> {
  const reply = await transport(
    guideModel(),
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: skeleton(extraction) },
    ],
    signal,
  );

  return parseJson<GuideProposal>(reply) ?? {};
}
