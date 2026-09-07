import { test } from "node:test";
import assert from "node:assert/strict";

import { extract, render } from "../lib/naiveExtractor.ts";
import {
  escapeBlock,
  escapeInline,
  escapeLinkText,
  escapeUrl,
  parseLlmsTxt,
  validateLlmsTxt,
} from "../lib/spec.ts";

/**
 * The example given in the spec at https://llmstxt.org. If this does not
 * validate, the validator is wrong whatever it says about our own output.
 */
const SPEC_EXAMPLE = `# FastHTML

> FastHTML is a python library which brings together Starlette, Uvicorn, HTMX, and fastcore's \`FT\` "FastTags" into a library for creating server-rendered hypermedia applications.

Important notes:

- Although parts of its API are inspired by FastAPI, it is *not* compatible with FastAPI syntax
- FastHTML is compatible with JS-native web components and any vanilla JS library

## Docs

- [FastHTML quick start](https://fastht.ml/docs/tutorials/quickstart_for_web_devs.html.md): A brief overview of many FastHTML features
- [HTMX reference](https://github.com/bigskysoftware/htmx/blob/master/www/content/reference.md): Brief description of all HTMX attributes

## Examples

- [Todo list application](https://github.com/AnswerDotAI/fasthtml/blob/main/examples/adv_app.py): Detailed walk-thru of a complete CRUD app

## Optional

- [Starlette full documentation](https://gist.githubusercontent.com/jph00/starlette-sml.md): A subset of the Starlette documentation
`;

test("the spec's own example validates and parses into its parts", () => {
  assert.deepEqual(validateLlmsTxt(SPEC_EXAMPLE), []);

  const { document } = parseLlmsTxt(SPEC_EXAMPLE);
  assert.equal(document.title, "FastHTML");
  assert.match(document.summary ?? "", /^FastHTML is a python library/);
  assert.equal(document.details.length, 2);
  assert.deepEqual(
    document.sections.map((section) => [section.name, section.links.length]),
    [["Docs", 2], ["Examples", 1], ["Optional", 1]],
  );
  assert.equal(document.sections[0].links[0].notes, "A brief overview of many FastHTML features");
});

test("a byte-order mark does not hide the title", () => {
  assert.deepEqual(validateLlmsTxt("﻿# Title\n"), []);
});

test("a file with only an H1 conforms: it is the sole requirement", () => {
  assert.deepEqual(validateLlmsTxt("# Just a title\n"), []);
});

for (const [name, text] of Object.entries({
  "no H1": "> summary\n\n## Docs\n\n- [a](https://x.com)\n",
  "a heading deeper than H2": "# T\n\n### Deep\n\n- [a](https://x.com)\n",
  "prose inside a section": "# T\n\n## Docs\n\nnot a list item\n",
  "a list item with no link": "# T\n\n## Docs\n\n- just text\n",
  "a second H1": "# T\n\n## Docs\n\n- [a](https://x.com)\n\n# Again\n",
  "content before the H1": "hello\n\n# T\n",
  "an empty H2": "# T\n\n## \n\n- [a](https://x.com)\n",
})) {
  test(`rejected: ${name}`, () => {
    assert.ok(validateLlmsTxt(text).length > 0, `expected an issue for ${name}`);
  });
}

test("escaping keeps a hostile value inside its own syntax", () => {
  assert.equal(escapeLinkText("Guide [draft]"), "Guide \\[draft\\]");
  assert.equal(escapeUrl("/a (copy) b"), "/a%20%28copy%29%20b");
  assert.equal(escapeInline("a note\nsplit over lines"), "a note split over lines");
  assert.equal(escapeBlock("## not a heading"), "\\## not a heading");
});

test("an escaped title parses back to the text a reader sees", () => {
  const line = `# T\n\n## Docs\n\n- [${escapeLinkText("Guide [draft]")}](https://x.com/a)\n`;
  assert.deepEqual(validateLlmsTxt(line), []);
  assert.equal(parseLlmsTxt(line).document.sections[0].links[0].title, "Guide [draft]");
});

/**
 * Hostile pages, run through the real pipeline. Titles and notes are taken
 * from the page, so a page is free to put a "]" or a "## " in one.
 */
const page = (body: string, head = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const HOSTILE: Record<string, string> = {
  "a bracket in a link title": page(`<h1>Docs</h1><main><a href="/a">Guide [draft]</a><a href="/b">Other [x](y)</a></main>`),
  "prose shaped like a heading": page(
    `<h1>S</h1><main><p>## Not a heading, but long enough that it is kept as orienting prose</p><a href="/a/x">One</a><a href="/a/y">Two</a></main>`,
  ),
  "parentheses and spaces in a URL": page(
    `<main><a href="/docs/a (copy).html">A</a><a href="/docs/b c">B</a></main>`,
    `<title>P</title>`,
  ),
  "a backslash in a link title": page(`<h1>T</h1><main><a href="/x/a">A\\B|C</a><a href="/x/b">D</a></main>`),
  "an anchor with no text": page(`<h1>T</h1><main><a href="/x/alpha"><img src="i.png"></a><a href="/x/beta">B</a></main>`),
  "a page title of only brackets": page(`<h1>[[[</h1><main><a href="/x/a">A</a><a href="/x/b">B</a></main>`),
  "an empty document": page(``),
  "a title that is one long word": page(`<h1>${"z".repeat(300)}</h1><main><a href="/x/a">A</a></main>`),
};

for (const [name, html] of Object.entries(HOSTILE)) {
  test(`conforms despite ${name}`, () => {
    const output = render(extract(html, "https://example.com/"), "https://example.com/");
    assert.deepEqual(validateLlmsTxt(output), [], output);
  });
}
