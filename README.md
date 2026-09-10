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
proxy.ts                 refreshes the Supabase session on every request
app/
  login/                 email + password sign-in
lib/
  authGate.ts            who may use the LLM features
  supabase/              browser, server and config clients
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

### When a site will not let us read it

Measured across a sample of well-known sites, refusals fall into three kinds that need three
different things:

| what happens | example | what it needs |
|---|---|---|
| 403, no challenge | `zillow.com` (by address reputation) | nothing that a header can fix |
| 403 with an anti-bot challenge | `openai.com`, `g2.com`, `medium.com`, `indeed.com` | a real browser, and often more |
| 200 with an empty shell | `docs.convex.dev` | a real browser |

**Headers.** We send `Accept` and `Accept-Language`, which some CDNs require, and identify ourselves
honestly in the User-Agent. We do not retry as a browser.

That was tried and removed. `zillow.com` looked like the case for it - 403 to curl, a full page to
us - until the difference turned out to be the HTTP client rather than the header: zillow refuses
curl whatever User-Agent it sends, and served Node's fetch whatever User-Agent *it* sent, until
repeated testing from one address turned that into a 403 as well. What varies is TLS fingerprint and
address reputation, neither of which a header changes. Nothing in a thirty-site scan was helped by
the swap, so the code went rather than shipping an impersonation that could not be shown to work.

**Challenges are detected rather than fought.** `cf-mitigated: challenge`, `challenge-platform`,
`_cf_chl` and their siblings are recognised from live responses, and the endpoint says which site
refused us and why. This matters more than it sounds: a challenge page parses perfectly well, and
before this the generator turned Medium into an llms.txt summarised as *"This website is using a
security service to protect itself from online attacks."* A confident file about Cloudflare.

**A browser, when there is one.** Set `RENDER_ENDPOINT` to a Browserless-compatible service and a
shell or a challenge is retried through it. Chromium is not bundled - it does not fit comfortably in
a Vercel function, and it is needed on a small fraction of requests - so the browser lives behind an
HTTP call and swapping provider is an env var. Rendered HTML is adopted only if it extracts *more*
links than the plain response did; a bigger page with nothing on it is not an improvement.

**Does a real browser solve it?** Measured with Playwright, and the answer depends entirely on
whether the browser has a screen:

| site | headless | headed |
|---|---|---|
| `docs.convex.dev` | 200, 101 links | 200, 101 links |
| `openai.com` | 403, "Just a moment..." | 200, 458KB, 90 links |
| `medium.com` | 403, "Attention Required" | 200, 52KB, 22 links |
| `g2.com` | 403 | 403 |

Headless fixes the JavaScript-rendered pages completely and does nothing at all for the challenges -
which matters, because a server has no screen. Headed Chrome gets through two of the three, and
`g2.com` refuses both. So a browser is the answer for row three and not for row two, and the
remaining options there are a paid unblocking service that maintains browser-identical TLS
fingerprints, or accepting that a site which went to this trouble does not want to be read by a
program. Note `openai.com` allows everything in its robots.txt while its edge refuses us: the crawl
policy and the bot filter are set by different people.

A caution learned the hard way: Cloudflare leaves its scripts in the pages it protects, so
`crunchbase.com` answers 200 with 128KB of real content and a `challenge-platform` script in it. An
earlier version of the detector read the body alone and refused two working sites. Body markers now
only count when the status says we were refused.

### Known limits

Most links carry no note. A single page rarely says anything about the pages it links to, and the
template's rule is to omit rather than invent — filling that slot properly means fetching the
targets, which this deliberately does not do.

A client-rendered page yields nothing, and says so rather than pretending: `docs.convex.dev`
returns a 4 KB shell with one anchor, and the output states that the links need JavaScript that a
single fetch does not run. That claim needs positive evidence - a script and an empty element for it
to mount into. Inferring it from "no links and little text" alone was wrong in both senses: it is
true of `example.com`, which is a complete page with nothing to link to.

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

## Crawling

