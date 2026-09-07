# llms.txt Generator

**Live: <https://llms-txt-keshav-chakrapani.vercel.app>**

A tool that generates an [`llms.txt`](https://llmstxt.org) file for a website.

You enter a URL; the server fetches that one page and builds an `llms.txt` from it. There is no
crawling — every line of the output comes from the single response, which is the constraint the
current version is built under.

## Setup

```bash
npm install
npm run dev
```

Open <http://localhost:3000> and enter a URL.

## How it works

```
TEMPLATE.txt             the target shape, and the rules the extractor follows
app/
  page.tsx               URL input, result preview, download
  api/generate/route.ts  POST { url } -> fetch -> guard -> build
lib/
  dom.ts                 HTML -> a small tree that can be measured
  nlp.ts                 tokenizing, stemming, overlap, sentence splitting
  naiveExtractor.ts      the tree -> { siteName, summary, sections } -> llms.txt
```

`POST /api/generate` takes `{ "url": "example.com" }` and returns:

```json
{
  "url": "https://example.com/",
  "status": 200,
  "contentType": "text/html; charset=utf-8",
  "truncated": false,
  "llmsTxt": "# Example Domain\n\n> ...\n\n## Subpages\n\n## Content\n..."
}
```

`TEMPLATE.txt` defines what is being aimed at, generalized from the spec at
[llmstxt.org](https://llmstxt.org) and from 22 files sampled off
[llmstxt.site](https://llmstxt.site). The generated file is:

```
# Title                      og:title, then <title>, then <h1>, then the hostname
> description                meta description, og: or twitter: variants
Source: https://example.com/

## Subpages
- [label](url)               every same-host <a href>, in document order

## Content
...                          the page's own text, headings and list items kept
```

### What the extractor infers

It is naive in that it sees one document: no crawl, no model, no fetching the pages it links to.
Everything is inferred from structure and word overlap.

- **Boilerplate.** Link density decides what is navigation: a nav is nearly all link text, a
  paragraph is nearly none. Chrome is read for its *links* and discarded for its prose, so menus
  no longer land in the body.
- **Sections.** Links group by shared path segment, and the grouping goes a segment deeper when
  one bucket would swallow most of the page — otherwise every documentation site collapses into a
  single `/docs` section. Locale segments are skipped, so `/docs/en/...` is not a section called
  "En". Names come from the page's own nav headings when one covers the group in both directions,
  else from the segment itself.
- **Duplicates.** URLs are canonicalized (fragment, trailing slash, `index.html`, scheme) and
  titles compared by stemmed token overlap, so "Pricing" and "Our Pricing" collapse to the shorter.
- **Notes.** Taken only from a container holding exactly one link — a card or list item, never a
  nav list, whose "neighbouring text" is just the other menu entries. Anything restating its own
  title, or reading as concatenated labels rather than prose, is dropped instead of padded out.
- **Curation.** Capped at 25 links a section and 150 overall; single-link sections merge into the
  catch-all. A 238-link dump of a Wikipedia article is a sitemap, which is the thing llms.txt
  exists not to be.

A non-HTML response has nothing to parse and passes through unchanged.

### Known limits

Most links carry no note. A single page rarely says anything about the pages it links to, and the
template's rule is to omit rather than invent — filling that slot properly means fetching the
targets, which this deliberately does not do.

A client-rendered page yields nothing, and says so rather than pretending: `docs.convex.dev`
returns a 4 KB shell with one anchor, and the output states that the links need JavaScript that a
single fetch does not run.

The URL is normalized first (a bare hostname gets `https://`; a non-http scheme is rejected
rather than defaulted, since prefixing `https://` onto `ftp://example.com` produces
`https://ftp://example.com`, which `URL` happily parses with the host `ftp`).

Responses are capped at 2 MB and the fetch times out after 15s.

### The one guard

`assertPublicUrl` refuses URLs resolving to a loopback, link-local, private or CGNAT address,
and re-checks the final URL after redirects.

This is deliberate rather than left over. The endpoint fetches a user-supplied URL server-side
and returns the body, so without it the deployed app is an open proxy into anything the function
can reach — `http://169.254.169.254/` (cloud instance metadata) included. A public URL can also
`302` into the private range, which is why the post-redirect check exists.

Set `ALLOW_PRIVATE_CRAWL_TARGETS=1` to bypass it when testing against a local server.

## Environment

Nothing is required to run the passthrough. `.env.example` documents the variables the fuller
version will use as it gets rebuilt (Supabase for persistence, OpenRouter for an LLM pass, a cron
secret for scheduled updates).

## Deployment

Deployed to Vercel as a standard Next.js app, from GitHub rather than from a laptop.

Work goes to `main` through a pull request. Opening one runs CI (lint and typecheck, in
`.github/workflows/ci.yml`) and builds a Vercel preview, whose URL is commented on the PR.
Merging deploys to production.

`main` is protected: it takes a passing `ci` check and a PR to change it. Vercel builds previews
on push regardless of CI, so a red check can sit next to a working preview — production is what
the protection gates.

CI pins Node 24 to match the npm that writes `package-lock.json`. npm 10 and npm 11 lay out the
wasm fallback dependencies differently, and `npm ci` rejects a lock file whose layout is not the
one it would have built.

## History

The full implementation — crawler with sitemap/robots/nav parsing, headless-browser fallback for
JS-rendered pages, deterministic sectioning, a constrained LLM copyedit pass, Supabase
persistence, change detection and scheduled re-crawls — is preserved at the tag
[`v1-full-generator`](https://github.com/KeshavC217/llms-txt-keshav-chakrapani/releases/tag/v1-full-generator).

```bash
git show v1-full-generator:lib/crawler.ts   # read a file from it
git diff v1-full-generator                  # what was removed
```
