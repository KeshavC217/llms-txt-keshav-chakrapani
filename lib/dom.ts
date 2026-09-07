/**
 * A small HTML tree, built because the template's rules are structural and
 * regexes cannot answer structural questions. "Is this nav?" is really "what
 * fraction of this subtree's text sits inside links, and what is it nested in"
 * - both need parents and children, not a match.
 *
 * This is not a spec-compliant parser. It handles the tag soup real pages are
 * made of well enough to measure them, and no more.
 */

export interface ElementNode {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent: ElementNode | null;
}

export type Node = ElementNode | { text: string };

export function isElement(node: Node): node is ElementNode {
  return "tag" in node;
}

/** Elements that never have children, so they never open a scope. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

/** Elements whose content is not markup, and must not be parsed as such. */
const RAW_TEXT = new Set(["script", "style", "template", "svg", "noscript"]);

/**
 * Which tags implicitly close an element that is still open: keyed by the open
 * element, valued by the tags that end it. An open <p> is ended by the next
 * <p> or <div>; an open <li> by the next <li>.
 */
const CLOSED_BY: Record<string, string[]> = {
  p: ["p", "div", "section", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6"],
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr"],
  td: ["td", "th", "tr"],
  th: ["td", "th", "tr"],
  option: ["option"],
};

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([a-z_:][-a-z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/gi)) {
    const value = match[2] ?? "";
    attrs[match[1].toLowerCase()] = decodeEntities(
      value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value,
    );
  }
  return attrs;
}

export function parseHtml(html: string): ElementNode {
  const root: ElementNode = { tag: "#root", attrs: {}, children: [], parent: null };
  let current = root;
  // Comments and doctypes carry nothing we measure, and IE conditionals in
  // them contain markup that would otherwise be parsed as real elements.
  const source = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype[^>]*>/gi, "");

  const tagPattern = /<(\/?)([a-z][a-z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(source)) !== null) {
    const [full, closing, rawTag, rawAttrs, selfClosing] = match;
    const tag = rawTag.toLowerCase();

    if (match.index > cursor) {
      const text = source.slice(cursor, match.index);
      if (text.trim()) current.children.push({ text: decodeEntities(text) });
    }
    cursor = match.index + full.length;

    if (closing) {
      // Close the nearest matching ancestor. An unmatched </div> is noise on a
      // real page, and unwinding to the root over it loses the whole document.
      let node: ElementNode | null = current;
      while (node && node.tag !== tag) node = node.parent;
      if (node?.parent) current = node.parent;
      continue;
    }

    // Read from the open element, not from the tag being opened: <p> inside a
    // <div> opens a child, while <p> after a <p> ends the first one.
    if (current.parent && (CLOSED_BY[current.tag] ?? []).includes(tag)) {
      current = current.parent;
    }

    const element: ElementNode = { tag, attrs: parseAttrs(rawAttrs), children: [], parent: current };
    current.children.push(element);

    if (VOID.has(tag) || selfClosing) continue;

    if (RAW_TEXT.has(tag)) {
      // Skip to the matching close tag without parsing what is between.
      const close = new RegExp(`</${tag}\\s*>`, "i");
      const rest = source.slice(cursor);
      const found = rest.search(close);
      cursor = found === -1 ? source.length : cursor + found + rest.match(close)![0].length;
      tagPattern.lastIndex = cursor;
      continue;
    }

    current = element;
  }

  if (cursor < source.length) {
    const text = source.slice(cursor);
    if (text.trim()) current.children.push({ text: decodeEntities(text) });
  }

  return root;
}

/** Depth-first walk in document order. */
export function* walk(node: ElementNode): Generator<ElementNode> {
  for (const child of node.children) {
    if (isElement(child)) {
      yield child;
      yield* walk(child);
    }
  }
}

export function textOf(node: Node): string {
  if (!isElement(node)) return node.text;
  return node.children.map(textOf).join(" ");
}

/**
 * Collapsed to single spaces - what every comparison below actually wants.
 * Joining children with a space puts one before punctuation too ("<em>ed</em>,"
 * becoming "ed ,"), so that is closed back up.
 */
export function cleanText(node: Node): string {
  return textOf(node)
    // Zero-width characters survive a \s+ collapse and show up as a stray
    // leading space once the string is used as a title.
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?)\]])/g, "$1")
    .replace(/([(\[])\s+/g, "$1")
    .trim();
}

/**
 * Share of this subtree's text that sits inside links. The single most useful
 * signal for telling navigation from prose: a nav is nearly all link text, a
 * paragraph is nearly none.
 */
export function linkDensity(node: ElementNode): number {
  const total = cleanText(node).length;
  if (total === 0) return 1;

  let linked = 0;
  for (const element of walk(node)) {
    if (element.tag === "a") linked += cleanText(element).length;
  }
  return Math.min(linked / total, 1);
}

export function attrsOf(node: ElementNode): string {
  return `${node.attrs.class ?? ""} ${node.attrs.id ?? ""} ${node.attrs.role ?? ""}`.toLowerCase();
}

export function ancestors(node: ElementNode): ElementNode[] {
  const chain: ElementNode[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) chain.push(parent);
  return chain;
}
