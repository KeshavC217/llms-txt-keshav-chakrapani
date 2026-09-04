/**
 * Parses an llms.txt back into structure.
 *
 * Monitoring needs this: "the file changed" is not a useful notification, and
 * a textual diff is worse than useless here because re-ordering a section
 * rewrites every line without anything meaningful having changed. Comparing
 * parsed documents lets the diff say "3 pages added, 1 title reworded", which
 * is the thing a user actually wants to know.
 *
 * Deliberately lenient, unlike lib/validate.ts: this parses documents in the
 * wild (including a site's own published file) rather than judging them, so a
 * malformed line is skipped rather than reported.
 */

export interface ParsedLink {
  name: string;
  url: string;
  notes?: string;
}

export interface ParsedSection {
  name: string;
  links: ParsedLink[];
}

export interface ParsedLlmsTxt {
  title: string;
  summary?: string;
  /** Free-form markdown between the summary and the first section. */
  intro?: string;
  sections: ParsedSection[];
}

const LINK_LINE = /^-\s+\[([^\]]*)\]\(([^)\s]+)\)(?::\s?(.*))?$/;

export function parseLlmsTxt(text: string): ParsedLlmsTxt {
  const lines = text.split("\n");

  let title = "";
  let summary: string | undefined;
  const introLines: string[] = [];
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!title && /^#\s+/.test(line)) {
      title = line.replace(/^#\s+/, "").trim();
      continue;
    }

    if (/^##\s+/.test(line)) {
      current = { name: line.replace(/^##\s+/, "").trim(), links: [] };
      sections.push(current);
      continue;
    }

    if (!current && /^>\s?/.test(line)) {
      // The blockquote summary may wrap across several lines.
      const part = line.replace(/^>\s?/, "").trim();
      summary = summary ? `${summary} ${part}` : part;
      continue;
    }

    const match = LINK_LINE.exec(line);
    if (match) {
      const [, name, url, notes] = match;
      // A link before any "## " heading is off-spec; keep it in an unnamed
      // section rather than dropping content the document clearly intended.
      if (!current) {
        current = { name: "", links: [] };
        sections.push(current);
      }
      current.links.push({ name: name.trim(), url, notes: notes?.trim() || undefined });
      continue;
    }

    if (!current && title && line.trim()) introLines.push(line.trim());
  }

  return {
    title,
    summary,
    intro: introLines.length ? introLines.join(" ") : undefined,
    sections,
  };
}

/** Every link in the document, flattened, keyed by URL. Later entries win. */
export function linksByUrl(parsed: ParsedLlmsTxt): Map<string, ParsedLink & { section: string }> {
  const map = new Map<string, ParsedLink & { section: string }>();
  for (const section of parsed.sections) {
    for (const link of section.links) map.set(link.url, { ...link, section: section.name });
  }
  return map;
}
