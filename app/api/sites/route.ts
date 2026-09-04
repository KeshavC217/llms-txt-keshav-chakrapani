import { NextResponse } from "next/server";
import { generateLlmsTxt, normalizeUrl } from "@/lib/generate";
import { summarizeDiff } from "@/lib/diff";
import {
  deleteSite,
  isStoreConfigured,
  latestSnapshot,
  listSites,
  listSnapshots,
  recordGeneration,
  trackSite,
} from "@/lib/store";

export const maxDuration = 300;

const REQUEST_BUDGET_MS = 55_000;
/**
 * Tracking is anonymous, so there is nothing stopping one person queueing a
 * thousand sites for our crawler to hit. A cap is the minimum defence; it is
 * not a substitute for auth, and the README says so.
 */
const MAX_TRACKED_SITES = Number(process.env.MAX_TRACKED_SITES ?? 100);
/** Refuse to schedule a crawl more often than this against a third party. */
const MIN_INTERVAL_HOURS = Number(process.env.MIN_CHECK_INTERVAL_HOURS ?? 6);

function storeUnavailable() {
  return NextResponse.json(
    { error: "Monitoring is not configured on this deployment (SUPABASE_URL / SUPABASE_SECRET_KEY)." },
    { status: 503 }
  );
}

/** Lists tracked sites with their latest result, for the dashboard. */
export async function GET() {
  if (!isStoreConfigured()) return storeUnavailable();

  try {
    const sites = await listSites();
    const rows = await Promise.all(
      sites.map(async (site) => {
        const snapshot = await latestSnapshot(site.id);
        return {
          ...site,
          pageCount: snapshot?.pageCount ?? null,
          lastGeneratedAt: snapshot?.createdAt ?? null,
          lastChangeSummary: snapshot?.diff ? summarizeDiff(snapshot.diff) : null,
        };
      })
    );
    return NextResponse.json({ sites: rows });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to list sites." }, { status: 500 });
  }
}

/** Starts tracking a site and generates its first snapshot. */
export async function POST(request: Request) {
  if (!isStoreConfigured()) return storeUnavailable();

  let body: { url?: string; useAi?: boolean; intervalHours?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const url = normalizeUrl(body.url ?? "");
  if (!url) return NextResponse.json({ error: "Please enter a valid URL." }, { status: 400 });

  const intervalHours = Math.max(MIN_INTERVAL_HOURS, Number(body.intervalHours) || 24);

  try {
    const existing = await listSites(MAX_TRACKED_SITES + 1);
    if (existing.length > MAX_TRACKED_SITES && !existing.some((s) => s.url === url)) {
      return NextResponse.json(
        { error: `This deployment tracks at most ${MAX_TRACKED_SITES} sites.` },
        { status: 429 }
      );
    }

    const site = await trackSite(url, { useAi: Boolean(body.useAi), intervalHours });
    const result = await generateLlmsTxt(url, {
      useAi: Boolean(body.useAi),
      budgetMs: REQUEST_BUDGET_MS,
    });
    const recorded = await recordGeneration(site, result.llmsTxt, {
      pageCount: result.pageCount,
      aiStatus: result.aiStatus,
    });

    return NextResponse.json({
      site,
      llmsTxt: result.llmsTxt,
      pageCount: result.pageCount,
      aiStatus: result.aiStatus,
      changed: recorded.changed,
      changeSummary: recorded.diff ? summarizeDiff(recorded.diff) : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to track that site.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/** Stops tracking a site and drops its history. */
export async function DELETE(request: Request) {
  if (!isStoreConfigured()) return storeUnavailable();

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing site id." }, { status: 400 });

  try {
    await deleteSite(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!isStoreConfigured()) return storeUnavailable();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing site id." }, { status: 400 });
  try {
    return NextResponse.json({ snapshots: await listSnapshots(id) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed." }, { status: 500 });
  }
}
