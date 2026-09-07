/**
 * Benchmarks the candidate models on this app's own two jobs.
 *
 * Deliberately not part of `npm test`: it needs a key and a network, costs a
 * fraction of a cent, and its numbers move with whatever the providers are
 * doing. Run it when the model choice is in question rather than on every push.
 *
 *   npm run bench
 */
import { readFileSync } from "node:fs";

const key =
  process.env.OPENROUTER_API_KEY ??
  (readFileSync(".env", "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m) ?? [])[1]?.trim();

if (!key) {
  console.error("Set OPENROUTER_API_KEY (or put it in .env) to run the benchmark.");
  process.exit(1);
}

const MODELS = [
  ["google/gemini-3.5-flash-lite", {}],
  ["google/gemma-4-31b-it", {}],
  ["openai/gpt-oss-120b", { reasoning: { effort: "low" } }],
  ["deepseek/deepseek-v4-flash", {}],
];

const LINKS = [
  ["Vision", "/docs/vision"], ["Streaming", "/docs/streaming"], ["Tool use", "/docs/tool-use"],
  ["Batch processing", "/docs/batches"], ["Rate limits", "/docs/rate-limits"],
  ["Quickstart", "/docs/get-started"], ["Pricing", "/docs/pricing"], ["Error codes", "/docs/errors"],
];

const TASKS = {
  chunk: {
    system:
      'You write the one-line notes in an llms.txt file. For each link, say what an agent would find ' +
      'at that URL, in at most 12 words. Never restate the title. Reply with JSON only: {"notes":{"<url>":"<note>"}}',
    user: `Site: Claude Platform Docs.\nLinks:\n${LINKS.map(([t, u]) => `- ${t} (${u})`).join("\n")}`,
    check: (d) => Object.keys(d?.notes ?? {}).length,
  },
  guide: {
    system:
      'You are naming the parts of an llms.txt file. Return a one-sentence site summary and a better ' +
      'name for each section. Reply with JSON only: {"summary":"...","sections":{"<current>":"<better>"}}',
    user: "Site name: Corvid\nSections and the pages under them:\n  Docs: Quickstart, Retries, Deploy\n  Pages: Log in, Sign up, Cart",
    check: (d) => (d?.summary ? 1 : 0),
  },
};

const RUNS = 3;

async function call(model, options, task) {
  const started = performance.now();
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: task.system },
          { role: "user", content: task.user },
        ],
        max_tokens: 900,
        temperature: 0,
        ...options,
      }),
    });

    const payload = await response.json();
    const reply = payload?.choices?.[0]?.message?.content ?? "";
    const start = reply.indexOf("{");
    const parsed = start === -1 ? null : JSON.parse(reply.slice(start, reply.lastIndexOf("}") + 1));

    return {
      ms: performance.now() - started,
      ok: task.check(parsed) > 0,
      reasoning: payload?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    };
  } catch {
    return { ms: performance.now() - started, ok: false, reasoning: 0 };
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (const [name, task] of Object.entries(TASKS)) {
  console.log(`\n== ${name} (${RUNS} runs)`);
  console.log(`${"model".padEnd(32)} ${"median".padStart(8)} ${"runs".padStart(22)}  ok  reasoning`);

  for (const [model, options] of MODELS) {
    const results = [];
    for (let i = 0; i < RUNS; i++) results.push(await call(model, options, task));

    const times = results.map((r) => r.ms);
    const ok = results.filter((r) => r.ok).length;
    console.log(
      `${model.padEnd(32)} ${(median(times) / 1000).toFixed(2).padStart(7)}s ` +
        `${times.map((t) => (t / 1000).toFixed(1)).join("/").padStart(22)}  ${ok}/${RUNS}  ` +
        `${Math.max(...results.map((r) => r.reasoning))}`,
    );
  }
}
