import { describe, expect, it } from "vitest";
import { cleanTitles, clusterByKeyword, titleCase } from "../../lib/nlp";
import type { PageInfo } from "../../lib/types";

function page(url: string, title: string, description?: string): PageInfo {
  return { url, title, description };
}

describe("titleCase", () => {
  it("capitalizes a plain word", () => {
    expect(titleCase("workers")).toBe("Workers");
  });

  it("upper-cases known acronyms", () => {
    expect(titleCase("api")).toBe("API");
    expect(titleCase("sdk")).toBe("SDK");
  });
});

describe("cleanTitles", () => {
  it("strips a trailing brand suffix shared across most titles", () => {
    const pages = [
      page("https://foo.com/a", "Alpha - Foo Docs"),
      page("https://foo.com/b", "Beta - Foo Docs"),
      page("https://foo.com/c", "Gamma - Foo Docs"),
    ];
    const cleaned = cleanTitles(pages);
    expect(cleaned.map((p) => p.title)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("strips a colon-separated brand suffix too, not just dash/pipe", () => {
    // Regression test: sites using Yoast-SEO-style "Title : Brand" titles
    // (colon, not dash) previously kept the suffix entirely, e.g. "About
    // Limecraft : Limecraft" never lost its trailing " : Limecraft".
    const pages = [
      page("https://foo.com/a", "About Foo : Foo"),
      page("https://foo.com/b", "Contact : Foo"),
      page("https://foo.com/c", "Pricing : Foo"),
    ];
    const cleaned = cleanTitles(pages);
    expect(cleaned.map((p) => p.title)).toEqual(["About Foo", "Contact", "Pricing"]);
  });

  it("pulls the distinguishing word out of the suffix when the prefix is generic", () => {
    const pages = [
      page("https://foo.com/a", "Overview - Foo Workers"),
      page("https://foo.com/b", "Overview - Foo Pages"),
      page("https://foo.com/c", "Overview - Foo Queues"),
    ];
    const cleaned = cleanTitles(pages);
    expect(cleaned.map((p) => p.title)).toEqual(["Workers", "Pages", "Queues"]);
  });

  it("leaves titles unchanged when there's no shared suffix pattern", () => {
    const pages = [page("https://foo.com/a", "Alpha"), page("https://foo.com/b", "Beta")];
    expect(cleanTitles(pages)).toEqual(pages);
  });

  it("is a no-op below the minimum sample size", () => {
    const pages = [page("https://foo.com/a", "Alpha - Foo Docs")];
    expect(cleanTitles(pages)).toEqual(pages);
  });
});

describe("clusterByKeyword", () => {
  it("groups pages sharing a recurring term into one cluster", () => {
    // "widget" is the only term shared by two or more pages here (each
    // page's other words are unique to it), so it's the unambiguous top
    // candidate for both — avoiding a tie between multiple equally-shared
    // terms, which the per-page picker breaks by each page's own token
    // order and can otherwise fragment rather than cluster.
    const pages = [
      page("https://foo.com/a", "Alpha Widget"),
      page("https://foo.com/b", "Beta Widget"),
      page("https://foo.com/c", "Gamma Gadget"),
    ];
    const clusters = clusterByKeyword(pages);
    expect(clusters.get("Widget")?.map((p) => p.url).sort()).toEqual(["https://foo.com/a", "https://foo.com/b"]);
    expect(clusters.get("Pages")?.map((p) => p.url)).toEqual(["https://foo.com/c"]);
  });

  it("puts everything under one 'Pages' bucket when below the minimum cluster size", () => {
    const pages = [page("https://foo.com/a", "Solo Page")];
    const clusters = clusterByKeyword(pages);
    expect(Array.from(clusters.entries())).toEqual([["Pages", pages]]);
  });

  it("returns an empty map for no pages", () => {
    expect(clusterByKeyword([])).toEqual(new Map());
  });

  it("excludes near-universal terms (site boilerplate) from clustering", () => {
    const pages = [
      page("https://foo.com/a", "Alpha Widget", "In stock, taxes included, free shipping."),
      page("https://foo.com/b", "Beta Widget", "In stock, taxes included, free shipping."),
      page("https://foo.com/c", "Gamma Gadget", "In stock, taxes included, free shipping."),
    ];
    const clusters = clusterByKeyword(pages);
    // "stock"/"taxes"/"shipping" appear on all 3 pages (document frequency 3
    // out of 3, i.e. > the 50% cap), so they shouldn't drive clustering.
    for (const label of clusters.keys()) {
      expect(label.toLowerCase()).not.toMatch(/stock|tax|ship/);
    }
  });
});

describe("cleanTitles separators", () => {
  it("strips a brand suffix glued on with any of the separators sites actually use", () => {
    const cases: [string, string][] = [
      ["Research \\ Anthropic", "Research"],
      ["Guides — Acme", "Guides"],
      ["Guides – Acme", "Guides"],
      ["Guides • Acme", "Guides"],
      ["Guides » Acme", "Guides"],
      ["Guides · Acme", "Guides"],
      ["Guides | Acme", "Guides"],
    ];

    for (const [raw, expected] of cases) {
      const cleaned = cleanTitles([
        { url: "https://a.test/1", title: raw },
        { url: "https://a.test/2", title: raw.replace("Guides", "Pricing").replace("Research", "Policy") },
      ]);
      expect(cleaned[0].title, `separator in ${JSON.stringify(raw)}`).toBe(expected);
    }
  });
});
