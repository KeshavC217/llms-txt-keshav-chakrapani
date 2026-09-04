import { describe, expect, it } from "vitest";
import { validateLlmsTxt } from "../../lib/validate";
import { buildLlmsTxt, formatLink } from "../../lib/buildLlmsTxt";
import type { CrawlResult, NavCategory, PageInfo } from "../../lib/types";

function page(url: string, title: string, description?: string): PageInfo {
  return { url, title, description };
}

function navCategory(label: string, hrefs: string[]): NavCategory {
  return { label, hrefs: new Set(hrefs), pathPrefixes: [] };
}

describe("buildLlmsTxt", () => {
  it("renders the title, description, and a Home section for the root page", () => {
    const result: CrawlResult = {
      rootUrl: "https://foo.com",
      siteTitle: "Foo Inc.",
      siteDescription: "The foo company.",
      pages: [page("https://foo.com", "Foo Inc.", "The foo company.")],
      navCategories: [],
    };
    const output = buildLlmsTxt(result);
    expect(output).toContain("# Foo Inc.");
    expect(output).toContain("> The foo company.");
    expect(output).toContain("## Home");
    expect(output).toContain("- [Foo Inc.](https://foo.com): The foo company.");
  });

  it("sections pages under their nav-bar category, in nav order", () => {
    const result: CrawlResult = {
      rootUrl: "https://foo.com",
      siteTitle: "Foo",
      pages: [
        page("https://foo.com", "Foo"),
        page("https://foo.com/pricing", "Pricing"),
        page("https://foo.com/docs", "Docs"),
      ],
      navCategories: [navCategory("Pricing", ["https://foo.com/pricing"]), navCategory("Docs", ["https://foo.com/docs"])],
    };
    const output = buildLlmsTxt(result);
    const pricingIndex = output.indexOf("## Pricing");
    const docsIndex = output.indexOf("## Docs");
    expect(pricingIndex).toBeGreaterThan(-1);
    expect(docsIndex).toBeGreaterThan(pricingIndex);
  });

  it("buckets a page under a known path section (e.g. /blog) when it has no nav match", () => {
    const result: CrawlResult = {
      rootUrl: "https://foo.com",
      siteTitle: "Foo",
      pages: [
        page("https://foo.com", "Foo"),
        page("https://foo.com/blog/post-1", "Post One"),
        page("https://foo.com/blog/post-2", "Post Two"),
      ],
      navCategories: [],
    };
    const output = buildLlmsTxt(result);
    expect(output).toContain("## Blog");
    expect(output).toContain("- [Post One](https://foo.com/blog/post-1)");
  });

  it("falls back to a catch-all Pages section for anything unclustered", () => {
    const result: CrawlResult = {
      rootUrl: "https://foo.com",
      siteTitle: "Foo",
      pages: [page("https://foo.com", "Foo"), page("https://foo.com/x", "X")],
      navCategories: [],
    };
    const output = buildLlmsTxt(result);
    expect(output).toContain("## Pages");
    expect(output).toContain("- [X](https://foo.com/x)");
  });

  it("sanitizes pipe characters and newlines out of titles/descriptions", () => {
    const result: CrawlResult = {
      rootUrl: "https://foo.com",
      siteTitle: "Foo",
      pages: [page("https://foo.com", "Foo", "Line one\nLine two | with a pipe")],
      navCategories: [],
    };
    const output = buildLlmsTxt(result);
    expect(output).toContain("Line one Line two - with a pipe");
  });

  it("cleans the top-level title the same way as every other page's title", () => {
    // Regression test: crawlResult.siteTitle is the raw, unclean <title> tag
    // (e.g. a Yoast-SEO-style "Page | Brand : Brand" duplicate), while the
    // root page's own entry in `pages` goes through cleanTitles(). The two
    // must not diverge — the top "# ..." line previously used the raw,
    // uncleaned siteTitle even though the Home section below it showed the
    // properly de-duplicated version of the exact same title.
    const rawTitle = "The Workspace for Video Teams | Foo : Foo";
    const result: CrawlResult = {
      rootUrl: "https://foo.com",
      siteTitle: rawTitle,
      pages: [
        page("https://foo.com", rawTitle),
        page("https://foo.com/about", "About Foo : Foo"),
        page("https://foo.com/contact", "Contact : Foo"),
      ],
      navCategories: [],
    };
    const output = buildLlmsTxt(result);
    const topTitle = output.split("\n")[0];
    const homeLine = output.match(/^- \[(.+?)\]\(https:\/\/foo\.com\)/m)?.[1];
    expect(topTitle).not.toContain("Foo : Foo");
    expect(topTitle.replace(/^# /, "")).toBe(homeLine);
  });

  it("uses the site's own root URL, description, and title as a fallback when missing", () => {
    const result: CrawlResult = {
      rootUrl: "https://foo.com",
      siteTitle: "",
      pages: [page("https://foo.com", "")],
      navCategories: [],
    };
    const output = buildLlmsTxt(result);
    expect(output.startsWith("# https://foo.com")).toBe(true);
    expect(output).toContain("> Site content crawled from https://foo.com.");
  });
});

describe("markdown-hostile characters in titles and URLs", () => {
  it("neutralizes square brackets in a title that would close the link early", () => {
    // Seen in a real published llms.txt: "...Cost in 2026? [Complete Pricing
    // Breakdown]" produces "- [A [B]](url)", which no parser reads as a link.
    const line = formatLink({
      url: "https://a.test/guide",
      title: "Website Cost in 2026? [Complete Breakdown]",
      description: "A guide.",
    });
    expect(line).toBe("- [Website Cost in 2026? (Complete Breakdown)](https://a.test/guide): A guide.");
    expect(validateLlmsTxt(`# T\n\n## S\n\n${line}\n`)).toEqual([]);
  });

  it("percent-encodes parentheses in a URL that would close the link early", () => {
    const line = formatLink({ url: "https://a.test/Foo_(bar)", title: "Foo" });
    expect(line).toBe("- [Foo](https://a.test/Foo_%28bar%29)");
    expect(validateLlmsTxt(`# T\n\n## S\n\n${line}\n`)).toEqual([]);
  });
});

