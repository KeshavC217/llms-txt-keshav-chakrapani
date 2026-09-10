import { NextResponse } from "next/server";

import { checkGenerateAccess } from "@/lib/authGate";
import { classifyEmpty, explain } from "@/lib/blocks";
import { enhance } from "@/lib/ai/enhance";
import { extract, linkCount } from "@/lib/naiveExtractor";
import { fetchPage, normalizeUrl, USER_AGENT } from "@/lib/fetchPage";
import { findPublished } from "@/lib/published";
import { generate } from "@/lib/generate";
import { renderConfigured, renderPage } from "@/lib/render";
import { structureHash } from "@/lib/monitor";
import { authConfigured } from "@/lib/supabase/config";
import { getUser } from "@/lib/supabase/server";
import { readGeneration, storeConfigured, writeGeneration } from "@/lib/store";
import { validateLlmsTxt } from "@/lib/spec";

/**
 * Generating an llms.txt: crawl the site, run the models over what was found,
 * save the result.
 *
 * One endpoint rather than two. There used to be a free deterministic path and
 * a gated model-assisted one, which meant two routes doing the same work up to
 * the last step, two answers for the same URL, and an option in the interface
 * asking people to choose between them. Generating always uses the models now,
 * always requires an account, and always saves what it produced.
 *
 * Reading what has been saved needs no account; see /api/saved.
 */

// A crawl and two model passes.
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
  const access = checkGenerateAccess({ signedIn: Boolean(await getUser()), authConfigured });
  if (!access.allowed) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  // A saved file is the answer unless a fresh one was asked for. It is not a
  // cache with an expiry: it is what this site's llms.txt is, until something
  // changes it - either a person asking again, or the scheduled check noticing
  // the site moved.
  if (storeConfigured() && body.regenerate !== true) {
    const saved = await readGeneration(url);
    if (saved) {
      return NextResponse.json({
        url: saved.url,
        llmsTxt: saved.llmsTxt,
        saved: true,
        generatedAt: saved.generatedAt,
        spec: { valid: validateLlmsTxt(saved.llmsTxt).length === 0, issues: [] },
      });
    }
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
  // challenge, so it must not be turned into an llms.txt.
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
    return NextResponse.json({ error: "That URL is not an HTML page, so there is nothing to read." }, { status: 415 });
  }

  const seed = extract(page.body, page.url);

  // If the site publishes its own, that is the answer: someone chose what
  // belonged in it. Not saved - it is already published at its own address,
  // and one request fetches it again.
  if (body.regenerate !== true) {
    const published = await findPublished(page.url, USER_AGENT, seed.existingLlmsTxt);
    if (published) {
      return NextResponse.json({
        url: page.url,
        llmsTxt: published.llmsTxt,
        source: "published",
        publishedAt: published.url,
        spec: { valid: published.conforms, issues: [] },
      });
    }
  }

  const generated = await generate(page.body, page.url, { seed });
  let extraction = generated.extraction;

  // Nothing extracted is worth a second look: some sites serve a challenge
  // with a 200, which the status check above cannot see.
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

  const { llmsTxt, report } = await enhance(extraction, page.url);
  const issues = validateLlmsTxt(llmsTxt);

  // Saved without conditions. Generating needs an account, which is what keeps
  // this table honest; nothing else has to be weighed.
  const stored = storeConfigured() ? await writeGeneration(url, llmsTxt, structureHash(extraction)) : false;

  return NextResponse.json({
    url: page.url,
    llmsTxt,
    saved: false,
    stored,
    crawl: generated.crawl,
    report,
    spec: { valid: issues.length === 0, issues },
    markdownAlternate: extraction.markdownAlternate,
    existingLlmsTxt: extraction.existingLlmsTxt,
  });
}
