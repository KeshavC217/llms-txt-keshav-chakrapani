/**
 * Integration test for the deterministic pipeline: a real HTTP server serving
 * a real (if small) website, crawled over a real socket, all the way to a
 * finished llms.txt.
 *
 * This is the layer the unit tests can't reach — they feed hand-written HTML
 * strings straight into one function, so they can't catch a bug in how the
 * crawler discovers, filters, ranks, or budgets URLs, which is where most of
 * the real defects live. It's also fully offline and deterministic, unlike
 * tests/eval, so it can gate CI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawlSite } from "../../lib/crawler";
import { buildLlmsTxt, groupPagesIntoSections } from "../../lib/buildLlmsTxt";
import { formatIssues, validateLlmsTxt } from "../../lib/validate";
import { startFixtureServer, type FixtureServer } from "../helpers/fixtureServer";
import type { CrawlResult } from "../../lib/types";

// The crawler refuses private addresses by default (SSRF guard); the fixture
// server is on 127.0.0.1, so tests opt in explicitly.
process.env.ALLOW_PRIVATE_CRAWL_TARGETS = "1";

let server: FixtureServer;
let result: CrawlResult;
let llmsTxt: string;

beforeAll(async () => {
  server = await startFixtureServer();
  result = await crawlSite(server.url);
  llmsTxt = buildLlmsTxt(result);
}, 60_000);

afterAll(async () => {
  await server?.close();
});

function urls(): string[] {
  return result.pages.map((p) => p.url.replace(server.url, ""));
}

describe("end-to-end crawl of a fixture site", () => {
  it("produces a spec-valid llms.txt", () => {
    const issues = validateLlmsTxt(llmsTxt);
    expect(issues, `llms.txt failed validation:\n${formatIssues(issues)}\n\n${llmsTxt}`).toEqual([]);
  });

  it("starts with the site title and summary", () => {
    expect(llmsTxt).toMatch(/^# Acme[^\n]*\n\n> Acme is widget infrastructure for teams that ship every day\./);
  });

  it("includes the homepage and its nav-linked pages", () => {
    expect(urls()).toContain("/");
    expect(urls()).toEqual(expect.arrayContaining(["/docs/getting-started", "/docs/config", "/pricing"]));
  });

  it("discovers pages that only exist in sitemap.xml", () => {
    // Nothing on the homepage links to /docs/api — it is reachable only
    // through the sitemap, which is exactly the gap sitemap discovery closes.
    expect(urls()).toContain("/docs/api");
  });

  it("honors robots.txt Disallow", () => {
    expect(urls()).not.toContain("/private/secret");
    expect(server.requests).not.toContain("/private/secret");
  });

  it("skips non-HTML links, junk paths, and other origins", () => {
    expect(server.requests).not.toContain("/whitepaper.pdf");
    expect(urls()).not.toContain("/login");
    expect(llmsTxt).not.toContain("external.example.com");
  });

  it("groups pages under the site's own nav labels", () => {
    const { sections } = groupPagesIntoSections(result);
    const docs = sections.get("Docs")?.map((p) => p.url.replace(server.url, "")) ?? [];
    expect(docs).toEqual(expect.arrayContaining(["/docs/getting-started", "/docs/config"]));
    expect(sections.has("Pricing")).toBe(true);
  });

  it("strips the repeated brand suffix from page titles", () => {
    const gettingStarted = result.pages.find((p) => p.url.endsWith("/docs/getting-started"));
    expect(gettingStarted?.title).toBe("Getting Started - Acme");

    const { sections } = groupPagesIntoSections(result);
    const cleaned = Array.from(sections.values())
      .flat()
      .find((p) => p.url.endsWith("/docs/getting-started"));
    expect(cleaned?.title).toBe("Getting Started");
  });

  it("falls back to a prose sentence when a page has no meta description", () => {
    const about = result.pages.find((p) => p.url.endsWith("/about"));
    expect(about?.description).toBe("Acme builds widget infrastructure for teams that ship every day.");
  });

  it("collapses the same page served at two URLs, keeping the shorter one", () => {
    expect(urls()).toContain("/integrations");
    expect(urls()).not.toContain("/integrations.htm");
  });

  it("follows rel=canonical instead of listing the page twice", () => {
    expect(urls()).toContain("/pricing");
    expect(urls()).not.toContain("/legacy-pricing");
  });

  it("drops a boilerplate description shared by several pages", () => {
    const boilerplate = "Acme: widget infrastructure for modern teams.";
    // Both pages survive — it is the useless description that goes, not them.
    expect(llmsTxt).toContain("(" + server.url + "/security)");
    expect(llmsTxt).toContain("(" + server.url + "/careers)");
    expect(llmsTxt).not.toContain(boilerplate);
  });

  it("does not repeat the site summary as the description of a subpage", () => {
    const summaryUses = llmsTxt.split("Acme is widget infrastructure for teams that ship every day.").length - 1;
    // Once as the "> " summary, once on the homepage link — never on a subpage.
    expect(summaryUses).toBeLessThanOrEqual(2);
  });

  it("emits parseable links for titles and URLs containing markdown delimiters", () => {
    // A "]" in a title or a "(" in a path silently breaks the link for every
    // markdown parser downstream — found in a real published llms.txt, and
    // reachable from any crawled page whose <title> uses brackets.
    expect(llmsTxt).toContain("[Website Cost in 2026? (Complete Breakdown)]");
    expect(llmsTxt).not.toMatch(/\[[^\]]*\[/);
    expect(llmsTxt).toContain("/docs/api_%28legacy%29");
    // The spec validator is the real assertion: it re-parses every link line.
    expect(validateLlmsTxt(llmsTxt)).toEqual([]);
  });

  it("does not emit any page twice", () => {
    const links = Array.from(llmsTxt.matchAll(/\]\(([^)]+)\)/g)).map((m) => m[1]);
    expect(new Set(links).size).toBe(links.length);
  });

  it("escapes nothing it shouldn't: a '$' in page text survives intact", () => {
    // "$0" in the Pricing description is a live regression guard: splicing
    // text through String.replace(str, str) would interpret "$&"/"$'" style
    // sequences as substitution patterns and corrupt the line.
    expect(llmsTxt).toContain("starts at $0");
  });
});

describe("crawl politeness", () => {
  it("waits and retries when the host answers 429, instead of dropping the page", () => {
    // A 429 means "too fast", not "this page is broken" — dropping it loses a
    // page the site was perfectly willing to serve a moment later.
    expect(server.throttleResponses, "the fixture should have throttled us").toBeGreaterThan(0);
    expect(urls(), "the throttled page should still make it into the output").toContain("/rate-limited");

    const page = result.pages.find((p) => p.url.endsWith("/rate-limited"));
    expect(page?.title).toBe("Popular Page - Acme");
  });

  it("paces requests instead of firing every worker at once", () => {
    // Bounded concurrency alone is not politeness: 8 workers against one host
    // is 8 simultaneous requests sustained for the whole crawl, which is how
    // a crawler earns a wall of 429s and gets blocked.
    const times = [...server.requestTimes].sort((a, b) => a - b);
    expect(times.length).toBeGreaterThan(10);

    // No more than a handful may land in any 100ms window.
    let worstBurst = 0;
    for (let i = 0; i < times.length; i++) {
      const inWindow = times.filter((t) => t >= times[i] && t < times[i] + 100).length;
      worstBurst = Math.max(worstBurst, inWindow);
    }
    expect(worstBurst, `${worstBurst} requests landed within one 100ms window`).toBeLessThanOrEqual(8);
  });
});

describe("redirects", () => {
  it("crawls the host it landed on, not the one that was typed", async () => {
    // pinecone.io redirects to www.pinecone.io. Keeping the typed origin made
    // every link on the fetched page fail the same-origin check, so the crawl
    // collapsed to whatever happened to be relative-linked — and every URL we
    // published was itself a redirect, costing a reader an extra hop per link.
    const viaRedirect = await crawlSite(`${server.url}/start-here`);

    expect(viaRedirect.rootUrl.replace(/\/$/, "")).toBe(server.url);
    expect(viaRedirect.pages.length, "a redirected entry point should crawl the whole site").toBeGreaterThan(5);
    expect(viaRedirect.pages.map((p) => p.url)).not.toContain(`${server.url}/start-here`);
  }, 60_000);
});

describe("crawl failure handling", () => {
  it("rejects a private address unless explicitly allowed", async () => {
    const original = process.env.ALLOW_PRIVATE_CRAWL_TARGETS;
    delete process.env.ALLOW_PRIVATE_CRAWL_TARGETS;
    try {
      await expect(crawlSite(server.url)).rejects.toThrow(/publicly reachable/i);
    } finally {
      process.env.ALLOW_PRIVATE_CRAWL_TARGETS = original;
    }
  });

  it("reports an unreachable site rather than returning an empty document", async () => {
    await expect(crawlSite("http://127.0.0.1:1/")).rejects.toThrow(/Could not reach/i);
  }, 30_000);
});
