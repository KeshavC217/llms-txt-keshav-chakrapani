import type { Extraction, LinkEntry } from "../naiveExtractor.ts";
import { type Transport, parseJson } from "./openrouter.ts";
import { workerModel } from "./models.ts";

/**
 * Stage two: the same small job, many times.
 *
 * Links are annotated in chunks, and the chunks follow section boundaries
 * rather than being cut every N links across the whole page. A chunk whose
 * links share a subject produces sharper notes than a chunk that mixes the API
 * reference with the careers page, and the section name is free context.
 */

const CHUNK_SIZE = 10;
const CONCURRENCY = 4;

const SYSTEM = [
  "You write the one-line notes in an llms.txt file: a curated map of a website for AI agents.",
  "For each link, say what an agent would find at that URL, in at most 12 words.",
  "Never restate the link's own title, and never invent a URL - use exactly the URLs given.",
  "Omit a link entirely rather than guess about it.",
  'Reply with JSON only: {"notes":{"<url>":"<note>"}}',
].join(" ");

export interface Chunk {
  section: string;
  links: LinkEntry[];
}

/** Groups links into per-section chunks, largest sections first. */
export function chunkLinks(extraction: Extraction): Chunk[] {
  const chunks: Chunk[] = [];

  for (const section of extraction.sections) {
    for (let i = 0; i < section.links.length; i += CHUNK_SIZE) {
      chunks.push({ section: section.name, links: section.links.slice(i, i + CHUNK_SIZE) });
    }
  }
  return chunks;
}

function prompt(chunk: Chunk, summary: string | undefined, siteName: string): string {
  const lines = [`Site: ${siteName}${summary ? ` - ${summary}` : ""}`, `Section: ${chunk.section}`, "", "Links:"];
  for (const link of chunk.links) lines.push(`- ${link.title} (${link.url})`);
  return lines.join("\n");
}

/**
 * Runs the chunks with a bounded number in flight and merges what comes back.
 *
 * A chunk that fails - malformed reply, timeout, a model that is simply down -
 * contributes nothing and does not take the others with it. Its links keep no
 * note, which is a poorer file and still a valid one.
 */
export async function runAnnotation(
  extraction: Extraction,
  transport: Transport,
  signal: AbortSignal,
): Promise<{ notes: Record<string, unknown>; failed: number }> {
  const chunks = chunkLinks(extraction);
  const notes: Record<string, unknown> = {};
  let failed = 0;
  let next = 0;

  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      try {
        const reply = await transport(
          workerModel(),
          [
            { role: "system", content: SYSTEM },
            { role: "user", content: prompt(chunk, extraction.summary, extraction.siteName) },
          ],
          signal,
        );

        const parsed = parseJson<{ notes?: Record<string, unknown> }>(reply);
        if (!parsed?.notes) {
          failed += 1;
          continue;
        }
        Object.assign(notes, parsed.notes);
      } catch {
        failed += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return { notes, failed };
}
