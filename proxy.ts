import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, authConfigured } from "./lib/supabase/config.ts";

/**
 * Refreshes the Supabase session on every request.
 *
 * Access tokens are short-lived. Without a refresh running ahead of the render,
 * a signed-in user silently becomes signed-out an hour later - and a server
 * component cannot fix it, because it cannot set cookies.
 *
 * This is `proxy.ts`, not `middleware.ts`: the middleware convention is
 * deprecated in Next 16 and renamed to proxy, so every Supabase guide that
 * says middleware.ts is describing an older Next than this one.
 */
export async function proxy(request: NextRequest) {
  if (!authConfigured) return NextResponse.next({ request });

  // Cookies must be written to a response that is actually returned, so this
  // response is threaded through rather than recreated afterwards.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // This call is the refresh. Nothing here reads the result: the point is the
  // rotated cookie it leaves on `response`.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  // Everything except static assets. Without a matcher this runs on every
  // request including CSS and images, which is a needless auth round trip.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
