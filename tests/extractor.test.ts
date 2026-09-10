import { test } from "node:test";
import assert from "node:assert/strict";

import { extract, render } from "../lib/naiveExtractor.ts";
import { parseLlmsTxt, validateLlmsTxt } from "../lib/spec.ts";
import {
  APP_SHELL,
  TINY_PAGE,
  CHROME_HEAVY,
  DOCS_SITE,
  HOSTILE_PAGE,
  LOCALE_SITE,
  MALFORMED,
  MARKETING_SITE,
} from "./fixtures.ts";

const at = (html: string, url: string) => extract(html, url);
const sectionNames = (html: string, url: string) => at(html, url).sections.map((section) => section.name);
const allLinks = (html: string, url: string) => [
  ...at(html, url).sections.flatMap((section) => section.links),
  ...at(html, url).optional,
];

test("the site name comes from og:site_name, not the branded page title", () => {
  // <title> is "Guides &amp; API - Corvid"; the file should say "Corvid".
  assert.equal(at(DOCS_SITE, "https://corvid.dev/docs").siteName, "Corvid");
});

test("the summary comes from the meta description", () => {
  assert.match(at(DOCS_SITE, "https://corvid.dev/docs").summary ?? "", /refuses to lose one/);
});

test("sections group a segment deeper when one bucket would take the page", () => {
  // Every link is under /docs, so grouping on the first segment would produce
  // a single section and no structure at all.
  const names = sectionNames(DOCS_SITE, "https://corvid.dev/docs");
  assert.ok(names.includes("Guides"), names.join(", "));
  assert.ok(names.includes("Reference"), names.join(", "));
});

test("notes are taken from the card beside a link", () => {
  const links = allLinks(DOCS_SITE, "https://corvid.dev/docs");
  const quickstart = links.find((link) => link.url.endsWith("/quickstart"));
  assert.match(quickstart?.note ?? "", /five minutes/);
});

test("a nav link gets no note from its neighbouring menu entries", () => {
  // The bug this pins: a nav list is "next to" every link in it, so sibling
  // text described each page by reciting the whole menu.
  for (const link of allLinks(DOCS_SITE, "https://corvid.dev/docs")) {
    assert.doesNotMatch(link.note ?? "", /Quickstart Retries|Retries Queues/);
  }
});

test("legal and careers links are routed to Optional, not to a section", () => {
  const { sections, optional } = at(DOCS_SITE, "https://corvid.dev/docs");
  const optionalUrls = optional.map((link) => link.url);
  assert.ok(optionalUrls.some((url) => url.endsWith("/privacy")), optionalUrls.join(", "));
  assert.ok(optionalUrls.some((url) => url.endsWith("/careers")), optionalUrls.join(", "));
  for (const section of sections) {
    assert.ok(!section.links.some((link) => link.url.endsWith("/terms")));
  }
});

test("an imperative nav label is reduced to its noun", () => {
  // "Explore Our Services" names the section "Services".
  assert.ok(sectionNames(MARKETING_SITE, "https://thornbury.co.uk/").includes("Services"));
});

test("one page written four ways appears once", () => {
  // /services/bridges, with a trailing slash, as index.html, and with a fragment.
  const bridges = allLinks(MARKETING_SITE, "https://thornbury.co.uk/").filter((link) =>
    link.url.includes("/services/bridges"),
  );
  assert.equal(bridges.length, 1, bridges.map((link) => link.url).join(", "));
  // Rule 3: the shorter, plainer title wins over "Our Bridges Practice".
  assert.equal(bridges[0].title, "Bridges");
});

test("a locale segment never becomes a section name", () => {
  const names = sectionNames(LOCALE_SITE, "https://platform.example.com/");
  assert.ok(!names.includes("En"), names.join(", "));
  assert.ok(names.includes("Build") || names.includes("Models"), names.join(", "));
});

test("chrome supplies links but never prose", () => {
  const extraction = at(CHROME_HEAVY, "https://ledger.example/");
  const prose = extraction.prose.join(" ");
  assert.doesNotMatch(prose, /cookies/i);
  assert.doesNotMatch(prose, /On this page/i);
  assert.match(prose + (extraction.summary ?? ""), /reconciles payouts/);

  // The in-page anchors are the same page and are dropped; the product links stay.
  const urls = allLinks(CHROME_HEAVY, "https://ledger.example/").map((link) => link.url);
  assert.ok(urls.some((url) => url.endsWith("/product/reconciliation")), urls.join(", "));
  assert.ok(!urls.some((url) => url.includes("#")), urls.join(", "));
});

test("an off-site link is not listed as a page of this site", () => {
  const urls = allLinks(CHROME_HEAVY, "https://ledger.example/").map((link) => link.url);
  assert.ok(!urls.some((url) => url.includes("twitter.com")), urls.join(", "));
});

test("a feed is not a page", () => {
  const urls = allLinks(CHROME_HEAVY, "https://ledger.example/").map((link) => link.url);
  assert.ok(!urls.some((url) => url.endsWith(".xml")), urls.join(", "));
});

