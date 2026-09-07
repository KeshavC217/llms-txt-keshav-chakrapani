import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, authConfigured } from "./config.ts";

/**
 * A Supabase client for server components, server actions and route handlers.
 *
 * `cookies()` is async in this version of Next, so this is too - the older
 * synchronous form found in most Supabase guides does not apply here.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // A server component cannot set cookies. That is expected: the proxy
          // refreshes the session on every request, so the write it could not
          // make here has already happened there.
        }
      },
    },
  });
}

/**
 * The signed-in user, or null.
 *
 * Deliberately `getUser()` and not `getSession()`: getSession reads the cookie
 * and trusts it, while getUser verifies the token with Supabase. For deciding
 * whether to run a paid LLM call, the cookie's own claim is not good enough.
 */
export async function getUser() {
  if (!authConfigured) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user;
}
