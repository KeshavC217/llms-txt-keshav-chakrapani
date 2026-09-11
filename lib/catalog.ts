/**
 * The catalog: how a stored site is written down, and how a person finds one.
 *
 * Filtering is client-side and stays that way while the list is one page of
 * rows the server already sent. A round trip per keystroke would buy nothing -
 * there is no information here the browser lacks - and would cost the pause
 * that makes a filter feel like a search box instead of a filter.
 */

/** The address as a person would say it: no scheme, no trailing slash. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * Whether a site answers to what has been typed.
 *
 * Matched against the address as displayed rather than as stored, because
 * that is what someone is reading when they type: "docs.c" should find
 * docs.convex.dev, and nobody types the scheme. Terms are matched
 * independently and in any order, so "docs convex" and "convex docs" both
 * work - one substring would make the second find nothing, which reads as a
 * bug rather than as a rule.
 */
export function matchesAddress(url: string, query: string): boolean {
  const haystack = displayUrl(url).toLowerCase();
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  return terms.every((term) => haystack.includes(term));
}
