import { NextResponse } from "next/server";

import { checkGenerateAccess } from "@/lib/authGate";
import { classifyEmpty, explain } from "@/lib/blocks";
import { enhance } from "@/lib/ai/enhance";
import { extract, linkCount } from "@/lib/naiveExtractor";
import { fetchPage, normalizeUrl, USER_AGENT } from "@/lib/fetchPage";
import { findPublished } from "@/lib/published";
import { generate } from "@/lib/generate";
import type { ProgressEvent } from "@/lib/progress";
import { describeRenderFailure, renderConfigured, renderPage } from "@/lib/render";
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
 *
 * THE RESPONSE IS TWO SHAPES, TOLD APART BY CONTENT-TYPE.
 *
 * Everything that can be answered without doing the real work - a bad body, an
 * invalid URL, the auth gate, a file already on hand - still comes back as one
 * `application/json` object with a real HTTP status, exactly as it always has.
 *
 * The moment the handler commits to fetching, crawling and running models, it
 * switches to `application/x-ndjson`: one JSON object per line, streamed as
 * the work happens, so the caller can narrate what is taking so long rather
 * than stare at a spinner for up to fifty seconds. Every line but the last is
 * `{"type":"progress", ...}`, shaped by lib/progress.ts. The last line is
 * always `{"type":"result", "ok": boolean, "status": number, ...}` - status
 * carries the HTTP code this would have been without streaming, since the
 * response itself has already committed to 200 by the time anything is known.
 * app/Generator.tsx is the reader.
 */

// A crawl and two model passes.
/*
 * The platform's ceiling, not the request's budget - those are different jobs.
 * REQUEST_BUDGET_MS in lib/deadline.ts is what the handler aims to finish
 * inside; this is the backstop that ends a request which somehow did not.
 * Hobby allows 300s with fluid compute, which is where the old 60 came from
 * and no longer is.
 */
