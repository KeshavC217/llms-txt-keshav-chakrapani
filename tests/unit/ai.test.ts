import { describe, expect, it, vi } from "vitest";
import { buildLlmsTxt } from "../../lib/buildLlmsTxt";
import { formatIssues, validateLlmsTxt } from "../../lib/validate";
import type { CrawlResult, NavCategory, PageInfo } from "../../lib/types";

vi.mock("../../lib/openrouter", () => ({
  requestJson: vi.fn(),
  isAiConfigured: () => true,
}));

// Imported after the mock so enhanceLlmsTxt picks up the mocked requestJson.
const { enhanceLlmsTxt } = await import("../../lib/ai");
const { requestJson } = await import("../../lib/openrouter");

function page(url: string, title: string, description?: string): PageInfo {
  return { url, title, description };
}

function navCategory(label: string, hrefs: string[]): NavCategory {
  return { label, hrefs: new Set(hrefs), pathPrefixes: [] };
}

function buildResult(): CrawlResult {
  return {
    rootUrl: "https://foo.com",
    siteTitle: "Foo",
    siteDescription: "The go-to platform for teams.",
    pages: [
      page("https://foo.com", "Foo", "The go-to platform for teams."),
      page("https://foo.com/team", "Meet the Team", "The go-to platform for teams."),
      page("https://foo.com/docs/getting-started", "Getting Started", "Getting started with Foo."),
    ],
    navCategories: [navCategory("Team", ["https://foo.com/team"])],
  };
}


/**
 * Stands in for the chunked model calls. enhanceLlmsTxt now makes one
 * document-level call plus one per section chunk, in parallel, so a test
 * fixture has to route each field to the call that actually owns it — and a
 * chunk worker only ever sees (and may only edit) its own pages. Filtering
 * pageEdits by what appears in each prompt reproduces that constraint rather
 * than papering over it.
 */
function mockPlan(plan: {
  siteTitle?: string;
  siteDescription?: string;
  siteIntro?: string;
  sectionLabels?: Record<string, string>;
  pageEdits?: Record<string, { title?: string; description?: string | null }>;
  optionalUrls?: string[];
  /** Return these edits from every chunk, even for URLs not in that chunk. */
  unsolicitedEdits?: Record<string, { title?: string; description?: string | null }>;
  unsolicitedOptional?: string[];
}) {
  vi.mocked(requestJson).mockImplementation(async (prompt: string) => {
    if (prompt.includes("copyediting the header")) {
      return {
        siteTitle: plan.siteTitle,
        siteDescription: plan.siteDescription,
        siteIntro: plan.siteIntro,
        sectionLabels: plan.sectionLabels,
      };
    }
    const owns = (url: string) => prompt.includes(`url: ${url}\n`);
    return {
      pageEdits: {
        ...Object.fromEntries(Object.entries(plan.pageEdits ?? {}).filter(([url]) => owns(url))),
        ...(plan.unsolicitedEdits ?? {}),
      },
      optionalUrls: [...(plan.optionalUrls ?? []).filter(owns), ...(plan.unsolicitedOptional ?? [])],
    };
  });
}

/** Every call fails, the way a dead model or a bad route does. */
function mockAllFail() {
  vi.mocked(requestJson).mockResolvedValue(null);
}

