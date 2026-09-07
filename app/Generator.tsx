"use client";

import { useState } from "react";

interface Result {
  url: string;
  status: number;
  contentType: string | null;
  truncated: boolean;
  llmsTxt: string;
  enhanced?: boolean;
  report?: { notesAccepted: number; notesRejected: number; sectionsRenamed: number; chunksFailed: number; guideModel: string; workerModel: string; reason?: string };
  spec?: { valid: boolean; issues: { line: number; message: string }[] };
  markdownAlternate?: string;
  existingLlmsTxt?: string;
}

/** Says what the models actually changed, rather than that they ran. */
function describeReport(report: NonNullable<Result["report"]>): string {
  const changes = [
    report.notesAccepted > 0 && `${report.notesAccepted} notes`,
    report.sectionsRenamed > 0 && `${report.sectionsRenamed} sections renamed`,
  ].filter(Boolean);

  if (changes.length === 0) return "AI added nothing";

  // A failed chunk means links that silently kept no note, which is worth
  // saying: the file is thinner than it looks, and not because the page was.
  const failed = report.chunksFailed > 0 ? `, ${report.chunksFailed} chunks failed` : "";
  return `${changes.join(", ")}${failed}`;
}

export function Generator({ signedIn, authConfigured }: { signedIn: boolean; authConfigured: boolean }) {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [enhance, setEnhance] = useState(false);

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Separate endpoint: it needs an account, spends money, and takes seconds.
      const response = await fetch(enhance ? "/api/enhance" : "/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Something went wrong.");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
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
        Builds an llms.txt from a single page: its title, the pages it links to, and its text.
      </p>

      <form onSubmit={generate} className="mt-8 flex gap-3">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="example.com"
          className="flex-1 rounded-lg border border-neutral-300 px-4 py-3 outline-none focus:border-neutral-500 dark:border-neutral-700"
        />
        <button
          type="submit"
          disabled={loading || !url.trim()}
          className="rounded-lg bg-neutral-900 px-6 py-3 font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {loading ? (enhance ? "Thinking…" : "Fetching…") : "Generate"}
        </button>
      </form>

      <label className="mt-3 flex items-center gap-2 text-sm text-neutral-500">
        <input
          type="checkbox"
          checked={enhance}
          disabled={!signedIn}
          onChange={(e) => setEnhance(e.target.checked)}
          className="h-4 w-4"
        />
        Improve the result with AI
        {!signedIn &&
          // Pointing an unconfigured deployment at /login would send someone to
          // a page that cannot sign them in.
          (authConfigured ? (
            <a href="/login" className="underline">
              (sign in required)
            </a>
          ) : (
            <span>(not configured on this deployment)</span>
          ))}
      </label>

      {error && (
        <p className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {result && (
        <section className="mt-8">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-neutral-500">
              HTTP {result.status} · {result.contentType ?? "unknown type"} ·{" "}
              {result.llmsTxt.length.toLocaleString()} chars
              {result.truncated && " (truncated)"}
              {result.report && (
                <>
                  {" · "}
                  <span>{describeReport(result.report)}</span>
                </>
              )}
              {result.spec && (
                <>
                  {" · "}
                  <span className={result.spec.valid ? "text-green-700 dark:text-green-500" : "text-amber-700 dark:text-amber-500"}>
                    {result.spec.valid ? "conforms to llmstxt.org" : `${result.spec.issues.length} spec issue(s)`}
                  </span>
                </>
              )}
            </p>
            <button
              onClick={download}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
            >
              Download llms.txt
            </button>
          </div>
          {result.existingLlmsTxt && (
            <p className="mt-3 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:bg-blue-950 dark:text-blue-300">
              This site already publishes an llms.txt at{" "}
              <a href={result.existingLlmsTxt} className="underline">
                {result.existingLlmsTxt}
              </a>
              . Its own file is authoritative; this one is generated from a single page.
            </p>
          )}

          <pre className="mt-3 max-h-[32rem] overflow-auto rounded-lg bg-neutral-50 p-4 font-mono text-xs whitespace-pre-wrap dark:bg-neutral-900">
            {result.llmsTxt}
          </pre>
        </section>
      )}
    </div>
  );
}