The generator reads the site, not just the page it was given.

**If the site publishes its own `llms.txt`, that is the answer.** Someone there chose what belonged
in it, which is more than a crawl can work out. It is checked before anything else, so it costs one
request rather than fifty: `getlago.com` returns in 0.2s instead of 8.4s. `regenerate: true` asks for
ours instead.

Recognised by shape - served as text, opening with an H1 - rather than by conformance. Strict
validation was tried first and rejected almost everything, including getlago's considered file, whose
prose under a section heading the grammar forbids. Whether it conforms is reported, not used to hide
it.

**Otherwise it crawls.** Discovery is the sitemap plus the links on the pages themselves, and both
are needed: `react.dev` answers 404 for `/sitemap.xml`, while `getlago.com` has a 282-URL sitemap
containing not one `/docs` page.

### The same site gives the same file

The crawl plans before it fetches, and that is what makes the output reproducible.

It used to let the race decide: four workers pulled from a queue until fifty pages came back, so the
fifty were whichever answered fastest. Two runs against an unchanged site produced different files -
`vercel.com` and `docs.stripe.com` each drifted by a link, and the page count wobbled between 50 and
52 because requests already in flight landed after the stop. That makes a content hash worthless for
noticing real change, and quietly biases the file towards whatever a site serves quickest.

Now selection is a pure function of what the site publishes - its sitemap in file order, and page
links in document order - ranked by a total order with no ties, one section at a time. Fetching
happens afterwards and cannot alter the list; results are sorted back into plan order, so a slow
response changes when a page arrives and never whether it is included.

Discovery still goes deeper than the first page, in waves: each wave is planned from the complete
result of the one before, so following links stays deterministic. Without that, `react.dev` - which
publishes no sitemap - would see only the 21 links on its home page instead of 50 pages.

Measured, three runs each: `vercel.com`, `docs.stripe.com`, `getlago.com` and `react.dev` now
produce byte-identical files. A test does the same against a fixture server that answers with random
latency, so arrival order differs on every run and the output must not.

What is still not deterministic is honest about itself. A crawl that hits the 25-second safety valve
is marked `partial` and is not stored, because its contents depend on how fast the network was.
Failures deliberately do not count as partial: a page failing twice is nearly always a stale sitemap
entry that fails identically every run - `docs.stripe.com` loses one page and `getlago.com` two, and
every run still hashes the same.

The pacer belongs to the site rather than to us: it widens its interval on every 429, 503 or doubling
of latency and never narrows within a crawl. It changes how fast the planned pages are fetched, not
which they are.

Politeness is not only manners. Measured on `getlago.com`, four workers with a 150ms gap fetched 30
pages in **2.7s** with a p90 of 306ms; eight workers with no gap took **4.3s** with a p90 of
**2032ms**. Asking harder made the site slower to answer.

`robots.txt` is fetched and obeyed - 104 URLs skipped on `modal.com` in one crawl.

### What crawling changed

| site | links | links with a real description |
|---|---|---|
| getlago.com | 68 -> 82 | 32 -> 70 |
| docs.stripe.com | 45 -> 52 | 1 -> 30 |
| modal.com | - -> 67 | - -> 28 |

Measured against files real sites publish (`npm run integration`, 11 sites), the deterministic output
went from **7.00/15 to 8.00**, its descriptions from 1.91 to 2.64. The AI-assisted output moved much
less, from 8.55 to 8.73 - the sieve had been compensating for the missing descriptions, and now has
better raw material rather than more work to do. Coverage barely moved and remains the weak axis:
fifty pages is not a whole site.

### Three things testing changed

**Ordering by depth starved the pages worth having.** `getlago.com` keeps its documentation out of
the sitemap, so shallowest-first spent the budget on `/about-us` and `/blog`. The frontier now gives
each section a turn.

**The first fallback discarded whole crawls.** It kept whichever of crawl and single page had more
links, so a home page linking 68 pages beat a crawl of 27 and the crawl was thrown away. Crawling is
now strictly additive: the home page knows what a site points at, the crawl knows what those pages
are.

