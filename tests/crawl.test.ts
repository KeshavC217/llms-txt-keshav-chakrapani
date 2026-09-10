import { test } from "node:test";
import assert from "node:assert/strict";

import { ALLOW_ALL, isAllowed, parseRobots } from "../lib/crawl/robots.ts";
import { sitemapCandidates } from "../lib/crawl/sitemap.ts";
import { canonicalize } from "../lib/crawl/url.ts";
import { curate, dedupeLinks } from "../lib/grouping.ts";
import { Pacer } from "../lib/crawl/pacer.ts";
import { readPage } from "../lib/pageMeta.ts";
import { findPublished, publishedCandidates } from "../lib/published.ts";
import { planCrawl } from "../lib/crawl/plan.ts";
import { crawl } from "../lib/crawl/crawl.ts";
import { Deadline } from "../lib/deadline.ts";
import { createServer } from "node:http";

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

const candidate = (url: string, sitemapPosition = Number.MAX_SAFE_INTEGER, inbound = 0) => ({
  url,
  sitemapPosition,
  inbound,
  segments: new URL(url).pathname.split("/").filter(Boolean),
});

test("the plan gives each section a turn", () => {
  // A site's documentation should not be buried by its blog: getlago.com
  // publishes 282 sitemap URLs and not one /docs page.
  const plan = planCrawl(
    [
      candidate("https://x.com/blog/a", 1),
      candidate("https://x.com/blog/b", 2),
      candidate("https://x.com/blog/c", 3),
      candidate("https://x.com/docs/a", 4),
      candidate("https://x.com/docs/b", 5),
    ],
    4,
  );

  assert.equal(plan.urls.filter((url) => url.includes("/docs/")).length, 2);
  assert.equal(plan.urls.filter((url) => url.includes("/blog/")).length, 2);
});

test("the plan is a total order, so the same input gives the same list", () => {
  const input = [
    candidate("https://x.com/b/2", 9),
    candidate("https://x.com/a/1", 9),
    candidate("https://x.com/a/2", 9),
    candidate("https://x.com/b/1", 9),
  ];

  // Same positions and depths: only the tie-break separates them, which is
  // exactly the case that used to be decided by whoever answered first.
  const first = planCrawl(input, 4).urls;
  const second = planCrawl([...input].reverse(), 4).urls;
  assert.deepEqual(first, second);
});

test("a site smaller than the budget yields all of it, once", () => {
  const plan = planCrawl([candidate("https://x.com/a"), candidate("https://x.com/b")], 50);
  assert.deepEqual(plan.urls.sort(), ["https://x.com/a", "https://x.com/b"]);
});

/** A site that answers in a different order every time. */
function jitteryServer(pages: Record<string, string>) {
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    const body = pages[path];
    // Random latency is the point: arrival order differs on every run, and the
    // output must not.
    setTimeout(() => {
      if (body === undefined) {
        response.writeHead(404).end("no");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" }).end(body);
    }, Math.random() * 120);
  });

  return new Promise<{ origin: string; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test("two crawls of an unchanged site produce the same pages, in the same order", async () => {
  // The property monitoring depends on: if this is not true, a content hash
  // reports a change every run and means nothing.
  const page = (title: string, links: string[] = []) =>
    `<html><head><title>${title}</title></head><body>${links
      .map((href) => `<a href="${href}">${href}</a>`)
      .join("")}</body></html>`;

  const pages: Record<string, string> = {
    "/": page("Home", ["/docs/a", "/docs/b", "/blog/a", "/blog/b", "/about"]),
    "/docs/a": page("Docs A"),
    "/docs/b": page("Docs B"),
    "/blog/a": page("Blog A"),
    "/blog/b": page("Blog B"),
    "/about": page("About"),
    "/robots.txt": "",
  };

  const server = await jitteryServer(pages);
  try {
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const result = await crawl(server.origin, {
        userAgent: "test",
        seed: { url: `${server.origin}/`, html: pages["/"] },
      });
      runs.push(result.pages.map((p) => `${p.url} ${p.title}`).join("\n"));
    }

    assert.equal(runs[0], runs[1], "run 1 and 2 differ");
    assert.equal(runs[1], runs[2], "run 2 and 3 differ");
  } finally {
    server.close();
  }
});

