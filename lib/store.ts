import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { diffLlmsTxt, isEmptyDiff, type LlmsTxtDiff } from "./diff";

/**
 * Persistence for tracked sites and their generated llms.txt history.
 *
 * All access is server-side with a BYPASSRLS key (see db/schema.sql): the
 * tables have RLS on with no policies, so nothing but this module can read or
 * write them. The browser never talks to Supabase.
 */

export interface TrackedSite {
  id: string;
  url: string;
  createdAt: string;
  lastCheckedAt: string | null;
  nextCheckAt: string;
  checkIntervalHours: number;
  useAi: boolean;
  monitored: boolean;
  status: "active" | "paused";
  consecutiveFailures: number;
  lastError: string | null;
}

export interface Snapshot {
  id: string;
  siteId: string;
  createdAt: string;
  llmsTxt: string;
  contentHash: string;
  pageCount: number;
  aiStatus: string | null;
  diff: LlmsTxtDiff | null;
}

export function isStoreConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

export function hashContent(llmsTxt: string): string {
  return createHash("sha256").update(llmsTxt).digest("hex");
}

let cached: SupabaseClient | null = null;

function client(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  // No session persistence or token refresh: this is a stateless server-side
  // client, and a refresh loop in a serverless function leaks timers.
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

/** Only for tests, which swap the connection between fixtures. */
export function resetStoreClient(): void {
  cached = null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toSite(row: any): TrackedSite {
  return {
    id: row.id,
    url: row.url,
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
    nextCheckAt: row.next_check_at,
    checkIntervalHours: row.check_interval_hours,
    useAi: row.use_ai,
    monitored: row.monitored ?? false,
    status: row.status,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
  };
}

function toSnapshot(row: any): Snapshot {
  return {
    id: row.id,
    siteId: row.site_id,
    createdAt: row.created_at,
    llmsTxt: row.llms_txt,
    contentHash: row.content_hash,
    pageCount: row.page_count,
    aiStatus: row.ai_status,
    diff: row.diff ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Starts tracking a site, or returns the existing row.
 *
 * Upsert rather than insert-then-catch: `url` is unique, and two people
 * submitting the same site concurrently should both succeed rather than one
 * getting a constraint error.
 */
export async function upsertSite(
  url: string,
  options: { useAi?: boolean; intervalHours?: number; monitored?: boolean } = {}
): Promise<TrackedSite> {
  const { data, error } = await client()
    .from("tracked_sites")
    .upsert(
      {
        url,
        use_ai: options.useAi ?? false,
        ...(options.intervalHours ? { check_interval_hours: options.intervalHours } : {}),
        // Only ever raised, never lowered: a plain generate for a site someone
        // already chose to monitor must not silently unmonitor it.
        ...(options.monitored ? { monitored: true } : {}),
      },
      { onConflict: "url", ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) throw new Error(`Could not save that site: ${error.message}`);
  return toSite(data);
}

/** Starts monitoring a site (creating it if needed). */
export function trackSite(url: string, options: { useAi?: boolean; intervalHours?: number } = {}): Promise<TrackedSite> {
  return upsertSite(url, { ...options, monitored: true });
}

export async function getSiteByUrl(url: string): Promise<TrackedSite | null> {
  const { data, error } = await client().from("tracked_sites").select("*").eq("url", url).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toSite(data) : null;
}

/** Monitored sites only — the dashboard must not fill with one-off lookups. */
export async function listSites(limit = 50): Promise<TrackedSite[]> {
  const { data, error } = await client()
    .from("tracked_sites")
    .select("*")
    .eq("monitored", true)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map(toSite);
}

export async function latestSnapshot(siteId: string): Promise<Snapshot | null> {
  const { data, error } = await client()
    .from("snapshots")
    .select("*")
    .eq("site_id", siteId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toSnapshot(data) : null;
}

export async function listSnapshots(siteId: string, limit = 20): Promise<Snapshot[]> {
  const { data, error } = await client()
    .from("snapshots")
    .select("*")
    .eq("site_id", siteId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map(toSnapshot);
}

/** Sites whose next check is due. The schedule lives in the database, so the cron is a stateless query. */
export async function dueSites(limit = 10): Promise<TrackedSite[]> {
  const { data, error } = await client()
    .from("tracked_sites")
    .select("*")
    .eq("status", "active")
    .eq("monitored", true)
    .lte("next_check_at", new Date().toISOString())
    .order("next_check_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map(toSite);
}

export interface RecordResult {
  changed: boolean;
  snapshot: Snapshot | null;
  diff: LlmsTxtDiff | null;
}

/**
 * Records a freshly generated document, writing a snapshot only if the content
 * actually changed.
 *
 * Storing every run would turn the history into a log of how often the cron
 * fired rather than a record of how the site evolved — and it is the history a
 * user reads to answer "what changed?". The hash comparison is exact; the
 * structured diff is computed for the notification, not for the decision.
 */
export async function recordGeneration(
  site: TrackedSite,
  llmsTxt: string,
  meta: { pageCount: number; aiStatus?: string }
): Promise<RecordResult> {
  const hash = hashContent(llmsTxt);
  const previous = await latestSnapshot(site.id);

  // Only advance the schedule for sites the scheduler actually visits;
  // a one-off generate should not look like a completed monitoring check.
  if (site.monitored) await markChecked(site);

  if (previous?.contentHash === hash) {
    return { changed: false, snapshot: previous, diff: null };
  }

  const diff = previous ? diffLlmsTxt(previous.llmsTxt, llmsTxt) : null;
  // A hash change with no structural change means only formatting moved —
  // still worth storing as the current version, but not worth announcing.
  const reportableDiff = diff && !isEmptyDiff(diff) ? diff : null;

  const { data, error } = await client()
    .from("snapshots")
    .insert({
      site_id: site.id,
      llms_txt: llmsTxt,
      content_hash: hash,
      page_count: meta.pageCount,
      ai_status: meta.aiStatus ?? null,
      diff: reportableDiff,
    })
    .select()
    .single();

  if (error) throw new Error(`Could not store snapshot: ${error.message}`);
  return { changed: true, snapshot: toSnapshot(data), diff: reportableDiff };
}

/** Marks a successful check and schedules the next one. */
export async function markChecked(site: TrackedSite): Promise<void> {
  const next = new Date(Date.now() + site.checkIntervalHours * 3600_000).toISOString();
  await client()
    .from("tracked_sites")
    .update({ last_checked_at: new Date().toISOString(), next_check_at: next, consecutive_failures: 0, last_error: null })
    .eq("id", site.id);
}

const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Records a failed check with exponential backoff, pausing a site that keeps
 * failing rather than retrying a dead host forever.
 */
export async function markFailed(site: TrackedSite, message: string): Promise<void> {
  const failures = site.consecutiveFailures + 1;
  const backoffHours = Math.min(site.checkIntervalHours * 2 ** failures, 24 * 7);
  await client()
    .from("tracked_sites")
    .update({
      last_checked_at: new Date().toISOString(),
      next_check_at: new Date(Date.now() + backoffHours * 3600_000).toISOString(),
      consecutive_failures: failures,
      last_error: message.slice(0, 500),
      ...(failures >= MAX_CONSECUTIVE_FAILURES ? { status: "paused" } : {}),
    })
    .eq("id", site.id);
}

export async function deleteSite(siteId: string): Promise<void> {
  await client().from("tracked_sites").delete().eq("id", siteId);
}
