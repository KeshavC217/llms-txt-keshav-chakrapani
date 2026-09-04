import { describe, expect, it } from "vitest";
import { validateLlmsTxt } from "../../lib/validate";

const codes = (text: string) => validateLlmsTxt(text).map((i) => i.code);

const VALID = `# Acme

> Acme is widget infrastructure for teams that ship every day.

Acme has three parts: a pipeline, a scheduler, and a dashboard.

## Docs

- [Getting Started](https://acme.test/docs/getting-started): Install Acme and ship a widget.
- [Configuration](https://acme.test/docs/config)

## Optional

- [Changelog](https://acme.test/changelog): Every release, newest first.
`;

describe("validateLlmsTxt", () => {
  it("accepts a well-formed document", () => {
    expect(validateLlmsTxt(VALID)).toEqual([]);
  });

  it("requires a single '# Title' as the first content line", () => {
    expect(codes("## Docs\n\n- [A](https://a.test)\n")).toContain("missing-h1");
    expect(codes("Intro text\n\n# Acme\n\n## Docs\n\n- [A](https://a.test)\n")).toContain("h1-not-first");
    expect(codes("# Acme\n\n# Also Acme\n\n## Docs\n\n- [A](https://a.test)\n")).toContain("multiple-h1");
    expect(codes("#  \n\n## Docs\n\n- [A](https://a.test)\n")).toContain("empty-h1");
  });

  it("rejects link lines that aren't '- [Name](url)'", () => {
    expect(codes("# A\n\n## S\n\n- https://a.test\n")).toContain("malformed-link");
    expect(codes("# A\n\n## S\n\n- [Name] (https://a.test)\n")).toContain("malformed-link");
    expect(codes("# A\n\n## S\n\n- [](https://a.test)\n")).toContain("empty-link-name");
    expect(codes("# A\n\n## S\n\n- [Name](https://a.test): \n")).toContain("empty-notes");
  });

  it("rejects relative and non-http URLs", () => {
    expect(codes("# A\n\n## S\n\n- [Name](/docs)\n")).toContain("invalid-url");
    expect(codes("# A\n\n## S\n\n- [Name](ftp://a.test/x)\n")).toContain("invalid-url");
  });

  it("catches structural mistakes the AI pass could introduce", () => {
    // A page moved into "## Optional" without pruning the section it left.
    expect(codes("# A\n\n## Empty\n\n## Optional\n\n- [X](https://a.test/x)\n")).toContain("empty-section");
    // The same page listed under two sections.
    expect(codes("# A\n\n## S1\n\n- [X](https://a.test/x)\n\n## S2\n\n- [X](https://a.test/x)\n")).toContain(
      "duplicate-url"
    );
    expect(codes("# A\n\n## Docs\n\n- [X](https://a.test/x)\n\n## docs\n\n- [Y](https://a.test/y)\n")).toContain(
      "duplicate-section"
    );
    expect(codes("# A\n\n- [X](https://a.test/x)\n")).toContain("link-outside-section");
    expect(codes("# A\n\n### Too Deep\n\n## S\n\n- [X](https://a.test/x)\n")).toContain("deep-heading");
  });

  it("flags a document with no links at all", () => {
    expect(codes("# A\n\n> Summary.\n")).toContain("no-links");
  });

  it("reports the offending line number", () => {
    const issue = validateLlmsTxt("# A\n\n## S\n\n- broken\n").find((i) => i.code === "malformed-link");
    expect(issue?.line).toBe(5);
  });
});
