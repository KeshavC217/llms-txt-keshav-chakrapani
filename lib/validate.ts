/**
 * A structural validator for the llms.txt format (https://llmstxt.org).
 *
 * The spec is small enough to check mechanically, which makes this the one
 * correctness signal that works on ANY site — unlike "does it look good",
 * which needs a human or an LLM judge. The integration tests assert a clean
 * result on fixture sites; the corpus eval asserts it on whatever random
 * live site it drew, so a markdown-shaped regression (a link line mangled by
 * the AI copyedit pass, an empty section left behind by an Optional move)
 * fails loudly instead of being eyeballed.
 *
 * Spec shape:
 *   # Title                      (required, exactly one)
 *   > Summary                    (optional blockquote, directly after title)
 *   ...free-form markdown...     (optional, no headings)
 *   ## Section                   (zero or more)
 *   - [Name](url): notes         (link list; notes optional)
 */

export interface ValidationIssue {
  code: string;
  message: string;
  line?: number;
}

// The trailing description is optional; a line that has the ":" but nothing
// after it is reported as empty-notes rather than as an unparseable line.
const LINK_LINE = /^- \[([^\]]*)\]\(([^)\s]+)\)(?::\s?(.*))?$/;

export function validateLlmsTxt(text: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (code: string, message: string, line?: number) => issues.push({ code, message, line });

  if (text.includes("\r")) push("crlf", "Document contains carriage returns; expected LF-only newlines.");

  const lines = text.split("\n");
  const firstContentIndex = lines.findIndex((l) => l.trim() !== "");

  if (firstContentIndex === -1) {
    push("empty", "Document is empty.");
    return issues;
  }

  const h1Lines = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^# /.test(l));
  if (h1Lines.length === 0) {
    push("missing-h1", "Document has no '# Title' line.", firstContentIndex + 1);
  } else if (h1Lines.length > 1) {
    push("multiple-h1", `Document has ${h1Lines.length} '# ' headings; exactly one is allowed.`, h1Lines[1].i + 1);
  }

  if (h1Lines.length > 0) {
    if (h1Lines[0].i !== firstContentIndex) {
      push("h1-not-first", "The '# Title' line must be the first non-empty line.", h1Lines[0].i + 1);
    }
    if (!h1Lines[0].l.slice(2).trim()) {
      push("empty-h1", "The '# Title' line has no title text.", h1Lines[0].i + 1);
    }
  }

  const seenUrls = new Map<string, number>();
  const seenSections = new Set<string>();
  let currentSection: { name: string; line: number; links: number } | null = null;

  const closeSection = () => {
    if (currentSection && currentSection.links === 0) {
      push("empty-section", `Section '${currentSection.name}' contains no links.`, currentSection.line);
    }
  };

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trimEnd();

    if (/^#{3,} /.test(line)) {
      push("deep-heading", `Heading deeper than '## ' is not part of the format: '${line.trim()}'.`, lineNo);
      return;
    }

    if (/^## /.test(line)) {
      closeSection();
      const name = line.slice(3).trim();
      if (!name) push("empty-section-name", "Section heading has no name.", lineNo);
      if (seenSections.has(name.toLowerCase())) {
        push("duplicate-section", `Section '${name}' appears more than once.`, lineNo);
      }
      seenSections.add(name.toLowerCase());
      currentSection = { name, line: lineNo, links: 0 };
      return;
    }

    if (/^\s*-\s/.test(rawLine)) {
      const match = LINK_LINE.exec(line);
      if (!match) {
        push("malformed-link", `List item is not a valid '- [Name](url): notes' line: '${line.trim()}'.`, lineNo);
        return;
      }

      const [, name, url, notes] = match;
      if (currentSection) currentSection.links += 1;
      else push("link-outside-section", `Link '${url}' appears before any '## Section' heading.`, lineNo);

      if (!name.trim()) push("empty-link-name", `Link to ${url} has an empty name.`, lineNo);

      let parsed: URL | null = null;
      try {
        parsed = new URL(url);
      } catch {
        parsed = null;
      }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        push("invalid-url", `Link target is not an absolute http(s) URL: '${url}'.`, lineNo);
      } else {
        const key = parsed.toString().replace(/\/$/, "");
        const previous = seenUrls.get(key);
        if (previous !== undefined) {
          push("duplicate-url", `URL ${url} is listed more than once (also on line ${previous}).`, lineNo);
        } else {
          seenUrls.set(key, lineNo);
        }
      }

      if (notes !== undefined && !notes.trim()) {
        push("empty-notes", `Link to ${url} has an empty description after its colon.`, lineNo);
      }
    }
  });

  closeSection();

  if (seenUrls.size === 0) push("no-links", "Document contains no links.");

  return issues;
}

/** Renders issues as a single multi-line string, for test failure messages. */
export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `  [${i.code}]${i.line ? ` line ${i.line}:` : ""} ${i.message}`).join("\n");
}
