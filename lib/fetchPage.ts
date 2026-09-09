/**
 * Fetching a user-supplied URL, safely, in one place.
 *
 * Lifted out of the generate route unchanged when a second endpoint needed the
 * same behaviour. The guard in particular is not something to have two of.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { type Block, detectBlock } from "./blocks.ts";

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
  isHtml: boolean;
  /** Set when the response is the site refusing us rather than the page. */
  block?: Block;
  /** True when the page only came back after asking as a browser would. */
  usedBrowserIdentity?: boolean;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;
const USER_AGENT = "llms-txt-generator/0.1 (+https://llmstxt.org)";

/**
 * A second identity, used only after a site has refused the first.
 *
 * We say who we are to begin with, which is the courteous order and the one
 * that lets a site allow us deliberately. Some filters reject any agent they do
 * not recognise without looking further - zillow.com answers 403 to ours and
 * 200 to this one, for the same page - and for those, asking again as a browser
 * is the difference between a result and nothing. Set FETCH_IDENTIFY_ONLY=1 to
 * never take the second step.
 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Sent on both attempts. These describe what we can accept rather than
 * claiming to be anything, and some CDNs reject a request that omits them.
 */
const COMMON_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Adds https:// when the user omits it, and rejects anything that isn't http(s). */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // An unsupported scheme has to be rejected rather than defaulted: prefixing
  // "https://" onto "ftp://example.com" yields "https://ftp://example.com",
  // which URL happily parses with the host "ftp".
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !/^https?$/i.test(scheme[1])) return null;

  try {
    const url = new URL(scheme ? trimmed : `https://${trimmed}`);
    return /^https?:$/.test(url.protocol) && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    // ::1 loopback, fc00::/7 unique-local, fe80::/10 link-local.
    if (v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8")) return true;
    // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 costume.
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }

  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || // this-network, private, loopback
    (a === 169 && b === 254) || // link-local, incl. cloud instance metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  );
}

/**
 * Refuses URLs that resolve to a non-public address.
 *
 * This is the one thing carried over from the previous implementation, and it
 * is here because the endpoint fetches a user-supplied URL server-side and
 * returns the body — without a check, anyone could point the deployed app at
 * http://169.254.169.254/ or an internal service and read the response. The
 * final URL is re-checked after redirects, since a public URL can 302 into
 * the private range.
 */
async function assertPublicUrl(url: string): Promise<void> {
  const { hostname } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, "");

  if (process.env.ALLOW_PRIVATE_CRAWL_TARGETS === "1") return;
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("That host isn't publicly reachable, so it can't be fetched.");
  }

  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => null);
  if (!addresses || addresses.length === 0) {
    throw new Error(`Could not resolve ${host}.`);
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("That host isn't publicly reachable, so it can't be fetched.");
  }
}

/**
 * Fetches the page, or throws with a message meant for the person who typed
 * the URL. Callers map that to a status code.
 *
 * A refusal is not an exception: a challenge page is a perfectly good HTTP
 * response, and the caller needs to know which of the two it received.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  await assertPublicUrl(url);

  let attempt = await request(url, USER_AGENT);
  let usedBrowserIdentity = false;

  // Only retried when the refusal looks like a filter on who is asking. A
  // challenge page would return the same challenge however we introduce
  // ourselves, so trying again just spends another request to be told so.
  if (attempt.block?.retryAsBrowser && process.env.FETCH_IDENTIFY_ONLY !== "1") {
    const second = await request(url, BROWSER_USER_AGENT);
    if (!second.block) {
      attempt = second;
      usedBrowserIdentity = true;
    }
  }

  return { ...attempt, usedBrowserIdentity };
}

async function request(url: string, userAgent: string): Promise<FetchedPage> {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent, ...COMMON_HEADERS },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  // A public URL can redirect into the private range, so the address we
  // actually landed on has to be checked too.
  await assertPublicUrl(response.url || url);

  const contentType = response.headers.get("content-type");
  const raw = await response.text();
  const body = raw.slice(0, MAX_BYTES);

  return {
    url: response.url || url,
    status: response.status,
    contentType,
    body,
    truncated: raw.length > MAX_BYTES,
    // Only HTML has a title, links and prose to pull apart. Anything else
    // (a text file, JSON) has nothing to parse.
    isHtml: /html/i.test(contentType ?? "") || /^\s*<(!doctype|html)/i.test(body),
    block: detectBlock(response.status, response.headers, body) ?? undefined,
  };
}
