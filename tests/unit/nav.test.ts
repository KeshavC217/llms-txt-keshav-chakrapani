import { describe, expect, it } from "vitest";
import { extractNavCategories, navSectionFor } from "../../lib/nav";

describe("extractNavCategories", () => {
  it("extracts a top-level nav item with a dropdown as a category with its member pages", () => {
    const html = `
      <html><body>
        <nav>
          <ul>
            <li><a href="/docs">Docs</a>
              <ul>
                <li><a href="/docs/getting-started">Getting Started</a></li>
                <li><a href="/docs/api">API</a></li>
              </ul>
            </li>
          </ul>
        </nav>
      </body></html>
    `;
    const categories = extractNavCategories(html, "https://foo.com");
    expect(categories).toHaveLength(1);
    expect(categories[0].label).toBe("Docs");
    expect(Array.from(categories[0].hrefs).sort()).toEqual([
      "https://foo.com/docs",
      "https://foo.com/docs/api",
      "https://foo.com/docs/getting-started",
    ]);
  });

  it("records a path prefix for a top-level item with no submenu", () => {
    const html = `
      <html><body>
        <nav><ul><li><a href="/blog">Blog</a></li></ul></nav>
      </body></html>
    `;
    const categories = extractNavCategories(html, "https://foo.com");
    expect(categories[0].pathPrefixes).toEqual(["/blog"]);
  });

  it("skips known noise items (login, cart, language switchers, etc.)", () => {
    const html = `
      <html><body>
        <nav>
          <ul>
            <li><a href="/login">Sign In</a></li>
            <li><a href="/cart">Cart</a></li>
            <li><a href="/no">Norsk</a></li>
            <li><a href="/pricing">Pricing</a></li>
          </ul>
        </nav>
      </body></html>
    `;
    const categories = extractNavCategories(html, "https://foo.com");
    expect(categories.map((c) => c.label)).toEqual(["Pricing"]);
  });

  it("merges the same nav item duplicated with different casing (desktop vs. mobile menu)", () => {
    const html = `
      <html><body>
        <nav id="desktop">
          <ul><li><a href="/culinary">CULINARY</a>
            <ul><li><a href="/culinary/menu">Menu</a></li></ul>
          </li></ul>
        </nav>
        <nav id="mobile">
          <ul><li><a href="/culinary">Culinary</a>
            <ul><li><a href="/culinary/chef">Chef</a></li></ul>
          </li></ul>
        </nav>
      </body></html>
    `;
    const categories = extractNavCategories(html, "https://foo.com");
    expect(categories).toHaveLength(1);
    // Prefers the mixed-case label over the all-caps duplicate.
    expect(categories[0].label).toBe("Culinary");
    expect(Array.from(categories[0].hrefs).sort()).toEqual([
      "https://foo.com/culinary",
      "https://foo.com/culinary/chef",
      "https://foo.com/culinary/menu",
    ]);
  });

  it("inserts spacing so a rich nav card's text doesn't collapse into a run-on label", () => {
    const html = `
      <html><body>
        <nav><ul><li><a href="/careers"><div>Careers</div><div>5</div><p>Shape the future</p></a></li></ul></nav>
      </body></html>
    `;
    const categories = extractNavCategories(html, "https://foo.com");
    expect(categories[0].label).toBe("Careers 5 Shape the future");
  });

  it("ignores cross-origin links inside the nav", () => {
    const html = `
      <html><body>
        <nav><ul><li><a href="https://other.com/x">External</a></li></ul></nav>
      </body></html>
    `;
    expect(extractNavCategories(html, "https://foo.com")).toEqual([]);
  });
});

describe("navSectionFor", () => {
  const categories = [
    {
      label: "Docs",
      hrefs: new Set(["https://foo.com/docs"]),
      pathPrefixes: ["/docs"],
    },
  ];

  it("matches a page linked directly from the nav", () => {
    expect(navSectionFor("https://foo.com/docs", categories)).toBe("Docs");
  });

  it("matches a page nested under a category's path prefix", () => {
    expect(navSectionFor("https://foo.com/docs/getting-started", categories)).toBe("Docs");
  });

  it("returns null for a page outside any category", () => {
    expect(navSectionFor("https://foo.com/pricing", categories)).toBeNull();
  });
});
