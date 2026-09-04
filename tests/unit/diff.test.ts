import { describe, expect, it } from "vitest";
import { diffLlmsTxt, isEmptyDiff, summarizeDiff } from "../../lib/diff";
import { parseLlmsTxt } from "../../lib/parse";

const BASE = `# Acme

> Acme is widget infrastructure.

## Docs

- [Getting Started](https://acme.test/docs/start): Install Acme.
- [Configuration](https://acme.test/docs/config)

## Pricing

- [Pricing](https://acme.test/pricing): Per-seat pricing.
`;

describe("parseLlmsTxt", () => {
  it("pulls out the title, summary, sections and links", () => {
    const parsed = parseLlmsTxt(BASE);
    expect(parsed.title).toBe("Acme");
    expect(parsed.summary).toBe("Acme is widget infrastructure.");
    expect(parsed.sections.map((s) => s.name)).toEqual(["Docs", "Pricing"]);
    expect(parsed.sections[0].links[0]).toEqual({
      name: "Getting Started",
      url: "https://acme.test/docs/start",
      notes: "Install Acme.",
    });
    expect(parsed.sections[0].links[1].notes).toBeUndefined();
  });

  it("keeps a link that appears before any heading rather than dropping content", () => {
    const parsed = parseLlmsTxt("# A\n\n- [X](https://a.test/x)\n");
    expect(parsed.sections[0].links).toHaveLength(1);
  });

  it("captures free-form intro prose without mistaking it for a link", () => {
    const parsed = parseLlmsTxt("# A\n\n> Summary.\n\nAcme has two parts.\n\n## S\n\n- [X](https://a.test/x)\n");
    expect(parsed.intro).toBe("Acme has two parts.");
  });
});

describe("diffLlmsTxt", () => {
  it("reports nothing for an identical document", () => {
    const diff = diffLlmsTxt(BASE, BASE);
    expect(isEmptyDiff(diff)).toBe(true);
    expect(summarizeDiff(diff)).toBe("no changes");
  });

  it("does not report a change when a section is merely reordered", () => {
    // The whole reason to diff structure rather than text: reordering
    // rewrites every line, and a monitoring system that cries wolf on that
    // gets muted.
    const reordered = `# Acme

> Acme is widget infrastructure.

## Pricing

- [Pricing](https://acme.test/pricing): Per-seat pricing.

## Docs

- [Getting Started](https://acme.test/docs/start): Install Acme.
- [Configuration](https://acme.test/docs/config)
`;
    expect(BASE).not.toBe(reordered);
    expect(isEmptyDiff(diffLlmsTxt(BASE, reordered))).toBe(true);
  });

  it("detects added and removed pages", () => {
    const next = BASE.replace(
      "- [Configuration](https://acme.test/docs/config)\n",
      "- [API](https://acme.test/docs/api): The HTTP API.\n"
    );
    const diff = diffLlmsTxt(BASE, next);
    expect(diff.pagesAdded).toEqual(["https://acme.test/docs/api"]);
    expect(diff.pagesRemoved).toEqual(["https://acme.test/docs/config"]);
    expect(summarizeDiff(diff)).toBe("1 page added, 1 page removed");
  });

  it("detects a reworded title and a changed description separately", () => {
    const next = BASE.replace("[Getting Started](https://acme.test/docs/start): Install Acme.", "[Quickstart](https://acme.test/docs/start): Install Acme in five minutes.");
    const diff = diffLlmsTxt(BASE, next);
    expect(diff.titlesChanged).toEqual([{ url: "https://acme.test/docs/start", from: "Getting Started", to: "Quickstart" }]);
    expect(diff.descriptionsChanged[0].to).toBe("Install Acme in five minutes.");
    expect(diff.pagesAdded).toEqual([]);
  });

  it("detects a page moving between sections without counting it as add+remove", () => {
    const next = `# Acme

> Acme is widget infrastructure.

## Docs

- [Getting Started](https://acme.test/docs/start): Install Acme.

## Pricing

- [Pricing](https://acme.test/pricing): Per-seat pricing.
- [Configuration](https://acme.test/docs/config)
`;
    const diff = diffLlmsTxt(BASE, next);
    expect(diff.pagesAdded).toEqual([]);
    expect(diff.pagesRemoved).toEqual([]);
    expect(diff.pagesMovedSection).toEqual([
      { url: "https://acme.test/docs/config", fromSection: "Docs", toSection: "Pricing" },
    ]);
  });

  it("detects section, title and summary changes", () => {
    const next = BASE.replace("## Pricing", "## Plans").replace("# Acme", "# Acme Inc").replace("> Acme is widget infrastructure.", "> Acme builds widget pipelines.");
    const diff = diffLlmsTxt(BASE, next);
    expect(diff.sectionsAdded).toEqual(["Plans"]);
    expect(diff.sectionsRemoved).toEqual(["Pricing"]);
    expect(diff.titleChanged).toEqual({ from: "Acme", to: "Acme Inc" });
    expect(diff.summaryChanged?.to).toBe("Acme builds widget pipelines.");
  });

  it("summarizes plural counts correctly", () => {
    const next = BASE.replace("## Docs\n", "## Docs\n\n- [A](https://acme.test/a)\n- [B](https://acme.test/b)\n");
    expect(summarizeDiff(diffLlmsTxt(BASE, next))).toBe("2 pages added");
  });
});
