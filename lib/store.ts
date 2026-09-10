import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { SUPABASE_URL } from "./supabase/config.ts";

/**
 * Storage for generated files.
 *
 * The decision, recorded because it is the kind that is expensive to reverse:
 * generations are stored GLOBALLY, and only when the AI pass produced them.
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
 * Two column lists, because a migration and a deploy arrive by different hands.
 *
 * Selecting a column the table does not have is an error, not an omission, so a
 * read asking for everything returns nothing at all - which emptied the saved
 * list entirely the first time this was tried before the migration had run.
 * Each read asks for the full set, and falls back to what has always existed.
 */
const BASE_COLUMNS = "url, llms_txt, content_hash, generated_at";
const SELECT_COLUMNS = `${BASE_COLUMNS}, structure_hash, last_checked_at, changed_at, change_count, check_interval_hours, sitemap_hash, source, published_at`;

const BASE_SUMMARY = "url, generated_at";
const SUMMARY_COLUMNS = `${BASE_SUMMARY}, changed_at, source`;

/** True when a query failed only because the schema is older than the code. */
const isMissingColumn = (error: { code?: string } | null) =>
  error?.code === "PGRST204" || error?.code === "42703";

/** How long a stored file is served before it is generated afresh. */
const MAX_AGE_MS = Number(process.env.GENERATION_MAX_AGE_MS ?? 24 * 60 * 60 * 1000);

export interface StoredGeneration {
  url: string;
  llmsTxt: string;
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

export function isFresh(generatedAt: string, now = Date.now()): boolean {
  const age = now - Date.parse(generatedAt);
  return Number.isFinite(age) && age >= 0 && age < MAX_AGE_MS;
}

export async function readGeneration(url: string): Promise<StoredGeneration | null> {
  const supabase = client();
  if (!supabase) return null;

  const attempt = await supabase.from(TABLE).select(SELECT_COLUMNS).eq("url", url).maybeSingle();
  const { data, error } = isMissingColumn(attempt.error)
    ? await supabase.from(TABLE).select(BASE_COLUMNS).eq("url", url).maybeSingle()
    : attempt;

  // A missing table, a revoked key, an unreachable database: all mean "nothing
  // saved", which is a state this already handles.
  if (error || !data) return null;

  return fromRow(data);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function fromRow(row: any): StoredGeneration {
  return {
    url: row.url,
    llmsTxt: row.llms_txt,
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
}

export async function listGenerations(limit = 100): Promise<SavedSummary[]> {
  const supabase = client();
  if (!supabase) return [];

  const query = (columns: string) =>
    supabase.from(TABLE).select(columns).order("generated_at", { ascending: false }).limit(limit);

  const attempt = await query(SUMMARY_COLUMNS);
  const { data, error } = isMissingColumn(attempt.error) ? await query(BASE_SUMMARY) : attempt;

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
  if (!error) return true;

  /*
   * The monitoring columns may not exist yet.
   *
   * Code and migration are deployed by different hands and rarely at the same
   * moment. Without this, a deploy that lands first turns every write into a
   * silent failure and caching simply stops - which is exactly what happened
   * on the first run of this change locally. Writing the older shape keeps the
   * feature that already worked working, and the next check fills in the
   * fingerprint once the column is there.
   */
  // PGRST204 is what PostgREST returns for a column its schema cache does not
  // know; 42703 is Postgres's own code for the same thing, kept in case the
  // request ever reaches the database directly. The first is what actually
  // came back when this was tried against the live project.
  if (error.code === "PGRST204" || error.code === "42703") {
    const { error: retry } = await supabase.from(TABLE).upsert(row);
    return !retry;
  }

  return false;
}
