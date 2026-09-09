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
 * Only AI-assisted results are written. That is the expensive path and the one
 * behind an account, so caching it saves something real. The deterministic file
 * is free and fast from /api/generate, so a row holding one would save nothing;
 * worse, a public endpoint that writes to durable storage is an invitation to
 * fill it with junk, and requiring an account closes that.
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

/** How long a stored file is served before it is generated afresh. */
const MAX_AGE_MS = Number(process.env.GENERATION_MAX_AGE_MS ?? 24 * 60 * 60 * 1000);

export interface StoredGeneration {
  url: string;
  llmsTxt: string;
  contentHash: string;
  generatedAt: string;
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

  const { data, error } = await supabase
    .from(TABLE)
    .select("url, llms_txt, content_hash, generated_at")
    .eq("url", url)
    .maybeSingle();

  // A missing table, a revoked key, an unreachable database: all mean "no
  // cached answer", which is a state this already handles.
  if (error || !data) return null;

  return {
    url: data.url,
    llmsTxt: data.llms_txt,
    contentHash: data.content_hash,
    generatedAt: data.generated_at,
  };
}

/**
 * Writes the generated file, replacing any previous one for the same URL.
 * Returns whether it was stored, which the caller reports rather than assumes.
 */
export async function writeGeneration(url: string, llmsTxt: string): Promise<boolean> {
  const supabase = client();
  if (!supabase) return false;

  const { error } = await supabase
    .from(TABLE)
    .upsert({
      url,
      llms_txt: llmsTxt,
      content_hash: hashContent(llmsTxt),
      generated_at: new Date().toISOString(),
    });

  return !error;
}