export const maxDuration = 300;

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
  // the site moved. Nothing to narrate here, so this stays plain JSON.
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
        // How current the file is, which is the last check rather than the
        // last rewrite; an unchanged site keeps both its text and its date.
        lastCheckedAt: saved.lastCheckedAt,
        spec: { valid: validateLlmsTxt(saved.llmsTxt).length === 0, issues: [] },
      });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (line: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      const progress = (event: ProgressEvent) => emit({ type: "progress", ...event });
      const finish = (payload: Record<string, unknown>) => {
        emit({ type: "result", ...payload });
        controller.close();
      };

      try {
        /*
         * One clock for everything below.
         *
         * Started after the gate rather than at the top of the handler, so a
         * caller who has to sign in is not charged for the check. Every
         * network step from here takes the shorter of its own cap and what
         * this has left, and the handler returns whatever it has when the
         * clock runs out - rather than being killed by the platform partway
         * through, which returns nothing, stores nothing, and leaves the next
         * attempt to fail identically.
         */
        const deadline = new Deadline(REQUEST_BUDGET_MS);

        progress({ stage: "fetching" });

        let page;
        try {
          page = await fetchPage(url, deadline);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Could not fetch that URL.";
          // A refused host is the caller's mistake; a failed fetch is the site's.
          const status = /publicly reachable|Could not resolve/.test(message) ? 400 : 502;
          finish({ ok: false, status, error: message });
          return;
        }

        // A challenge page parses perfectly well and describes nothing but the
        // challenge, so it must not be turned into an llms.txt. Saying which
        // site refused us and why is the whole of what can be done about it.
        if (page.block) {
          finish({ ok: false, status: 502, error: explain(page.block, page.url), blocked: page.block.kind, url: page.url });
          return;
        }

        if (!page.isHtml) {
          finish({ ok: false, status: 415, error: "That URL is not an HTML page, so there is nothing to read." });
          return;
        }

        let seed = extract(page.body, page.url);

        /*
         * Nothing to describe, so read it the way a browser would.
         *
         * The trigger is simply that the fetch found no links. It used to also
         * require `clientRendered` - positive evidence of a shell - and that
         * turned out to be too narrow against a live site: the render is
         * adopted only if it found MORE links than the plain fetch did, so
         * trying whenever we found none costs a few seconds at worst.
         */
        let renderNote: string | undefined;

        if (linkCount(seed) === 0 && renderConfigured()) {
          progress({ stage: "rendering" });
          const rendered = await renderPage(page.url, deadline);

          if (rendered.ok) {
            const fromBrowser = extract(rendered.html, rendered.url);
            if (linkCount(fromBrowser) > linkCount(seed)) {
              page = { ...page, url: rendered.url, body: rendered.html };
              seed = fromBrowser;
              renderNote = `rendered (${rendered.waitedFor}): ${linkCount(fromBrowser)} links`;
            } else {
              /*
               * The browser ran and the page is still empty. Not a failure of
               * this code, and worth saying out loud: it is what a site that
               * serves nothing to automation looks like from here, and it is
               * the case that has to be told apart from a timeout.
               */
              renderNote = `rendered (${rendered.waitedFor}) but found no links`;
            }
          } else {
            renderNote = describeRenderFailure(rendered);
          }

          // The deployment's copy of this is the only place the answer lives:
          // resy.com renders on a laptop and not here, and until now every way
          // of failing arrived as the same silence.
          console.log(`render ${page.url}: ${renderNote}`);
        }

        // If the site publishes its own, that is the answer: someone chose
        // what belonged in it. Saved like anything else, but marked as theirs
        // - so the list says which files this project wrote and which it
        // merely found, and so the scheduled check knows to re-read their
        // file rather than crawl.
        if (body.regenerate !== true) {
          progress({ stage: "checking-published" });
          const published = await findPublished(page.url, USER_AGENT, seed.existingLlmsTxt, deadline);
          if (published) {
            progress({ stage: "saving" });
            const kept = storeConfigured()
              ? await writeGeneration(url, published.llmsTxt, { source: "published", publishedAt: published.url })
              : false;

            finish({
              ok: true,
              status: 200,
              url: page.url,
              llmsTxt: published.llmsTxt,
              source: "published",
              publishedAt: published.url,
              stored: kept,
              spec: { valid: published.conforms, issues: [] },
            });
            return;
          }
        }

        const generated = await generate(page.body, page.url, { seed, deadline, onProgress: progress });
        const extraction = generated.extraction;

        // Nothing extracted is worth a second look: some sites serve a
        // challenge with a 200, which the status check above cannot see.
        if (linkCount(extraction) === 0) {
          const late = classifyEmpty(page.body);
          if (late) {
            finish({ ok: false, status: 502, error: explain(late, page.url), blocked: late.kind, url: page.url });
            return;
          }
        }

        const { llmsTxt, report } = await enhance(extraction, page.url, undefined, deadline, progress);
        const issues = validateLlmsTxt(llmsTxt);

        progress({ stage: "saving" });

        /*
         * A file cut short by the clock is stored, but without a fingerprint.
         *
         * Refusing to store it was tried and undone: it recreates the dead
         * zone the deadline exists to remove. What must not be stored is the
         * structure hash - which pages a partial crawl holds depends on how
         * fast the site was today, so a fingerprint from one would report a
         * change on every subsequent check. A null hash already means "no
         * baseline" to the monitor, which takes a fresh one from its own
         * complete crawl.
         */
        const partial = generated.crawl?.partial === true;
        const stored = storeConfigured()
          ? await writeGeneration(url, llmsTxt, {
              structureHash: partial ? undefined : structureHash(extraction),
              source: "generated",
            })
          : false;

        finish({
          ok: true,
          status: 200,
          url: page.url,
          llmsTxt,
          saved: false,
          stored,
          partial,
          crawl: generated.crawl,
          report,
          spec: { valid: issues.length === 0, issues },
          existingLlmsTxt: extraction.existingLlmsTxt,
          // Only present when a browser was tried, which is only when the
          // plain fetch found nothing. Travels in the response as well as the
          // log so the answer does not require access to the deployment.
          render: renderNote,
        });
      } catch (err) {
        // A safety net rather than a routine path: nothing above should throw
        // uncaught, and a stream that ended with no result line would leave
        // the caller waiting on a bar that can never finish.
        finish({ ok: false, status: 500, error: err instanceof Error ? err.message : "Something went wrong." });
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
