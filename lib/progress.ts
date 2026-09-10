/**
 * What "generating" is actually made of, so a progress indicator can say so.
 *
 * The request is still synchronous - one Vercel function, the clock in
 * lib/deadline.ts, the same 50-second budget as always. What changes is that
 * the handler now narrates itself as it goes, over the same response, rather
 * than the caller waiting on a single opaque await. See app/api/generate for
 * how the events are put on the wire and app/Generator.tsx for how they are
 * read back off it.
 *
 * The stages are not equal-sized steps and the percentage below does not
 * pretend they are: fetching one page is a few hundred milliseconds and
 * annotating fifty links can be thirty seconds. The weights are a rough map of
 * a multi-stage pipeline onto one bar, chosen from what these stages have
 * measured at in practice, not a measurement of the request in progress. What
 * is not approximate is the label and the counts - every event corresponds to
 * a real step the server is doing right now, and fetched/planned and
 * completed/total are exact.
 */

export type ProgressEvent =
  | { stage: "fetching" }
  | { stage: "rendering" }
  | { stage: "checking-published" }
  | { stage: "crawling"; fetched: number; planned: number }
  | { stage: "summarizing" }
  | { stage: "annotating"; completed: number; total: number }
  | { stage: "saving" };

/**
 * Order matters here twice over: it is the order a request actually goes
 * through them, and it is what "before" below sums.
 */
const STAGES: { stage: ProgressEvent["stage"]; weight: number; label: string }[] = [
  { stage: "fetching", weight: 5, label: "Fetching the page" },
  { stage: "rendering", weight: 15, label: "Site needs a browser to read it - rendering the page" },
  { stage: "checking-published", weight: 5, label: "Checking whether the site already publishes an llms.txt" },
  { stage: "crawling", weight: 40, label: "Crawling the site" },
  { stage: "summarizing", weight: 5, label: "Writing the summary and section names" },
  { stage: "annotating", weight: 25, label: "Writing a note for each link" },
  { stage: "saving", weight: 5, label: "Saving the result" },
];

const before = (index: number) => STAGES.slice(0, index).reduce((sum, entry) => sum + entry.weight, 0);

/**
 * A 0-100 position for the bar and the sentence to put beside it.
 *
 * Not every request passes through every stage - most sites need no
 * rendering, and a request that ran out of time before the models skips
 * annotating. Skipped stages simply never arrive as events, so the bar jumps
 * over their share rather than pausing on it; the alternative, redistributing
 * the missing weight live, would make the same site report a different
 * percentage on every run depending on which stages it happened to need.
 */
export function describeProgress(event: ProgressEvent): { percent: number; label: string } {
  const index = STAGES.findIndex((entry) => entry.stage === event.stage);
  if (index === -1) return { percent: 0, label: "Working" };

  const stage = STAGES[index];
  const base = before(index);

  if (event.stage === "crawling") {
    const fraction = event.planned > 0 ? Math.min(1, event.fetched / event.planned) : 0;
    const label =
      event.planned > 0 ? `Crawling the site - ${event.fetched} of ${event.planned} pages` : stage.label;
    return { percent: Math.round(base + stage.weight * fraction), label };
  }

  if (event.stage === "annotating") {
    const fraction = event.total > 0 ? Math.min(1, event.completed / event.total) : 0;
    const label =
      event.total > 0 ? `Writing a note for each link - ${event.completed} of ${event.total} groups` : stage.label;
    return { percent: Math.round(base + stage.weight * fraction), label };
  }

  // A step with no internal count is shown half spent while it runs, so the
  // bar visibly moves rather than sitting still for however long it takes.
  return { percent: Math.round(base + stage.weight * 0.5), label: stage.label };
}
