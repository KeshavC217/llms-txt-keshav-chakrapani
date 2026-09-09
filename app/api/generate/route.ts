import { NextResponse } from "next/server";

import { extract, linkCount, render } from "@/lib/naiveExtractor";
import { generate } from "@/lib/generate";
import { findPublished } from "@/lib/published";
import { USER_AGENT } from "@/lib/fetchPage";
import { fetchPage, normalizeUrl } from "@/lib/fetchPage";
import { classifyEmpty, explain } from "@/lib/blocks";
import { renderConfigured, renderPage } from "@/lib/render";
import { validateLlmsTxt } from "@/lib/spec";

/**
 * Builds an llms.txt from one fetched page, following TEMPLATE.txt. Open to
 * everyone and entirely deterministic; the model-assisted path is a separate
 * endpoint at /api/enhance, because it needs an account and a longer deadline.
 */

// A crawl of up to 150 pages, paced, plus the render. Comfortably inside this,
// but not inside the default.
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: { url?: string; regenerate?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const url = normalizeUrl(body.url ?? "");
  if (!url) {
    return NextResponse.json({ error: "Please enter a valid URL." }, { status: 400 });
  }

  let page;
  try {
    page = await fetchPage(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not fetch that URL.";
    // A refused host is the caller's mistake; a failed fetch is the site's.
    const status = /publicly reachable|Could not resolve/.test(message) ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }

  // A challenge page parses perfectly well and describes nothing but the
  // challenge, so it must not be turned into an llms.txt. Say what happened.
  if (page.block) {
    const rendered = page.block.kind === "bot-challenge" && renderConfigured() ? await renderPage(page.url) : null;

    if (!rendered) {
      return NextResponse.json(
        { error: explain(page.block, page.url), blocked: page.block.kind, url: page.url },
        { status: 502 },
      );
    }
    page = { ...page, body: rendered.html, block: undefined, isHtml: true };
  }

  if (!page.isHtml) {
    return NextResponse.json({
      url: page.url,
      status: page.status,
      contentType: page.contentType,
      truncated: page.truncated,
      llmsTxt: page.body,
    });
  }

  // If the site publishes its own, that is the answer: someone chose what
  // belonged in it, and one request settles it instead of fifty.
  const seed = extract(page.body, page.url);

  if (body.regenerate !== true) {
    const published = await findPublished(page.url, USER_AGENT, seed.existingLlmsTxt);
    if (published) {
      return NextResponse.json({
        url: page.url,
        status: page.status,
        contentType: page.contentType,
        truncated: false,
        llmsTxt: published.llmsTxt,
        source: "published",
        publishedAt: published.url,
        spec: { valid: published.conforms, issues: [] },
      });
    }
  }

  const { extraction: crawled, crawl } = await generate(page.body, page.url, { seed });
  let extraction = crawled;

  // A shell with no links is the other case a browser fixes: nothing refused
  // us, the page simply had not built itself yet.
  // Nothing extracted is worth a second look: some sites serve a challenge with
  // a 200, which the status check above cannot see.
  if (linkCount(extraction) === 0) {
    const late = classifyEmpty(page.body);
    if (late) {
      const rendered = renderConfigured() ? await renderPage(page.url) : null;
      if (!rendered) {
        return NextResponse.json(
          { error: explain(late, page.url), blocked: late.kind, url: page.url },
          { status: 502 },
        );
      }
      extraction = extract(rendered.html, page.url);
    }
  }

  if (extraction.clientRendered && renderConfigured()) {
    const rendered = await renderPage(page.url);
    if (rendered) {
      // Adopted only if it actually found more than the plain response did.
      // "Longer HTML" is not the test - a renderer can return a bigger page
      // that still has nothing on it.
      const better = extract(rendered.html, page.url);
      if (linkCount(better) > linkCount(extraction)) extraction = better;
    }
  }

  const llmsTxt = render(extraction, page.url);
  const issues = validateLlmsTxt(llmsTxt);

  return NextResponse.json({
    url: page.url,
    status: page.status,
    contentType: page.contentType,
    truncated: page.truncated,
    llmsTxt,
    // Checked on the way out rather than asserted in a comment: the file we
    // just built is parsed back against the grammar at llmstxt.org.
    spec: { valid: issues.length === 0, issues },
    markdownAlternate: extraction.markdownAlternate,
    existingLlmsTxt: extraction.existingLlmsTxt,
    crawl,
  });
}
