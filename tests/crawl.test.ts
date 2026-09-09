import { test } from "node:test";
import assert from "node:assert/strict";

import { ALLOW_ALL, isAllowed, parseRobots } from "../lib/crawl/robots.ts";
import { sitemapCandidates } from "../lib/crawl/sitemap.ts";
import { Frontier, canonicalize } from "../lib/crawl/frontier.ts";
import { Pacer } from "../lib/crawl/pacer.ts";
import { readPage } from "../lib/pageMeta.ts";
import { findPublished, publishedCandidates } from "../lib/published.ts";

const AGENT = "llms-txt-generator";

test("an empty or missing robots.txt allows everything", () => {
  assert.equal(isAllowed(parseRobots(""), "/anything"), true);
  assert.equal(isAllowed(ALLOW_ALL, "/anything"), true);
});

test("a bare Disallow allows everything, rather than nothing", () => {
  // "Disallow:" with no value is the documented way to permit a crawl, and
  // reading it as "disallow /" would refuse the entire site.
  assert.equal(isAllowed(parseRobots("User-agent: *\nDisallow:"), "/docs"), true);
});

test("the longest matching rule wins, and Allow breaks a tie", () => {
  const robots = parseRobots("User-agent: *\nDisallow: /docs\nAllow: /docs/public");
  assert.equal(isAllowed(robots, "/docs/private"), false);
  assert.equal(isAllowed(robots, "/docs/public/guide"), true);

  const tie = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a");
  assert.equal(isAllowed(tie, "/a/b"), true);
});

test("a group naming us beats the wildcard group", () => {
  const robots = parseRobots(
    ["User-agent: *", "Disallow: /", "", "User-agent: llms-txt-generator", "Disallow: /private"].join("\n"),
    AGENT,
  );
  assert.equal(isAllowed(robots, "/docs"), true);
  assert.equal(isAllowed(robots, "/private/x"), false);
});

test("consecutive user-agent lines share the rules that follow", () => {
  const robots = parseRobots(["User-agent: googlebot", "User-agent: *", "Disallow: /secret"].join("\n"), AGENT);
  assert.equal(isAllowed(robots, "/secret/x"), false);
});

test("wildcards and end-of-path anchors are honoured", () => {
  const robots = parseRobots("User-agent: *\nDisallow: /*.json$\nDisallow: /a/*/b");
  assert.equal(isAllowed(robots, "/data.json"), false);
  assert.equal(isAllowed(robots, "/data.json.html"), true);
  assert.equal(isAllowed(robots, "/a/x/b"), false);
});

test("sitemap and crawl-delay are read", () => {
  const robots = parseRobots(
    ["Sitemap: https://x.com/sitemap.xml", "User-agent: *", "Crawl-delay: 2", "Disallow: /x"].join("\n"),
    AGENT,
  );
  assert.deepEqual(robots.sitemaps, ["https://x.com/sitemap.xml"]);
  assert.equal(robots.crawlDelayMs, 2000);
});

test("comments and malformed lines are ignored, not fatal", () => {
  const robots = parseRobots("# a comment\nUser-agent: *\ngarbage line\nDisallow: /x # trailing");
  assert.equal(isAllowed(robots, "/x/y"), false);
  assert.equal(isAllowed(robots, "/y"), true);
});

test("declared sitemaps are preferred, with the convention as a fallback", () => {
  assert.deepEqual(sitemapCandidates("https://x.com", ["https://x.com/sm/a.xml"]), [
    "https://x.com/sm/a.xml",
    "https://x.com/sitemap.xml",
  ]);
  assert.deepEqual(sitemapCandidates("https://x.com", []), ["https://x.com/sitemap.xml"]);
});

test("one page has one address", () => {
  const base = "https://x.com/docs";
  const forms = [
    "https://x.com/docs/guide/",
    "https://x.com/docs/guide/index.html",
    "https://x.com/docs/guide#top",
    "https://x.com/docs/guide?utm_source=twitter",
    "/docs/guide",
  ];
  const canonical = forms.map((form) => canonicalize(form, base));
  assert.equal(new Set(canonical).size, 1, JSON.stringify(canonical));
});

test("a real query parameter is kept, a tracking one is not", () => {
  assert.match(canonicalize("https://x.com/s?q=billing&utm_medium=email", "https://x.com/")!, /\?q=billing$/);
});

test("assets and other schemes are not pages", () => {
  for (const href of ["/logo.png", "/app.js", "/feed.xml", "mailto:a@b.com", "javascript:void(0)"]) {
    assert.equal(canonicalize(href, "https://x.com/"), null, href);
  }
});

