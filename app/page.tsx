"use client";

import { useState, type FormEvent } from "react";

type Status = "idle" | "loading" | "success" | "error";
type AiStatus = "off" | "unavailable" | "applied" | "no-changes" | "failed";

/**
 * What to tell the user about the AI pass. "failed" and "unavailable" get a
 * visible warning rather than silence: previously any unsuccessful outcome
 * rendered nothing at all, so a broken AI pass was indistinguishable from
 * never having ticked the box — you'd get byte-identical output twice with no
 * explanation.
 */
const AI_NOTICE: Record<AiStatus, { text: string; warn: boolean } | null> = {
  off: null,
  applied: { text: "AI-polished", warn: false },
  "no-changes": { text: "AI reviewed it and found nothing to change", warn: false },
  failed: { text: "AI polish failed — showing the un-polished version", warn: true },
  unavailable: { text: "AI polish unavailable — set OPENROUTER_API_KEY", warn: true },
};

export default function Home() {
  const [url, setUrl] = useState("");
  const [useAi, setUseAi] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [llmsTxt, setLlmsTxt] = useState("");
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus>("off");
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim() || status === "loading") return;

    setStatus("loading");
    setError("");

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, useAi }),
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
      setStatus("success");
    } catch {
      setError("Couldn't reach the server. Please try again.");
      setStatus("error");
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

  return (
    <main className="flex-1 flex flex-col items-center px-6 py-16 sm:py-24">
      <div className="w-full max-w-2xl flex flex-col gap-8">
        <header className="flex flex-col gap-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">llms.txt Generator</h1>
          <p className="text-foreground/60">
            Enter a website URL to crawl it and generate an{" "}
            <a
              href="https://llmstxt.org"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              llms.txt
            </a>{" "}
            file.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
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
        </form>

        <label className="flex items-center gap-2 text-sm text-foreground/70 -mt-4 select-none">
          <input
            type="checkbox"
            checked={useAi}
            onChange={(e) => setUseAi(e.target.checked)}
            disabled={status === "loading"}
            className="size-4 rounded border-foreground/30"
          />
          Use AI to polish section names and summary
        </label>

        {status === "error" && (
          <p className="text-sm text-red-500 text-center">{error}</p>
        )}

        {status === "success" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-foreground/60">
                Crawled {pageCount} page{pageCount === 1 ? "" : "s"}
                {AI_NOTICE[aiStatus] && (
                  <>
                    {" · "}
                    <span className={AI_NOTICE[aiStatus]!.warn ? "text-amber-600 dark:text-amber-500" : undefined}>
                      {AI_NOTICE[aiStatus]!.text}
                    </span>
                  </>
                )}
              </p>
              <button
                onClick={handleDownload}
                className="rounded-lg border border-foreground/15 px-4 py-2 text-sm font-medium hover:bg-foreground/5 transition-colors"
              >
                Download llms.txt
              </button>
            </div>
            <pre className="w-full max-h-[28rem] overflow-auto rounded-lg border border-foreground/15 bg-foreground/[0.03] p-4 text-xs leading-relaxed font-mono whitespace-pre-wrap">
              {llmsTxt}
            </pre>
          </div>
        )}
      </div>
    </main>
  );
}
