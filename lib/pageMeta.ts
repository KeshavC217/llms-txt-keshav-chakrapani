/**
 * What one page says about itself.
 *
 * The single-page generator had to guess: it named a page from its slug and
 * borrowed a description from whatever text sat near the link. A crawler can
 * simply ask the page, and this is the asking - the difference between calling
 * something "Sso" and calling it "Single Sign-On (SSO)".
 */

import { type ElementNode, cleanText, parseHtml, walk } from "./dom.ts";
import { stripBrandSuffix } from "./nlp.ts";

export interface PageMeta {
  url: string;
  title: string;
  description?: string;
  /** Same-site hrefs, unresolved; the frontier decides what to do with them. */
  links: string[];
}

/** Content of the first <meta> matching any of these names or properties. */
export function metaContent(root: ElementNode, names: string[]): string | undefined {
  for (const name of names) {
    for (const element of walk(root)) {
      if (element.tag !== "meta") continue;

      const key = (element.attrs.name ?? element.attrs.property ?? "").toLowerCase();
      const content = element.attrs.content?.trim();
      if (key === name && content) return content.replace(/\s+/g, " ");
    }
  }
  return undefined;
}

export function firstText(root: ElementNode, tag: string): string | undefined {
  for (const element of walk(root)) {
    if (element.tag !== tag) continue;
    const text = cleanText(element);
    if (text) return text;
  }
  return undefined;
}

/** href of the first <link> carrying every one of the given attributes. */
export function linkRel(root: ElementNode, rel: string, type?: string): string | undefined {
  for (const element of walk(root)) {
    if (element.tag !== "link") continue;

    const rels = (element.attrs.rel ?? "").toLowerCase().split(/\s+/);
    if (!rels.includes(rel)) continue;
    if (type && (element.attrs.type ?? "").toLowerCase() !== type) continue;
    if (element.attrs.href) return element.attrs.href;
  }
  return undefined;
}

/**
 * Reads one crawled page.
 *
 * The canonical URL is preferred when the page declares one, which collapses
 * the `?ref=` and `?utm_source=` variants of a page into the single address the
 * site considers real.
 */
export function readPage(html: string, url: string, brand?: string): PageMeta {
  const root = parseHtml(html);

  const canonical = (() => {
    const declared = linkRel(root, "canonical");
    if (!declared) return url;
    try {
      const resolved = new URL(declared, url);
      // Only trusted within the same site: a canonical pointing elsewhere is
      // the page saying it is a copy, and following it would leave the crawl.
      return resolved.host === new URL(url).host ? resolved.toString() : url;
    } catch {
      return url;
    }
  })();

  const rawTitle = metaContent(root, ["og:title"]) ?? firstText(root, "title") ?? firstText(root, "h1") ?? "";
  const description = metaContent(root, ["description", "og:description", "twitter:description"]);

  const links: string[] = [];
  for (const anchor of walk(root)) {
    if (anchor.tag === "a" && anchor.attrs.href) links.push(anchor.attrs.href);
  }

  return {
    url: canonical,
    // Every page on a site carries the brand in its title; the page's own name
    // is what is left once that is removed.
    title: stripBrandSuffix(rawTitle, brand).trim(),
    description,
    links,
  };
}
