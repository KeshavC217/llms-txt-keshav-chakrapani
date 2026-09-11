"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { displayUrl, matchesAddress } from "@/lib/catalog";
import { describeProgress, type ProgressEvent } from "@/lib/progress";

interface Result {
  url: string;
  llmsTxt: string;
  /** True when this came from storage rather than from a fresh run. */
  saved?: boolean;
  stored?: boolean;
  /** The clock ran out mid-crawl, so this is what was read rather than all of it. */
  partial?: boolean;
  generatedAt?: string;
  lastCheckedAt?: string | null;
  source?: "published";
  publishedAt?: string;
  crawl?: { pages: number; planned: number; failed: number; partial: boolean };
  /** Why a browser was needed, and what it got. Absent unless one was tried. */
  render?: string;
  report?: { notesAccepted: number; sectionsRenamed: number; chunksFailed: number; workerModel: string };
  spec?: { valid: boolean; issues: { line: number; message: string }[] };
}

/** One line of what /api/generate streamed back, before the type is known. */
type StreamedLine = ({ type: "progress" } & ProgressEvent) | ({ type: "result" } & Record<string, unknown>);

export interface SavedSite {
  url: string;
  /** When the file was last written, which is not the same as how current it is. */
  generatedAt: string;
  /** When the site was last looked at, whether or not it had moved. */
  lastCheckedAt?: string | null;
  changedAt?: string | null;
  /** "published" means the site wrote it; "generated" means this project did. */
  source: string;
}

