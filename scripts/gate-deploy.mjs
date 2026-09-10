/**
 * Lets a deployment proceed only if CI passed on the same commit.
 *
 * Branch protection already stops a red pull request being merged, so the hole
 * this closes is narrower than it looks and entirely real: Vercel's Git
 * integration builds on every push to main, and it starts the moment the push
 * lands - in parallel with the CI run for that commit, not after it. A merge
 * whose checks go red on main, an admin pushing directly, or a green PR that
 * conflicts semantically with something merged a minute earlier all reach
 * production without anything having agreed they should.
 *
 * Run by Vercel as the Ignored Build Step; see vercel.json.
 *
 * THE EXIT CODES ARE INVERTED, which is Vercel's convention and not a mistake
 * here: the command answers "should this build be IGNORED?".
 *
 *   exit 0  ->  ignore the commit, skip the build
 *   exit 1  ->  do not ignore, go ahead and build
 *
 * It needs no credentials. The repository is public, so GitHub serves check
 * runs for a commit to anyone who asks.
 */

const BUILD = 1;
const SKIP = 0;

const repo = process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
  ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
  : null;
const sha = process.env.VERCEL_GIT_COMMIT_SHA;
const branch = process.env.VERCEL_GIT_COMMIT_REF;
/*
 * Either signal is enough. Trusting VERCEL_ENV alone would fail open if it were
 * ever unset - the gate would decide this was a preview and wave the build
 * through, which is the one way a gate must not be wrong.
 */
const PRODUCTION_BRANCH = "main";
const production = process.env.VERCEL_ENV === "production" || branch === PRODUCTION_BRANCH;

const done = (code, why) => {
  console.log(`${code === BUILD ? "building" : "skipping"}: ${why}`);
  process.exit(code);
};

/*
 * Previews are how a change is looked at before it is merged, so they are not
 * gated on anything. Only production waits for the verdict.
 */
if (!production) done(BUILD, `${branch ?? "unknown branch"} is not production`);
if (!repo || !sha) done(BUILD, "no commit information, so there is nothing to check against");

/** How long CI may take before we stop waiting. A run takes about 35 seconds. */
const API = process.env.DEPLOY_GATE_API ?? "https://api.github.com";
const DEADLINE_MS = Number(process.env.DEPLOY_GATE_DEADLINE_MS ?? 8 * 60_000);
const POLL_MS = Number(process.env.DEPLOY_GATE_POLL_MS ?? 10_000);
const startedAt = Date.now();

async function ciConclusion() {
  const response = await fetch(`${API}/repos/${repo}/commits/${sha}/check-runs`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "llms-txt-deploy-gate" },
  });
  if (!response.ok) return { error: `GitHub answered ${response.status}` };

  const runs = (await response.json()).check_runs ?? [];
  const ci = runs.find((run) => run.name === "ci");
  if (!ci) return { missing: true };

  return ci.status === "completed" ? { conclusion: ci.conclusion } : { pending: ci.status };
}

for (;;) {
  const result = await ciConclusion().catch((error) => ({ error: String(error) }));

  if (result.conclusion === "success") done(BUILD, `ci passed on ${sha.slice(0, 7)}`);
  if (result.conclusion) done(SKIP, `ci ${result.conclusion} on ${sha.slice(0, 7)} - production keeps the last good build`);

  /*
   * Anything unresolved fails closed. Deploying because we could not find out
   * whether the tests passed would make this decoration: the whole value of a
   * gate is what it does when it cannot tell.
   */
  if (Date.now() - startedAt > DEADLINE_MS) {
    const why = result.error ?? (result.missing ? "no ci check ever appeared" : `ci still ${result.pending}`);
    done(SKIP, `gave up after ${Math.round(DEADLINE_MS / 60_000)} minutes: ${why}`);
  }

  console.log(`waiting: ${result.error ?? (result.missing ? "ci has not started" : `ci is ${result.pending}`)}`);
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
