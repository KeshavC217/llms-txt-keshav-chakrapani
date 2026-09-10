import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { SUPABASE_URL } from "./supabase/config.ts";

/**
 * Storage for generated files.
 *
 * The decision, recorded because it is the kind that is expensive to reverse:
 * generations are stored GLOBALLY, keyed by URL alone.
 *
 * Global rather than per user. The file is derived entirely from public pages,
 * so two people asking about the same site should get the same answer. Storing
 * a copy each would mean crawling that site once per person to produce
 * identical output, which is how a tool earns a site's 429s, and it multiplies
 * the model spend by the number of people who happened to be curious. It also
 * keeps monitoring coherent: one site, one schedule, one row to compare
 * against, rather than one per interested account.
 *
 * What is deliberately not global is who asked. The pages are public; the fact
 * that a particular person is reading a particular competitor's site is not. So
 * this table holds no user column at all, and anything about a person - history,
 * which sites they track - belongs in its own table under RLS when it exists.
 *
 * Everything a signed-in person generates is written, without conditions. An
 * earlier version weighed four of them - was the crawl complete, did the models
 * help, does it conform, is a store configured - and the result was that a file
 * could quietly fail to be kept for reasons nobody could see from the outside.
 * Generating requires an account, which is what keeps the table from filling
 * with junk, so nothing further needs guarding.
 *
 * The key is the URL alone, and stays that way only because every crawl uses
 * the same page ceiling. Anything that makes the output depend on a request
 * option - a prefix filter, a depth - has to enter the key with it, or the
 * first caller's options would be served to everyone who follows.
 *
 * Where this stops being right: the moment output stops being a pure function
 * of public data. If people can edit their file, supply their own prompt, or
 * point at a site only they can reach, that artifact is theirs and cannot be
 * shared - it belongs in a per-user table keyed to them, with this one left as
 * the shared cache underneath. And when prefix filters arrive, the key has to
 * take in the options: keyed on URL alone, someone asking for /docs/* would be
 * handed a whole-site file that happened to be stored first.
 *
 * The table is server-only. It has RLS enabled with no policies at all, so the
 * publishable key can read and write nothing - verified against the live
 * project, where a browser-key read returns no rows and a browser-key insert is
 * refused outright. This client uses the secret key, which bypasses RLS and
 * never leaves the server.
 *
 * Storage is an optimisation, not a dependency. Every function here returns
 * null or false rather than throwing when the table or the key is missing, so
 * the app works exactly as it did before the migration was run.
 */

const TABLE = "generations";

/*
 * The columns the table has, which db/schema.sql is the record of.
 *
 * There used to be a second, shorter list for each of these and a retry that
 * fell back to it, because selecting a column the table does not have is an
 * error rather than an omission - a read asking for everything returns nothing
 * at all, which emptied the saved list the first time this was deployed ahead
 * of its migration. That was worth having while the schema lived only in
 * someone's memory. It is written down now, so the fallback defended a state
 * that no longer occurs and hid a real misconfiguration behind a partial row.
 */
const SELECT_COLUMNS =
  "url, llms_txt, content_hash, generated_at, structure_hash, last_checked_at, changed_at, change_count, check_interval_hours, sitemap_hash, source, published_at, status, error, claimed_at";

const SUMMARY_COLUMNS = "url, generated_at, changed_at, source, status";

/**
 * Where a site is between being asked for and having a file.
 *
 * The queue and the catalogue are one list, so this is the only thing that
 * separates a site being crawled from one that is done.
 */
export type Status = "queued" | "crawling" | "ready" | "failed";

export interface StoredGeneration {
  url: string;
  /** Empty until the worker has written one; see `status`. */
  llmsTxt: string;
  status: Status;
  /** Why it failed, in the words the caller would have been given. */
  error?: string | null;
  contentHash: string;
  generatedAt: string;
  /** Fingerprint of the site itself, model-free; see lib/monitor.ts. */
  structureHash?: string | null;
  lastCheckedAt?: string | null;
  changedAt?: string | null;
  changeCount?: number;
  checkIntervalHours?: number;
  sitemapHash?: string | null;
  /** "generated" - we crawled and wrote it. "published" - the site's own file. */
  source?: string;
  /** For a published file, where it lives, so it can be re-read. */
  publishedAt?: string | null;
}

export const storeConfigured = () => Boolean(SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);

