"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type Status = "idle" | "loading" | "success" | "error";
type AiStatus = "off" | "unavailable" | "applied" | "no-changes" | "failed" | "skipped";

/**
 * What to tell the user about the AI pass. Every unsuccessful outcome says so
 * explicitly: previously they all rendered nothing, so a broken AI pass was
 * indistinguishable from never having ticked the box — you'd get identical
 * output twice with no explanation.
 */
const AI_NOTICE: Record<AiStatus, { text: string; warn: boolean } | null> = {
  off: null,
  applied: { text: "AI-polished", warn: false },
  "no-changes": { text: "AI reviewed it, nothing to change", warn: false },
  failed: { text: "AI polish failed — showing the un-polished version", warn: true },
  unavailable: { text: "AI polish unavailable — set OPENROUTER_API_KEY", warn: true },
  skipped: { text: "AI polish skipped — the crawl used the time budget", warn: true },
};

interface TrackedSite {
  id: string;
  url: string;
  lastCheckedAt: string | null;
  nextCheckAt: string;
  checkIntervalHours: number;
  status: "active" | "paused";
  consecutiveFailures: number;
  lastError: string | null;
  pageCount: number | null;
  lastGeneratedAt: string | null;
  lastChangeSummary: string | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [useAi, setUseAi] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [llmsTxt, setLlmsTxt] = useState("");
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus>("off");
  const [cached, setCached] = useState(false);
  const [error, setError] = useState("");

  const [sites, setSites] = useState<TrackedSite[] | null>(null);
  const [monitoringAvailable, setMonitoringAvailable] = useState(true);
  const [busySiteId, setBusySiteId] = useState<string | null>(null);
  const [tracking, setTracking] = useState(false);
  const [notice, setNotice] = useState("");

  /**
   * Fetches the tracked-site list. Returns the next state rather than setting
   * it, so the initial effect can drop the result if the component unmounted
   * mid-request — a fetch that resolves after unmount would otherwise set
   * state on a dead component.
   */
  const fetchSites = useCallback(async (): Promise<{ available: boolean; sites: TrackedSite[] }> => {
    try {
      const res = await fetch("/api/sites");
      // 503 means this deployment has no Supabase configured. Monitoring is
      // optional, so hide it rather than showing a broken panel.
      if (res.status === 503) return { available: false, sites: [] };
      const data = await res.json();
      return { available: true, sites: data.sites ?? [] };
    } catch {
      return { available: false, sites: [] };
    }
  }, []);

  const loadSites = useCallback(async () => {
    const { available, sites: next } = await fetchSites();
    setMonitoringAvailable(available);
    setSites(next);
  }, [fetchSites]);

  useEffect(() => {
    let cancelled = false;
    fetchSites().then(({ available, sites: next }) => {
      if (cancelled) return;
      setMonitoringAvailable(available);
      setSites(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchSites]);

  async function generate(refresh = false) {
    if (!url.trim() || status === "loading") return;
    setStatus("loading");
    setError("");
    setNotice("");

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, useAi, refresh }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        setStatus("error");
        return;
      }

      setLlmsTxt(data.llmsTxt);
      setPageCount(data.pageCount);
      setAiStatus((data.aiStatus as AiStatus) ?? "off");
      setCached(Boolean(data.cached));
      setStatus("success");
    } catch {
      setError("Couldn't reach the server. Please try again.");
      setStatus("error");
    }
  }

