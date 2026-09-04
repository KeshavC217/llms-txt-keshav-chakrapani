/**
 * Shared measurement helpers for the evals.
 *
 * Everything here is objective — no LLM judgment. These are the numbers that
 * can gate a build: whether a URL resolves, and how much of a site's own
 * published llms.txt we independently rediscovered.
 */

/** Runs `fn` over `items` with at most `limit` in flight, preserving output order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const EVAL_USER_AGENT = "llms-txt-generator-tests/0.1 (+https://llmstxt.org)";
const DEFAULT_TIMEOUT_MS = 8000;

export interface DirectoryEntry {
  homepage: string;
  llmsTxtUrl: string;
}

export async function fetchText(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": EVAL_USER_AGENT },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** The directory lists each entry as a homepage link followed by its /llms.txt (and sometimes /llms-full.txt) link. */
/**
 * Whether a directory entry's llms.txt lives on the same host as the homepage
 * it is paired with. 109 of 1558 entries do not: pinecone.io is listed with
 * docs.pinecone.io/llms.txt, hyperliquid.xyz with a gitbook.io URL, and at
 * least one pairing is simply wrong data. Crawling one host and scoring
 * against another host's index measures nothing, so those entries are
 * excluded from a recall cohort rather than counted as 0%.
 */
export function isSameHostEntry(entry: DirectoryEntry): boolean {
  try {
    const host = (u: string) => new URL(u).host.toLowerCase().replace(/^www\./, "");
    return host(entry.homepage) === host(entry.llmsTxtUrl);
  } catch {
    return false;
  }
}

export function parseDirectory(html: string): DirectoryEntry[] {
  const hrefs = Array.from(html.matchAll(/<a\s[^>]*href="([^"]+)"/g)).map((m) => m[1]);

  const entries: DirectoryEntry[] = [];
  let currentHomepage: string | null = null;

  for (const href of hrefs) {
    if (!/^https?:\/\//.test(href)) continue;

    if (/\/llms\.txt\/?$/i.test(href)) {
      if (currentHomepage && !entries.some((e) => e.homepage === currentHomepage)) {
        entries.push({ homepage: currentHomepage, llmsTxtUrl: href });
      }
    } else if (!/\/llms-full\.txt\/?$/i.test(href)) {
      currentHomepage = href;
    }
  }

  return entries;
}

export function extractUrls(llmsTxt: string): string[] {
  return Array.from(llmsTxt.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)).map((m) => m[1].replace(/\/$/, ""));
}

export function extractHeaders(llmsTxt: string): string[] {
  return Array.from(llmsTxt.matchAll(/^##\s+(.+)$/gm)).map((m) => m[1].trim());
}

/**
 * Reduces a URL to the identity a comparison should use: scheme, "www.", and
 * a trailing slash are not differences in which page is being referenced.
 * Without this the metric is dominated by host cosmetics — we crawl
 * www.zams.com and its own llms.txt writes zams.com, which scored 0% recall
 * on a crawl that had in fact found the pages.
 */
export function urlIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase().replace(/^www\./, "");
    // llms.txt files commonly link the MARKDOWN variant of a page
    // ("/pricing/md/", "/reference/limits.md") rather than the HTML URL a
    // crawler sees. Those name the same page, so treating them as different
    // made pinecone.io score 0% recall on pages we had in fact found.
    const path = parsed.pathname
      .replace(/\.md$/i, "")
      .replace(/\/md\/?$/i, "")
      .replace(/\/$/, "");
    return `${host}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

/** The host part of a urlIdentity, for deciding whether we could ever have crawled it. */
function identityHost(identity: string): string {
  return identity.split("/")[0];
}

export interface RecallResult {
  /** Raw: hits over every URL the reference lists, however unreachable. */
  ratio: number;
  /**
   * Hits over the URLs we could plausibly have found: same host as the pages
   * we crawled, and capped at our own page budget.
   *
   * The raw ratio is unusable as a gate. mpv-gmbh.de's llms.txt lists 11,137
   * URLs against a 100-page crawl budget — its maximum possible recall is
   * 0.9%, so the raw number measures the size of their site, not the quality
   * of our crawl. pinecone.io's lists pages on docs.pinecone.io, a host we
   * deliberately never crawl. Normalizing by what was actually attainable is
   * what makes the number comparable between sites.
   */
  attainableRatio: number;
  referenceCount: number;
  /** Reference URLs on a host we actually crawled. */
  reachableCount: number;
  missed: string[];
}

export function measureRecall(ours: string[], reference: string, pageBudget = Infinity): RecallResult {
  const referenceUrls = Array.from(new Set(extractUrls(reference).map(urlIdentity)));
  if (referenceUrls.length === 0) {
    return { ratio: 0, attainableRatio: 0, referenceCount: 0, reachableCount: 0, missed: [] };
  }

  const ourIdentities = ours.map(urlIdentity);
  const oursSet = new Set(ourIdentities);
  const ourHosts = new Set(ourIdentities.map(identityHost));

  const reachable = referenceUrls.filter((u) => ourHosts.has(identityHost(u)));
  const missed: string[] = [];
  let hits = 0;
  let reachableHits = 0;

  for (const url of referenceUrls) {
    if (oursSet.has(url)) hits++;
    else missed.push(url);
  }
  for (const url of reachable) if (oursSet.has(url)) reachableHits++;

  const attainableDenominator = Math.max(1, Math.min(reachable.length, pageBudget));
  return {
    ratio: hits / referenceUrls.length,
    attainableRatio: Math.min(1, reachableHits / attainableDenominator),
    referenceCount: referenceUrls.length,
    reachableCount: reachable.length,
    missed,
  };
}

// Statuses that mean "the server declined to answer right now", not "this
// page does not exist". Hammering one host with 100 parallel HEADs makes it
// shed load, and counting that as a dead link had the eval manufacturing a
// 74%-dead-link result for a site whose pages all return 200 when asked
// politely — a false accusation against the code under test.
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const LIVENESS_CONCURRENCY = 6;

/**
 * HEAD each URL (falling back to a ranged GET, which some CDNs prefer) and
 * report the fraction that resolve. Bounded concurrency, because every URL
 * here points at the same host by construction.
 */
export async function measureLinkLiveness(
  urls: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<{ ratio: number; dead: string[]; checked: number; transient: number }> {
  const dead: string[] = [];
  let checked = 0;
  let transient = 0;

  await mapWithConcurrency(urls, LIVENESS_CONCURRENCY, async (url) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": EVAL_USER_AGENT },
      });
      if (res.status === 405 || res.status === 501) {
        res = await fetch(url, {
          redirect: "follow",
          signal: controller.signal,
          headers: { "User-Agent": EVAL_USER_AGENT, Range: "bytes=0-0" },
        });
      }

      if (TRANSIENT_STATUSES.has(res.status)) {
        transient++;
        return;
      }
      checked++;
      if (res.status >= 400) dead.push(`${url} -> HTTP ${res.status}`);
    } catch {
      // Network error: could equally be the runner's own connectivity, so it
      // counts neither for nor against the ratio.
    } finally {
      clearTimeout(timeout);
    }
  });

  // `checked` is reported so a caller can tell "every link resolved" apart
  // from "no link could be verified at all" — a host that refuses HEAD from
  // our user agent used to be indistinguishable from a perfect score.
  return { ratio: checked === 0 ? 1 : (checked - dead.length) / checked, dead, checked, transient };
}

/**
 * Deterministic shuffle (mulberry32). A corpus eval has to draw the SAME
 * cohort every run or its aggregate numbers can't be compared across commits
 * — a score that moved because the sample changed tells you nothing.
 */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}


export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
