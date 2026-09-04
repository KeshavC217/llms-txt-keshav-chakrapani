/**
 * Integration test for the storage layer against the REAL Supabase project.
 *
 * Skips itself when SUPABASE_URL / SUPABASE_SECRET_KEY are absent, so CI and
 * other contributors are not blocked on credentials — but when they are
 * present this exercises the actual schema, which is the only way to catch a
 * column rename, a missing default, or a constraint that does not behave the
 * way the DDL reads.
 *
 * Every row it creates uses a reserved URL prefix and is deleted afterwards.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  deleteSite,
  dueSites,
  getSiteByUrl,
  hashContent,
  isStoreConfigured,
  latestSnapshot,
  listSnapshots,
  markFailed,
  recordGeneration,
  trackSite,
  type TrackedSite,
} from "../../lib/store";

const PREFIX = `https://store-test-${Date.now()}.invalid`;
const created: string[] = [];

async function make(suffix = ""): Promise<TrackedSite> {
  const site = await trackSite(`${PREFIX}${suffix}`);
  created.push(site.id);
  return site;
}

afterAll(async () => {
  if (!isStoreConfigured()) return;
  for (const id of created) await deleteSite(id).catch(() => {});
});

const doc = (links: string) => `# Test\n\n> A summary.\n\n## S\n\n${links}\n`;

describe.runIf(isStoreConfigured())("store against real Supabase", () => {
  it("tracking the same URL twice returns one row, not a constraint error", async () => {
    const first = await make("/dup");
    const second = await trackSite(`${PREFIX}/dup`);
    expect(second.id).toBe(first.id);
    expect(await getSiteByUrl(`${PREFIX}/dup`)).toMatchObject({ id: first.id });
  });

  it("stores the first generation and computes no diff for it", async () => {
    const site = await make("/first");
    const result = await recordGeneration(site, doc("- [A](https://a.test/a)"), { pageCount: 1, aiStatus: "off" });

    expect(result.changed).toBe(true);
    expect(result.diff, "the first snapshot has nothing to compare against").toBeNull();
    expect(result.snapshot?.contentHash).toBe(hashContent(doc("- [A](https://a.test/a)")));
  });

  it("writes no snapshot when the content is unchanged", async () => {
    const site = await make("/same");
    const text = doc("- [A](https://a.test/a)");
    await recordGeneration(site, text, { pageCount: 1 });
    const second = await recordGeneration(site, text, { pageCount: 1 });

    expect(second.changed, "an identical re-crawl must not create history").toBe(false);
    expect(await listSnapshots(site.id)).toHaveLength(1);
  });

  it("stores a structured diff when the content changes", async () => {
    const site = await make("/changed");
    await recordGeneration(site, doc("- [A](https://a.test/a)"), { pageCount: 1 });
    const result = await recordGeneration(site, doc("- [A](https://a.test/a)\n- [B](https://a.test/b): New."), {
      pageCount: 2,
    });

    expect(result.changed).toBe(true);
    expect(result.diff?.pagesAdded).toEqual(["https://a.test/b"]);
    // Round-tripped through jsonb, which does not preserve key order.
    const stored = await latestSnapshot(site.id);
    expect(stored?.diff?.pagesAdded).toEqual(["https://a.test/b"]);
    expect(await listSnapshots(site.id)).toHaveLength(2);
  });

  it("reordering a section changes the hash but reports no diff worth sending", async () => {
    const site = await make("/reorder");
    await recordGeneration(site, "# T\n\n## A\n\n- [X](https://a.test/x)\n\n## B\n\n- [Y](https://a.test/y)\n", { pageCount: 2 });
    const result = await recordGeneration(site, "# T\n\n## B\n\n- [Y](https://a.test/y)\n\n## A\n\n- [X](https://a.test/x)\n", { pageCount: 2 });

    expect(result.changed, "the bytes did change, so the new version is stored").toBe(true);
    expect(result.diff, "but nothing a person would call a change happened").toBeNull();
  });

  it("schedules the next check after a successful run", async () => {
    const site = await make("/schedule");
    await recordGeneration(site, doc("- [A](https://a.test/a)"), { pageCount: 1 });

    const after = await getSiteByUrl(site.url);
    expect(after?.lastCheckedAt).toBeTruthy();
    expect(new Date(after!.nextCheckAt).getTime()).toBeGreaterThan(Date.now() + 3600_000);
    expect(after?.consecutiveFailures).toBe(0);
  });

  it("backs off and eventually pauses a site that keeps failing", async () => {
    let site = await make("/failing");
    for (let i = 0; i < 5; i++) {
      await markFailed(site, `attempt ${i} failed`);
      site = (await getSiteByUrl(site.url))!;
    }
    expect(site.consecutiveFailures).toBe(5);
    expect(site.status, "a dead host should stop being retried forever").toBe("paused");
    expect(site.lastError).toContain("failed");
  });

  it("only returns due, active sites to the scheduler", async () => {
    const due = await make("/due");
    const paused = await make("/paused");
    for (let i = 0; i < 5; i++) {
      await markFailed(paused, "x");
      Object.assign(paused, await getSiteByUrl(paused.url));
    }

    const ids = (await dueSites(200)).map((s) => s.id);
    expect(ids, "a newly tracked site is due immediately").toContain(due.id);
    expect(ids, "a paused site must not be picked up").not.toContain(paused.id);
  });
});
