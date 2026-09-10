/**
 * Who may generate.
 *
 * Generating crawls someone else's site and spends money on models, so it
 * needs an account. Reading what has already been generated does not: those
 * files describe public pages, and there is nothing to protect.
 */

export interface GateResult {
  allowed: boolean;
  status: number;
  error?: string;
}

const ALLOWED: GateResult = { allowed: true, status: 200 };

export function checkGenerateAccess({
  signedIn,
  authConfigured,
}: {
  signedIn: boolean;
  authConfigured: boolean;
}): GateResult {
  // 503, not 401: the caller did nothing wrong and signing in will not help,
  // because this deployment has no accounts to sign in to.
  if (!authConfigured) {
    return { allowed: false, status: 503, error: "Accounts are not configured on this deployment." };
  }

  if (!signedIn) {
    return { allowed: false, status: 401, error: "Sign in to generate. Saved files are readable by anyone." };
  }

  return ALLOWED;
}
