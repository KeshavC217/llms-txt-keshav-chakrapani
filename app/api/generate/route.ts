import { NextResponse } from "next/server";

import { extract, render } from "@/lib/naiveExtractor";
import { fetchPage, normalizeUrl } from "@/lib/fetchPage";
import { validateLlmsTxt } from "@/lib/spec";

/**
 * Builds an llms.txt from one fetched page, following TEMPLATE.txt. Open to
 * everyone and entirely deterministic; the model-assisted path is a separate
 * endpoint at /api/enhance, because it needs an account and a longer deadline.
 */

export async function POST(request: Request) {
  let body: { url?: string };
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

  if (!page.isHtml) {
    return NextResponse.json({
      url: page.url,
      status: page.status,
      contentType: page.contentType,
      truncated: page.truncated,
      llmsTxt: page.body,
    });
  }

  const extraction = extract(page.body, page.url);
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
  });
}
