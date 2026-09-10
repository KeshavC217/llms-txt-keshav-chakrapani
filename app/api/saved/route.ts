import { NextResponse } from "next/server";

import { listGenerations, readGeneration, storeConfigured } from "@/lib/store";
import { normalizeUrl } from "@/lib/fetchPage";

/**
 * Reading what has been generated. No account required.
 *
 * These files describe public pages and were produced from public pages, so
 * there is nothing here to protect. Generating is what costs something and
 * what needs an account; reading the result does not.
 */

export async function GET(request: Request) {
  if (!storeConfigured()) return NextResponse.json({ saved: [] });

  const requested = new URL(request.url).searchParams.get("url");

  if (requested) {
    const url = normalizeUrl(requested);
    if (!url) return NextResponse.json({ error: "Please ask for a valid URL." }, { status: 400 });

    const saved = await readGeneration(url);
    if (!saved) return NextResponse.json({ error: "Nothing has been generated for that site yet." }, { status: 404 });

    return NextResponse.json({
      url: saved.url,
      llmsTxt: saved.llmsTxt,
      generatedAt: saved.generatedAt,
      changedAt: saved.changedAt,
      saved: true,
    });
  }

  return NextResponse.json({ saved: await listGenerations() });
}
