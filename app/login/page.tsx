import { redirect } from "next/navigation";

import { getUser } from "@/lib/supabase/server";
import { authConfigured } from "@/lib/supabase/config";

import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in - llms.txt Generator" };

export default async function LoginPage() {
  if (await getUser()) redirect("/");

  return (
    <main className="mx-auto w-full max-w-sm px-6 py-16">
      <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-neutral-500">
        The generator is open to everyone. An account is only needed for the AI features.
      </p>

      {authConfigured ? (
        <LoginForm />
      ) : (
        <p className="mt-8 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Accounts are not configured on this deployment. Set SUPABASE_URL and
          SUPABASE_PUBLISHABLE_KEY to enable them.
        </p>
      )}
    </main>
  );
}
