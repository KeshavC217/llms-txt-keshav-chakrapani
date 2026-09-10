/**
 * The deploy gate, exercised as Vercel runs it.
 *
 * Worth testing as a program rather than a function because the thing most
 * likely to go wrong is the exit code, and it is inverted: Vercel asks "should
 * this build be ignored?", so 0 means skip and 1 means build. Getting that
 * backwards would either deploy every red commit or deploy none at all, and
 * both would look like the gate working.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/gate-deploy.mjs", import.meta.url));

/** Stands in for GitHub, so the gate can be tested without one. */
let answer: { status: number; body: unknown } = { status: 200, body: { check_runs: [] } };

const server = createServer((_request, response) => {
  response.writeHead(answer.status, { "content-type": "application/json" });
  response.end(JSON.stringify(answer.body));
});
const port = await new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve(typeof address === "object" && address ? address.port : 0);
  });
});

after(() => server.close());

function run(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      {
        env: {
          ...process.env,
          DEPLOY_GATE_API: `http://127.0.0.1:${port}`,
          DEPLOY_GATE_DEADLINE_MS: "600",
          DEPLOY_GATE_POLL_MS: "150",
          VERCEL_GIT_REPO_OWNER: "owner",
          VERCEL_GIT_REPO_SLUG: "repo",
          VERCEL_GIT_COMMIT_SHA: "abc1234567890",
          ...env,
        },
      },
      (error, stdout) => resolve({ code: error && "code" in error ? Number(error.code) : 0, out: String(stdout) }),
    );
  });
}

const ci = (status: string, conclusion: string | null) => ({
  status: 200,
  body: { check_runs: [{ name: "ci", status, conclusion }] },
});

const BUILD = 1;
const SKIP = 0;

test("a commit whose ci passed is built", async () => {
  answer = ci("completed", "success");
  const { code, out } = await run({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" });

  assert.equal(code, BUILD, out);
  assert.match(out, /building/);
});

test("a commit whose ci failed is not", async () => {
  answer = ci("completed", "failure");
  const { code, out } = await run({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" });

  assert.equal(code, SKIP, out);
  assert.match(out, /keeps the last good build/);
});

test("a preview is never gated", async () => {
  // Previews are how a change is looked at before it is merged. Gating them
  // would mean waiting for CI to see the thing CI is testing.
  answer = ci("completed", "failure");
  const { code } = await run({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "some-branch" });

  assert.equal(code, BUILD);
});

test("main is gated even if VERCEL_ENV says nothing", async () => {
  // Trusting VERCEL_ENV alone fails open, which is the one way a gate must not
  // be wrong.
  answer = ci("completed", "failure");
  const { code } = await run({ VERCEL_GIT_COMMIT_REF: "main" });

  assert.equal(code, SKIP);
});

test("a verdict that never arrives fails closed", async () => {
  // Deploying because we could not find out whether the tests passed would
  // make this decoration. What a gate does when it cannot tell is the whole of
  // its value.
  answer = ci("in_progress", null);
  const { code, out } = await run({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" });

  assert.equal(code, SKIP, out);
  assert.match(out, /gave up/);
});

test("GitHub being unreachable also fails closed", async () => {
  answer = { status: 500, body: {} };
  const { code } = await run({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" });

  assert.equal(code, SKIP);
});

test("a ci run that never appears fails closed", async () => {
  answer = { status: 200, body: { check_runs: [] } };
  const { code, out } = await run({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" });

  assert.equal(code, SKIP);
  assert.match(out, /no ci check ever appeared/);
});
