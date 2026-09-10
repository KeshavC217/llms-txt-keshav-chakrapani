import { test } from "node:test";
import assert from "node:assert/strict";

import { checkGenerateAccess } from "../lib/authGate.ts";

const gate = (overrides: Partial<Parameters<typeof checkGenerateAccess>[0]> = {}) =>
  checkGenerateAccess({ signedIn: false, authConfigured: true, ...overrides });

test("generating needs an account", () => {
  const result = gate({ signedIn: false });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 401);
  assert.match(result.error ?? "", /sign in/i);
});

test("a signed-in person may generate", () => {
  assert.equal(gate({ signedIn: true }).allowed, true);
});

test("an unconfigured deployment says so instead of demanding a sign-in", () => {
  // 503, not 401: there is no account to sign in to, so telling the caller to
  // sign in would send them somewhere that cannot help.
  const result = gate({ signedIn: false, authConfigured: false });
  assert.equal(result.status, 503);
  assert.doesNotMatch(result.error ?? "", /sign in/i);
});

test("being signed in does not paper over a missing configuration", () => {
  assert.equal(gate({ signedIn: true, authConfigured: false }).allowed, false);
});
