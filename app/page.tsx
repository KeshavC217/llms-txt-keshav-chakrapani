"use client";

import { useState } from "react";

interface Result {
  url: string;
  status: number;
  contentType: string | null;
  truncated: boolean;
  llmsTxt: string;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/generate", {
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
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
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
          {loading ? "Fetching…" : "Generate"}
        </button>
      </form>

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
            </p>
            <button
              onClick={download}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
            >
              Download llms.txt
            </button>
          </div>
          <pre className="mt-3 max-h-[32rem] overflow-auto rounded-lg bg-neutral-50 p-4 font-mono text-xs whitespace-pre-wrap dark:bg-neutral-900">
            {result.llmsTxt}
          </pre>
        </section>
      )}
    </main>
  );
}
