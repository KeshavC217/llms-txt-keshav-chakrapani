import { describe, expect, it } from "vitest";
import { extractInternalLinks, extractMetadata, isPlaceholderTitle } from "../../lib/extract";

describe("extractMetadata", () => {
  it("prefers <title>, then meta description", () => {
    const html = `
      <html><head>
        <title>Foo — Home</title>
        <meta name="description" content="  The foo product.  " />
      </head><body></body></html>
    `;
    const meta = extractMetadata(html, "https://foo.com");
    expect(meta.title).toBe("Foo — Home");
    expect(meta.description).toBe("The foo product.");
  });

  it("falls back to og:description when no meta description is present", () => {
    const html = `
      <html><head>
        <title>Foo</title>
        <meta property="og:description" content="OG description here" />
      </head><body></body></html>
    `;
    const meta = extractMetadata(html, "https://foo.com");
    expect(meta.description).toBe("OG description here");
  });

  it("falls back to <h1> when there is no <title>", () => {
    const html = `<html><body><h1>Page Heading</h1></body></html>`;
    const meta = extractMetadata(html, "https://foo.com");
    expect(meta.title).toBe("Page Heading");
  });

  it("inserts spacing between adjacent elements in the title fallback", () => {
    // Regression test for the "Careers5Shape the future with us" bug: adjacent
    // block elements with no whitespace text node between them must not
    // collapse into one run-on word once tags are stripped.
    const html = `<html><body><h1><div>Careers</div><div>5</div><p>Shape the future with us</p></h1></body></html>`;
    const meta = extractMetadata(html, "https://foo.com");
    expect(meta.title).toBe("Careers 5 Shape the future with us");
  });

  it("falls back to the URL when there is no title or h1", () => {
    const meta = extractMetadata("<html><body></body></html>", "https://foo.com/bar");
    expect(meta.title).toBe("https://foo.com/bar");
  });

  it("falls back to the first substantive prose sentence in the body", () => {
    const html = `
      <html><body>
        <main>
          <p>Buy Now</p>
          <p>Welcome to Foo, a company that builds delightful tools for people who write software every day.</p>
        </main>
      </body></html>
    `;
    const meta = extractMetadata(html, "https://foo.com");
    expect(meta.description).toContain("Welcome to Foo");
  });

  it("skips prose found inside nav/header/footer chrome", () => {
    const html = `
      <html><body>
        <nav><p>This is a decently long piece of nav text that reads like real prose content here.</p></nav>
        <main><p>Actual content sentence describing what this company does for its customers today.</p></main>
      </body></html>
    `;
    const meta = extractMetadata(html, "https://foo.com");
    expect(meta.description).toContain("Actual content sentence");
  });
});

describe("isPlaceholderTitle", () => {
  it.each(["Loading...", "loading", "Redirecting...", "Please Wait", "Just a moment..."])(
    "treats %j as a placeholder",
    (title) => {
      expect(isPlaceholderTitle(title)).toBe(true);
    }
  );

  it.each(["Home", "Loading Docks — Foo Corp", "About Us"])("does not treat %j as a placeholder", (title) => {
    expect(isPlaceholderTitle(title)).toBe(false);
  });
});

describe("extractInternalLinks", () => {
  it("extracts and normalizes same-origin links, deduping trailing slashes", () => {
    const html = `
      <html><body>
        <a href="/about">About</a>
        <a href="/about/">About with slash</a>
        <a href="https://foo.com/pricing">Pricing</a>
      </body></html>
    `;
    const links = extractInternalLinks(html, "https://foo.com");
    expect(links.sort()).toEqual(["https://foo.com/about", "https://foo.com/pricing"]);
  });

  it("excludes cross-origin links, hashes, mailto, and javascript hrefs", () => {
    const html = `
      <html><body>
        <a href="https://other.com/page">Other</a>
        <a href="#section">Anchor</a>
        <a href="mailto:hi@foo.com">Email</a>
        <a href="javascript:void(0)">JS</a>
        <a href="tel:+1234567890">Phone</a>
      </body></html>
    `;
    expect(extractInternalLinks(html, "https://foo.com")).toEqual([]);
  });

  it("resolves relative hrefs against the base URL", () => {
    const html = `<html><body><a href="pricing">Pricing</a></body></html>`;
    const links = extractInternalLinks(html, "https://foo.com/products/");
    expect(links).toEqual(["https://foo.com/products/pricing"]);
  });
});
