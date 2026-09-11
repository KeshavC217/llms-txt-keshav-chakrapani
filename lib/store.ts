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
  "url, llms_txt, content_hash, generated_at, structure_hash, last_checked_at, changed_at, check_interval_hours, sitemap_hash, source, published_at";

const SUMMARY_COLUMNS = "url, generated_at, last_checked_at, changed_at, source";

export interface StoredGeneration {
  url: string;
  llmsTxt: string;
  contentHash: string;
  generatedAt: string;
  /** Fingerprint of the site itself, model-free; see lib/monitor.ts. */
  structureHash?: string | null;
  lastCheckedAt?: string | null;
  changedAt?: string | null;
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
    llmsTxt: row.llms_txt,
    contentHash: row.content_hash,
    generatedAt: row.generated_at,
    structureHash: row.structure_hash,
    lastCheckedAt: row.last_checked_at,
    changedAt: row.changed_at,
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
  /** When the file itself was last written. */
  generatedAt: string;
  /**
   * When the site was last looked at, whether or not it had moved. This is
   * what "up to date as of" means: an unchanged site keeps its generatedAt
   * forever, so that date says how old the text is, not how current it is.
   */
  lastCheckedAt?: string | null;
  changedAt?: string | null;
  source: string;
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
        lastCheckedAt: row.last_checked_at ?? null,
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
    /*
     * Generating a site is looking at it, so this counts as its first check.
     *
     * Without it a new row has no last_checked_at, isDue reads never-checked
     * as due, and the next scheduled run spends a check asking whether the
     * site has changed since we built it minutes ago. Cheap when the site has
     * a sitemap and not cheap at all when it does not, since that falls
     * through to a full crawl.
     */
    last_checked_at: row.generated_at,
  });

  return !error;
}
