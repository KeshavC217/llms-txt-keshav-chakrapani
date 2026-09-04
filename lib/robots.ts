/**
 * A minimal robots.txt matcher — enough to be a polite crawler against
 * third-party sites without pulling in a dependency.
 *
 * Scope, deliberately: only `Disallow`/`Allow` path rules from the groups
 * that apply to us (our own token, else `*`), matched with the longest-rule-
 * wins precedence the REP draft specifies, with `*` and `$` wildcards. Not
 * handled: `Crawl-delay` (we crawl at most ~20 pages once, so pacing isn't
 * meaningful) and cross-host rules (we only ever crawl one origin).
 *
 * Applied to DISCOVERED links only, never to the URL the user typed: someone
 * generating an llms.txt for their own site shouldn't be refused because the
 * site blanket-disallows unknown agents, but we also shouldn't go spidering
 * paths the operator asked crawlers to stay out of.
 */

export interface RobotsRules {
  rules: { allow: boolean; pattern: string }[];
  sitemaps: string[];
}

export const EMPTY_ROBOTS: RobotsRules = { rules: [], sitemaps: [] };

export function parseRobotsTxt(text: string, userAgentToken: string): RobotsRules {
  const sitemaps: string[] = [];
  const groups = new Map<string, { allow: boolean; pattern: string }[]>();

  let activeAgents: string[] = [];
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }

    if (field === "user-agent") {
      // Consecutive User-agent lines share one group of rules.
      if (!lastLineWasAgent) activeAgents = [];
      activeAgents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    if (field !== "allow" && field !== "disallow") continue;
    if (activeAgents.length === 0) continue;

    for (const agent of activeAgents) {
      if (!groups.has(agent)) groups.set(agent, []);
      // An empty Disallow value means "allow everything" — not a rule.
      if (field === "disallow" && value === "") continue;
      groups.get(agent)!.push({ allow: field === "allow", pattern: value });
    }
  }

  const token = userAgentToken.toLowerCase();
  const rules = groups.get(token) ?? groups.get("*") ?? [];
  return { rules, sitemaps };
}

function matchLength(pattern: string, path: string): number {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const regex = new RegExp(
    "^" +
      body
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      (anchored ? "$" : "")
  );

  return regex.test(path) ? body.length : -1;
}

/** Whether robots.txt permits fetching this path. Longest matching rule wins; ties go to Allow. */
export function isAllowedByRobots(rules: RobotsRules, pathWithQuery: string): boolean {
  let best: { allow: boolean; length: number } | null = null;

  for (const rule of rules.rules) {
    const length = matchLength(rule.pattern, pathWithQuery);
    if (length < 0) continue;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }

  return best ? best.allow : true;
}
