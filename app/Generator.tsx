"use client";

import Link from "next/link";
import { useState } from "react";

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
  source?: "published";
  publishedAt?: string;
  crawl?: { pages: number; planned: number; failed: number; partial: boolean };
  report?: { notesAccepted: number; sectionsRenamed: number; chunksFailed: number; workerModel: string };
  spec?: { valid: boolean; issues: { line: number; message: string }[] };
}

/** One line of what /api/generate streamed back, before the type is known. */
type StreamedLine = ({ type: "progress" } & ProgressEvent) | ({ type: "result" } & Record<string, unknown>);

export interface SavedSite {
  url: string;
  generatedAt: string;
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
        setResult(data);
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
    setLoading(true);
    setError(null);
    setResult(null);

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
          to generate a new one. Anything already generated is below.
        </p>
      )}

      {error && (
        <p className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
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
              {result.report && <> · {describeReport(result.report)}</>}
              {result.saved && result.generatedAt && (
                <> · {result.source === "published" ? "read" : "generated"} {age(result.generatedAt)}</>
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

      {saved.length > 0 && (
        <section className="mt-12">
          <h2 className="text-sm font-medium text-neutral-500">Already generated</h2>
          <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
            {saved.map((site) => (
              <li key={site.url} className="flex items-center justify-between gap-4 py-2 text-sm">
                <button type="button" onClick={() => void open(site.url)} className="truncate text-left underline">
                  {site.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </button>
                <span className="shrink-0 text-neutral-500">
                  {site.source === "published" ? "site's own" : "generated"} · {age(site.generatedAt)}
                  {site.changedAt ? " · updated since" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
