/**
 * An end-to-end evaluation against sites that publish their own llms.txt.
 *
 * Those files are the ground truth this project does not otherwise have: a
 * human, or a documentation platform, decided what belonged in them. Sampling
 * from https://llmstxt.site gives real pages, chosen by someone other than us,
 * with an answer key attached.
 *
 * For each site it generates our file and asks a cheap model to compare it
 * against the published one.
 *
 * This used to grade two candidates - a free deterministic file and the
 * AI-assisted one - and the interesting number was the gap between them rather
 * than either absolute score. There is one endpoint now, so there is one
 * candidate, and the A/B is gone. What replaces it as the error bar: every
 * candidate is graded twice, and the disagreement between those two gradings
 * is how much of any difference in the table is the judge rather than us.
 *
 * Deliberately not part of `npm test`: it needs a key, a network, a running
 * dev server and an account, takes minutes, and its results move with whoever
 * is publishing what. Run it when the pipeline changes:
 *
 *   npm run dev            # in another terminal
 *   npm run integration -- --sites 6
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const SITES = Number(flag("sites", 5));
const SEED = Number(flag("seed", Date.now() % 100000));
const BASE = flag("base", "http://localhost:3000");
/**
 * Chosen by testing candidates on a good and a deliberately poor candidate for
 * the same reference, and keeping the one that separated them furthest:
 *
 *   nova-micro-v1      good 13/15  bad  3/15  gap 10   0.8s   $0.032/1k
 *   gpt-oss-20b        good 12/15  bad  3/15  gap  9   6.5s   $0.071/1k
 *   granite-4.0-h-micro good 12/15 bad  4/15  gap  8   2.7s   $0.018/1k
 *   mistral-nemo       good 13/15  bad  9/15  gap  4   3.7s   $0.013/1k
 *   qwen3.7-flash / ling-3.0-flash: no answer at all
 *
 * Cheapest is the wrong test. mistral-nemo costs least and gave a file with no
 * descriptions and no real sections 9 out of 15, which cannot measure anything.
 * The two that failed outright are reasoning models: they spend the whole token
 * budget thinking and return empty content.
 */
const JUDGE = flag("judge", "amazon/nova-micro-v1");

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const [k, ...rest] = l.split("=");
      return [k.trim(), rest.join("=").trim()];
    }),
);

const need = (name) => {
  if (!env[name]) {
    console.error(`Set ${name} in .env to run the evaluation.`);
    process.exit(1);
  }
  return env[name];
};

/** Deterministic shuffle, so a run can be repeated with --seed. */
function shuffled(items, seed) {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return [...items].sort(() => random() - 0.5);
}

/** Signs in as the test account: generating is gated and should stay that way. */
async function sessionCookie() {
  const url = need("SUPABASE_URL");
  const response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: need("SUPABASE_PUBLISHABLE_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ email: need("TEST_ACCOUNT_EMAIL"), password: need("TEST_ACCOUNT_PASSWORD") }),
  });

  if (!response.ok) {
    console.error(`Could not sign in as ${env.TEST_ACCOUNT_EMAIL}: HTTP ${response.status}`);
    process.exit(1);
  }

  const session = await response.json();
  const ref = new URL(url).hostname.split(".")[0];
  const value = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `sb-${ref}-auth-token=base64-${value}`;
}

async function sampleSites(count, seed) {
  const html = await fetch("https://llmstxt.site/").then((r) => r.text());
  const links = [...new Set([...html.matchAll(/href=["'](https?:\/\/[^"']*\/llms\.txt)["']/g)].map((m) => m[1]))];
  return shuffled(links, seed).slice(0, count);
}

async function ours(url, cookie) {
  const started = performance.now();
  const response = await fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    // regenerate: the endpoint now hands back a site's own llms.txt when it
    // publishes one, and grading that against itself would measure nothing.
    body: JSON.stringify({ url, regenerate: true }),
  });

  const payload = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    ms: Math.round(performance.now() - started),
    text: payload.llmsTxt ?? "",
    error: payload.error,
    report: payload.report,
    spec: payload.spec?.valid,
  };
}

/** The published file is the answer key; a long one is trimmed to keep the judge cheap. */
const trim = (text, max = 6000) => (text.length > max ? `${text.slice(0, max)}\n[...truncated]` : text);

