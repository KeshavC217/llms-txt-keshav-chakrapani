import { describe, expect, it } from "vitest";
import { matchesPrefix, normalizePrefix } from "../../lib/crawler";

describe("normalizePrefix", () => {
  it("accepts a bare path, with or without slashes", () => {
    expect(normalizePrefix("docs")).toBe("/docs");
    expect(normalizePrefix("/docs")).toBe("/docs");
    expect(normalizePrefix("/docs/")).toBe("/docs");
    expect(normalizePrefix("  /docs//  ")).toBe("/docs");
  });

  it("accepts a full URL, since people paste those", () => {
    expect(normalizePrefix("https://acme.test/docs/guides/")).toBe("/docs/guides");
  });

  it("treats the site root as a prefix matching everything", () => {
    expect(normalizePrefix("/")).toBe("/");
  });

  it("rejects empty input", () => {
    expect(normalizePrefix("")).toBeNull();
    expect(normalizePrefix("   ")).toBeNull();
  });
});

describe("matchesPrefix", () => {
  it("matches the prefix itself and anything nested under it", () => {
    expect(matchesPrefix("https://a.test/docs", ["/docs"])).toBe(true);
    expect(matchesPrefix("https://a.test/docs/", ["/docs"])).toBe(true);
    expect(matchesPrefix("https://a.test/docs/start", ["/docs"])).toBe(true);
  });

  it("does not match a path that merely shares a prefix string", () => {
    // "/docs" must not capture "/docsearch" — the classic startsWith bug.
    expect(matchesPrefix("https://a.test/docsearch", ["/docs"])).toBe(false);
    expect(matchesPrefix("https://a.test/documentation", ["/docs"])).toBe(false);
  });

  it("matches any of several prefixes", () => {
    expect(matchesPrefix("https://a.test/blog/post", ["/docs", "/blog"])).toBe(true);
    expect(matchesPrefix("https://a.test/pricing", ["/docs", "/blog"])).toBe(false);
  });

  it("treats '/' as matching everything", () => {
    expect(matchesPrefix("https://a.test/anything/deep", ["/"])).toBe(true);
  });

  it("returns false for an unparseable URL rather than throwing", () => {
    expect(matchesPrefix("not a url", ["/docs"])).toBe(false);
  });
});