/** "3h ago", so a stored file says how old it is. */
function age(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * How current a stored file is, which is when the site was last looked at -
 * not when the file was last written.
 *
 * A site that has not moved keeps the text it already had, so generated_at
 * stops advancing and a file the scheduled check confirmed ten minutes ago
 * reads as three weeks old. What a reader wants from this line is "up to date
 * as of", and that is last_checked_at, whether or not the check found
 * anything to rewrite. Rows written before the monitoring columns existed have
 * no check to report, so those fall back to when they were generated.
 */
function refreshed(site: { generatedAt: string; lastCheckedAt?: string | null }): string {
  return age(site.lastCheckedAt ?? site.generatedAt);
}

/** The exact dates, on hover, since the line itself is deliberately rough. */
function freshnessDetail(site: { generatedAt: string; lastCheckedAt?: string | null }): string {
  const written = `File written ${new Date(site.generatedAt).toLocaleString()}`;
  if (!site.lastCheckedAt) return written;

  return `Site last checked ${new Date(site.lastCheckedAt).toLocaleString()}\n${written}`;
}

/** Says what the models changed, rather than that they ran. */
function describeReport(report: NonNullable<Result["report"]>): string {
  const changes = [
    report.notesAccepted > 0 && `${report.notesAccepted} notes`,
    report.sectionsRenamed > 0 && `${report.sectionsRenamed} sections renamed`,
  ].filter(Boolean);

  if (changes.length === 0) return "the models added nothing";
  return `${changes.join(", ")}${report.chunksFailed > 0 ? `, ${report.chunksFailed} chunks failed` : ""}`;
}

export function Generator({ signedIn, saved }: { signedIn: boolean; saved: SavedSite[] }) {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [tab, setTab] = useState<"generate" | "catalog">("generate");
  /*
   * A saved file that arrived unasked, held back until the person says what
   * they wanted.
   *
   * Typing an address that already has a file is ambiguous - "show me it" and
   * "do it again" are both ordinary things to mean - and the old behaviour
   * picked one silently, putting a file on screen with a small note saying how
   * old it was. Someone who wanted a fresh one had to notice the note, find
   * the Regenerate button, and pay for the request twice.
   *
   * The file itself is already here, so choosing to see it costs nothing.
   */
  const [pending, setPending] = useState<Result | null>(null);
  const [query, setQuery] = useState("");

  /*
   * Filtering happens here rather than on the server: the list is already in
   * the page, fifty rows of it, so a keystroke costs nothing and a round trip
   * would cost a visible pause. It matches the address as displayed - no
   * scheme, no trailing slash - because that is what someone is looking at
   * when they type, and "docs.c" should find docs.convex.dev.
   */
  const matched = useMemo(() => {
    return query.trim() ? saved.filter((site) => matchesAddress(site.url, query)) : saved;
  }, [saved, query]);

  /**
   * Reads /api/generate's streamed body as it arrives - one JSON object per
   * line - rather than waiting for the whole response, which is the entire
   * point: a caller watching this update lives through the wait rather than
   * finding out afterward what it was waiting on.
   *
   * Every response starts as `application/json`, whether the answer came back
   * immediately (a saved file, a validation error) or the server committed to
   * doing the work; only the second case switches content types, and that is
   * the flag this branches on.
   */
  async function consumeStream(response: Response): Promise<void> {
    if (!response.body) throw new Error("Something went wrong.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;

        const event = JSON.parse(line) as StreamedLine;
        if (event.type === "progress") {
          setProgress(event);
          continue;
        }

        // The result line, whichever way the request ended. `ok` is the
        // outcome - the HTTP status this would have been without streaming
        // has already been spent making the response 200, so it travels here
        // instead.
        if (event.ok) {
          setResult(event as unknown as Result);
        } else {
          throw new Error((event.error as string | undefined) ?? "Something went wrong.");
        }
      }
    }
  }

  /**
   * `force` is a parameter rather than read from state: setting state and
   * reading it in the same handler sends the previous value, because React
   * does not apply the update until the next render.
   */
  async function run(target: string, force: boolean) {
    if (!target.trim()) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setPending(null);
    setProgress(null);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target, regenerate: force }),
      });

      if ((response.headers.get("content-type") ?? "").includes("application/x-ndjson")) {
        await consumeStream(response);
      } else {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Something went wrong.");

        /*
         * Only ask when there is a question. A file that was just built is not
         * a choice, and neither is a saved one for somebody who cannot
         * regenerate it - offering a single option is a worse way of showing
         * the file than showing the file.
         */
        if (data.saved && !force && signedIn) setPending(data);
        else setResult(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  /** Reading a saved file needs no account, so it does not go through /api/generate. */
  async function open(target: string) {
    // The file appears where files appear. Reading one from the catalog is
    // still "here is a file", so it lands on the same panel a fresh
    // generation would, with the address filled in so Regenerate means this.
    setTab("generate");
    setLoading(true);
    setError(null);
    setResult(null);
    // Clicking a row in the catalog says which of the two you meant.
    setPending(null);

    try {
      const response = await fetch(`/api/saved?url=${encodeURIComponent(target)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not read that one.");
      setResult(data);
      setUrl(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that one.");
    } finally {
      setLoading(false);
    }
  }

  function download() {
    if (!result) return;
    const href = URL.createObjectURL(new Blob([result.llmsTxt], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = "llms.txt";
    link.click();
    URL.revokeObjectURL(href);
  }

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">llms.txt Generator</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Crawls a site and writes its <code>llms.txt</code>. Generating needs an account; reading what has
        been generated does not.
      </p>

      <nav
        role="tablist"
        aria-label="Sections"
        className="mt-8 flex gap-1 border-b border-neutral-200 dark:border-neutral-800"
      >
        {(
          [
            ["generate", "Generate"],
            ["catalog", saved.length > 0 ? `Catalog (${saved.length})` : "Catalog"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === id
                ? "border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
                : "border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-300"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div role="tabpanel" hidden={tab !== "generate"}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(url, false);
          }}
          className="mt-8 flex gap-3"
        >
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="example.com"
            className="flex-1 rounded-lg border border-neutral-300 px-4 py-3 outline-none focus:border-neutral-500 dark:border-neutral-700"
          />
          <button
            type="submit"
            disabled={loading || !url.trim() || !signedIn}
            title={signedIn ? undefined : "Sign in to generate"}
            className="rounded-lg bg-neutral-900 px-6 py-3 font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {loading ? "Working…" : "Generate"}
          </button>
        </form>

        {loading && (
          <div className="mt-6" aria-live="polite">
            {/*
              React batches setResult/setError with the setLoading(false) that
              follows them, so this never renders mid-transition to "done" - the
              bar is simply replaced by the result or the error on the next
              frame, rather than flashing a completed state of its own.
            */}
            {(() => {
              const { percent, label } = progress ? describeProgress(progress) : { percent: 0, label: "Starting…" };
              return (
                <>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                    <div
                      className="h-full rounded-full bg-neutral-900 transition-[width] duration-300 ease-out dark:bg-neutral-100"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <p className="mt-2 text-sm text-neutral-500">{label}</p>
                </>
              );
            })()}
          </div>
        )}

        {!signedIn && (
          <p className="mt-3 text-sm text-neutral-500">
            <Link href="/login" className="underline">
              Sign in
            </Link>{" "}
            to generate a new one. Anything already generated is in the{" "}
            <button type="button" onClick={() => setTab("catalog")} className="underline">
              catalog
            </button>
            .
          </p>
        )}

        {error && (
          <p className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        {pending && (
          <section className="mt-6 rounded-lg border border-neutral-300 px-4 py-4 dark:border-neutral-700">
            <p className="text-sm">
              <strong className="font-medium">{displayUrl(pending.url)}</strong> already has an{" "}
              <code>llms.txt</code>
              {pending.source === "published" ? " that the site publishes itself" : " generated by this tool"},
              <span title={pending.generatedAt ? freshnessDetail({ generatedAt: pending.generatedAt, lastCheckedAt: pending.lastCheckedAt }) : undefined}>
                {pending.generatedAt ? ` refreshed ${refreshed({ generatedAt: pending.generatedAt, lastCheckedAt: pending.lastCheckedAt })}` : ""}
              </span>
              .
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              {pending.source === "published"
                ? "Someone there chose what belonged in it. Generating one anyway replaces it with ours."
                : "Regenerating crawls the site again and writes a new one over it."}
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => {
                  // Already in hand: this is a reveal, not a request.
                  setResult(pending);
                  setPending(null);
                }}
                className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
              >
                Show the saved file
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = pending.url;
                  setPending(null);
                  void run(target, true);
                }}
                className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
              >
                {pending.source === "published" ? "Generate one anyway" : "Regenerate"}
              </button>
            </div>
          </section>
        )}

        {result?.partial && (
          <div className="mt-6 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            This site was slow enough that time ran out mid-crawl, so this covers{" "}
            {result.crawl ? `${result.crawl.pages} of ${result.crawl.planned} pages` : "part of the site"} rather than all
            of it.{" "}
            {signedIn && (
              <button type="button" className="underline" onClick={() => void run(result.url, true)}>
                Try again
              </button>
            )}
          </div>
        )}

        {result?.source === "published" && (
          <div className="mt-6 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:bg-blue-950 dark:text-blue-300">
            This is the site&apos;s own llms.txt, from{" "}
            <a href={result.publishedAt} className="underline">
              {result.publishedAt}
            </a>
            . Someone there chose what belonged in it.{" "}
            {signedIn && (
              <button type="button" className="underline" onClick={() => void run(url, true)}>
                Generate one anyway
              </button>
            )}
          </div>
        )}

        {result && (
          <section className="mt-8">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-neutral-500">
                {result.llmsTxt.length.toLocaleString()} chars
                {result.crawl && <> · {result.crawl.pages} pages crawled</>}
              {result.render && <> · {result.render}</>}
                {result.report && <> · {describeReport(result.report)}</>}
                {result.saved && result.generatedAt && (
                  <span title={freshnessDetail({ generatedAt: result.generatedAt, lastCheckedAt: result.lastCheckedAt })}>
                    {" · "}
                    {result.source === "published" ? "site's own" : "generated"} · refreshed{" "}
                    {refreshed({ generatedAt: result.generatedAt, lastCheckedAt: result.lastCheckedAt })}
                  </span>
                )}
                {result.stored && <> · saved</>}
                {result.spec && (
                  <>
                    {" · "}
                    <span
                      className={
                        result.spec.valid ? "text-green-700 dark:text-green-500" : "text-amber-700 dark:text-amber-500"
                      }
                    >
                      {result.spec.valid ? "conforms to llmstxt.org" : "does not conform"}
                    </span>
                  </>
                )}
              </p>
              <div className="flex gap-3">
                {result.saved && signedIn && (
                  <button
                    onClick={() => void run(result.url, true)}
                    className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
                  >
                    Regenerate
                  </button>
                )}
                <button
                  onClick={download}
                  className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
                >
                  Download
                </button>
              </div>
            </div>
            <pre className="mt-3 max-h-[32rem] overflow-auto rounded-lg bg-neutral-50 p-4 font-mono text-xs whitespace-pre-wrap dark:bg-neutral-900">
              {result.llmsTxt}
            </pre>
          </section>
        )}

      </div>

      <div role="tabpanel" hidden={tab !== "catalog"} className="mt-8">
        {saved.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Nothing has been generated yet. Anything anyone generates shows up here, for everyone.
          </p>
        ) : (
          <>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by address"
              aria-label="Filter the catalog by address"
              className="w-full rounded-lg border border-neutral-300 px-4 py-2.5 outline-none focus:border-neutral-500 dark:border-neutral-700"
            />
            <p className="mt-2 text-xs text-neutral-500">
              {matched.length === saved.length
                ? `${saved.length} ${saved.length === 1 ? "site" : "sites"}`
                : `${matched.length} of ${saved.length}`}
            </p>

            {matched.length === 0 ? (
              <p className="mt-6 text-sm text-neutral-500">Nothing here matches “{query.trim()}”.</p>
            ) : (
              <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
                {matched.map((site) => (
                  <li key={site.url} className="flex items-center justify-between gap-4 py-2 text-sm">
                    <button type="button" onClick={() => void open(site.url)} className="truncate text-left underline">
                      {displayUrl(site.url)}
                    </button>
                    <span className="shrink-0 text-neutral-500" title={freshnessDetail(site)}>
                      {site.source === "published" ? "site's own" : "generated"} · refreshed {refreshed(site)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
