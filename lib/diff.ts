import { linksByUrl, parseLlmsTxt, type ParsedLink } from "./parse";

/**
 * A structured comparison of two llms.txt documents.
 *
 * Everything here is expressed in terms a person would use to describe what
 * happened to a website — pages appeared, a title was reworded, a section was
 * renamed — rather than in terms of lines changed. A text diff would report
 * every line as modified when a section is merely reordered, which is exactly
 * the false alarm a monitoring system must not send.
 */

export interface FieldChange {
  url: string;
  from?: string;
  to?: string;
}

export interface LlmsTxtDiff {
  pagesAdded: string[];
  pagesRemoved: string[];
  titlesChanged: FieldChange[];
  descriptionsChanged: FieldChange[];
  pagesMovedSection: (FieldChange & { fromSection: string; toSection: string })[];
  sectionsAdded: string[];
  sectionsRemoved: string[];
  titleChanged?: { from: string; to: string };
  summaryChanged?: { from?: string; to?: string };
}

export function diffLlmsTxt(previous: string, next: string): LlmsTxtDiff {
  const before = parseLlmsTxt(previous);
  const after = parseLlmsTxt(next);

  const beforeLinks = linksByUrl(before);
  const afterLinks = linksByUrl(after);

  const diff: LlmsTxtDiff = {
    pagesAdded: [],
    pagesRemoved: [],
    titlesChanged: [],
    descriptionsChanged: [],
    pagesMovedSection: [],
    sectionsAdded: [],
    sectionsRemoved: [],
  };

  for (const [url, link] of afterLinks) {
    const old = beforeLinks.get(url);
    if (!old) {
      diff.pagesAdded.push(url);
      continue;
    }
    if (old.name !== link.name) diff.titlesChanged.push({ url, from: old.name, to: link.name });
    if ((old.notes ?? "") !== (link.notes ?? "")) {
      diff.descriptionsChanged.push({ url, from: old.notes, to: link.notes });
    }
    if (old.section !== link.section) {
      diff.pagesMovedSection.push({ url, fromSection: old.section, toSection: link.section });
    }
  }

  for (const url of beforeLinks.keys()) {
    if (!afterLinks.has(url)) diff.pagesRemoved.push(url);
  }

  const beforeSections = new Set(before.sections.map((s) => s.name));
  const afterSections = new Set(after.sections.map((s) => s.name));
  for (const name of afterSections) if (!beforeSections.has(name)) diff.sectionsAdded.push(name);
  for (const name of beforeSections) if (!afterSections.has(name)) diff.sectionsRemoved.push(name);

  if (before.title !== after.title) diff.titleChanged = { from: before.title, to: after.title };
  if ((before.summary ?? "") !== (after.summary ?? "")) {
    diff.summaryChanged = { from: before.summary, to: after.summary };
  }

  return diff;
}

/** Whether a diff contains anything worth telling a person about. */
export function isEmptyDiff(diff: LlmsTxtDiff): boolean {
  return (
    diff.pagesAdded.length === 0 &&
    diff.pagesRemoved.length === 0 &&
    diff.titlesChanged.length === 0 &&
    diff.descriptionsChanged.length === 0 &&
    diff.pagesMovedSection.length === 0 &&
    diff.sectionsAdded.length === 0 &&
    diff.sectionsRemoved.length === 0 &&
    !diff.titleChanged &&
    !diff.summaryChanged
  );
}

/** A one-line human summary, e.g. "3 pages added, 1 removed, 2 titles reworded". */
export function summarizeDiff(diff: LlmsTxtDiff): string {
  const parts: string[] = [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  if (diff.pagesAdded.length) parts.push(`${plural(diff.pagesAdded.length, "page")} added`);
  if (diff.pagesRemoved.length) parts.push(`${plural(diff.pagesRemoved.length, "page")} removed`);
  if (diff.titlesChanged.length) parts.push(`${plural(diff.titlesChanged.length, "title")} reworded`);
  if (diff.descriptionsChanged.length) {
    parts.push(`${plural(diff.descriptionsChanged.length, "description")} changed`);
  }
  if (diff.pagesMovedSection.length) parts.push(`${plural(diff.pagesMovedSection.length, "page")} recategorized`);
  if (diff.sectionsAdded.length) parts.push(`${plural(diff.sectionsAdded.length, "section")} added`);
  if (diff.sectionsRemoved.length) parts.push(`${plural(diff.sectionsRemoved.length, "section")} removed`);
  if (diff.titleChanged) parts.push("site title changed");
  if (diff.summaryChanged) parts.push("summary changed");

  return parts.length ? parts.join(", ") : "no changes";
}

export type { ParsedLink };
