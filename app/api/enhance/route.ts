import { NextResponse } from "next/server";

import { checkLlmAccess } from "@/lib/authGate";
import { enhance } from "@/lib/ai/enhance";
import { extract, linkCount } from "@/lib/naiveExtractor";
import { generate } from "@/lib/generate";
import { findPublished } from "@/lib/published";
import { USER_AGENT } from "@/lib/fetchPage";
import { fetchPage, normalizeUrl } from "@/lib/fetchPage";
import { classifyEmpty, explain } from "@/lib/blocks";
import { renderConfigured, renderPage } from "@/lib/render";
import { aiConfigured } from "@/lib/ai/models";
import { authConfigured } from "@/lib/supabase/config";
import { getUser } from "@/lib/supabase/server";
import { validateLlmsTxt } from "@/lib/spec";
import { isFresh, readGeneration, storeConfigured, writeGeneration } from "@/lib/store";

/**
 * The model-assisted path: everything /api/generate does, then a guide pass and
 * a chunked annotation pass over the result.
 *
 * Separate from /api/generate because it differs in all three of the ways that
 * matter: it needs an account, it spends money, and it takes seconds rather
 * than milliseconds.
 */

// Two stages of model calls against a 20s internal budget. The default limit
// would cut the request off mid-flight.
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

  // Checked before the fetch: refusing after fifteen seconds spent on someone
  // else's server would waste their bandwidth to tell us nothing.
  const access = checkLlmAccess({
    enhanceRequested: true,
    signedIn: Boolean(await getUser()),
    authConfigured,
  });
  if (!access.allowed) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }


  // Checked before fetching: a stored answer means neither this site nor the
  // models need to be touched at all.
  if (storeConfigured()) {
    const stored = await readGeneration(url);
    if (stored && isFresh(stored.generatedAt)) {
      return NextResponse.json({
        url: stored.url,
        llmsTxt: stored.llmsTxt,
        enhanced: true,
        cached: true,
        generatedAt: stored.generatedAt,
        spec: { valid: validateLlmsTxt(stored.llmsTxt).length === 0, issues: [] },
      });
    }
  }

  if (!aiConfigured()) {
    return NextResponse.json({ error: "The AI features are not configured on this deployment." }, { status: 503 });
  }

  let page;
  try {
    page = await fetchPage(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not fetch that URL.";
    const status = /publicly reachable|Could not resolve/.test(message) ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }

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
    return NextResponse.json({ error: "That URL is not an HTML page, so there is nothing to enhance." }, { status: 415 });
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

  const { llmsTxt, enhanced, report, fatal } = await enhance(extraction, page.url);

  // An empty account or a rejected key is a broken deployment, not a thin
  // result. Returning 200 with a quietly worse file would hide the one failure
  // an operator has to act on.
  if (fatal) {
    return NextResponse.json(
      {
        error:
          fatal.kind === "credits"
            ? "The AI features are temporarily unavailable: the OpenRouter account is out of credits."
            : "The AI features are misconfigured: OpenRouter rejected the API key.",
        report,
      },
      { status: 503 },
    );
  }

  const issues = validateLlmsTxt(llmsTxt);

  // Only stored when the models actually improved it and the result conforms.
  // A file the AI could not help with is the deterministic one, which anyone
  // can have for free from the other endpoint; keeping it would fill the table
  // with rows that save nothing.
  const stored = enhanced && issues.length === 0 && storeConfigured() ? await writeGeneration(url, llmsTxt) : false;

  return NextResponse.json({
    url: page.url,
    cached: false,
    stored,
    crawl,
    status: page.status,
    contentType: page.contentType,
    truncated: page.truncated,
    llmsTxt,
    enhanced,
    // What the models proposed and how much of it survived, so a bad model is
    // visible in the response rather than quietly producing a thin file.
    report,
    spec: { valid: issues.length === 0, issues },
    markdownAlternate: extraction.markdownAlternate,
    existingLlmsTxt: extraction.existingLlmsTxt,
  });
}
