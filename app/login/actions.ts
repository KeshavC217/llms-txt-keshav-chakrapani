"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { authConfigured } from "@/lib/supabase/config";

export interface AuthState {
  error?: string;
  message?: string;
}

function readCredentials(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  return { email, password };
}

/** Shared validation, so sign-in and sign-up reject the same input the same way. */
function validate({ email, password }: { email: string; password: string }): string | null {
  if (!authConfigured) return "Accounts are not configured on this deployment.";
  if (!email || !email.includes("@")) return "Enter a valid email address.";
  if (password.length < 8) return "Passwords are at least 8 characters.";
  return null;
}

/**
 * One action for both buttons, told apart by the intent the button submits.
 * Two separate actions meant two pieces of form state and a rule for which one
 * to show; this needs neither.
 */
export async function authenticate(_state: AuthState, formData: FormData): Promise<AuthState> {
  const credentials = readCredentials(formData);
  const invalid = validate(credentials);
  if (invalid) return { error: invalid };

  const supabase = await createClient();

  if (formData.get("intent") === "signup") {
    const { data, error } = await supabase.auth.signUp(credentials);
    if (error) return { error: error.message };

    // With email confirmation on, signUp returns a user but no session: the
    // account exists and cannot be used until the link is clicked.
    if (!data.session) return { message: "Check your email to confirm the account, then sign in." };
  } else {
    const { error } = await supabase.auth.signInWithPassword(credentials);

    // Supabase gives one message for a wrong password and an unknown address
    // alike, which is deliberate: telling them apart tells a stranger which
    // addresses have accounts here.
    if (error) return { error: "That email and password do not match an account." };
  }

  revalidatePath("/", "layout");
  redirect("/");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/");
}