describe("enhanceLlmsTxt", () => {
  it("falls back to the deterministic output when the model call fails", async () => {
    mockAllFail();
    const result = buildResult();
    const llmsTxt = buildLlmsTxt(result);
    expect(await enhanceLlmsTxt(result, llmsTxt)).toEqual({ llmsTxt, status: "failed" });
  });

  it("clears a description via explicit null, moves a page to Optional, and prunes the now-empty section", async () => {
    mockPlan({
      pageEdits: { "https://foo.com/team": { description: null } },
      optionalUrls: ["https://foo.com/team"],
    });

    const result = buildResult();
    const llmsTxt = buildLlmsTxt(result);
    const { llmsTxt: enhanced } = await enhanceLlmsTxt(result, llmsTxt);

    expect(enhanced).not.toContain("## Team");
    expect(enhanced).toContain("## Optional");
    expect(enhanced).toContain("- [Meet the Team](https://foo.com/team)");
    // The description must be gone, not just unchanged.
    expect(enhanced).not.toContain("Meet the Team](https://foo.com/team): ");
    // Untouched pages must survive verbatim.
    expect(enhanced).toContain("- [Getting Started](https://foo.com/docs/getting-started): Getting started with Foo.");
  });

  it("inserts a free-form siteIntro paragraph between the summary and the first section", async () => {
    mockPlan({
      siteIntro: "Foo has two main parts: a dashboard and an API.",
    });

    const result = buildResult();
    const llmsTxt = buildLlmsTxt(result);
    const { llmsTxt: enhanced } = await enhanceLlmsTxt(result, llmsTxt);

    const lines = enhanced.split("\n");
    const summaryIndex = lines.findIndex((l) => l.startsWith("> "));
    const introIndex = lines.findIndex((l) => l === "Foo has two main parts: a dashboard and an API.");
    const firstHeaderIndex = lines.findIndex((l) => l.startsWith("## "));

    expect(introIndex).toBeGreaterThan(summaryIndex);
    expect(introIndex).toBeLessThan(firstHeaderIndex);
  });

  it("prunes two adjacent sections that both become empty, including at the end of the document", async () => {
    // Regression test: a single-pass global regex only prunes every other
    // empty section when two sit next to each other, because removing the
    // first one consumes the leading newline the second one's own match
    // needs. This also covers the case where the last section in the
    // document is one of the emptied ones.
    const result: CrawlResult = {
      rootUrl: "https://foo.com",
      siteTitle: "Foo",
      siteDescription: "The go-to platform for teams.",
      pages: [
        page("https://foo.com", "Foo", "The go-to platform for teams."),
        page("https://foo.com/guide", "Guide"),
        page("https://foo.com/blog", "Blog Post"),
        page("https://foo.com/ack", "Acknowledgements"),
      ],
      navCategories: [
        navCategory("Guide", ["https://foo.com/guide"]),
        navCategory("Blog", ["https://foo.com/blog"]),
        navCategory("Acknowledgements", ["https://foo.com/ack"]),
      ],
    };

    mockPlan({
      optionalUrls: ["https://foo.com/blog", "https://foo.com/ack"],
    });

    const llmsTxt = buildLlmsTxt(result);
    const { llmsTxt: enhanced } = await enhanceLlmsTxt(result, llmsTxt);

    expect(enhanced).not.toContain("## Blog");
    expect(enhanced).not.toContain("## Acknowledgements");
    expect(enhanced).toContain("## Guide");
    expect(enhanced).toContain("## Optional");
    expect(enhanced).toContain("- [Blog Post](https://foo.com/blog)");
    expect(enhanced).toContain("- [Acknowledgements](https://foo.com/ack)");
  });

  it("ignores an edit or optionalUrls entry for a URL that wasn't in the crawl", async () => {
    // "unsolicited" so the edit bypasses the fixture's own per-chunk
    // ownership filter and actually reaches applyPlan — otherwise the test
    // would pass because the mock dropped it, proving nothing about the
    // guard that is supposed to catch a hallucinated URL.
    mockPlan({
      unsolicitedEdits: { "https://evil.com/hallucinated": { title: "Hacked" } },
      unsolicitedOptional: ["https://evil.com/hallucinated"],
    });

    const result = buildResult();
    const llmsTxt = buildLlmsTxt(result);
    const { llmsTxt: enhanced } = await enhanceLlmsTxt(result, llmsTxt);

    expect(enhanced).toBe(llmsTxt);
  });
  it("splices '$' sequences literally instead of as regex substitution patterns", async () => {
    // Regression test: String.replace(string, string) interprets "$&", "$`",
    // "$'" and "$1" in the REPLACEMENT as substitution patterns, so a model
    // rewriting a pricing page's copy ("$0 to $1M") used to silently splice
    // the surrounding document into the line instead of a dollar sign.
    mockPlan({
      siteTitle: "Foo $& Co",
      siteDescription: "Plans from $0 to $1M in revenue.",
      pageEdits: {
        "https://foo.com/team": { title: "The $` Team", description: "Costs $0. Worth $'." },
      },
    });

    const result = buildResult();
    const { llmsTxt: enhanced } = await enhanceLlmsTxt(result, buildLlmsTxt(result));

    expect(enhanced).toContain("# Foo $& Co");
    expect(enhanced).toContain("> Plans from $0 to $1M in revenue.");
    expect(enhanced).toContain("- [The $` Team](https://foo.com/team): Costs $0. Worth $'.");
  });

  it("produces a spec-valid document for every edit it accepts", async () => {
    mockPlan({
      siteTitle: "Foo",
      siteIntro: "Foo is a dashboard and an API.",
      sectionLabels: { Team: "People" },
      pageEdits: { "https://foo.com/team": { description: null } },
      optionalUrls: ["https://foo.com/team"],
    });

    const result = buildResult();
    const { llmsTxt: enhanced } = await enhanceLlmsTxt(result, buildLlmsTxt(result));
    const issues = validateLlmsTxt(enhanced);
    expect(issues, `${formatIssues(issues)}\n\n${enhanced}`).toEqual([]);
  });
});
