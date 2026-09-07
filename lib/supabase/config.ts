/**
 * Supabase configuration, in one place so a missing variable fails loudly at
 * the point of use rather than as an opaque 401 from the API later.
 *
 * Neither name is NEXT_PUBLIC_. Sign-in happens in a server action and the
 * session is refreshed in the proxy, so nothing in the browser talks to
 * Supabase and nothing needs to be shipped to it. The publishable key would be
 * safe to expose - that is what "publishable" means - but exposing a value no
 * client reads is surface for nothing.
 *
 * The key still matters: it is the anonymous tier, so row-level security
 * applies to whatever a signed-in user does. The secret key, read nowhere in
 * this app, bypasses RLS entirely - using it for user sessions would make
 * every row policy decoration.
 */

export const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
export const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

/**
 * Whether auth is configured at all. The generator works without it - only the
 * LLM features require an account - so the app has to run, and say so, with
 * these unset rather than crash on boot.
 */
export const authConfigured = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
