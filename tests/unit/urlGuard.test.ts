import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertPublicUrl, isPrivateAddress } from "../../lib/urlGuard";

describe("isPrivateAddress", () => {
  it("recognizes every non-public IPv4 range we care about", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "255.255.255.255"]) {
      expect(isPrivateAddress(ip), `${ip} should be private`).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1"]) {
      expect(isPrivateAddress(ip), `${ip} should be public`).toBe(false);
    }
  });

  it("handles IPv6, including IPv4-mapped loopback", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  it("treats anything it can't parse as unsafe", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  beforeEach(() => {
    delete process.env.ALLOW_PRIVATE_CRAWL_TARGETS;
  });
  afterEach(() => {
    process.env.ALLOW_PRIVATE_CRAWL_TARGETS = "1";
  });

  it("rejects loopback and internal hostnames without a DNS lookup", async () => {
    for (const url of ["http://localhost/", "http://localhost:6379/", "http://foo.local/", "http://api.localhost/"]) {
      await expect(assertPublicUrl(url), url).rejects.toThrow(/publicly reachable/i);
    }
  });

  it("rejects private IP literals, including the cloud metadata endpoint", async () => {
    for (const url of ["http://127.0.0.1:3000/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://10.0.0.5/"]) {
      await expect(assertPublicUrl(url), url).rejects.toThrow(/publicly reachable/i);
    }
  });

  it("rejects non-http schemes and unparseable input", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http and https/i);
    await expect(assertPublicUrl("not a url")).rejects.toThrow(/valid URL/i);
  });

  it("rejects a hostname that doesn't resolve", async () => {
    await expect(assertPublicUrl("https://this-host-does-not-exist.invalid/")).rejects.toThrow(/resolve/i);
  });

  it("is disabled by the test escape hatch", async () => {
    process.env.ALLOW_PRIVATE_CRAWL_TARGETS = "1";
    await expect(assertPublicUrl("http://127.0.0.1:3000/")).resolves.toBeUndefined();
  });
});
