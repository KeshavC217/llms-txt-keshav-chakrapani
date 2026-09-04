import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The crawler fetches a URL the user typed, server-side. Without a guard that
 * makes this endpoint a server-side request forgery (SSRF) proxy: a user could
 * enter `http://169.254.169.254/...` (cloud instance metadata) or
 * `http://localhost:6379` and have our server fetch it and hand back the body.
 *
 * So every host is resolved to its IP(s) up front and rejected if ANY of them
 * is a non-public address. DNS-rebinding (a name that resolves to a public IP
 * here, then a private one when fetch() re-resolves it) is not fully closed by
 * this — closing that needs pinned-IP dialing — but the response-side check in
 * the crawler (see assertPublicUrl on the post-redirect URL) means an attacker
 * cannot read the body of an internal response, which is the part that leaks.
 */

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "[::1]"]);

/** Escape hatch for tests, which crawl a fixture server on 127.0.0.1. */
function privateTargetsAllowed(): boolean {
  return process.env.ALLOW_PRIVATE_CRAWL_TARGETS === "1";
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(normalized)) return true; // unique local
  // IPv4-mapped (::ffff:127.0.0.1) inherits the IPv4 rules.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true; // not an IP literal we understand — treat as unsafe
}

/**
 * Throws unless `url` is an http(s) URL whose host resolves entirely to public
 * addresses. Callers should treat the thrown message as user-facing.
 */
export async function assertPublicUrl(url: string): Promise<void> {
  if (privateTargetsAllowed()) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("Only http and https URLs can be crawled.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("That host isn't publicly reachable, so it can't be crawled.");
  }

  const literal = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(literal)) {
    if (isPrivateAddress(literal)) {
      throw new Error("That host isn't publicly reachable, so it can't be crawled.");
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error("Could not resolve that hostname.");
  }

  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error("That host isn't publicly reachable, so it can't be crawled.");
  }
}
