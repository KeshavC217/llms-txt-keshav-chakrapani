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
  spec.ts                the llmstxt.org grammar: escaping out, parsing back
tests/
  fixtures.ts            mock pages, one per genre the extractor meets
  *.test.ts              node:test suites, run with `npm test`
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

### Conformance

The output follows the grammar at [llmstxt.org](https://llmstxt.org) strictly: one H1 and it comes
first, no heading deeper than H2, sections that contain list items and nothing else, and every item
carrying a hyperlink. Values are escaped on the way out, so a page whose link title contains `]`,
whose URL contains `(`, or whose first paragraph begins `##` cannot produce a file that stops
parsing.

`lib/spec.ts` implements the grammar both ways - escaping to make output conform, parsing to check
it did. Every response reports the result:

```json
"spec": { "valid": true, "issues": [] }
```

`npm test` includes the conformance suite: the spec's own FastHTML example, seven files that must be
rejected, and eight hostile pages run through the real pipeline. CI runs it on every PR. The
adversarial cases earned their place - they caught a bug where correctly escaped `\[draft\]` was
rejected by the validator's own regex.

Two things the spec recommends that a single fetch cannot honestly do. It asks that links point at
markdown versions of pages; we cannot know a `.md` twin exists without fetching it, and inventing
those URLs would mean emitting links we have never seen. And where a page advertises
`rel="alternate" type="text/markdown"` or `rel="describedby"`, that is reported rather than acted
on - a markdown twin for the fetched page says nothing verifiable about the pages it links to. If a
site already publishes its own llms.txt, the UI says so: theirs is authoritative.

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

## Tests

```bash
npm test        # node --test, no framework and no dependencies
```

Node 24 runs TypeScript directly, so the suites are `.ts` and import the modules they test. That is
why `lib` modules import each other by full filename (`./dom.ts`) and why type-only imports carry an
inline `type` marker: Node strips types when it runs a file and cannot otherwise tell an interface
from a value.

`tests/fixtures.ts` holds mock pages, one per genre the extractor actually meets - a documentation
site with a sidebar and cards, a marketing site reaching one page by four URLs, an application
shell, locale-prefixed paths, a chrome-heavy page, and deliberately malformed markup. Several encode
a specific bug found against live sites, so a regression has somewhere to fail loudly.

Writing them found five real defects: `<p>` inside a `<div>` closed the `<div>` (the implicit-close
table was keyed backwards), `stem("guides")` did not match `stem("guide")`, `stripBrandSuffix` left
a two-word brand in place, deduping a link kept the nav copy and threw away the card's description,
and a card description was repeated as orienting prose.

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
