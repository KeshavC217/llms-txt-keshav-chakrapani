/**
 * robots.txt: what a site has said about being crawled.
 *
 * Not a formality. Every site sampled while planning this had one, and the
 * rules were real - 96 Disallow lines on bbc.co.uk, 31 on modal.com. A crawler
 * that ignores them is not merely impolite, it wastes its budget fetching
 * pages the site has already said are not worth having.
 *
 * The format is de facto rather than standardised, so this follows the
 * behaviour Google documents: group records by user-agent, prefer the most
 * specific group that matches us, and within a group let the longest matching
 * rule win, with Allow beating Disallow on an exact tie.
 */

const FETCH_TIMEOUT_MS = 8_000;

export interface Rule {
  allow: boolean;
  path: string;
}

export interface Robots {
  rules: Rule[];
  /** Sitemap: lines, which are global rather than per group. */
  sitemaps: string[];
  /** Crawl-delay in ms for our group, when one is stated. */
  crawlDelayMs?: number;
}

export const ALLOW_ALL: Robots = { rules: [], sitemaps: [] };

/**
 * Parses for one agent. Groups are keyed by User-agent lines, and consecutive
 * User-agent lines share the group that follows them.
 */
export function parseRobots(text: string, agent = "llms-txt-generator"): Robots {
  const lowerAgent = agent.toLowerCase();
  const sitemaps: string[] = [];

  // Collected per group name so the most specific match can be chosen after
  // the whole file has been read.
  const groups = new Map<string, { rules: Rule[]; crawlDelayMs?: number }>();
  let current: string[] = [];
  let expectingAgents = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "sitemap") {
      sitemaps.push(value);
      continue;
    }

    if (field === "user-agent") {
      // A User-agent line after rules starts a new group; one directly after
      // another User-agent line joins the same group.
      if (!expectingAgents) current = [];
      current.push(value.toLowerCase());
      expectingAgents = true;
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), { rules: [] });
      continue;
    }

    expectingAgents = false;
    if (current.length === 0) continue;

    for (const name of current) {
      const group = groups.get(name)!;
      if (field === "allow" || field === "disallow") {
        // "Disallow:" with no value is the documented way to allow everything,
        // and must not be read as "disallow /".
        if (field === "disallow" && !value) continue;
        group.rules.push({ allow: field === "allow", path: value });
      } else if (field === "crawl-delay") {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) group.crawlDelayMs = Math.min(seconds * 1000, 10_000);
      }
    }
  }

  // Most specific wins: our own name, then any prefix of it a site might use,
  // then the wildcard.
  const named = [...groups.keys()]
    .filter((name) => name !== "*" && (lowerAgent.includes(name) || name.includes(lowerAgent)))
    .sort((a, b) => b.length - a.length)[0];

  const chosen = groups.get(named ?? "*");
  return { rules: chosen?.rules ?? [], sitemaps, crawlDelayMs: chosen?.crawlDelayMs };
}

/** Whether a path may be fetched. Longest match wins; Allow wins a tie. */
export function isAllowed(robots: Robots, pathname: string): boolean {
  let best: Rule | null = null;

  for (const rule of robots.rules) {
    if (!matches(rule.path, pathname)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/** Supports the two wildcards in common use: * for any run, $ for end-of-path. */
function matches(pattern: string, pathname: string): boolean {
  if (!pattern) return false;
  if (!pattern.includes("*") && !pattern.endsWith("$")) return pathname.startsWith(pattern);

  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const expression = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");

  return new RegExp(`^${expression}${anchored ? "$" : ""}`).test(pathname);
}

/**
 * Fetches robots.txt. Anything other than a served file means no restrictions:
 * a 404 is the documented "crawl freely", and a site that errors has not told
 * us to stay out.
 */
export async function fetchRobots(origin: string, userAgent: string): Promise<Robots> {
  try {
    const response = await fetch(new URL("/robots.txt", origin), {
      headers: { "User-Agent": userAgent, Accept: "text/plain,*/*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return ALLOW_ALL;
    return parseRobots(await response.text(), userAgent);
  } catch {
    return ALLOW_ALL;
  }
}
