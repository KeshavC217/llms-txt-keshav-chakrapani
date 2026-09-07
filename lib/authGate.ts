/**
 * Who may use what.
 *
 * The generator itself is open: anyone can fetch a URL and get an llms.txt.
 * The LLM pass is not, because it spends money per call and needs an identity
 * to attribute that to.
 *
 * Kept as a pure function, separate from Supabase, so the rule can be read and
 * tested without a network or a session. The route supplies the two facts.
 */

export interface GateResult {
  allowed: boolean;
  status: number;
  error?: string;
}

export const ALLOWED: GateResult = { allowed: true, status: 200 };

export function checkLlmAccess({
  enhanceRequested,
  signedIn,
  authConfigured,
}: {
  enhanceRequested: boolean;
  signedIn: boolean;
  authConfigured: boolean;
}): GateResult {
  // Nobody asked for the paid path, so there is nothing to gate.
  if (!enhanceRequested) return ALLOWED;

  // 503, not 401: the caller did nothing wrong and signing in will not help,
  // because this deployment has no accounts to sign in to.
  if (!authConfigured) {
    return { allowed: false, status: 503, error: "The AI features are not configured on this deployment." };
  }

  if (!signedIn) {
    return { allowed: false, status: 401, error: "Sign in to use the AI features." };
  }

  return ALLOWED;
}