**Template descriptions are worse than none.** Sites set one description for every page - every
getlago doc claims to be "Developer documentation for Lago's API-first billing platform". A
description repeated across a fifth of the crawl is dropped, and the home page's specific note kept.

## The AI sieve

`POST /api/enhance` is the model-assisted path: everything `/api/generate` does, then two model
passes over the result. It is a separate endpoint because it differs in all three ways that matter -
it needs an account, it spends money, and it takes seconds rather than milliseconds.

**Stage one, the guide.** One call carrying the whole skeleton, returning a site summary and a
better name for each section. This is the global judgment, made once however many links there are.

**Stage two, annotation.** Links are chunked ten at a time *within a section*, four calls in flight,
each chunk carrying its section name and the stage-one summary. A chunk of links that share a
subject gets sharper notes than one mixing the API reference with the careers page.

**The sieve is the third stage, and the reason for the name.** The model proposes; deterministic
code disposes. Every proposal is checked against something already known to be true:

| proposal | accepted only if |
|---|---|
| note | it keys a URL we actually extracted, is at most 12 words, and does not restate its title |
| summary | one sentence, under 200 characters, no URL, not merely the site name again |
| section name | short, not a locale, not a duplicate of another section |
| the whole file | it still parses as a conforming llms.txt |

A hallucinated URL cannot enter the file, because notes attach by looking the URL up among the links
already extracted - an invented one has nowhere to land. Every slot the model fills is optional in
the spec, so rejecting is always safe: a dropped note leaves a link without one, which is a poorer
file and still a valid one.

The endpoint reports what survived (`notesAccepted`, `notesRejected`, `sectionsRenamed`,
`chunksFailed`), so a model that is quietly doing nothing is visible rather than inferred.

### When a call fails

Failures are told apart rather than counted together, because they call for different things:

| kind | what it is | what happens |
|---|---|---|
| `rate-limited` | 429, from the platform or every provider at capacity | up to 3 attempts, honouring `Retry-After` |
| `upstream` | 5xx | up to 3 attempts |
| `credits` | 402, the account cannot pay | stops immediately, endpoint answers 503 |
| `auth` | 401/403, key missing or rejected | stops immediately, endpoint answers 503 |
| `timeout` | our own deadline | not retried; those links keep no note |
| `unparseable` | a reply that is not usable JSON | not retried - temperature is 0, so it would repeat |

Backoff is exponential with full jitter. The jitter is the point rather than a refinement: chunks
are dispatched together, so they meet a rate limit together, and a fixed delay would send the whole
batch back in step and reproduce the burst that caused it.

An empty account is the case worth separating. It fails every chunk identically, so the run stops at
the first 402 rather than proving it a dozen more times, and the endpoint returns **503 with a
reason** instead of 200 and a quietly thinner file - that is the one failure an operator has to act
on, and it should not look like a slow model.

### Choosing the models

`npm run bench` measures the candidates on these two jobs. Not part of `npm test`: it needs a key
and a network, and its numbers move with whatever the providers are doing.

| model | chunk (median of 3) | guide | $/M in -> out |
|---|---|---|---|
| `gemini-3.5-flash-lite` | **1.28s** (1.3/1.3/1.2) | **0.67s** | 0.30 -> 2.50 |
| `gemma-4-31b-it` | 2.37s (2.2/2.4/3.3) | 1.78s | 0.09 -> 0.34 |
| `gpt-oss-120b` | 3.20s (**49.6**/3.2/0.9) | 2.01s | 0.037 -> 0.17 |
| `deepseek-v4-flash` | 7.32s | 9.73s | 0.089 -> 0.177 |

All four return valid JSON, and all four reached the same judgment on the guide task - so the choice
is latency and cost, not capability. Gemini guides because its variance is near zero; Gemma works
the chunks because its output is a third the price and that is what multiplies. `gpt-oss-120b`
spends reasoning tokens on trivial work and produced a 49.6-second outlier annotating eight links;
`reasoning: {enabled: false}` is rejected outright and low effort does not fix the tail.