test("an application shell is reported as one, not as an empty site", () => {
  const extraction = at(APP_SHELL, "https://docs.convex.dev/");
  assert.equal(extraction.clientRendered, true);
  assert.match(render(extraction, "https://docs.convex.dev/"), /added by JavaScript/);
});

test("a small complete page is not mistaken for an application shell", () => {
  // The case the first version got wrong in production: example.com has one
  // off-site link and four sentences, which reads as "no links and little
  // text" - true of a shell, and equally true of a page with nothing on it.
  const extraction = at(TINY_PAGE, "https://example.com/");
  assert.equal(extraction.clientRendered, false);

  const output = render(extraction, "https://example.com/");
  assert.doesNotMatch(output, /JavaScript/);
  assert.match(output, /No links to other pages/);
});

test("a page with no links but plenty of script is a shell", () => {
  // Both halves are required: script alone is every page on the web, and an
  // empty mount element alone could be an empty sidebar.
  const scriptOnly = `<!doctype html><html><head><title>T</title></head><body><p>Some words here.</p><script src="/a.js"></script></body></html>`;
  assert.equal(at(scriptOnly, "https://example.com/").clientRendered, false);
});

test("an icon-only anchor is named from its path", () => {
  const links = allLinks(HOSTILE_PAGE, "https://edge.example/");
  const third = links.find((link) => link.url.endsWith("/three"));
  assert.equal(third?.title, "Three");
});

test("malformed markup still produces a conforming file", () => {
  const output = render(at(MALFORMED, "https://broken.example/"), "https://broken.example/");
  assert.deepEqual(validateLlmsTxt(output), []);
  const { document } = parseLlmsTxt(output);
  assert.equal(document.sections.flatMap((section) => section.links).length, 2);
});

test("every fixture renders a file that parses back as conforming", () => {
  for (const [name, html] of Object.entries({
    DOCS_SITE,
    MARKETING_SITE,
    APP_SHELL,
    LOCALE_SITE,
    HOSTILE_PAGE,
    CHROME_HEAVY,
    MALFORMED,
  })) {
    const output = render(at(html, "https://example.com/"), "https://example.com/");
    assert.deepEqual(validateLlmsTxt(output), [], `${name}:\n${output}`);
  }
});

test("the rendered order is title, summary, prose, sections, Optional last", () => {
  const output = render(at(DOCS_SITE, "https://corvid.dev/docs"), "https://corvid.dev/docs");
  const lines = output.split("\n").filter(Boolean);
  assert.match(lines[0], /^# Corvid$/);
  assert.match(lines[1], /^> /);
  assert.equal(output.trimEnd().split("\n").filter((line) => line.startsWith("## ")).pop(), "## Optional");
});

test("a title the site serves for every page is not that page's title", async () => {
  // resy.com builds itself in the browser, so every address returns the same
  // 5KB shell titled "Resy | Right This Way". Crawling it produced a file whose
  // links were thirty-seven identical "Right This Way", each having displaced
  // the perfectly good name the rendered home page had for it.
  const { buildFromCrawl } = await import("../lib/buildFromCrawl.ts");

  const shell = (url: string) => ({ url, title: "Right This Way", links: [] });
  const seed = extract(
    `<html><head><title>Resy</title></head><body><main>
       <ul>
         <li><a href="/venues/carbone">Carbone</a></li>
         <li><a href="/venues/essex">Essex</a></li>
         <li><a href="/venues/torrisi">Torrisi</a></li>
         <li><a href="/venues/umeko">Umeko</a></li>
       </ul>
     </main></body></html>`,
    "https://resy.com/",
  );

  const built = buildFromCrawl(
    ["/venues/carbone", "/venues/essex", "/venues/torrisi", "/venues/umeko"].map((path) =>
      shell(`https://resy.com${path}`),
    ),
    seed,
    "https://resy.com/",
  );

  const titles = [...built.sections.flatMap((section) => section.links), ...built.optional].map((link) => link.title);
  assert.ok(titles.includes("Carbone"), "the name the link gave it survives");
  assert.equal(
    titles.filter((title) => title === "Right This Way").length,
    0,
    "the shell's title describes no page and must not displace one",
  );
});

test("a title only a couple of pages share is still their own", async () => {
  // The rule is repetition across the crawl, not any repetition at all: two
  // pages legitimately called the same thing are not a template.
  const { buildFromCrawl } = await import("../lib/buildFromCrawl.ts");

  const pages = [
    { url: "https://x.com/docs/a", title: "Overview", links: [] },
    { url: "https://x.com/docs/b", title: "Overview", links: [] },
    { url: "https://x.com/docs/c", title: "Streaming", links: [] },
    { url: "https://x.com/docs/d", title: "Batching", links: [] },
    { url: "https://x.com/docs/e", title: "Errors", links: [] },
    { url: "https://x.com/docs/f", title: "Webhooks", links: [] },
  ];

  const seed = extract(`<html><head><title>X</title></head><body><a href="/docs/a">A</a></body></html>`, "https://x.com/");
  const built = buildFromCrawl(pages, seed, "https://x.com/");
  const titles = [...built.sections.flatMap((s) => s.links), ...built.optional].map((l) => l.title);

  assert.ok(titles.includes("Overview"), "two of six is not a template");
});