test("the frontier refuses duplicates, other hosts, and disallowed paths", () => {
  const frontier = new Frontier({ origin: "https://x.com", isAllowed: (path) => !path.startsWith("/private") });

  assert.equal(frontier.add("/a", "https://x.com/", 0), true);
  assert.equal(frontier.add("https://x.com/a/", "https://x.com/", 0), false, "same page, second form");
  assert.equal(frontier.add("https://other.com/a", "https://x.com/", 0), false, "different host");
  assert.equal(frontier.add("/private/x", "https://x.com/", 0), false, "robots");
  assert.equal(frontier.pending, 1);
});

test("prefix filters include and exclude", () => {
  const frontier = new Frontier({
    origin: "https://x.com",
    include: ["/docs"],
    exclude: ["/docs/legacy"],
    isAllowed: () => true,
  });

  assert.equal(frontier.add("/docs/guide", "https://x.com/", 0), true);
  assert.equal(frontier.add("/blog/post", "https://x.com/", 0), false);
  assert.equal(frontier.add("/docs/legacy/old", "https://x.com/", 0), false);
});

test("the pacer widens when refused and never narrows again", () => {
  const pacer = new Pacer(100);
  const before = pacer.intervalMs;
  pacer.refused();
  assert.ok(pacer.intervalMs > before);

  const widened = pacer.intervalMs;
  for (let i = 0; i < 5; i++) pacer.observe(10);
  assert.equal(pacer.intervalMs, widened, "a fast response must not undo the backoff");
});

test("the pacer widens when a site slows down", () => {
  // The softer version of a 429: measured against this site's own baseline,
  // because slow for one site is normal for another.
  const pacer = new Pacer(100);
  for (const fast of [100, 110, 90]) pacer.observe(fast);
  const before = pacer.intervalMs;
  for (const slow of [2000, 2100, 2200]) pacer.observe(slow);
  assert.ok(pacer.intervalMs > before);
});

test("a site that keeps pushing back ends the crawl", () => {
  const pacer = new Pacer(100);
  for (let i = 0; i < 12; i++) pacer.refused();
  assert.equal(pacer.exhausted, true);
});

test("a page is read as the page describes itself", () => {
  const html = `<html><head><title>Single Sign-On (SSO) - Lago</title>
    <meta name="description" content="Configure SAML and Okta for your workspace.">
    <link rel="canonical" href="https://x.com/docs/sso"></head>
    <body><a href="/docs/a">A</a></body></html>`;

  const page = readPage(html, "https://x.com/docs/sso?utm_source=x", "Lago");
  assert.equal(page.title, "Single Sign-On (SSO)");
  assert.match(page.description ?? "", /SAML and Okta/);
  assert.equal(page.url, "https://x.com/docs/sso", "canonical wins over the requested URL");
});

test("a canonical pointing off-site is not followed", () => {
  // That is a page saying it is a copy of someone else's; taking it would walk
  // the crawl off the site it was asked about.
  const html = `<html><head><title>T</title><link rel="canonical" href="https://elsewhere.com/x"></head></html>`;
  assert.equal(readPage(html, "https://x.com/a").url, "https://x.com/a");
});

test("a published file is looked for most-specific first", () => {
  // The spec says a file covers the paths beneath it and agents should prefer
  // the most specific, so /docs asks /docs/llms.txt before the site root.
  assert.deepEqual(publishedCandidates("https://x.com/docs/guide"), [
    "https://x.com/docs/llms.txt",
    "https://x.com/llms.txt",
  ]);

  // A rel=describedby link outranks both: the site has named its own file.
  assert.deepEqual(publishedCandidates("https://x.com/docs", "https://x.com/a.txt")[0], "https://x.com/a.txt");
  assert.deepEqual(publishedCandidates("https://x.com/"), ["https://x.com/llms.txt"]);
});

test("a published file is recognised by shape, not by conformance", async () => {
  // getlago.com publishes a considered file with prose under a section
  // heading, which the grammar forbids and a reader would still rather have.
  const original = globalThis.fetch;
  const serve = (body: string, type = "text/plain") =>
    (globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { "content-type": type } })) as typeof fetch);

  try {
    serve("# Lago\n\n> A billing platform\n\n## When to use Lago\nProse the spec disallows.\n");
    const found = await findPublished("https://x.com/", "test");
    assert.ok(found, "a non-conforming file is still the site's own answer");
    assert.equal(found.conforms, false);

    // The common failure this still has to exclude: a 404 page served as 200.
    serve("<!doctype html><html><body>Not found</body></html>", "text/html");
    assert.equal(await findPublished("https://x.com/", "test"), null);

    // Text that is not an llms.txt at all.
    serve("Just some notes about the site, not a structured file at all really.");
    assert.equal(await findPublished("https://x.com/", "test"), null);
  } finally {
    globalThis.fetch = original;
  }
});
