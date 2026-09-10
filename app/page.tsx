import Link from "next/link";

import { Generator } from "./Generator";
import { listGenerations } from "@/lib/store";
import { signOut } from "./login/actions";
import { authConfigured } from "@/lib/supabase/config";
import { getUser } from "@/lib/supabase/server";

export default async function Home() {
  // Both are public reads; only generating is gated.
  const [user, saved] = await Promise.all([getUser(), listGenerations(50)]);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      {authConfigured && (
        <div className="mb-8 flex items-center justify-end gap-3 text-sm text-neutral-500">
          {user ? (
            <>
              <span>{user.email}</span>
              <form action={signOut}>
                <button type="submit" className="underline">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <Link href="/login" className="underline">
              Sign in
            </Link>
          )}
        </div>
      )}

      <Generator signedIn={Boolean(user)} saved={saved} />
    </main>
  );
}