  async function handleTrack() {
    if (!url.trim()) return;
    setTracking(true);
    setNotice("");
    try {
      const res = await fetch("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, useAi }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not track that site.");
      } else {
        setLlmsTxt(data.llmsTxt);
        setPageCount(data.pageCount);
        setAiStatus(data.aiStatus);
        setStatus("success");
        setNotice(`Now monitoring ${data.site.url}`);
        await loadSites();
      }
    } finally {
      setTracking(false);
    }
  }

  async function checkNow(site: TrackedSite) {
    setBusySiteId(site.id);
    setNotice("");
    try {
      const res = await fetch(`/api/refresh?url=${encodeURIComponent(site.url)}`, { method: "POST" });
      const data = await res.json();
      const outcome = data.results?.[0];
      // 401 here means the deployment has a CRON_SECRET the browser cannot
      // send. Say so plainly rather than leaving the button looking broken.
      if (res.status === 401) setNotice("Checking requires the scheduler's secret; this button only works locally.");
      else if (!outcome) setNotice("Nothing to check.");
      else if (outcome.status === "failed") setNotice(`Check failed: ${outcome.error}`);
      else if (outcome.status === "unchanged") setNotice(`${site.url}: no changes`);
      else setNotice(`${site.url}: ${outcome.changeSummary ?? "updated"}`);
      await loadSites();
    } finally {
      setBusySiteId(null);
    }
  }

  async function untrack(site: TrackedSite) {
    setBusySiteId(site.id);
    try {
      await fetch(`/api/sites?id=${site.id}`, { method: "DELETE" });
      await loadSites();
    } finally {
      setBusySiteId(null);
    }
  }

  function handleDownload() {
    const blob = new Blob([llmsTxt], { type: "text/plain" });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = "llms.txt";
    link.click();
    URL.revokeObjectURL(downloadUrl);
  }

  const notice_ = AI_NOTICE[aiStatus];

  return (
    <main className="flex-1 flex flex-col items-center px-6 py-16 sm:py-20">
      <div className="w-full max-w-3xl flex flex-col gap-8">
        <header className="flex flex-col gap-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">llms.txt Generator</h1>
          <p className="text-foreground/60">
            Crawl a website and generate an{" "}
            <a
              href="https://llmstxt.org"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              llms.txt
            </a>
            , then keep it up to date as the site changes.
          </p>
        </header>

        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void generate();
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="example.com"
              className="flex-1 rounded-lg border border-foreground/15 bg-transparent px-4 py-3 text-sm outline-none focus:border-foreground/40 transition-colors"
              disabled={status === "loading"}
            />
            <button
              type="submit"
              disabled={status === "loading" || !url.trim()}
              className="rounded-lg bg-foreground text-background px-6 py-3 text-sm font-medium disabled:opacity-40 transition-opacity"
            >
              {status === "loading" ? "Generating…" : "Generate"}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm text-foreground/70">
            <label className="flex items-center gap-2 select-none">
              <input
                type="checkbox"
                checked={useAi}
                onChange={(e) => setUseAi(e.target.checked)}
                disabled={status === "loading"}
                className="size-4 rounded border-foreground/30"
              />
              Use AI to polish titles and section names
            </label>
            {monitoringAvailable && (
              <button
                type="button"
                onClick={() => void handleTrack()}
                disabled={!url.trim() || tracking || status === "loading"}
                className="underline underline-offset-2 disabled:opacity-40 hover:text-foreground"
              >
                {tracking ? "Setting up…" : "Monitor this site for changes"}
              </button>
            )}
          </div>
        </form>

        {status === "error" && <p className="text-sm text-red-500 text-center">{error}</p>}
        {notice && <p className="text-sm text-foreground/70 text-center">{notice}</p>}

        {status === "success" && (
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-foreground/60">
                Crawled {pageCount} page{pageCount === 1 ? "" : "s"}
                {notice_ && (
                  <>
                    {" · "}
                    <span className={notice_.warn ? "text-amber-600 dark:text-amber-500" : undefined}>
                      {notice_.text}
                    </span>
                  </>
                )}
                {cached && (
                  <>
                    {" · "}
                    <button onClick={() => void generate(true)} className="underline underline-offset-2">
                      cached, re-crawl
                    </button>
                  </>
                )}
              </p>
              <button
                onClick={handleDownload}
                className="rounded-lg border border-foreground/15 px-4 py-2 text-sm font-medium hover:bg-foreground/5 transition-colors shrink-0"
              >
                Download llms.txt
              </button>
            </div>
            <pre className="w-full max-h-[28rem] overflow-auto rounded-lg border border-foreground/15 bg-foreground/[0.03] p-4 text-xs leading-relaxed font-mono whitespace-pre-wrap">
              {llmsTxt}
            </pre>
          </section>
        )}

        {monitoringAvailable && sites !== null && sites.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-foreground/70">Monitored sites</h2>
            <ul className="flex flex-col divide-y divide-foreground/10 rounded-lg border border-foreground/15">
              {sites.map((site) => (
                <li key={site.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <span className="font-mono text-xs truncate max-w-full sm:max-w-[18rem]">{site.url}</span>
                  <span className="text-foreground/50 text-xs">
                    {site.pageCount ?? "—"} pages · checked {timeAgo(site.lastCheckedAt)} · every {site.checkIntervalHours}h
                  </span>
                  {site.status === "paused" && (
                    <span className="text-xs text-amber-600 dark:text-amber-500">
                      paused after {site.consecutiveFailures} failures
                    </span>
                  )}
                  {site.lastChangeSummary && (
                    <span className="text-xs text-foreground/70">last change: {site.lastChangeSummary}</span>
                  )}
                  <span className="ml-auto flex gap-3 text-xs">
                    <button
                      onClick={() => void checkNow(site)}
                      disabled={busySiteId === site.id}
                      className="underline underline-offset-2 disabled:opacity-40"
                    >
                      {busySiteId === site.id ? "Checking…" : "Check now"}
                    </button>
                    <button
                      onClick={() => void untrack(site)}
                      disabled={busySiteId === site.id}
                      className="underline underline-offset-2 text-foreground/50 disabled:opacity-40"
                    >
                      Stop
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
