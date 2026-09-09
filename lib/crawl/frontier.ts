/**
 * What is worth fetching next, and what has been seen already.
 *
 * Deduplication is the whole job. A site links the same page from every header,
 * with a trailing slash here and a ?ref= there, and a crawler that treats those
 * as different pages spends its budget re-reading one page.
 */

export interface FrontierOptions {
  origin: string;
  /** Only these path prefixes, when given. */
  include?: string[];
  /** Never these path prefixes. */
  exclude?: string[];
  isAllowed: (pathname: string) => boolean;
}

/** Not pages: assets, downloads, feeds. */
const NON_PAGE =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|rss|atom|zip|gz|tgz|pdf|docx?|xlsx?|pptx?|mp[34]|webm|mov|woff2?|ttf|eot)$/i;

/** Query keys that identify the referrer rather than the page. */
const TRACKING = /^(utm_|ref$|referrer$|fbclid$|gclid$|mc_cid$|mc_eid$|source$)/i;

/**
 * One address per page: scheme and host from the origin, tracking parameters
 * dropped, fragment removed, trailing slash and index.html normalised away.
 */
export function canonicalize(href: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (NON_PAGE.test(url.pathname)) return null;

  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
  url.pathname = url.pathname.replace(/\/index\.(html?|php)$/i, "/").replace(/(.)\/$/, "$1");

  return url.toString();
}

export class Frontier {
  private readonly seen = new Set<string>();
  /** One queue per top-level section, so each can be given a turn. */
  private readonly queues = new Map<string, { url: string; depth: number; segments: number }[]>();
  private turn = 0;
  // Declared and assigned rather than written as a constructor parameter
  // property: Node runs these files by stripping types, and a parameter
  // property is not a type to strip - it generates an assignment.
  private readonly options: FrontierOptions;

  constructor(options: FrontierOptions) {
    this.options = options;
  }

  get pending(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  /** Returns true when the URL was new and acceptable. */
  add(href: string, base: string, depth: number): boolean {
    const url = canonicalize(href, base);
    if (!url) return false;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    if (parsed.host !== new URL(this.options.origin).host) return false;
    if (this.seen.has(url)) return false;

    const path = parsed.pathname;
    if (!this.options.isAllowed(path)) return false;
    if (this.options.exclude?.some((prefix) => path.startsWith(prefix))) return false;
    if (this.options.include?.length && !this.options.include.some((prefix) => path.startsWith(prefix))) return false;

    this.seen.add(url);
    const segments = path.split("/").filter(Boolean);
    const section = segments[0] ?? "";

    const queue = this.queues.get(section);
    const item = { url, depth, segments: segments.length };
    if (queue) queue.push(item);
    else this.queues.set(section, [item]);
    return true;
  }

  /**
   * A turn each, by section, shallowest first within a section.
   *
   * Ordering by depth alone starves exactly the pages worth having. On
   * getlago.com the sitemap holds 282 marketing and blog URLs and not one
   * /docs page - documentation is reachable only through links - so taking the
   * shallowest first spends the entire budget on /about-us and /blog before
   * reaching /docs/guide/security/sso, which is four segments deep and the sort
   * of page the file exists to point at.
   *
   * Round-robin instead: every section gets a turn, so a site's documentation
   * is not buried by its blog, and a budget of any size ends up spread across
   * what the site actually contains.
   */
  next(): { url: string; depth: number } | undefined {
    const sections = [...this.queues.keys()];
    if (sections.length === 0) return undefined;

    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[(this.turn + i) % sections.length];
      const queue = this.queues.get(section)!;
      if (queue.length === 0) {
        this.queues.delete(section);
        continue;
      }

      this.turn = (this.turn + i + 1) % Math.max(sections.length, 1);
      let best = 0;
      for (let j = 1; j < queue.length; j += 1) {
        if (queue[j].segments < queue[best].segments) best = j;
      }
      return queue.splice(best, 1)[0];
    }
    return undefined;
  }
}
