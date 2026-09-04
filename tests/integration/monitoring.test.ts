/**
 * Integration test for the monitoring endpoints against the real Supabase
 * project and the local fixture site.
 *
 * This is the assignment's third task — "detect changes in the website's
 * structure or content and update the llms.txt accordingly" — so it is tested
 * end to end rather than by unit-testing the pieces: track a site, mutate the
 * site, refresh, and assert the diff describes what actually changed.
 *
 * Skips without Supabase credentials.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteSite, getSiteByUrl, isStoreConfigured, latestSnapshot, listSnapshots } from "../../lib/store";
import { startFixtureServer, type FixtureServer } from "../helpers/fixtureServer";
import { normalizeUrl } from "../../lib/generate";

process.env.ALLOW_PRIVATE_CRAWL_TARGETS = "1";
process.env.CRAWL_MIN_REQUEST_INTERVAL_MS = "0";
process.env.CRON_SECRET = process.env.CRON_SECRET || "test-cron-secret";

const { GET: refreshGet } = await import("../../app/api/refresh/route");
const { POST: trackSitePost, DELETE: untrack } = await import("../../app/api/sites/route");

let server: FixtureServer;
const trackedIds: string[] = [];
const trackedUrls: string[] = [];
/** Sites are stored under their normalized URL, so lookups must normalize too. */
const storedUrl = () => normalizeUrl(server.url)!;

beforeAll(async () => {
  server = await startFixtureServer();
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (!isStoreConfigured()) return;
  // Clean up by URL as well as by collected id: tracking a deliberately dead
  // host returns an error body with no site id, so an id-only cleanup leaves
  // that row behind and the next run inherits it.
  for (const id of trackedIds) await deleteSite(id).catch(() => {});
  for (const url of trackedUrls) {
    const site = await getSiteByUrl(url).catch(() => null);
    if (site) await deleteSite(site.id).catch(() => {});
  }
});

function req(url: string, init?: RequestInit) {
  return new Request(url, { headers: { "Content-Type": "application/json" }, ...init });
}

describe.runIf(isStoreConfigured())("monitoring end to end", () => {
  it("refuses an unauthenticated refresh", async () => {
    const res = await refreshGet(req("http://localhost/api/refresh"));
    expect(res.status, "this endpoint triggers crawls; it must not be open").toBe(401);
  });

  it("refuses a wrong secret", async () => {
    const res = await refreshGet(req("http://localhost/api/refresh?secret=not-the-secret"));
    expect(res.status).toBe(401);
  });

  it("tracks a site, then reports no change when nothing changed", async () => {
    const tracked = await trackSitePost(
      req("http://localhost/api/sites", { method: "POST", body: JSON.stringify({ url: server.url }) })
    );
    expect(tracked.status).toBe(200);
    const body = await tracked.json();
    trackedIds.push(body.site.id);
    trackedUrls.push(body.site.url);

    expect(body.pageCount).toBeGreaterThan(3);
    expect(body.llmsTxt).toMatch(/^# /);
    expect(body.changed, "the first generation is always a change").toBe(true);

    const res = await refreshGet(
      req(`http://localhost/api/refresh?secret=${process.env.CRON_SECRET}&url=${encodeURIComponent(server.url)}`)
    );
    const refreshed = await res.json();
    expect(refreshed.results[0].status, "an unchanged site must not create history").toBe("unchanged");
    expect(await listSnapshots(body.site.id)).toHaveLength(1);
  }, 120_000);

  it("detects a real content change and describes it", async () => {
    const site = await getSiteByUrl(storedUrl());
    expect(site).toBeTruthy();

    // Change the site the way a real site changes: a page's title is reworded.
    server.setPageTitle("/pricing", "Plans and Pricing - Acme");

    const res = await refreshGet(
      req(`http://localhost/api/refresh?secret=${process.env.CRON_SECRET}&url=${encodeURIComponent(server.url)}`)
    );
    const refreshed = await res.json();

    expect(refreshed.results[0].status).toBe("changed");
    expect(refreshed.results[0].changeSummary, "the summary should name what changed").toMatch(/title/i);

    const snapshot = await latestSnapshot(site!.id);
    expect(snapshot?.diff?.titlesChanged?.[0]?.to).toContain("Plans and Pricing");
    expect(await listSnapshots(site!.id), "a real change adds one version").toHaveLength(2);
  }, 120_000);

  it("records a failure and backs the site off rather than retrying forever", async () => {
    const dead = "http://127.0.0.1:1/";
    trackedUrls.push(dead);
    const tracked = await trackSitePost(
      req("http://localhost/api/sites", { method: "POST", body: JSON.stringify({ url: dead }) })
    );
    // Tracking a dead host fails the first generation, which is expected.
    const body = await tracked.json();
    if (body.site?.id) trackedIds.push(body.site.id);

    const site = await getSiteByUrl(dead);
    if (!site) return; // tracking rejected it outright, which is also fine

    await refreshGet(req(`http://localhost/api/refresh?secret=${process.env.CRON_SECRET}&url=${encodeURIComponent(dead)}`));
    const after = await getSiteByUrl(dead);
    expect(after!.consecutiveFailures).toBeGreaterThan(0);
    expect(after!.lastError).toBeTruthy();
    expect(new Date(after!.nextCheckAt).getTime(), "a failing site is checked later, not sooner").toBeGreaterThan(Date.now());
  }, 120_000);

  it("untracks a site and its history", async () => {
    const site = await getSiteByUrl(storedUrl());
    const res = await untrack(req(`http://localhost/api/sites?id=${site!.id}`, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await getSiteByUrl(storedUrl())).toBeNull();
    expect(await listSnapshots(site!.id), "cascade should drop the snapshots too").toHaveLength(0);
  });
});