function client() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!SUPABASE_URL || !key) return null;

  return createClient(SUPABASE_URL, key, {
    // Nothing about this client belongs to a person: no session to persist and
    // none to refresh.
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** What monitoring will compare to notice a site has changed. */
export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export async function readGeneration(url: string): Promise<StoredGeneration | null> {
  const supabase = client();
  if (!supabase) return null;

  const { data, error } = await supabase.from(TABLE).select(SELECT_COLUMNS).eq("url", url).maybeSingle();

  // A missing table, a revoked key, an unreachable database: all mean "nothing
  // saved", which is a state this already handles.
  if (error || !data) return null;

  return fromRow(data);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function fromRow(row: any): StoredGeneration {
  return {
    url: row.url,
    llmsTxt: row.llms_txt ?? "",
    status: (row.status ?? "ready") as Status,
    error: row.error,
    contentHash: row.content_hash,
    generatedAt: row.generated_at,
    structureHash: row.structure_hash,
    lastCheckedAt: row.last_checked_at,
    changedAt: row.changed_at,
    changeCount: row.change_count ?? 0,
    checkIntervalHours: row.check_interval_hours ?? 24,
    sitemapHash: row.sitemap_hash,
    source: row.source ?? "generated",
    publishedAt: row.published_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Everything saved, newest first. Readable by anyone: these describe public pages. */
export interface SavedSummary {
  url: string;
  generatedAt: string;
  changedAt?: string | null;
  source: string;
  status: Status;
}

export async function listGenerations(limit = 100): Promise<SavedSummary[]> {
  const supabase = client();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from(TABLE)
    .select(SUMMARY_COLUMNS)
    .order("generated_at", { ascending: false })
    .limit(limit);

  // The column list is chosen at runtime, so the client cannot infer a row
  // type for it; the shape is asserted here the same way fromRow does.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return error || !data
    ? []
    : (data as any[]).map((row) => ({
        url: row.url,
        generatedAt: row.generated_at,
        changedAt: row.changed_at ?? null,
        source: row.source ?? "generated",
        status: (row.status ?? "ready") as Status,
      }));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * The rows a scheduled check should look at, least recently checked first, so
 * a run that can only manage a few takes the ones most overdue.
 */
export async function generationsToCheck(limit: number): Promise<StoredGeneration[]> {
  const supabase = client();
  if (!supabase) return [];

  const query = (columns: string) =>
    supabase.from(TABLE).select(columns).order("last_checked_at", { ascending: true, nullsFirst: true }).limit(limit);

  const attempt = await query(SELECT_COLUMNS);
  // Before the monitoring columns exist there is nothing to schedule, so an
  // empty list is the honest answer rather than a fallback.
  return attempt.error || !attempt.data ? [] : attempt.data.map(fromRow);
}

/**
 * Records the outcome of a check. Written even when nothing changed - that is
 * what moves the row down the queue and widens its interval.
 */
export async function recordCheck(
  url: string,
  update: {
    structureHash: string;
    sitemapHash?: string;
    checkIntervalHours: number;
    changed: boolean;
    changeCount: number;
    llmsTxt?: string;
  },
): Promise<boolean> {
  const supabase = client();
  if (!supabase) return false;

  const now = new Date().toISOString();
  const { error } = await supabase
    .from(TABLE)
    .update({
      structure_hash: update.structureHash,
      sitemap_hash: update.sitemapHash ?? null,
      check_interval_hours: update.checkIntervalHours,
      last_checked_at: now,
      change_count: update.changeCount,
      ...(update.changed ? { changed_at: now } : {}),
      // Only replaced when the site moved: an unchanged site keeps the file it
      // already has, along with the date it was generated.
      ...(update.llmsTxt ? { llms_txt: update.llmsTxt, content_hash: hashContent(update.llmsTxt), generated_at: now } : {}),
    })
    .eq("url", url);

  return !error;
}

/**
 * Writes the generated file, replacing any previous one for the same URL.
 * Returns whether it was stored, which the caller reports rather than assumes.
 */
export interface WriteOptions {
  structureHash?: string;
  /** "published" when this is the site's own file rather than one we built. */
  source?: "generated" | "published";
  publishedAt?: string;
}

export async function writeGeneration(url: string, llmsTxt: string, options: WriteOptions = {}): Promise<boolean> {
  const supabase = client();
  if (!supabase) return false;

  const row = {
    url,
    llms_txt: llmsTxt,
    content_hash: hashContent(llmsTxt),
    generated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from(TABLE).upsert({
    ...row,
    structure_hash: options.structureHash ?? null,
    source: options.source ?? "generated",
    published_at: options.publishedAt ?? null,
  });

  return !error;
}

/*
 * The queue, which is the same table as the catalogue.
 *
 * A separate jobs table was the obvious shape and the wrong one: it would mean
 * two lists to keep in step, and a site being crawled would be invisible to the
 * catalogue until it finished. One row per site, carrying its own state, is
 * fewer moving parts and a better product - the catalogue can say "crawling".
 */

/**
 * Asks for a site. Returns whether a crawl was actually queued.
 *
 * An upsert rather than an insert, because asking twice for the same site is
 * ordinary - two people, or one person impatient. A row already queued or
 * crawling is left exactly as it is, so a second ask joins the first rather
 * than restarting it or creating a duplicate.
 */
export async function enqueue(url: string): Promise<boolean> {
  const supabase = client();
  if (!supabase) return false;

  const existing = await readGeneration(url);
  if (existing && (existing.status === "queued" || existing.status === "crawling")) return true;

  const { error } = await supabase.from(TABLE).upsert({
    url,
    status: "queued",
    error: null,
    claimed_at: null,
    // Kept if the row already had one: a site being regenerated should go on
    // showing its previous file until the new one replaces it.
    ...(existing ? {} : { llms_txt: null, content_hash: "", generated_at: new Date().toISOString() }),
  });

  return !error;
}

/**
 * Takes one queued site, or null when there is nothing to do.
 *
 * The claim is optimistic rather than `for update skip locked`: the update is
 * conditional on the row still being queued, so two workers racing for the same
 * site produce one winner and one empty result, and the loser simply asks
 * again. That needs no stored procedure, which would have been a second place
 * where this logic lived and a migration to keep in step with it.
 */
export async function claimNext(): Promise<StoredGeneration | null> {
  const supabase = client();
  if (!supabase) return null;

  const { data: queued } = await supabase
    .from(TABLE)
    .select("url")
    .eq("status", "queued")
    .order("generated_at", { ascending: true })
    .limit(5);

  for (const candidate of queued ?? []) {
    const { data } = await supabase
      .from(TABLE)
      .update({ status: "crawling", claimed_at: new Date().toISOString() })
      .eq("url", candidate.url)
      .eq("status", "queued")
      .select(SELECT_COLUMNS)
      .maybeSingle();

    if (data) return fromRow(data);
  }

  return null;
}

/** The crawl produced a file. */
export async function completeGeneration(
  url: string,
  llmsTxt: string,
  options: WriteOptions = {},
): Promise<boolean> {
  const supabase = client();
  if (!supabase) return false;

  const { error } = await supabase
    .from(TABLE)
    .update({
      llms_txt: llmsTxt,
      content_hash: hashContent(llmsTxt),
      generated_at: new Date().toISOString(),
      structure_hash: options.structureHash ?? null,
      source: options.source ?? "generated",
      published_at: options.publishedAt ?? null,
      status: "ready",
      error: null,
      claimed_at: null,
    })
    .eq("url", url);

  return !error;
}

/**
 * The crawl could not produce one, and the reason is worth keeping.
 *
 * A site that refuses us says so in the catalogue rather than disappearing from
 * it, which is the difference between a tool that looks broken and one that
 * tells you what happened.
 */
export async function failGeneration(url: string, reason: string): Promise<boolean> {
  const supabase = client();
  if (!supabase) return false;

  const { error } = await supabase
    .from(TABLE)
    .update({ status: "failed", error: reason.slice(0, 500), claimed_at: null })
    .eq("url", url);

  return !error;
}

/**
 * Frees rows a worker claimed and never finished - it was cancelled, or the
 * runner was killed mid-crawl. Without this a crashed run would strand a site
 * in "crawling" forever, and nothing would ever pick it up again.
 */
export async function releaseStaleClaims(olderThanMs = 30 * 60_000): Promise<number> {
  const supabase = client();
  if (!supabase) return 0;

  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { data } = await supabase
    .from(TABLE)
    .update({ status: "queued", claimed_at: null })
    .eq("status", "crawling")
    .lt("claimed_at", cutoff)
    .select("url");

  return data?.length ?? 0;
}
