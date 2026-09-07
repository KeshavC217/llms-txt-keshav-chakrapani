import { NextResponse } from "next/server";

import { checkLlmAccess } from "@/lib/authGate";
import { enhance } from "@/lib/ai/enhance";
import { extract } from "@/lib/naiveExtractor";
import { fetchPage, normalizeUrl } from "@/lib/fetchPage";
import { aiConfigured } from "@/lib/ai/models";
import { authConfigured } from "@/lib/supabase/config";
import { getUser } from "@/lib/supabase/server";
import { validateLlmsTxt } from "@/lib/spec";

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

  if (!page.isHtml) {
    return NextResponse.json({ error: "That URL is not an HTML page, so there is nothing to enhance." }, { status: 415 });
  }

  const extraction = extract(page.body, page.url);
  const { llmsTxt, enhanced, report } = await enhance(extraction, page.url);
  const issues = validateLlmsTxt(llmsTxt);

  return NextResponse.json({
    url: page.url,
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