const JUDGE_SYSTEM = [
  "You are grading generated llms.txt files against the one the site actually publishes.",
  "An llms.txt is a curated map of a site for AI agents: a title, a summary, and sections of links with short notes.",
  "Score the candidate 1-5 on each of:",
  "coverage - does it point at the same important pages as the reference;",
  "descriptions - are its per-link notes specific and informative rather than absent or empty;",
  "structure - is it organised the way the reference is, with meaningful section names.",
  "Judge only what is present. The candidate is built from a crawl capped at 50 pages, so a reference covering a whole site will always be broader.",
  'Reply with JSON only: {"coverage":n,"descriptions":n,"structure":n,"comment":"<12 words>"}',
].join(" ");

async function judge(reference, candidate) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${need("OPENROUTER_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: JUDGE,
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: `REFERENCE (published by the site):\n${trim(reference)}\n\nCANDIDATE:\n${trim(candidate)}` },
      ],
    }),
  });

  const payload = await response.json();
  const reply = payload?.choices?.[0]?.message?.content ?? "";
  const start = reply.indexOf("{");
  if (start === -1) return null;

  try {
    return JSON.parse(reply.slice(start, reply.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const cookie = await sessionCookie();
const sites = await sampleSites(SITES, SEED);
console.log(`Judge: ${JUDGE}   sites: ${sites.length}   seed: ${SEED}\n`);

const rows = [];
for (const llmsUrl of sites) {
  const origin = new URL(llmsUrl).origin;
  const host = new URL(origin).hostname.replace(/^www\./, "");
  process.stdout.write(`${host.padEnd(30)}`);

  const reference = await fetch(llmsUrl, { signal: AbortSignal.timeout(20000) })
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");

  if (reference.length < 80) {
    console.log("skipped - its own llms.txt was unreachable");
    continue;
  }

  const mine = await ours(origin, cookie);
  if (!mine.ok || !mine.text) {
    // Not a wasted row: a page we cannot read at all is the finding.
    console.log(`FAILED - ${mine.error ?? "no output"}`);
    rows.push({ host, failed: mine.error ?? "no output" });
    continue;
  }

  // Graded twice, same input, same temperature. Anything the two disagree on
  // is the judge's own variance, and that is the floor below which a change in
  // the table below means nothing.
  const [first, second] = await Promise.all([judge(reference, mine.text), judge(reference, mine.text)]);
  if (!first || !second) {
    console.log(`UNGRADED - the judge returned nothing usable`);
    rows.push({ host, failed: "judge returned nothing" });
    continue;
  }

  const total = (s) => s.coverage + s.descriptions + s.structure;
  rows.push({ host, first, second, notes: mine.report?.notesAccepted ?? 0, ms: mine.ms, spec: mine.spec });

  console.log(
    `${total(first)}/15  ${mine.ms}ms  notes ${mine.report?.notesAccepted ?? 0}  ` +
      `${mine.spec ? "conforms" : "DOES NOT CONFORM"}  ${first.comment ?? ""}`,
  );
}

const scored = rows.filter((r) => r.first && r.second);
console.log(`\n${"".padEnd(30)} ${"coverage".padStart(9)} ${"descript".padStart(9)} ${"structure".padStart(9)} ${"total".padStart(7)}`);

const axis = (field) => mean(scored.map((r) => (r.first[field] + r.second[field]) / 2));
const [c, d, st] = ["coverage", "descriptions", "structure"].map(axis);
console.log(`${"generated".padEnd(30)} ${c.toFixed(2).padStart(9)} ${d.toFixed(2).padStart(9)} ${st.toFixed(2).padStart(9)} ${(c + d + st).toFixed(2).padStart(7)}`);

// The same file, graded twice by the same judge at temperature 0. Whatever it
// disagrees with itself about is the error bar on every number above.
const noise = mean(
  scored.map((r) =>
    Math.abs(r.first.coverage - r.second.coverage) +
    Math.abs(r.first.descriptions - r.second.descriptions) +
    Math.abs(r.first.structure - r.second.structure),
  ),
);
console.log(
  `\njudge noise: ${noise.toFixed(2)}/15 between two gradings of the same file - ` +
    `treat any change smaller than this as nothing.`,
);

const nonConforming = scored.filter((r) => r.spec === false);
if (nonConforming.length) {
  console.log(`\nDid not conform to llmstxt.org (${nonConforming.length}/${scored.length}):`);
  for (const row of nonConforming) console.log(`  ${row.host}`);
}

const failed = rows.filter((r) => r.failed);
if (failed.length) {
  console.log(`\nUnreadable pages (${failed.length}/${rows.length}) - candidates for the bot-protection work:`);
  for (const row of failed) console.log(`  ${row.host.padEnd(32)} ${row.failed}`);
}

console.log(`\nScored ${scored.length} of ${rows.length} sampled sites.`);
