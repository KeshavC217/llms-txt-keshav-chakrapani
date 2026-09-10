import { NextResponse } from "next/server";

import { checkGenerateAccess } from "@/lib/authGate";
import { enqueue, readGeneration, storeConfigured } from "@/lib/store";
import { normalizeUrl } from "@/lib/fetchPage";
import { requestCrawl } from "@/lib/dispatch";
import { authConfigured } from "@/lib/supabase/config";
import { getUser } from "@/lib/supabase/server";
import { validateLlmsTxt } from "@/lib/spec";

/**
 * Asking for a site's llms.txt.
 *
 * This used to do the whole job - fetch, crawl, two model passes, store - which
 * meant it had to finish inside a Vercel function's sixty seconds. It is now an
 * enqueue: it writes a row and returns, and scripts/worker.ts fills it in with
 * no ceiling to work under. The deadline that used to thread through every step
 * left with the work.
 *
 * What has not changed: a saved file is served straight back, generating needs
 * an account, and reading needs none.
 */

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

  const access = checkGenerateAccess({ signedIn: Boolean(await getUser()), authConfigured });
  if (!access.allowed) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  if (!storeConfigured()) {
    return NextResponse.json(
      { error: "No store is configured on this deployment, so there is nowhere to put the result." },
      { status: 503 },
    );
  }

  // A saved file is the answer unless a fresh one was asked for. It is not a
  // cache with an expiry: it is what this site's llms.txt is, until something
  // changes it - a person asking again, or the scheduled check noticing the
  // site moved.
  const saved = await readGeneration(url);
  if (saved && saved.status === "ready" && body.regenerate !== true) {
    return NextResponse.json({
      url: saved.url,
      llmsTxt: saved.llmsTxt,
      status: saved.status,
      saved: true,
      source: saved.source,
      publishedAt: saved.publishedAt,
      generatedAt: saved.generatedAt,
      spec: { valid: validateLlmsTxt(saved.llmsTxt).length === 0, issues: [] },
    });
  }

  if (!(await enqueue(url))) {
    return NextResponse.json({ error: "Could not queue that site. Try again." }, { status: 502 });
  }

  /*
   * Wake the worker, and do not care much whether it woke.
   *
   * The dispatch is what makes a queued site start within seconds instead of
   * waiting for the next scheduled pass. If it fails - no token configured, a
   * GitHub outage - the row is still queued and the schedule will collect it,
   * so this reports what happened rather than failing the request.
   */
  const dispatched = await requestCrawl(url);

  return NextResponse.json({ url, status: "queued", dispatched });
}
