/**
 * One address per page.
 *
 * Deduplication is the whole job. A site links the same page from every header,
 * with a trailing slash here and a ?ref= there, and a crawler that treats those
 * as different pages spends its budget re-reading one page.
 */

/** Not pages: assets, downloads, feeds. */
const NON_PAGE =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|rss|atom|zip|gz|tgz|pdf|docx?|xlsx?|pptx?|mp[34]|webm|mov|woff2?|ttf|eot)$/i;

/**
 * Query keys that identify the referrer rather than the page.
 *
 * Two shapes, because ad platforms write both. A vendor prefixes its whole
 * family - `utm_` (Urchin, which everyone inherited), `hsa_`/`hstk_`
 * (HubSpot), `gad_` (Google Ads), `vector_` (Profound's own campaign tags,
 * which is where this was noticed) - or it drops a single opaque click id.
 *
 * The suffix rule catches the families nobody has heard of yet: a key ending
 * `_source`, `_medium`, `_campaign`, `_term` or `_content` is a UTM field
 * wearing a different prefix, whoever minted it.
 *
 * What is deliberately not here is anything that could name a page. `?id=`,
 * `?page=`, `?q=` and `?title=` stay, because dropping one would send us to a
 * different page than the link pointed at - en.wikipedia.org addresses every
 * article as /w/index.php?title=X.
 */
const TRACKING =
  /^(utm_|hsa_|hstk_|gad_|vector_|_hs|ref$|referrer$|source$|fbclid$|gclid$|dclid$|gbraid$|wbraid$|msclkid$|twclid$|ttclid$|igshid$|yclid$|epik$|mc_cid$|mc_eid$|s_kwcid$|li_fat_id$|.*_(source|medium|campaign|term|content)$)/i;

/**
 * Drops the keys above, in place.
 *
 * Exported because the address a person pastes needs the same treatment as
 * one found in a link - it is the same page, and it becomes the key the file
 * is stored under. See normalizeUrl in lib/fetchPage.ts.
 */
export function stripTracking(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
}

/**
 * Queries that ask for something to be done to a page, rather than for a page.
 *
 * Thirteen of the fifty-two links generated for en.wikipedia.org were these:
 * "Revision history", "Printable version", "Mobile view", "Switch to legacy
 * parser", "Get shortened URL". They are operations on the page you are
 * already looking at, and an llms.txt exists to tell an agent what a site
 * contains - never to point it at an edit form.
 *
 * `action` is matched on its value rather than its presence, because plenty of
 * sites use ?action= for ordinary content and only these values mean an
 * operation.
 */
const OPERATION_KEY = /^(printable|mobileaction|veaction|redlink|useparsoid|diff|oldid|replytoc)$/i;
const OPERATION_ACTION = /^(edit|history|info|raw|purge|delete|watch|unwatch|render|submit|rollback|revert|credits)$/i;

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
    if (OPERATION_KEY.test(key)) return null;
    if (/^action$/i.test(key) && OPERATION_ACTION.test(url.searchParams.get(key) ?? "")) return null;
  }
  stripTracking(url);

  /*
   * `/docs/index.html` is a directory index and the directory is the better
   * address for it. `/w/index.php?title=X` is a program being called, and
   * stripping the script name invents an address we never fetched - which is
   * what we were emitting for Wikipedia, alongside the correct form of the
   * same page, so one page appeared twice under two spellings.
   */
  if (url.search === "") {
    url.pathname = url.pathname.replace(/\/index\.(html?|php)$/i, "/");
  }
  url.pathname = url.pathname.replace(/(.)\/$/, "$1");

  return url.toString();
}
