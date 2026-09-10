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
