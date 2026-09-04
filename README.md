# llms.txt Generator (v0)

A tool that crawls a website and generates an [`llms.txt`](https://llmstxt.org) file. The
crawl, extraction and sectioning are fully deterministic (heuristics + lightweight NLP); an
optional LLM pass then copyedits the finished document. This is an early version — no automated
monitoring/updates, no deployment. It runs locally.

## How it works

1. You enter a URL in the browser.
2. The server checks the URL is publicly reachable (see **Safety** below), reads `robots.txt`,
   then fetches the homepage, extracts its title/description, and pulls same-origin links from it.
3. It merges those links with the URLs in the site's `sitemap.xml` and ranks them: nav-linked
   pages first, then other homepage links, then sitemap-only URLs (shallowest paths first — a
   sitemap is mostly deep leaves, and spending the whole budget on
   `/docs/reference/some/deep/leaf` while missing `/docs` produces a much worse index). Links to
   non-HTML files, `robots.txt`-disallowed paths, and boilerplate paths (`/login`, `/cart`, …)
   are dropped.
4. It fetches up to 100 of those pages, at most 8 at a time, and extracts each one's title/description
   (`<title>`/`<h1>`, `<meta name="description">`/`og:description`, falling back to the first
   prose sentence in the page body via [`compromise`](https://github.com/spencermountain/compromise)
   when no meta description exists). If a successfully-fetched page's visible text is suspiciously
   short (< 200 characters after stripping scripts/styles — usually an empty SPA shell like
   `<div id="root"></div>`, filled in by client-side JS after load), it's re-fetched with a
   headless [Playwright](https://playwright.dev) browser (`lib/browserRender.ts`) and the render is
   used if it actually recovers more content than the original. The same escalation covers a page
   that bot-walls plain `fetch()` but serves a real browser.
5. Duplicate entries are collapsed — by `<link rel="canonical">` where a page declares one, and
   otherwise by identical title + description (so `/amenities` and `/amenities.htm` don't both
   appear). A description shared by several pages, or identical to the site summary, is dropped:
   it distinguishes nothing, and the spec makes descriptions optional.
6. Titles get cleaned up: sites almost always append a boilerplate suffix to `<title>`
   ("Foo · Cloudflare Workers docs"). Rather than guessing the brand from the hostname (which
   breaks the moment a domain spells the brand differently than the page content does — e.g.
   `claracars.pt` vs. the displayed "Clara Carros"), the boilerplate words are detected directly
   from how often they recur across the *crawled titles themselves*, then stripped, so the output
   reads like a curated `llms.txt` rather than raw `<title>` dumps.
7. Pages are grouped into sections, in priority order:
   1. **The site's own nav bar.** `lib/nav.ts` parses `<nav>`/`[role="navigation"]` on the
      homepage: a top-level item with a dropdown becomes a section named after that item, with
      every link in the dropdown as a member; a flat top-level link becomes a section covering
      its own page plus anything nested under its path. This is the strongest signal available —
      it's the taxonomy the site's own authors chose, in their own words, in their own order —
      so it wins over anything we could infer from crawled content.
   2. **Known path prefixes** (`/docs`, `/blog`, `/api`, ...) for anything the nav didn't cover
      (locale prefixes like `/en/` are skipped when reading the path, so `/en/blog` still matches
      `/blog`).
   3. **Repeated path segments** — any other segment shared by ≥3 pages becomes its own section
      (`/car/<slug>` × 4 → "Car"). This catches templated/inventory sites (e-commerce listings,
      product pages) *before* keyword clustering, since those pages tend to repeat the same
      marketing boilerplate ("taxes included", "in stock") which would otherwise fool clustering
      into grouping unrelated pages together.
   4. **Keyword clustering** (last resort) for whatever's left, using
      [`natural`](https://github.com/NaturalNode/natural) — stemming + document-frequency, not
      TF-IDF's top term (see note below).
8. **Optionally**, an LLM copyedit pass (`lib/ai.ts`, via OpenRouter) runs over the finished
   document, **fanned out into parallel calls**: one document-level call owning the title,
   summary, intro and section names, plus one call per section chunk (max 12 pages each, 6 in
   flight) owning only that chunk's link text. Sizing is driven by output tokens, which is what
   actually fails: a single call for a 90-page site emitted ~5,200 completion tokens, 65% of the
   8,000 cap, and overflowing that cap silently discarded the entire pass. Chunked, the busiest
   call emits ~760 tokens (9%). It also means one bad provider response costs one section's
   wording instead of the whole document. It is deliberately not allowed to write the document:
   each call returns a sparse *edit map*
   (reword this title, drop that description, rename this section, demote these pages to
   `## Optional`), every entry is validated against the known page/section set before being
   spliced in, and the result is re-checked against the spec validator — if it fails, the
   deterministic version is served instead. So the model can improve the wording but has no path
   to invent a URL, drop a page, or produce a malformed file.

   What is deliberately *not* chunked is anything needing a whole-document view. The one genuinely
   cross-page decision — dropping a description repeated across many pages — was moved into
   deterministic code (step 5), so no worker needs to see the whole document to make it.
9. You can preview the result and download it as `llms.txt`.

## Safety

The endpoint fetches a URL the user typed, server-side, which is an SSRF hazard: without a guard
someone could point it at `http://169.254.169.254/` (cloud instance metadata) or an internal
service and read the response. `lib/urlGuard.ts` resolves every host and refuses any that maps to
a loopback, link-local, private, or CGNAT address — on the URL entered *and* on the final URL
after redirects, since a public URL can 302 into the private range. Tests opt out via
`ALLOW_PRIVATE_CRAWL_TARGETS=1` so they can crawl a fixture server on `127.0.0.1`.

### Why document-frequency clustering, not TF-IDF top-term

The obvious first instinct is "grab each page's top TF-IDF term and group by that." That's
actually backwards: TF-IDF is designed to *downweight* words that recur across many documents —
which is exactly the signal a shared-topic cluster needs (e.g. five blog posts that all mention
the same technology). Grouping by top-TF-IDF-term mostly produces singletons. Instead, this
clusters pages by finding stemmed terms that appear on at least two pages (and fewer than half of
all pages, to exclude site-wide boilerplate/brand terms), which reliably recovers real topical
groups — verified against a blog where it correctly grouped unrelated-looking post titles that
all discuss the same underlying technology.

### What browser rendering fixes

It fixes **client-rendered content** — SPAs whose initial HTML response is an empty shell.
Verified against a local test page whose content only appears via a `setTimeout`-driven DOM
update: the plain-fetch version returned nothing but a `<title>`; the rendered version correctly
recovered the real title, description, and internal nav links.

## Setup

```bash
npm install
npx playwright install chromium  # one-time browser download for the render fallback
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), enter a URL (e.g. `example.com`), and click
**Generate**.

## Testing

Three layers, each answering a different question. The first two are hermetic and gate CI; the
third ("eval") is deliberately not — it needs the live web and, optionally, an LLM judge, and it
measures quality rather than asserting correctness.

```bash
npm test                  # unit + integration — deterministic, offline, safe to gate CI on
npm run test:unit
npm run test:integration
npm run test:eval         # seeded cohort from llmstxt.site, scored against each site's own file
npm run test:eval:site    # single random live site; quick version of the same idea
```

**Unit** (`tests/unit`) — pure functions against hand-written HTML and fixtures.

**Integration** (`tests/integration`) — a real `node:http` server (`tests/helpers/fixtureServer.ts`)
serving a small site built to exercise every branch the crawler has to get right: a nav with a
dropdown, a sitemap listing pages the homepage never links to, a `robots.txt` `Disallow`, a PDF
link, a `/login` link, an external link, duplicate pages at two URLs, a `rel=canonical`, a
client-rendered SPA shell, and a page that bot-walls plain `fetch()` but serves a real browser.
This is the layer unit tests can't reach — most real defects are in how URLs get discovered,
filtered, ranked and budgeted, not in any single function. `api-route.test.ts` drives the actual
route handler, including the SSRF refusals. The browser-render suite skips itself (visibly) if
Playwright's chromium isn't installed.

`ai-provider.test.ts` runs the AI pass against a **fake OpenRouter**
(`tests/helpers/fakeOpenRouter.ts`) that reproduces how real providers actually fail — JSON
escaped inside a string, truncation at the token cap, an empty content field after billing 8k
tokens, prose instead of JSON, 429s, and a hard 405. This layer did not exist at first, and its
absence is why a completely broken AI pass once shipped with a green suite: the unit tests mock
the whole `openrouter` module (so they never see a request body), and every other integration
test is deliberately offline. Nothing could observe the request we actually send or the response
we actually get back.

**Corpus eval** (`tests/eval/corpus.test.ts`, `npm run test:eval`) — the main
quality gate. Every site in the [llmstxt.site](https://llmstxt.site) directory has published its
own `llms.txt`, which makes it the closest thing to a labelled dataset this problem has: a human
decided which pages of their site matter, and we can check how much of that we rediscovered
without any judgment call. The eval draws a **seeded** cohort (so a score that moves is
attributable to a code change, not a different sample), crawls them in parallel, and asserts on
**aggregates** — one live site being down is noise; a drop in the cohort median is signal. Spec
validity is the exception, asserted per-site, since malformed output is our bug on any input.

```bash
npm run test:eval                                   # 8 seeded sites
EVAL_SITES=20 EVAL_SEED=7 npm run test:eval         # bigger / different cohort
EVAL_JUDGE=1 EVAL_REPORT=eval.json npm run test:eval  # add the LLM judge, save a report
```

Getting the recall metric honest took three tries, and the failures are instructive:

- **Raw recall is unusable as a gate.** One cohort site's `llms.txt` lists 11,137 URLs against a
  100-page budget — its maximum possible score is 0.9%, so the raw number measures the size of
  their site, not the quality of our crawl. Recall is therefore normalized by what was
  *attainable*: reference URLs on a host we actually crawled, capped at a page budget.
- **That cap must be a fixed constant of the benchmark, not the crawler's live
  `MAX_CRAWL_PAGES`.** It was briefly the latter, which made the metric blind to the one thing it
  exists to catch: a crawl capped at 5 pages still scored 80% "attainable recall" because the
  denominator shrank with it. A benchmark whose denominator moves with the thing under test
  cannot measure that thing.
- **Sites that cannot be scored are excluded explicitly, not counted as 0%.** 109 of 1558
  directory entries pair a homepage with an `llms.txt` on a different host (pinecone.io with
  docs.pinecone.io); others link the same pages on github.com, or publish a file with no markdown
  links at all. Each is reported with its reason.

The eval also had to be taught not to manufacture its own failures: link liveness originally fired
one unbounded `Promise.all` of ~100 HEAD requests at a single host, which made servers shed load
with 503s. That scored one site at 26% dead links whose pages all return 200 when asked politely.
Liveness is now bounded to 6 concurrent, and 429/5xx count as *unverifiable* rather than dead.

**Single-site eval** (`tests/eval/single-site.test.ts`, `npm run test:eval:site`) — the
quick version of the same idea against one site, useful with `RANDOM_SITE_URL` for investigating
a specific case. It scores three ways, weakest signal last:

1. **Spec validity** (hard assertion, no network or LLM) — `lib/validate.ts` checks the output is
   a well-formed `llms.txt`: one `# Title`, no malformed link lines, no relative URLs, no
   duplicate URLs, no empty sections. If we emit something invalid, that's a bug on any site.
2. **Link liveness and recall** (objective, no LLM) — every URL we publish is `HEAD`ed and must
   resolve; separately, we report what fraction of the URLs in the site's *own* published
   `llms.txt` we independently found. Dead links are an unambiguous defect. Recall is reported
   rather than asserted, since a hand-written `llms.txt` often lists pages no crawler can reach.
3. **LLM judge** (`lib/judge.ts`) — a cheap model scores our output on its own merits
   (`qualityScore`) and against the site's real `llms.txt` (`similarityScore`), and lists concrete
   defects. It's run on **both** the deterministic and the AI-copyedited output, so the question
   that actually matters — *does the AI pass make it better?* — is measured rather than assumed.
   Reported by default, since one random site is a noisy signal; set `JUDGE_MIN_QUALITY` (with a
   larger `RANDOM_SITE_COUNT`) to turn it into a real gate.

```bash
RANDOM_SITE_URL=https://example.com npm run test:eval:site   # target one site
RANDOM_SITE_COUNT=5 JUDGE_MIN_QUALITY=6 npm run test:eval:site
```

Why the judge isn't the primary signal: "similar to one hand-authored example" isn't ground truth
— two good `llms.txt` files for the same site can organize it completely differently. Validity,
liveness and recall are checkable facts, so they gate; the judge informs.

## Known limitations (by design, for this pass)

- Browser rendering only kicks in for thin/empty initial HTML or a failed fetch — it doesn't wait
  for arbitrary client-side interactions (clicking "load more", infinite scroll, auth walls)
  beyond a page's normal load.
- Keyword clustering is lexical, not semantic — it groups pages that share literal vocabulary, so
  a taxonomy that requires real-world knowledge (e.g. knowing "Workers" and "Durable Objects" are
  both "serverless compute" without either page saying so) is out of reach without an
  embeddings/LLM step.
- Nav extraction only sees the homepage's nav bar; a site whose meaningful nav only appears on
  interior pages (e.g. a docs sidebar not present on the marketing homepage) falls back to the
  path/keyword heuristics.
- Crawling is one level deep from the homepage plus the sitemap — it doesn't recursively follow
  interior links.
- The SSRF guard resolves DNS once, so it doesn't close DNS rebinding (a name that resolves
  public here and private when `fetch` re-resolves it). The post-redirect check means an attacker
  can't read an internal response body, which is the part that leaks; fully closing it needs
  pinned-IP dialing.
- No persistence, no automated re-crawling/change detection.
- Requests to a host are paced (`CRAWL_MIN_REQUEST_INTERVAL_MS`, default 120ms) and back off
  automatically on 429/503, honouring `Retry-After`. The backoff is permanent for the rest of the
  crawl rather than per-request: a server that just said "too fast" will say it again if the other
  in-flight workers keep the old rate. This costs real time — beeclue.com goes from ~9s to ~16s —
  and it is worth it, since bounded concurrency alone still means 8 simultaneous requests to one
  host sustained across a hundred pages.
- Crawl is capped at 100 pages per site (`MAX_CRAWL_PAGES`) at concurrency 8
  (`MAX_CRAWL_CONCURRENCY`), with a 60s overall timeout. Measured against beeclue.com, whose own
  published `llms.txt` lists 91 URLs: a 20-page cap gave 20% URL recall in 2.1s, 100 pages gives
  97% in ~4s.
- The spec validator is stricter than real-world practice in one respect: it rejects `###`
  subsections, which published files do use (beeclue.com's has nine). Our generator never emits
  them, so this only matters if you point the validator at someone else's file.

## Project structure

```
app/
  page.tsx              Main UI: URL input, generate button, result preview, download
  api/generate/route.ts POST endpoint that runs the crawl + build pipeline
lib/
  crawler.ts            Discovery + fetch: robots, sitemap, ranking, dedupe, bounded concurrency
  extract.ts            Title/description/canonical/link extraction, incl. prose fallback
  browserRender.ts      Headless-browser fallback for thin/JS-rendered/bot-walled pages
  robots.txt            (lib/robots.ts) Minimal robots.txt matcher
  urlGuard.ts           SSRF guard: refuses non-public hosts
  nav.ts                Extracts the site's own nav-bar taxonomy for sectioning
  nlp.ts                Title cleanup + keyword-based section clustering (fallback)
  buildLlmsTxt.ts       Formats crawl results into the llms.txt spec structure
  validate.ts           Structural llms.txt validator (used in tests and as an AI-output gate)
  openrouter.ts         OpenRouter client: JSON extraction, retry, timeouts
  ai.ts                 Optional LLM copyedit pass (sparse, validated edit map)
  judge.ts              LLM-as-judge scoring, for the evals only
  types.ts              Shared types
tests/
  unit/                 Pure functions
  helpers/              Fixture site, fake OpenRouter, shared eval metrics
  integration/          Whole pipeline + API route against the fixture server (offline)
  eval/                 Real sites scored against their own published llms.txt
                          corpus.test.ts       seeded cohort from llmstxt.site (the quality gate)
                          single-site.test.ts  one site, for investigating a specific case
```

## Environment

```
OPENROUTER_API_KEY   enables the AI copyedit pass and the eval's judge
OPENROUTER_MODEL     override the model (default: google/gemma-4-31b-it)
MAX_CRAWL_PAGES      page budget per crawl (default: 100)
MAX_CRAWL_CONCURRENCY  parallel fetches (default: 8)
```
