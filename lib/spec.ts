/**
 * The llms.txt grammar, as specified at https://llmstxt.org.
 *
 * The spec fixes an exact structure and ordering:
 *
 *   - an optional byte-order mark
 *   - an H1 with the name of the project or site (the only required part)
 *   - a blockquote with a short summary
 *   - zero or more markdown sections of any type EXCEPT headings
 *   - zero or more sections delimited by H2 headers, each containing a "file
 *     list": list items with a required [name](url) and optional ": notes"
 *
 * Two halves live here. `escape*` makes a rendered file conform by
 * construction, and `validate` proves it did - a generator that only claims to
 * follow a format nobody checks tends not to.
 */

export interface SpecLink {
  title: string;
  url: string;
  notes?: string;
}

export interface SpecSection {
  name: string;
  links: SpecLink[];
}

export interface SpecDocument {
  title: string;
  summary?: string;
  details: string[];
  sections: SpecSection[];
}

export interface SpecIssue {
  line: number;
  message: string;
}

/**
 * A file list item: a required hyperlink, then optionally ":" and notes.
 *
 * The link text allows backslash-escaped characters, so a title containing a
 * literal bracket - escaped exactly as Markdown prescribes - still reads as a
 * link rather than as prose that failed to parse.
 */
const LIST_ITEM = /^[-*+]\s+\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)\s*(?::\s*(.*))?$/;

/** Undoes escapeLinkText, so a parsed title is the text a reader sees. */
function unescape(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

/**
 * Link text is delimited by brackets, so a title containing one ends the link
 * early and the rest becomes prose. Backslash-escaping is how Markdown says to
 * keep the character as a character.
 */
export function escapeLinkText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/([\[\]\\])/g, "\\$1").trim();
}

/**
 * Parentheses close the URL, and a space ends it. Both appear in real links,
 * so they are percent-encoded rather than left to break the syntax.
 */
export function escapeUrl(url: string): string {
  return url.replace(/[()\s]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Notes run to end of line, so a newline would silently split the entry. */
export function escapeInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Free-form text sits where the spec allows any markdown "except headings", so
 * a paragraph that happens to begin with "#" has to stop looking like one.
 */
export function escapeBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s*)(#{1,6})(\s)/, "$1\\$2$3"))
    .join("\n")
    .trim();
}

/**
 * Parses a file per the grammar above, collecting every place it departs from
 * the spec. Order matters, so this is a state machine over lines rather than a
 * set of independent regexes.
 */
export function parseLlmsTxt(text: string): { document: SpecDocument; issues: SpecIssue[] } {
  const issues: SpecIssue[] = [];
  const lines = text.replace(/^﻿/, "").split("\n");

  const document: SpecDocument = { title: "", details: [], sections: [] };
  let stage: "title" | "summary" | "details" | "sections" = "title";
  let section: SpecSection | null = null;
  let detail: string[] = [];

  const flushDetail = () => {
    const text = detail.join("\n").trim();
    if (text) document.details.push(text);
    detail = [];
  };

  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    const number = index + 1;
    // The space after the hashes is required (so "#hashtag" is not a heading),
    // but the text after it is not: "##" alone is an empty heading, and saying
    // so is more useful than silently treating it as prose.
    const heading = line.match(/^(#{1,6})(?:\s+(.*))?$/);

    if (heading) {
      const [, hashes, name = ""] = heading;

      if (hashes.length === 1) {
        if (stage !== "title") {
          issues.push({ line: number, message: "A second H1: the file names the site once, at the top." });
          return;
        }
        if (!name.trim()) issues.push({ line: number, message: "The H1 is empty." });
        document.title = name.trim();
        stage = "summary";
        return;
      }

      if (stage === "title") {
        issues.push({ line: number, message: "A heading before the H1 title." });
      }

      if (hashes.length > 2) {
        issues.push({
          line: number,
          message: `H${hashes.length} used; sections are delimited by H2, and nothing deeper is defined.`,
        });
        return;
      }

      flushDetail();
      section = { name: name.trim(), links: [] };
      if (!section.name) issues.push({ line: number, message: "An H2 with no section name." });
      document.sections.push(section);
      stage = "sections";
      return;
    }

    if (!line.trim()) {
      if (stage === "details") flushDetail();
      return;
    }

    if (stage === "title") {
      issues.push({ line: number, message: "Content before the H1: the title comes first." });
      return;
    }

    if (stage === "summary") {
      if (line.startsWith(">")) {
        const summary = line.replace(/^>\s?/, "").trim();
        document.summary = document.summary ? `${document.summary} ${summary}` : summary;
        return;
      }
      stage = "details";
    }

    if (stage === "sections" && section) {
      const item = line.trimStart().match(LIST_ITEM);
      if (!item) {
        issues.push({
          line: number,
          message: "A section holds a file list; this line is not a list item with a link.",
        });
        return;
      }

      const [, title, url, notes] = item;
      if (!title.trim()) issues.push({ line: number, message: "A link with no name." });
      section.links.push({ title: unescape(title).trim(), url, notes: notes?.trim() || undefined });
      return;
    }

    // Reached only in the details stage: the summary branch above has already
    // moved past itself, and a section consumes its own lines.
    detail.push(line);
  });

  flushDetail();
  if (!document.title) issues.push({ line: 1, message: "No H1: the file must name the site." });

  return { document, issues };
}

/** The issues alone - "does this file conform?" without the parse tree. */
export function validateLlmsTxt(text: string): SpecIssue[] {
  return parseLlmsTxt(text).issues;
}
