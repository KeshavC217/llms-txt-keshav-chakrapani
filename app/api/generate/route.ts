import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { buildLlmsTxt } from "@/lib/llmsTxt";

/**
 * Fetches the URL the user typed and builds an llms.txt out of that single
 * response — its title and description, the same-site links it points at, and
 * its own text. Nothing beyond this one request is fetched.
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;
const USER_AGENT = "llms-txt-generator/0.1 (+https://llmstxt.org)";

/** Adds https:// when the user omits it, and rejects anything that isn't http(s). */
function normalizeUrl(input: string): string | null {
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

export async function POST(request: Request) {
  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const url = normalizeUrl(body.url ?? "");
  if (!url) {
    return NextResponse.json({ error: "Please enter a valid URL." }, { status: 400 });
  }

  try {
    await assertPublicUrl(url);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid URL." }, { status: 400 });
  }

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    // A public URL can redirect into the private range, so the address we
    // actually landed on has to be checked too.
    await assertPublicUrl(response.url || url);

    const contentType = response.headers.get("content-type");
    const raw = await response.text();
    const page = raw.slice(0, MAX_BYTES);
    const finalUrl = response.url || url;

    // Only HTML has a title, links and prose to pull apart. Anything else
    // (a text file, JSON) has nothing to parse, so it passes through as-is.
    const isHtml = /html/i.test(contentType ?? "") || /^\s*<(!doctype|html)/i.test(page);

    return NextResponse.json({
      url: finalUrl,
      status: response.status,
      contentType,
      truncated: raw.length > MAX_BYTES,
      llmsTxt: isHtml ? buildLlmsTxt(page, finalUrl) : page,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not fetch that URL.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
