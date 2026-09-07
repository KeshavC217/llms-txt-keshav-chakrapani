/**
 * Builds an llms.txt from a single fetched page — nothing else is requested.
 * Everything below comes from the one HTML document we already have in hand:
 * its title and description, the links it points at (the "subpages"), and its
 * own body text dumped underneath.
 */

export interface Subpage {
  url: string;
  label: string;
}

export interface Page {
  title: string;
  description: string | null;
  subpages: Subpage[];
  content: string;
}

const VOID_TEXT_TAGS = /<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAG = /<[^>]+>/g;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Tag soup to plain text: strip markup, decode entities, squash whitespace. */
function plainText(html: string): string {
  return decodeEntities(html.replace(TAG, " ")).replace(/\s+/g, " ").trim();
}

function firstMatch(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const value = plainText(match[1]);
      if (value) return value;
    }
  }
  return null;
}

/** <meta> attribute order isn't fixed, so match name-then-content and the reverse. */
function meta(...names: string[]): RegExp[] {
  return names.flatMap((name) => [
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`, "i"),
  ]);
}

/** Links that are plainly not pages: assets, downloads, feeds. */
const NON_PAGE = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|rss|atom|zip|gz|tgz|pdf|docx?|xlsx?|pptx?|mp[34]|webm|mov|woff2?|ttf|eot)$/i;

/**
 * Same-origin links, in the order the page lists them. Anchor text is the
 * label; where there is none (an icon link, say) the path stands in. The page
 * itself is dropped — it is the document these are subpages of.
 */
function extractSubpages(html: string, baseUrl: string): Subpage[] {
  const base = new URL(baseUrl);
  const found = new Map<string, Subpage>();

  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(match[1].trim()), base);
    } catch {
      continue;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.host !== base.host) continue;
    if (NON_PAGE.test(url.pathname)) continue;

    url.hash = "";
    const key = url.toString();
    if (key === base.toString() || found.has(key)) continue;

    const label = plainText(match[2]) || url.pathname;
    found.set(key, { url: key, label });
  }

  return [...found.values()];
}

/**
 * The page's own text, kept in document order with headings and list items
 * marked so the dump stays readable rather than becoming one long paragraph.
 */
function extractContent(html: string): string {
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;

  return decodeEntities(
    body
      .replace(VOID_TEXT_TAGS, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n\n${"#".repeat(Number(level))} `)
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|header|footer|tr|h[1-6]|li|ul|ol|pre|blockquote)>/gi, "\n\n")
      .replace(TAG, " "),
  )
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    // A bullet with nothing after it is a stripped icon or a wrapper <li>.
    .replace(/^-$\n?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parsePage(html: string, url: string): Page {
  const title =
    firstMatch(html, [
      ...meta("og:title", "twitter:title"),
      /<title[^>]*>([\s\S]*?)<\/title>/i,
      /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    ]) ?? new URL(url).hostname;

  return {
    title,
    description: firstMatch(html, meta("description", "og:description", "twitter:description")),
    subpages: extractSubpages(html, url),
    content: extractContent(html),
  };
}

/** Renders the parsed page as llms.txt: page info, subpages, then the content. */
export function renderLlmsTxt(page: Page, url: string): string {
  const lines = [`# ${page.title}`, ""];

  if (page.description) lines.push(`> ${page.description}`, "");
  lines.push(`Source: ${url}`, "");

  lines.push("## Subpages", "");
  if (page.subpages.length === 0) {
    lines.push("_No links to other pages on this site were found._", "");
  } else {
    for (const subpage of page.subpages) lines.push(`- [${subpage.label}](${subpage.url})`);
    lines.push("");
  }

  lines.push("## Content", "", page.content, "");
  return lines.join("\n");
}

export function buildLlmsTxt(html: string, url: string): string {
  return renderLlmsTxt(parsePage(html, url), url);
}
