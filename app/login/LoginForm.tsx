"use client";

import Link from "next/link";
import { useActionState } from "react";

import { type AuthState, authenticate } from "./actions";

export function LoginForm() {
  const [state, run, busy] = useActionState(authenticate, {} as AuthState);

  return (
    <form action={run} className="mt-8 flex flex-col gap-3">
      <label className="text-sm font-medium" htmlFor="email">
        Email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        className="rounded-lg border border-neutral-300 px-4 py-3 outline-none focus:border-neutral-500 dark:border-neutral-700"
      />

      <label className="mt-2 text-sm font-medium" htmlFor="password">
        Password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        minLength={8}
        required
        className="rounded-lg border border-neutral-300 px-4 py-3 outline-none focus:border-neutral-500 dark:border-neutral-700"
      />

      {state.error && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:bg-blue-950 dark:text-blue-300">
          {state.message}
        </p>
      )}

      <div className="mt-2 flex gap-3">
        <button
          type="submit"
          name="intent"
          value="signin"
          disabled={busy}
          className="flex-1 rounded-lg bg-neutral-900 px-6 py-3 font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {busy ? "Working…" : "Sign in"}
        </button>
        <button
          type="submit"
          name="intent"
          value="signup"
          disabled={busy}
          className="flex-1 rounded-lg border border-neutral-300 px-6 py-3 font-medium disabled:opacity-40 dark:border-neutral-700"
        >
          Create account
        </button>
      </div>

      <Link href="/" className="mt-4 text-center text-sm text-neutral-500 underline">
        Back to the generator
      </Link>
    </form>
  );
}
