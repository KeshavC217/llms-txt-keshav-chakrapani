/**
 * Waking the worker.
 *
 * Crawling happens in a GitHub Actions run (see .github/workflows/worker.yml),
 * which the schedule starts every few minutes at best - GitHub delays scheduled
 * events under load, and a quiet repository sees far fewer than it asks for. A
 * person who has just typed a URL should not wait for that, so asking for a
 * site sends a repository_dispatch and the run starts within seconds.
 *
 * This is an optimisation, not the mechanism. Every queued row is picked up by
 * the next scheduled pass whether or not the dispatch worked, so nothing here
 * throws: a failure is reported and the request succeeds regardless.
 */

const DISPATCH_TIMEOUT_MS = 5_000;

export const dispatchConfigured = () =>
  Boolean(process.env.GITHUB_DISPATCH_TOKEN && process.env.GITHUB_REPOSITORY);

/** Returns whether the worker was actually woken. */
export async function requestCrawl(url: string): Promise<boolean> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) return false;

  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      // The payload is for the run's log, not for the worker: it reads the
      // queue from the database, so a dispatch carrying the wrong URL - or a
      // scheduled run carrying none - makes no difference to what gets built.
      body: JSON.stringify({ event_type: "crawl", client_payload: { url } }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });

    return response.status === 204;
  } catch {
    return false;
  }
}
