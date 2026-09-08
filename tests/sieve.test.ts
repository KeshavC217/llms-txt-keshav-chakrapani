import { test } from "node:test";
import assert from "node:assert/strict";

import { acceptNote, acceptSectionName, acceptSummary, applyProposals, emptyReport } from "../lib/ai/sieve.ts";
import { chunkLinks } from "../lib/ai/annotate.ts";
import { parseJson } from "../lib/ai/openrouter.ts";
import { enhance } from "../lib/ai/enhance.ts";
import { extract } from "../lib/naiveExtractor.ts";
import { validateLlmsTxt } from "../lib/spec.ts";
import { DOCS_SITE } from "./fixtures.ts";

const URL_ = "https://corvid.dev/docs";
const extraction = () => extract(DOCS_SITE, URL_);

/** A transport that replies with whatever the test dictates. */
const fake = (reply: string | (() => Promise<string>)) =>
  typeof reply === "string" ? async () => reply : reply;

test("a note that restates its title is rejected", () => {
  // The exact rule the deterministic path applies to notes found on the page.
  assert.equal(acceptNote("Rate limits and rate limiting", "Rate limits"), null);
  assert.ok(acceptNote("How many requests a minute each plan allows", "Rate limits"));
});

test("a note longer than a sentence is rejected", () => {
  const rambling = Array.from({ length: 14 }, (_, i) => `word${i}`).join(" ");
  assert.equal(acceptNote(rambling, "Queues"), null);
});

test("a note carrying markdown link syntax is rejected", () => {
  // A "](" would end the note's own link early and turn the rest into prose.
  assert.equal(acceptNote("see [the docs](https://x.com) for more", "Queues"), null);
});

test("a note split over lines is joined, not discarded", () => {
  // The newline is the only thing wrong with it, and the file is one line per
  // link either way - so flatten it and keep a note that would otherwise be lost.
  assert.equal(
    acceptNote("first line\nsecond line about the queue", "Queues"),
    "first line second line about the queue",
  );
});

test("a non-string note is rejected rather than coerced", () => {
  for (const value of [null, 42, {}, []]) assert.equal(acceptNote(value, "Queues"), null);
});

test("a summary that is just the site name is rejected", () => {
  assert.equal(acceptSummary("Corvid", "Corvid"), null);
  assert.ok(acceptSummary("A queue for background jobs that keeps every attempt", "Corvid"));
});

test("a summary containing a URL is rejected", () => {
  assert.equal(acceptSummary("Read more at https://corvid.dev/docs for details", "Corvid"), null);
});

test("a section name that duplicates another is rejected", () => {
  // Two identical H2s would split one list into two halves under one heading.
  assert.equal(acceptSectionName("Guides", new Set(["guides"])), null);
  assert.equal(acceptSectionName("Reference", new Set(["guides"])), "Reference");
});

test("a locale or markdown-bearing section name is rejected", () => {
  assert.equal(acceptSectionName("en", new Set()), null);
  assert.equal(acceptSectionName("## Guides", new Set()), null);
});

test("a note for a URL we never extracted has nowhere to land", () => {
  const report = emptyReport();
  const result = applyProposals(
    extraction(),
    { notes: { "https://corvid.dev/docs/invented-by-the-model": "A page that does not exist" } },
    report,
  );

  const urls = result.sections.flatMap((s) => s.links).map((l) => l.url);
  assert.ok(!urls.some((u) => u.includes("invented")));
  assert.equal(report.notesAccepted, 0);
  assert.equal(report.notesRejected, 1);
});

test("chunks follow section boundaries", () => {
  // A chunk that mixes the API reference with the careers page gets vaguer
  // notes than one whose links share a subject.
  const chunks = chunkLinks(extraction());
  for (const chunk of chunks) assert.ok(chunk.links.length > 0 && chunk.links.length <= 10);
  assert.equal(new Set(chunks.map((c) => c.section)).size, chunks.length);
});

test("JSON is recovered from a fenced or prefaced reply", () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure! Here you go: {"a":1} Hope that helps.'), { a: 1 });
  assert.equal(parseJson("no json here"), null);
  assert.equal(parseJson(""), null);
});

test("a model that returns nonsense leaves the deterministic file untouched", async () => {
  const result = await enhance(extraction(), URL_, {
    guide: fake("I'm sorry, I can't help with that."),
    worker: fake("<html>error</html>"),
  });

  assert.equal(result.enhanced, false);
  assert.deepEqual(validateLlmsTxt(result.llmsTxt), []);
  assert.match(result.llmsTxt, /^# Corvid/);
});

test("a model that throws is not allowed to fail the request", async () => {
  const result = await enhance(extraction(), URL_, {
    guide: fake(async () => {
      throw new Error("502 upstream");
    }),
    worker: fake(async () => {
      throw new Error("502 upstream");
    }),
  });

  assert.equal(result.enhanced, false);
  assert.deepEqual(validateLlmsTxt(result.llmsTxt), []);
  assert.ok(result.report.chunksFailed > 0);
});

test("one bad chunk does not take the good ones with it", async () => {
  const links = extraction().sections.flatMap((s) => s.links);
  let call = 0;

  const result = await enhance(extraction(), URL_, {
    guide: fake("{}"),
    worker: fake(async () => {
      if (call++ === 0) return "not json at all";
      return JSON.stringify({ notes: Object.fromEntries(links.map((l) => [l.url, "What an agent finds at this page"])) });
    }),
  });

  // Only meaningful if the fixture actually produces more than one chunk.
  if (chunkLinks(extraction()).length > 1) {
    assert.equal(result.enhanced, true);
    assert.ok(result.report.notesAccepted > 0);
    assert.equal(result.report.chunksFailed, 1);
  }
  assert.deepEqual(validateLlmsTxt(result.llmsTxt), []);
});

test("accepted proposals reach the file, and the file still conforms", async () => {
  const links = extraction().sections.flatMap((s) => s.links);
  const result = await enhance(extraction(), URL_, {
    guide: fake(JSON.stringify({ summary: "A durable queue that replays failed background jobs", sections: {} })),
    worker: fake(
      JSON.stringify({ notes: Object.fromEntries(links.map((l) => [l.url, "What an agent finds at this page"])) }),
    ),
  });

  assert.equal(result.enhanced, true);
  assert.ok(result.report.notesAccepted > 0);
  assert.match(result.llmsTxt, /> A durable queue that replays failed background jobs/);
  assert.deepEqual(validateLlmsTxt(result.llmsTxt), []);
});

test("a hostile proposal cannot break the grammar", async () => {
  const links = extraction().sections.flatMap((s) => s.links);
  const result = await enhance(extraction(), URL_, {
    guide: fake(JSON.stringify({ summary: "## Not a heading but a summary that is long enough", sections: {} })),
    worker: fake(
      JSON.stringify({
        notes: Object.fromEntries(links.map((l) => [l.url, "ends the line here\n## and starts a heading"])),
      }),
    ),
  });

  assert.deepEqual(validateLlmsTxt(result.llmsTxt), []);
  assert.doesNotMatch(result.llmsTxt, /\n## and starts a heading/);
});