Measured end to end: 8-14 seconds a site, every note accepted, roughly a quarter of a cent.

### Does the AI actually help?

`npm run integration` answers that against sites which publish their own `llms.txt`. Those files are
the ground truth this project otherwise lacks: a human, or a documentation platform, decided what
belonged in them. Sampling from [llmstxt.site](https://llmstxt.site) gives real pages, chosen by
someone other than us, with an answer key attached.

For each site it generates both files and asks a cheap model to grade each against the published one.
Eleven sites, seed 90210:

| | coverage | descriptions | structure | total |
|---|---|---|---|---|
| deterministic | 2.18 | 1.91 | 2.91 | **7.00** |
| AI-assisted | 2.45 | 2.64 | 3.45 | **8.55** |

The run also measures its own error bar. The sieve cannot add or remove links, so both candidates
point at exactly the same pages and any coverage difference is noise: it came out at **0.27**. So
descriptions (+0.73) and structure (+0.55) are real, and the coverage "gain" of +0.27 is nothing -
which is right, because nothing changed there. The AI improves the two things it is allowed to touch
and leaves the rest alone.

Absolute scores are low on purpose: the reference covers a whole site and we read one page. The
number worth watching is the gap between our own two outputs, judged identically.

**Choosing a judge is not about price.** Candidates were tested on one good and one deliberately poor
file for the same reference, keeping whichever separated them furthest:

| judge | good | bad | gap | speed | cost/1k |
|---|---|---|---|---|---|
| `nova-micro-v1` | 13/15 | 3/15 | **10** | 0.8s | $0.032 |
| `gpt-oss-20b` | 12/15 | 3/15 | 9 | 6.5s | $0.071 |
| `granite-4.0-h-micro` | 12/15 | 4/15 | 8 | 2.7s | $0.018 |
| `mistral-nemo` | 13/15 | 9/15 | 4 | 3.7s | $0.013 |

`mistral-nemo` is the cheapest and useless here: it gave a file with no descriptions and no real
sections 9 out of 15. `qwen3.7-flash` and `ling-3.0-flash` returned nothing at all - both are
reasoning models that spend the entire token budget thinking and answer with empty content.

## What gets stored

AI-assisted results are kept; nothing else is. `/api/enhance` looks in the store before fetching, so
a hit costs neither a request to the site nor a model call: react.dev takes 28.8s to generate and
0.6s to serve again, byte for byte identical.

**Globally, not per user.** The file is derived entirely from public pages, so two people asking
about the same site should get the same answer, and crawling it twice to produce identical output is
how a tool earns a site's 429s.

**Only the AI-assisted path writes.** It is the expensive one and the one behind an account. The
deterministic file is free and fast from `/api/generate`, so storing it would fill the table with
rows that save nothing - and a public endpoint that writes to durable storage is an invitation to
fill it with junk.

Only a result the models actually improved, and which still conforms to the spec, is written.

```sql
create table public.generations (
  url          text primary key,
  llms_txt     text        not null,
  content_hash text        not null,
  generated_at timestamptz not null default now()
);

alter table public.generations enable row level security;
create index generations_generated_at_idx on public.generations (generated_at);
```

RLS is enabled with **no policies at all**, so the publishable key can neither read nor write:
verified against the live project, a browser-key read returns zero rows and a browser-key insert is
refused with *"new row violates row-level security policy"*. The store uses `SUPABASE_SECRET_KEY`,
which bypasses RLS and never leaves the server - the first thing in this project to need it.

`content_hash` is written now although nothing reads it yet: it is what change detection will
compare, and adding the column later would mean a migration.

Freshness defaults to 24 hours, overridable with `GENERATION_MAX_AGE_MS`.

Storage is an optimisation, not a dependency. A missing table, a revoked key or an unreachable
database all mean "no cached answer", which is a state the endpoint already handles - verified by
running against the live project before the table existed.

## Keeping files current

A site reorganises its documentation and the file we generated for it quietly becomes wrong.
`POST /api/refresh`, called every fifteen minutes by `.github/workflows/monitor.yml`, re-checks
stored sites and rewrites the ones that moved.

**Two hashes, and the difference between them is the design.** `content_hash` fingerprints the file
we serve, which is AI-assisted: models are asked at temperature zero but not promised to be
identical, so a change there proves nothing about the site. `structure_hash` fingerprints the site -
the URLs and titles a deterministic crawl finds, sorted, with no model involved. That comparison is
why the crawler was made reproducible first.

**Cheapest first.** A site's sitemap costs one request and settles most checks, because it shows the
thing an llms.txt cares about most: pages appearing and disappearing. Only if that moved do we crawl
and fingerprint, still without a model. Only a site whose structure really changed is rewritten,
which is the only step that costs anything.

**Attention follows behaviour.** Each site carries its own interval, halved when it changes and
grown by half when it does not, bounded between an hour and a week. From a day, a busy site reaches
hourly in five checks and a quiet one weekly in five.

**A run is bounded by time and expense, not by a count of sites.** Twenty checks, at most two
rewrites, and a 45-second deadline - with a rewrite only begun when 35 seconds remain, because one
takes about thirty and the deadline cannot interrupt work already started. The first live run took 69
seconds and would have been killed mid-write by the function limit.

Three states record nothing at all, each for the same reason: a check that reached no verdict must
not look like a quiet site.

- **deferred** - the run was out of budget. Nothing is written, not even the timestamp, so the row
  keeps its place at the front of the queue and the next run takes it up. Writing the timestamp would
  make a change we had just found wait a full interval.
- **skipped** - blocked, not HTML, or a crawl cut short. The previous fingerprints stay, so a site
  that recovers is compared against what it looked like before.
- **baseline** - a row stored before it had a fingerprint. Recording the first one is not a change,
  and treating it as one would have every existing site watched twice as closely for having been
  here longest.

## Accounts

The generator is open to everyone. An account is only required for the LLM features, which cost
money per call and need an identity to attribute that to. `lib/authGate.ts` holds that rule as a
pure function, checked before the fetch rather than after - refusing once we have already spent
fifteen seconds on someone else's server wastes their bandwidth to tell us nothing.

Sign-in is email and password, through Supabase. Two details differ from every Supabase guide you
will find, because this is Next 16:

- Session refresh lives in **`proxy.ts`**, not `middleware.ts`. The middleware convention is
  deprecated and renamed in Next 16.
- `cookies()` is **async**, so the server client is async too.

The session is verified with `getUser()` rather than read from `getSession()`. getSession trusts the
cookie; getUser checks the token with Supabase. For deciding whether to spend money on an LLM call,
the cookie's own claim is not good enough.

With the Supabase variables unset the app still runs: the generator works, and the AI toggle says it
is not configured rather than offering a sign-in that cannot happen. A request for the LLM path then
gets 503, not 401 - the caller did nothing wrong and signing in would not help.

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

CI pins Node 24, and pins npm to the exact version that writes `package-lock.json`. npm decides how
the wasm fallback dependencies are laid out in the lock file, and `npm ci` rejects a layout it would
not have written. Pinning Node alone is not enough, because its bundled npm moves with patch
releases - a lock written by 11.6.2 met a runner carrying 11.19.1 and the install failed. Regenerate
the lock with `npx npm@11.19.1 install`, matching the version in `ci.yml`.

## History

The full implementation — crawler with sitemap/robots/nav parsing, headless-browser fallback for
JS-rendered pages, deterministic sectioning, a constrained LLM copyedit pass, Supabase
persistence, change detection and scheduled re-crawls — is preserved at the tag
[`v1-full-generator`](https://github.com/KeshavC217/llms-txt-keshav-chakrapani/releases/tag/v1-full-generator).

```bash
git show v1-full-generator:lib/crawler.ts   # read a file from it
git diff v1-full-generator                  # what was removed
```
