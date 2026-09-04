import * as cheerio from "cheerio";
import { textWithSpacing } from "./extract";
import type { NavCategory } from "./types";

const NAV_NOISE_WORDS = new Set([
  "home",
  "login",
  "log in",
  "sign in",
  "sign up",
  "signup",
  "register",
  "cart",
  "search",
  "menu",
  "logout",
  "sign out",
  "account",
  "settings",
  "close",
  "toggle navigation",
  "skip to content",
  "language",
  // Common language-switcher labels (endonyms), which show up as top-level
  // nav items on multilingual sites but aren't a real content category.
  "english",
  "norsk",
  "dansk",
  "svenska",
  "suomi",
  "deutsch",
  "français",
  "francais",
  "español",
  "espanol",
  "italiano",
  "português",
  "portugues",
  "nederlands",
  "polski",
  "русский",
  "中文",
  "日本語",
  "한국어",
  "العربية",
  "ไทย",
  "tiếng việt",
  "türkçe",
]);

function clean(value: string | undefined | null): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Extracts the site's own nav-bar taxonomy: for each top-level nav item that
 * has a dropdown/submenu, the item's text becomes a category label and every
 * link inside the submenu becomes a member page. For a top-level item with
 * no submenu, its own href's path becomes a "path prefix" — any crawled page
 * nested under that path (e.g. /docs/getting-started under a "Docs" -> /docs
 * link) is considered part of that category too.
 *
 * This is deliberately scoped to <nav>/[role=navigation] elements (the site's
 * own header/top-bar menu, and any other elements marked as navigation) since
 * that's the taxonomy the site's authors actually intended readers to use —
 * a much stronger signal than reverse-engineering categories from page text.
 */
export function extractNavCategories(html: string, baseUrl: string): NavCategory[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const categories = new Map<string, NavCategory>();

  $("nav, [role='navigation']").each((_, navEl) => {
    const allLis = $(navEl).find("li").toArray();
    const topLevelLis = allLis.filter((li) => $(li).parentsUntil(navEl, "li").length === 0);

    // Nav markup without <li> wrappers (e.g. plain flexbox <a> links) — treat
    // top-level <a>s directly as flat category anchors.
    const candidates =
      topLevelLis.length > 0
        ? topLevelLis
        : $(navEl)
            .find("a")
            .toArray()
            .filter((a) => $(a).parentsUntil(navEl, "a").length === 0);

    for (const el of candidates) {
      const $el = $(el);
      const directLink = $el.is("a") ? $el : $el.children("a").first();
      const labelSource = directLink.length ? directLink : $el.find("a").first();
      const label = labelSource.length ? clean(textWithSpacing($, labelSource.get(0)!)) : "";

      if (!label || NAV_NOISE_WORDS.has(label.toLowerCase()) || label.length > 40) continue;

      const descendantLinks = ($el.is("a") ? $el : $el.find("a")).toArray();
      const hrefs = new Set<string>();
      let pathPrefix: string | null = null;

      descendantLinks.forEach((a, idx) => {
        const href = $(a).attr("href");
        if (!href) return;

        let resolved: URL;
        try {
          resolved = new URL(href, base);
        } catch {
          return;
        }
        if (resolved.origin !== base.origin) return;

        resolved.hash = "";
        const normalized = resolved.toString().replace(/\/$/, "");
        hrefs.add(normalized);

        if (idx === 0 && resolved.pathname && resolved.pathname !== "/") {
          pathPrefix = resolved.pathname.replace(/\/$/, "");
        }
      });

      if (hrefs.size === 0) continue;

      // Key case-insensitively: the same nav item often appears twice in the
      // markup (desktop nav + a duplicated mobile-menu nav) with different
      // casing (e.g. an all-caps "CULINARY" alongside "Culinary"), which
      // would otherwise fork into two separate sections in the output.
      const key = label.toLowerCase();
      const existing = categories.get(key) ?? { label, hrefs: new Set<string>(), pathPrefixes: [] };
      // Prefer a mixed-case label over an all-caps one — all-caps here is
      // almost always a CSS text-transform artifact rather than real casing.
      if (/[a-z]/.test(label) && !/[a-z]/.test(existing.label)) {
        existing.label = label;
      }
      hrefs.forEach((h) => existing.hrefs.add(h));
      if (pathPrefix && !existing.pathPrefixes.includes(pathPrefix)) {
        existing.pathPrefixes.push(pathPrefix);
      }
      categories.set(key, existing);
    }
  });

  return Array.from(categories.values());
}

/** Finds which nav category (if any) a page belongs to, by direct link or path prefix. */
export function navSectionFor(pageUrl: string, categories: NavCategory[]): string | null {
  const normalized = pageUrl.replace(/\/$/, "");

  for (const category of categories) {
    if (category.hrefs.has(normalized)) return category.label;
  }

  let pathname: string;
  try {
    pathname = new URL(pageUrl).pathname.replace(/\/$/, "");
  } catch {
    return null;
  }

  for (const category of categories) {
    for (const prefix of category.pathPrefixes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return category.label;
    }
  }

  return null;
}