test("prefix filters keep a crawl inside a section", async () => {
  // These were covered against a class that no longer runs anything. The
  // capability is real - crawl.ts applies both when it considers a URL - so
  // the test now goes through the crawler itself.
  const page = (title: string, links: string[] = []) =>
    `<html><head><title>${title}</title></head><body>${links
      .map((href) => `<a href="${href}">${href}</a>`)
      .join("")}</body></html>`;

  const pages: Record<string, string> = {
    "/": page("Home", ["/docs/guide", "/docs/legacy/old", "/blog/post"]),
    "/docs/guide": page("Guide"),
    "/docs/legacy/old": page("Old"),
    "/blog/post": page("Post"),
    "/robots.txt": "",
  };

  const server = await jitteryServer(pages);
  try {
    const result = await crawl(server.origin, {
      userAgent: "test",
      seed: { url: `${server.origin}/`, html: pages["/"] },
      include: ["/docs"],
      exclude: ["/docs/legacy"],
    });

    const paths = result.pages.map((p) => new URL(p.url).pathname).sort();
    assert.deepEqual(paths, ["/", "/docs/guide"], "excluded and out-of-prefix pages must not be fetched");
  } finally {
    server.close();
  }
});

test("a slow site ends the crawl on the deadline rather than the function's limit", async () => {
  // The failure this exists to stop: news.ycombinator.com took 61 seconds and
  // had not started the model passes, so Vercel killed the request. Nothing
  // was returned, nothing stored, and the next attempt failed identically.
  const page = (title: string, links: string[] = []) =>
    `<html><head><title>${title}</title></head><body>${links
      .map((href) => `<a href="${href}">${href}</a>`)
      .join("")}</body></html>`;

  const links = Array.from({ length: 40 }, (_, i) => `/slow/${i}`);
  const pages: Record<string, string> = { "/": page("Home", links), "/robots.txt": "" };
  for (const href of links) pages[href] = page(`Page ${href}`);

  // 200ms a page: forty of them cannot fit in a second however they are
  // scheduled, so the deadline is what has to end this.
  const server = await slowServer(pages, 200);
  try {
    const budget = 1_000;
    const startedAt = Date.now();
    const result = await crawl(server.origin, {
      userAgent: "test",
      seed: { url: `${server.origin}/`, html: pages["/"] },
      deadline: new Deadline(budget),
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(result.partial, true, "a crawl cut short has to say so");
    assert.ok(result.pages.length < 41, "it cannot have read the whole site");
    // The margin is one page in flight per worker: the check refuses to START
    // a page it cannot finish, and cannot interrupt one already running.
    assert.ok(elapsed < budget + 2_000, `crawl overran its deadline: ${elapsed}ms against ${budget}ms`);
  } finally {
    server.close();
  }
});

test("discovery that leaves no time to fetch anything is skipped", async () => {
  // A sitemap fetched with nothing left to crawl afterwards costs the site a
  // request and tells us nothing we can use.
  const pages: Record<string, string> = {
    "/": `<html><head><title>Home</title></head><body><a href="/a">A</a></body></html>`,
    "/robots.txt": "",
    "/sitemap.xml": `<urlset><url><loc>https://x.com/a</loc></url></urlset>`,
    "/a": `<html><head><title>A</title></head></html>`,
  };

  const server = await slowServer(pages, 0);
  try {
    const result = await crawl(server.origin, {
      userAgent: "test",
      seed: { url: `${server.origin}/`, html: pages["/"] },
      // Already spent: nothing may be started at all.
      deadline: new Deadline(0),
    });

    assert.equal(result.partial, true);
    assert.equal(result.fetched, 0, "no request may be made with no time to make one");
    // The seed is still there: the caller already had it, so it costs nothing
    // and a file naming one page beats a file naming none.
    assert.equal(result.pages.length, 1);
  } finally {
    server.close();
  }
});

/** A site with a fixed, controllable delay on every response. */
function slowServer(pages: Record<string, string>, delayMs: number) {
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    const body = pages[path];
    setTimeout(() => {
      if (body === undefined) {
        response.writeHead(404).end("no");
        return;
      }
      const type = path.endsWith(".xml") ? "application/xml" : path.endsWith(".txt") ? "text/plain" : "text/html";
      response.writeHead(200, { "content-type": type }).end(body);
    }, delayMs);
  });

  return new Promise<{ origin: string; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test("the pacer refuses a turn that would arrive after the deadline", async () => {
  // What took a twenty-second crawl to seventy. The queue is shared, so with
  // four workers and news.ycombinator.com's ten-second crawl-delay the fourth
  // worker's turn is forty seconds away - and it used to sleep for all of it,
  // budget or no budget.
  const pacer = new Pacer(200);

  assert.equal(await pacer.wait(new Deadline(10_000)), true, "the first turn is now");
  assert.equal(await pacer.wait(new Deadline(100)), false, "the second is 200ms out, with 100ms left");
});

test("a refused turn does not move the queue on", async () => {
  // The worker is stopping. Consuming its slot would make the next one wait
  // for a request that is never sent, which on a site asking for a ten-second
  // delay is ten seconds of nothing.
  const pacer = new Pacer(200);
  assert.equal(await pacer.wait(new Deadline(10_000)), true);
  assert.equal(await pacer.wait(new Deadline(100)), false);

  const at = Date.now();
  assert.equal(await pacer.wait(new Deadline(10_000)), true);
  const waited = Date.now() - at;

  // One interval, not two: the refusal above took no slot. Generous upper
  // bound because a timer may fire late, but 400ms would mean it had.
  assert.ok(waited < 380, `waited ${waited}ms, so the refused turn had consumed a slot`);
});

test("the pacer reserves what the caller still needs after waiting", async () => {
  // Otherwise a worker sleeps to the very edge of the budget and fetches
  // nothing with what is left.
  const pacer = new Pacer(200);
  assert.equal(await pacer.wait(new Deadline(10_000)), true, "first turn, no wait");

  assert.equal(await pacer.wait(new Deadline(250), 100), false, "200ms wait + 100ms of work > 250ms");
  assert.equal(await pacer.wait(new Deadline(250), 10), true, "200ms wait + 10ms of work fits");
});

test("without a deadline the pacer behaves as it always did", async () => {
  // Every caller outside a crawl passes nothing, and paces rather than stops.
  const pacer = new Pacer(0);
  assert.equal(await pacer.wait(), true);
  assert.equal(await pacer.wait(), true);
});

test("a script invocation is not treated as a directory index", () => {
  // /docs/index.html is a directory index and the directory is the better
  // address. /w/index.php?title=X is a program being called: stripping the
  // script name invents an address we never fetched, and en.wikipedia.org was
  // getting both spellings of the same page in one file.
  assert.equal(canonicalize("/docs/index.html", "https://x.com/"), "https://x.com/docs");
  assert.equal(
    canonicalize("/w/index.php?title=Main_Page", "https://x.com/"),
    "https://x.com/w/index.php?title=Main_Page",
  );
});

test("an operation on a page is not a page", () => {
  // Thirteen of Wikipedia's fifty-two links were these. An llms.txt says what a
  // site contains; it must never point an agent at an edit form.
  for (const href of [
    "/w/index.php?title=Main_Page&action=edit",
    "/w/index.php?title=Main_Page&action=history",
    "/page?printable=yes",
    "/page?mobileaction=toggle_view_mobile",
    "/page?useparsoid=0",
    "/w/index.php?title=X&oldid=12345",
  ]) {
    assert.equal(canonicalize(href, "https://x.com/"), null, href);
  }

  // But ?action= is common on ordinary pages, so only operation values count.
  assert.ok(canonicalize("/shop?action=browse", "https://x.com/"));
  assert.ok(canonicalize("/docs?version=2", "https://x.com/"));
});

test("one entry per page, where the query is a variant rather than the page", () => {
  // airbnb.com linked its gift-card page ten times, so a whole section of the
  // generated file was one page under ten spellings.
  const variants = Array.from({ length: 6 }, (_, i) => ({
    title: "Airbnb gift cards",
    url: `https://x.com/gift/buy?country=US&card_name=v${i}`,
  }));

  const [section] = curate([
    { name: "Gift", links: [{ title: "Airbnb gift cards", url: "https://x.com/gift/buy?country=US" }, ...variants] },
  ]);

  assert.equal(section.links.length, 1);
  assert.equal(section.links[0].url, "https://x.com/gift/buy?country=US", "the shortest form survives");
});

test("the same path with different titles is several pages, not one", () => {
  // en.wikipedia.org addresses every article as /w/index.php?title=X. Folding
  // on the path alone would collapse an encyclopedia into a single link, which
  // is why the title has to be part of the question.
  const [section] = curate([
    {
      name: "Wiki",
      links: [
        { title: "Kurultai", url: "https://x.com/w/index.php?title=Kurultai" },
        { title: "English language", url: "https://x.com/w/index.php?title=English_language" },
        { title: "Convoys in World War I", url: "https://x.com/w/index.php?title=Convoys" },
      ],
    },
  ]);

  assert.equal(section.links.length, 3);
});

test("the variant that says something outlives the one that does not", () => {
  const [section] = curate([
    {
      name: "Help",
      links: [
        { title: "Contact us", url: "https://x.com/help/contact-us?entry=FOOTER" },
        { title: "Contact us", url: "https://x.com/help/contact-us?entry=HOME", note: "Reach support by phone or chat." },
      ],
    },
  ]);

  assert.equal(section.links.length, 1);
  assert.match(section.links[0].note ?? "", /phone or chat/);
});

test("the Optional list is deduplicated too", () => {
  // Optional is a flat list rather than a Section, so it does not pass through
  // curate. modal.com listed /signup twice there, once with ?next= attached.
  const kept = dedupeLinks([
    { title: "Signup", url: "https://x.com/signup?next=%2Fapps" },
    { title: "Signup", url: "https://x.com/signup" },
    { title: "Careers", url: "https://x.com/careers" },
  ]);

  assert.deepEqual(
    kept.map((link) => link.url),
    ["https://x.com/signup", "https://x.com/careers"],
  );
});

test("a page linked from two sections is kept once", () => {
  // Deduping within each section separately would miss this, and a site links
  // the same page from more than one part of its navigation.
  const sections = curate([
    { name: "Docs", links: [{ title: "Pricing", url: "https://x.com/pricing?from=docs" }, { title: "A", url: "https://x.com/a" }] },
    { name: "Company", links: [{ title: "Pricing", url: "https://x.com/pricing" }, { title: "B", url: "https://x.com/b" }] },
  ]);

  const urls = sections.flatMap((section) => section.links.map((link) => link.url));
  assert.equal(urls.filter((url) => url.includes("/pricing")).length, 1);
  assert.ok(urls.includes("https://x.com/pricing"), "the plain form is the one to keep");
});

test("the same page under a long title and a short one is one link", () => {
  // nytimes.com offered both, because one title came from the page's own
  // <title> and the other from the text of a link to it.
  const kept = dedupeLinks([
    {
      title: "Connections - Group words that share a common thread",
      url: "https://x.com/games/connections",
      note: "A new puzzle each day.",
    },
    { title: "Connections", url: "https://x.com/games/connections?smid=nav" },
  ]);

  assert.equal(kept.length, 1);
  assert.match(kept[0].note ?? "", /new puzzle/);
});

test("containment does not merge two real pages that share an address", () => {
  // The risk the test above introduces. Every Wikipedia article is
  // /w/index.php?title=X, so a short title contained in a longer one must not
  // be enough on its own - these are different articles.
  const kept = dedupeLinks([
    { title: "Convoys", url: "https://x.com/wiki/Convoys" },
    { title: "Convoys in World War I", url: "https://x.com/wiki/Convoys_in_World_War_I" },
  ]);

  assert.equal(kept.length, 2, "different addresses are different pages whatever the titles say");
});

test("a section gets budget in proportion to how much of the site it is", () => {
  // A turn each treats every section as equally important, which on a
  // documentation site is plainly wrong: 200 pages of docs and 2 of careers
  // are not two things of equal weight.
  const many = Array.from({ length: 200 }, (_, i) => candidate(`https://x.com/docs/${i}`));
  const few = [candidate("https://x.com/careers/a"), candidate("https://x.com/careers/b")];

  const plan = planCrawl([...many, ...few], 50);
  const docs = plan.urls.filter((url) => url.includes("/docs/")).length;
  const careers = plan.urls.filter((url) => url.includes("/careers/")).length;

  assert.ok(docs > careers * 5, `docs took ${docs} and careers ${careers}`);
  assert.ok(careers >= 1, "but the smaller section is not starved");
  assert.equal(plan.urls.length, 50, "and the budget is spent");
});

test("a section smaller than its share does not waste the budget", () => {
  // Sections that run out early hand what is left back, or a site with one
  // large section and several tiny ones would crawl well under its limit.
  const plan = planCrawl(
    [
      ...Array.from({ length: 90 }, (_, i) => candidate(`https://x.com/docs/${i}`)),
      candidate("https://x.com/about/a"),
      candidate("https://x.com/legal/a"),
    ],
    50,
  );

  assert.equal(plan.urls.length, 50);
});

test("with more sections than budget, the largest are the ones described", () => {
  // Taking one page each from eighty sections describes nothing.
  const candidates = [
    ...Array.from({ length: 30 }, (_, i) => candidate(`https://x.com/docs/${i}`)),
    ...Array.from({ length: 20 }, (_, i) => candidate(`https://x.com/guides/${i}`)),
    ...Array.from({ length: 60 }, (_, i) => candidate(`https://x.com/tiny${i}/a`)),
  ];

  const plan = planCrawl(candidates, 10);
  assert.equal(plan.urls.length, 10);
  assert.ok(plan.urls.some((url) => url.includes("/docs/")), "the biggest section is represented");
  assert.ok(plan.urls.some((url) => url.includes("/guides/")));
});

test("the page a site links to most is the page taken first", () => {
  // react.dev links /learn five times, /reference/react and /blog four - which
  // are exactly its three most important pages. That is the site voting, and
  // it needs no judgement from us.
  const plan = planCrawl(
    [
      candidate("https://x.com/docs/rarely", Number.MAX_SAFE_INTEGER, 1),
      candidate("https://x.com/docs/often", Number.MAX_SAFE_INTEGER, 9),
      candidate("https://x.com/docs/sometimes", Number.MAX_SAFE_INTEGER, 4),
    ],
    2,
  );

  assert.deepEqual(plan.urls, ["https://x.com/docs/often", "https://x.com/docs/sometimes"]);
});

test("where nothing is linked more than once, ranking falls through to depth", () => {
  // docs.convex.dev fills its budget from the sitemap alone, so every
  // candidate is mentioned exactly once and the signal is uniformly absent.
  // It has to fall through rather than mislead.
  const plan = planCrawl(
    [
      candidate("https://x.com/docs/a/b/c", Number.MAX_SAFE_INTEGER, 1),
      candidate("https://x.com/docs/a", Number.MAX_SAFE_INTEGER, 1),
      candidate("https://x.com/docs/a/b", Number.MAX_SAFE_INTEGER, 1),
    ],
    3,
  );

  assert.deepEqual(plan.urls, ["https://x.com/docs/a", "https://x.com/docs/a/b", "https://x.com/docs/a/b/c"]);
});

test("ranking keeps the plan a pure function of its input", () => {
  // The property everything downstream rests on: an unchanged site must yield
  // the same pages, or a content hash reports a change every run.
  const input = [
    candidate("https://x.com/a/1", 5, 3),
    candidate("https://x.com/b/1", 5, 3),
    candidate("https://x.com/a/2", 5, 3),
    candidate("https://x.com/b/2", 2, 7),
  ];

  assert.deepEqual(planCrawl(input, 3).urls, planCrawl([...input].reverse(), 3).urls);
});
