import { describe, expect, it } from "vitest";
import { isAllowedByRobots, parseRobotsTxt } from "../../lib/robots";

const parse = (text: string) => parseRobotsTxt(text, "llms-txt-generator");

describe("parseRobotsTxt", () => {
  it("collects Sitemap directives regardless of which group they sit in", () => {
    const rules = parse("Sitemap: https://a.test/sitemap.xml\nUser-agent: *\nDisallow: /x\nSitemap: https://a.test/two.xml");
    expect(rules.sitemaps).toEqual(["https://a.test/sitemap.xml", "https://a.test/two.xml"]);
  });

  it("prefers rules for our own token over the wildcard group", () => {
    const rules = parse("User-agent: *\nDisallow: /\n\nUser-agent: llms-txt-generator\nDisallow: /private");
    expect(isAllowedByRobots(rules, "/docs")).toBe(true);
    expect(isAllowedByRobots(rules, "/private")).toBe(false);
  });

  it("applies consecutive User-agent lines to one shared group", () => {
    const rules = parse("User-agent: googlebot\nUser-agent: *\nDisallow: /private");
    expect(isAllowedByRobots(rules, "/private/x")).toBe(false);
  });

  it("ignores comments and treats an empty Disallow as 'allow everything'", () => {
    const rules = parse("User-agent: *  # everyone\nDisallow:\n");
    expect(rules.rules).toEqual([]);
    expect(isAllowedByRobots(rules, "/anything")).toBe(true);
  });

  it("lets the longest matching rule win, with Allow breaking ties", () => {
    const rules = parse("User-agent: *\nDisallow: /docs\nAllow: /docs/public");
    expect(isAllowedByRobots(rules, "/docs/private")).toBe(false);
    expect(isAllowedByRobots(rules, "/docs/public/a")).toBe(true);
  });

  it("supports * and $ wildcards", () => {
    const rules = parse("User-agent: *\nDisallow: /*.json$\nDisallow: /a/*/b");
    expect(isAllowedByRobots(rules, "/data.json")).toBe(false);
    expect(isAllowedByRobots(rules, "/data.json?x=1")).toBe(true); // $ anchors the end
    expect(isAllowedByRobots(rules, "/a/anything/b")).toBe(false);
  });

  it("allows everything when robots.txt has no applicable rules", () => {
    expect(isAllowedByRobots(parse(""), "/x")).toBe(true);
    expect(isAllowedByRobots(parse("User-agent: googlebot\nDisallow: /"), "/x")).toBe(true);
  });
});
