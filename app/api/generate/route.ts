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
import { Deadline, REQUEST_BUDGET_MS } from "@/lib/deadline";

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
        source: saved.source,
        publishedAt: saved.publishedAt,
        generatedAt: saved.generatedAt,
        spec: { valid: validateLlmsTxt(saved.llmsTxt).length === 0, issues: [] },
      });
    }
  }

  /*
   * One clock for everything below.
   *
   * Started after the gate rather than at the top of the handler, so a caller
   * who has to sign in is not charged for the check. Every network step from
   * here takes the shorter of its own cap and what this has left, and the
   * handler returns whatever it has when the clock runs out - rather than
   * being killed by the platform partway through, which returns nothing,
   * stores nothing, and leaves the next attempt to fail identically.
   */
  const deadline = new Deadline(REQUEST_BUDGET_MS);

  let page;
  try {
    page = await fetchPage(url, deadline);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not fetch that URL.";
    // A refused host is the caller's mistake; a failed fetch is the site's.
    const status = /publicly reachable|Could not resolve/.test(message) ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }

  // A challenge page parses perfectly well and describes nothing but the
  // challenge, so it must not be turned into an llms.txt. Saying which site
  // refused us and why is the whole of what can be done about it.
  if (page.block) {
    return NextResponse.json(
      { error: explain(page.block, page.url), blocked: page.block.kind, url: page.url },
      { status: 502 },
    );
  }

  if (!page.isHtml) {
    return NextResponse.json({ error: "That URL is not an HTML page, so there is nothing to read." }, { status: 415 });
  }

  let seed = extract(page.body, page.url);

  /*
   * Nothing to describe, so read it the way a browser would.
   *
   * The trigger is simply that the fetch found no links. It used to also
   * require `clientRendered` - positive evidence of a shell - and that turned
   * out to be too narrow against a live site: resy.com serves a different page
   * to a datacentre address than to a laptop, and the variant Vercel receives
   * does not look like a shell, so the render was skipped and the file came
   * back empty.
   *
   * Dropping the condition is safe because of the one below it: the rendered
   * page is adopted only if it found MORE links than the plain fetch did. The
   * cost of guessing wrong is a few seconds on a site that genuinely has no
   * links, which is rare and which the crawl would find nothing on anyway.
   */
  if (linkCount(seed) === 0 && renderConfigured()) {
    const rendered = await renderPage(page.url);
    if (rendered) {
      const fromBrowser = extract(rendered.html, rendered.url);
      if (linkCount(fromBrowser) > linkCount(seed)) {
        page = { ...page, url: rendered.url, body: rendered.html };
        seed = fromBrowser;
      }
    }
  }

  // If the site publishes its own, that is the answer: someone chose what
  // belonged in it. Saved like anything else, but marked as theirs - so the
  // list says which files this project wrote and which it merely found, and so
  // the scheduled check knows to re-read their file rather than crawl.
  if (body.regenerate !== true) {
    const published = await findPublished(page.url, USER_AGENT, seed.existingLlmsTxt, deadline);
    if (published) {
      const kept = storeConfigured()
        ? await writeGeneration(url, published.llmsTxt, { source: "published", publishedAt: published.url })
        : false;

      return NextResponse.json({
        url: page.url,
        llmsTxt: published.llmsTxt,
        source: "published",
        publishedAt: published.url,
        stored: kept,
        spec: { valid: published.conforms, issues: [] },
      });
    }
  }

  const generated = await generate(page.body, page.url, { seed, deadline });
  const extraction = generated.extraction;

  // Nothing extracted is worth a second look: some sites serve a challenge
  // with a 200, which the status check above cannot see.
  if (linkCount(extraction) === 0) {
    const late = classifyEmpty(page.body);
    if (late) {
      return NextResponse.json(
        { error: explain(late, page.url), blocked: late.kind, url: page.url },
        { status: 502 },
      );
    }
  }

  const { llmsTxt, report } = await enhance(extraction, page.url, undefined, deadline);
  const issues = validateLlmsTxt(llmsTxt);

  /*
   * A file cut short by the clock is stored, but without a fingerprint.
   *
   * Refusing to store it was tried here and undone: it recreates the dead zone
   * this deadline exists to remove. A site slow enough to always run out of
   * time would always be partial, so it would never acquire a file at all -
   * which is the original bug wearing a better error message. It also puts
   * back the "was the crawl complete" condition that #13 removed on purpose.
   *
   * What must not be stored is the structure hash. Which pages a partial crawl
   * holds depends on how fast the site was today, so a fingerprint taken from
   * one would report a change on every subsequent check and the site would be
   * rewritten forever. A null hash already means "no baseline" to the monitor,
   * which takes a fresh one from its own complete crawl and improves the file
   * then.
   */
  const partial = generated.crawl?.partial === true;
  const stored = storeConfigured()
    ? await writeGeneration(url, llmsTxt, {
        structureHash: partial ? undefined : structureHash(extraction),
        source: "generated",
      })
    : false;

  return NextResponse.json({
    url: page.url,
    llmsTxt,
    saved: false,
    stored,
    partial,
    crawl: generated.crawl,
    report,
    spec: { valid: issues.length === 0, issues },
    existingLlmsTxt: extraction.existingLlmsTxt,
  });
}
