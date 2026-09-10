/**
 * The file the site already publishes.
 *
 * If a site has written its own llms.txt, that is the answer. Someone chose
 * what belonged in it, which is more than any crawl can work out, and handing
 * back a generated substitute would be both worse and faintly rude.
 *
 * Checked before crawling, so the hit costs one request instead of fifty. It is
 * also the only useful answer for a site that refuses us: openai.com serves an
 * anti-bot challenge to every request, and publishes a perfectly good llms.txt
 * on its docs domain.
 */

import { validateLlmsTxt } from "./spec.ts";

/** Their llms.txt is a text file, and there are up to two candidates to try. */
const FETCH_TIMEOUT_MS = 5_000;
const MAX_BYTES = 2_000_000;

export interface PublishedFile {
  url: string;
  llmsTxt: string;
  /** Whether it satisfies the grammar; reported, never used to hide the file. */
  conforms: boolean;
}

/**
 * Where to look, most specific first.
 *
 * The spec says a file covers the paths beneath it and that agents should
 * prefer the most specific one, so a request for /docs checks /docs/llms.txt
 * before the site root. A `rel="describedby"` link, when the page declares one,
 * outranks both: the site has said exactly which file describes it.
 */
export function publishedCandidates(pageUrl: string, declared?: string): string[] {
  const candidates: string[] = [];
  if (declared) candidates.push(declared);

  try {
    const url = new URL(pageUrl);
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments.length > 0) candidates.push(new URL(`/${segments[0]}/llms.txt`, url.origin).toString());
    candidates.push(new URL("/llms.txt", url.origin).toString());
  } catch {
    // A URL we cannot parse has no candidates, which the caller reads as "none".
  }

  return [...new Set(candidates)];
}

/**
 * Returns a published file if the site really serves one.
 *
 * Recognised by shape, not by conformance. Strict validation was tried first
 * and rejected almost everything: getlago.com publishes a thoughtful file with
 * prose under a section heading, which the grammar forbids and a reader would
 * still rather have. llmstxt.site says as much about its own directory - the
 * files listed there may not meet the specification.
 *
 * So the test is only that this is an llms.txt at all: served as text, and
 * opening with the H1 the format requires. That still excludes the common
 * failure of a site answering 200 with an HTML 404 page. Whether it conforms is
 * reported to the caller rather than used to hide it.
 */
export async function findPublished(pageUrl: string, userAgent: string, declared?: string): Promise<PublishedFile | null> {
  for (const candidate of publishedCandidates(pageUrl, declared)) {
    try {
      const response = await fetch(candidate, {
        headers: { "User-Agent": userAgent, Accept: "text/plain,text/markdown,*/*" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) continue;
      if (/html/i.test(response.headers.get("content-type") ?? "")) continue;

      const llmsTxt = (await response.text()).slice(0, MAX_BYTES);
      const body = llmsTxt.replace(/^\uFEFF/, "").trimStart();
      if (body.length < 40 || !body.startsWith("# ")) continue;

      return { url: response.url || candidate, llmsTxt, conforms: validateLlmsTxt(llmsTxt).length === 0 };
    } catch {
      // Unreachable is the same as absent.
    }
  }
  return null;
}
