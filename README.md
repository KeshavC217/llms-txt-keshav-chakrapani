# llms.txt Generator

**Live: <https://llms-txt-keshav-chakrapani.vercel.app>**

A tool that generates an [`llms.txt`](https://llmstxt.org) file for a website, and keeps it up to
date as the site changes.

You enter a URL. If the site publishes its own `llms.txt`, that is the answer and it costs one
request. Otherwise the server crawls the site — sitemap and links, paced by what the site tolerates,
obeying `robots.txt` — extracts what each page says about itself, groups the result into sections,
runs two model passes over it, and stores what it produced. A scheduled job re-checks stored sites
and rewrites the ones that have moved.

## Setup

```bash
npm install
cp .env.example .env    # then fill it in; see Environment below
npm run dev
```

Open <http://localhost:3000> and enter a URL.

Nothing is strictly required to *run* the app, but the parts each variable switches on are not
optional to the product:

| without | what happens |
|---|---|
| `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` | there are no accounts, so generating answers 503 |
| `SUPABASE_SECRET_KEY` | nothing is stored, so nothing is monitored and the saved list is empty |
| `OPENROUTER_API_KEY` | the file is built deterministically, with no summary or per-link notes |

A first run also needs the table: apply [`db/schema.sql`](db/schema.sql) in the Supabase SQL editor.

## How it works

```
TEMPLATE.txt             the target shape, and the rules the extractor follows
db/schema.sql            the one table, and the two migrations that grew it
app/
  page.tsx               the saved list, server-rendered; Generator.tsx is the client half
  login/                 email + password sign-in
  api/generate/route.ts  POST { url } -> published? -> crawl -> models -> store
  api/saved/route.ts     GET the saved list, or one file. No account needed.
  api/refresh/route.ts   POST, cron-authenticated: re-check what is due
proxy.ts                 refreshes the Supabase session (Next 16's middleware)
lib/
  deadline.ts            one clock for the request, so the steps cannot outlast it
  fetchPage.ts           one page, with the SSRF guard and the block detector
  blocks.ts              telling a challenge page from a real one
  published.ts           finding and recognising a site's own llms.txt
  crawl/
    crawl.ts             the crawl itself: discover, plan, fetch, collect
    plan.ts              what to fetch, decided before anything is fetched
    sitemap.ts           sitemap and sitemap-index discovery
    robots.ts            parsing robots.txt and applying it
    pacer.ts             how fast this site is willing to be asked
    url.ts               one address per page
  pageMeta.ts            what a crawled page says about itself
  buildFromCrawl.ts      crawled pages -> the same Extraction shape
  grouping.ts            links -> sections, and the caps that keep a file curated
  naiveExtractor.ts      a page -> { siteName, summary, sections } -> llms.txt
  dom.ts                 HTML -> a small tree that can be measured
  nlp.ts                 tokenizing, stemming, overlap, sentence splitting
  ai/                    the guide pass, the annotation pass, and the sieve
  spec.ts                the llmstxt.org grammar: escaping out, parsing back
  monitor.ts             fingerprints and the per-site check interval
  store.ts               the generations table
tests/
  fixtures.ts            mock pages, one per genre the extractor meets
  *.test.ts              node:test suites, run with `npm test`
```

`POST /api/generate` takes `{ "url": "example.com", "regenerate": false }` and returns:

```json
{
  "url": "https://example.com/",
  "llmsTxt": "# Example\n\n> ...\n\n## Docs\n\n- [Quickstart](...): ...\n",
  "crawl": { "pages": 50, "planned": 49, "failed": 0, "partial": false },
  "report": { "notesAccepted": 44, "sectionsRenamed": 3, "chunksFailed": 0 },
  "spec": { "valid": true, "issues": [] },
  "stored": true
}
```

Three other shapes come back from the same endpoint: a stored file (`saved: true`, with
`generatedAt`), a site's own file (`source: "published"`, with `publishedAt`), and a refusal
(`blocked`, with the kind of block). `regenerate: true` skips both short circuits and crawls.

`TEMPLATE.txt` defines what is being aimed at, generalized from the spec at
[llmstxt.org](https://llmstxt.org) and from 22 files sampled off
[llmstxt.site](https://llmstxt.site). The generated file is:

```
# Site name                  og:site_name, og:title, <title>, <h1>, then the hostname
> one-sentence summary       meta description, og:/twitter: variants, or the AI guide pass

orienting prose              optional, and omitted rather than padded

## Section name              a nav heading, or the shared path segment
- [title](url): note         the page's own <title> and description, or an AI note

## Optional                  pages that exist but are rarely what an agent came for
- [title](url): note
```

### What the extractor infers

The extractor sees one document at a time and no model. It runs first on the page you gave, which
supplies the site name, the summary and the orienting prose; the crawl then feeds it every other
page. Everything here is inferred from structure and word overlap.

- **Boilerplate.** Link density decides what is navigation: a nav is nearly all link text, a
  paragraph is nearly none. Chrome is read for its *links* and discarded for its prose, so menus
  no longer land in the body.
- **Sections.** Links group by shared path segment, and the grouping goes a segment deeper when
  one bucket would swallow most of the page — otherwise every documentation site collapses into a
  single `/docs` section. Locale segments are skipped, so `/docs/en/...` is not a section called
  "En". Names come from the page's own nav headings when one covers the group in both directions,
  else from the segment itself.
- **Duplicates.** URLs are canonicalized (fragment, trailing slash, tracking parameters, scheme) and
  titles compared by stemmed token overlap, so "Pricing" and "Our Pricing" collapse to the shorter.
  One canonicaliser, in `lib/crawl/url.ts` — there were three, and they disagreed.
- **One entry per page.** A query string is usually a variant rather than a page: `airbnb.com`
  linked its gift-card page ten times as `?card_name=arctic`, `&baths`, `&cozy`, and an entire
  section of the file was one page under ten spellings. It cannot simply be dropped, because
  `en.wikipedia.org` addresses every article as `/w/index.php?title=X`. What separates them is the
  title, which the crawler has because it fetched the page: same address and same page-name is one
  link, same address and different names is several. Titles are matched by containment rather than
  equality, since the same page arrives as "Connections" from a link and "Connections - Group words
  that share a common thread" from its own `<title>`.
- **Operations are not pages.** `?action=edit`, `?action=history`, `?printable=yes`,
  `?mobileaction=`, `?oldid=` and their siblings are dropped. Thirteen of the fifty-two links
  generated for `en.wikipedia.org` were these — "Revision history", "Printable version", "Switch to
  legacy parser". An llms.txt says what a site contains; it should never point an agent at an edit
  form. `action` is matched on its value, because plenty of sites use `?action=` for real content.
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

Two things the spec recommends that this does not do. It asks that links point at markdown versions
of pages; we cannot know a `.md` twin exists without fetching it, and inventing those URLs would
mean emitting links we have never seen. And where a page advertises
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
| 200 with an empty shell | `docs.convex.dev` | a real browser, which this does not have |

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

**No browser.** There was one, behind a `RENDER_ENDPOINT` env var pointing at a Browserless-style
service, and it was removed rather than kept as an option. It had never run - the variable was set in
no environment - and the measurement below is why it would not have helped where it was aimed:
headless browsers do not get past a challenge, and a server has no screen. What it could genuinely
fix is the third row, application shells, which is a real but narrower problem than the code implied.

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

### One site this does not solve: resy.com

Rendering fixes `docs.convex.dev` everywhere - 0 links from a fetch, 25 in the generated file, on the
deployment as well as a laptop. `resy.com` is fixed only on a laptop.

| where | result |
|---|---|
| laptop, headless Chromium | 222 links |
| laptop, through the full pipeline | 39 rendered, 42 in the file |
| the Vercel deployment | **0 links, in about three seconds** |

Three seconds is the finding rather than the zero: a render takes ten or more, so on the deployment
the browser is not producing anything for this site. Chromium itself is fine there - convex proves
that on the same deploy - so it is something about resy and that address, most likely its bot
protection treating a datacentre differently from a residential connection. That has not been
demonstrated, and it is recorded here as unexplained rather than dressed up.

One thing that is **not** the explanation, though it looked like it: the `>` line differing between
runs. That is written by the model, not read from the page, so two runs of the same site produce two
summaries. It was briefly mistaken for the site serving different content, which it is not.

Sites that need a browser and are reachable are handled. This one is left as a known gap.

### Known limits

**`/w/index.php?title=X` is a program, not a directory.** Stripping `index.php` is right for
`/docs/index.html` and wrong for a script invocation — it invented an address we had never fetched,
and Wikipedia came out with both spellings of the same page in one file. The strip now only happens
when there is no query string.

**Nothing ranks pages by importance.** Within a section the plan orders by depth, then sitemap
position, then alphabetically. With 4,693 candidates on `docs.stripe.com` and a budget of 50, that
is the difference between a useful file and an arbitrary one, and it is what holds the coverage
score down. The signals to fix it are already in hand and unused: whether the home page links to a
page, its prominence in the nav, how many crawled pages link to it, its depth, whether it carries a
description of its own.

**A slow site used to outlast the function.** Fixed; see [One clock for the request](#one-clock-for-the-request).

**A link with no note is left without one.** The template's rule is to omit rather than invent. The
crawl fetches every page it lists, so most links now carry the page's own description; where a site
sets one boilerplate description for its whole domain, that is detected and dropped rather than
repeated down the file, and the models fill the gap or nothing does.

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

Measured against files real sites publish (`npm run integration`), reading the site rather than the
page took the deterministic output from **7.00/15 to 8.00** and its descriptions from 1.91 to 2.64.
The AI-assisted output moved much less, 8.55 to 8.73 - the sieve had been compensating for the
missing descriptions and now has better raw material rather than more work to do. Coverage barely
moved and remains the weak axis: fifty pages is not a whole site.

Those four numbers are the last measurement taken while there were two outputs to compare, kept
because the comparison is the point. The current figure, one endpoint and a different sample, is
under [Is the output any good?](#is-the-output-any-good) below.

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

## One clock for the request

Every step had its own timeout and nothing bounded their sum. Each number was defensible alone -
10s to fetch the page, 5s to look for a published file, 4s for `robots.txt`, 8s for a sitemap, 25s
of crawling, 35s of models - and together they were roughly twice the sixty seconds a Vercel
function is allowed.

So on a slow site the platform killed the process partway through, which is the worst of the
outcomes available:

- the caller gets Vercel's own timeout page rather than JSON, so the interface can only say
  *"something went wrong"*;
- nothing is stored, because the write is the last line of a handler that was never reached;
- and since nothing is stored, the next attempt starts from the beginning and dies in the same
  place. **A site slow enough to trip this could never acquire a file at all**, however many times
  anyone asked.

That last one is why it is a bug rather than a slow path.

`lib/deadline.ts` is one clock, started when the request arrives and passed down. Every network step
takes the shorter of its own cap and what is left, and the handler returns what it has when the
clock runs out.

### What actually took seventy seconds

The obvious culprit was the crawl asking the wrong question. It checked *has the budget elapsed*
before starting a page, so a worker that passed with a tenth of a second to spare still had a full
page timeout ahead of it. It now asks whether a page can still be started at all, and the page's own
abort signal is the shorter of its cap and the remainder - so a page begun late is aborted exactly
on the deadline rather than past it.

That was not the big one. `news.ycombinator.com` asks for a **ten-second crawl delay** in its
robots.txt, which is honoured; the pacer's queue is shared, so with four workers the fourth worker's
turn is forty seconds away - and `pacer.wait()` slept for all of it without consulting any budget.
The retry after a failed page did it a second time. A crawl budgeted at twenty seconds took seventy.

`Pacer.wait()` now takes the deadline and returns false when the turn would arrive too late, so the
worker stops instead of sleeping. A refused turn does not consume a slot, or the next worker would
wait for a request that is never sent.

| site | before | after |
|---|---|---|
| `news.ycombinator.com` | 71.2s, killed, no file | 28.4s, 4 pages, 23 notes |
| `airbnb.com` | 27.9s | 37.9s, 47 of 49 pages |
| `nytimes.com` | 60.9s at the ceiling | 38.0s, 32 pages |
| `en.wikipedia.org` | 21s | 21.2s, complete |

Hacker News gets four pages because it asked to be crawled once every ten seconds and that is what
fifty seconds buys. Four pages with real notes is a file; a timeout is not.

### A partial file is stored, without a fingerprint

Refusing to store one was tried and undone: it recreates the dead zone the deadline exists to
remove, since a site that always runs out of time would always be partial and so would never
acquire a file. It also puts back the "was the crawl complete" condition that was deliberately
removed when saving stopped having conditions.

What must not be stored is the **structure hash**. Which pages a truncated crawl holds depends on
how fast the site was that day, so a fingerprint taken from one would report a change on every
subsequent check and the site would be rewritten forever. A null hash already means "no baseline" to
the monitor, which takes a fresh one from its own complete crawl later.

The response carries `partial: true` and the interface says so, with the page counts and a way to
try again.

## The AI sieve

Two model passes run over every crawl, inside `/api/generate`.

They used to live behind a second endpoint, `/api/enhance`, with the first serving a free
deterministic file. That is gone: two routes did the same work up to the last step, returned two
different answers for the same URL, and put a toggle in front of people asking them to choose
between a good file and a better one. `lib/ai/enhance.ts` is the pass; there is one endpoint.

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
`chunksFailed`), so a model that is quietly doing nothing is visible rather than inferred. The
interface says it in words: *"44 notes, 3 sections renamed"*, not *"AI enabled"*.

With no `OPENROUTER_API_KEY` the passes are skipped and the deterministic file is served, which is
also what happens when the models return nothing usable.

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

### Is the output any good?

`npm run integration` answers that against sites which publish their own `llms.txt`. Those files are
the ground truth this project otherwise lacks: a human, or a documentation platform, decided what
belonged in them. Sampling from [llmstxt.site](https://llmstxt.site) gives real pages, chosen by
someone other than us, with an answer key attached.

Eight sites, seed 90210, judged by `nova-micro-v1`:

| coverage | descriptions | structure | total |
|---|---|---|---|
| 2.13 | 3.44 | 3.13 | **8.69** / 15 |

All eight conformed to the grammar. Median time to generate was 26 seconds.

**Coverage is the weak axis and the honest one.** The reference describes a whole site; we crawl
fifty pages. Nothing in the pipeline yet asks which fifty *matter* - within a section the plan
orders by depth, then sitemap position, then alphabetically - so on a large site the budget is spent
arbitrarily rather than badly. That is the next thing worth building, and it is why descriptions and
structure score a point and a half higher than coverage does.

**The error bar is measured rather than assumed.** This used to grade two candidates - a free
deterministic file and the AI-assisted one - and the number that mattered was the gap between them.
With one endpoint there is one candidate, so instead every file is graded twice by the same judge at
temperature 0, and the disagreement between those gradings is the noise floor: **0.63 / 15**. Any
change smaller than that means nothing.

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

## Generating and reading

**Generating requires an account.** It crawls someone else's site and spends money on models, so it
is not something to leave open to the internet. `POST /api/generate` is the only way to make a file,
and it always crawls, always runs the models, and always saves what it produced.

**Reading needs no account.** `GET /api/saved` lists what has been generated; `GET /api/saved?url=...`
returns one file. Those files describe public pages and were built from public pages, so there is
nothing in them to protect. The home page shows the list to anyone.

**Saving has no conditions.** If a signed-in person generates a site, the result is kept. An earlier
version weighed four of them - was the crawl complete, did the models help, does it conform, is a
store configured - and the effect was that a file could quietly fail to be kept for reasons nobody
could see from outside. Requiring an account is what keeps the table honest; nothing else needs
guarding.

It is not a cache and has no expiry. A saved file is what that site's llms.txt *is*, until something
replaces it: a person asking for a fresh one, or the scheduled check noticing the site moved.

The table is [`db/schema.sql`](db/schema.sql): the four original columns, the seven the monitor
added, and `source`/`published_at` for telling a site's own file from ours. It is idempotent, so it
doubles as the migration for a deployment that predates either change.

`lib/store.ts` used to tolerate an older schema, falling back to the original four columns when
PostgREST reported one it did not know - selecting a missing column returns *nothing at all* rather
than a partial row, which emptied the saved list the first time this was deployed ahead of its
migration. That was worth having while the schema lived only in someone's memory. Now that the file
above is the record, the fallback defended a state that no longer occurs and would hide a real
misconfiguration behind a silently partial row, so it is gone. **Run `db/schema.sql` before the
first deploy.**

RLS is enabled with **no policies at all**, so the publishable key can neither read nor write:
verified against the live project, a browser-key read returns zero rows and a browser-key insert is
refused with *"new row violates row-level security policy"*. Everything goes through the server using
`SUPABASE_SECRET_KEY`, which bypasses RLS and never leaves it.

A site that publishes its own llms.txt is saved too, with `source: "published"` and the address it
was read from. Marked rather than merged: the saved list says which files this project wrote and
which it merely found, and the scheduled check knows to re-read their file rather than crawl the
site and replace someone's curation with our guess.

## Keeping it up to date

A file that was right when it was generated is wrong the moment the site is reorganised, so stored
sites are re-checked on a schedule and the ones that moved are rewritten.

**Work is done cheapest first**, because most checks find nothing:

| tier | cost | what it settles |
|---|---|---|
| the site's own `llms.txt`, if the row is one | 1 request | did their file change |
| the sitemap's fingerprint | 1 request | did the page list change |
| a crawl, fingerprinted without any model | ~9s | did the structure change |
| regenerate | ~30s | write the new file |

A tier only runs when the one above it was inconclusive. A sitemap that has not moved settles a site
in about half a second, which is what makes checking hundreds of sites affordable.

**Each site carries its own interval.** It halves when a check finds a change and grows by half when
it does not, bounded by `MONITOR_MIN_INTERVAL_HOURS` (1) and `MONITOR_MAX_INTERVAL_HOURS` (168). A
docs site that ships daily converges on being checked daily; a static marketing page drifts out to
weekly. A row that has never been fingerprinted records its first one as a *baseline* rather than a
change — otherwise every pre-existing row would halve its interval on the first pass and be watched
twice as closely for having been there longest.

**The loop lives in GitHub Actions, the crawling lives on Vercel.** `.github/workflows/monitor.yml`
calls `POST /api/refresh` until it reports nothing left due. A serverless function on this plan is
killed at 60 seconds, so one call can only handle a slice of the queue; the runner has six hours.
The crawling deliberately stays on the deployment - that is where the credentials already are, and
requests from a shared CI address are far more likely to meet an anti-bot challenge than requests
from the app's own host.

To set it up, add two repository secrets:

```
APP_URL       https://your-deployment.vercel.app
CRON_SECRET   the same value as the deployment's CRON_SECRET (openssl rand -hex 32)
```

`/api/refresh` compares the bearer token in constant time and answers 401 without one. Run it by
hand from the Actions tab (`workflow_dispatch`) rather than waiting for the schedule.

**The schedule is a ceiling, not a promise.** The cron reads `2-59/5` - every five minutes, offset
off the hour because GitHub documents that scheduled events are delayed under load and that "high
load times include the start of every hour". In practice a low-activity repository sees far fewer:
this one has been running roughly every four hours. GitHub also disables schedules on repositories
with no activity for 60 days, without saying so. Anything that has to be reliable belongs on a real
scheduler; this is the free one.

**A run is bounded by expense, not by a count of sites.** `MONITOR_CHECKS_PER_RUN` (40) and
`MONITOR_REGENERATIONS_PER_RUN` (2) are separate because the two cost two orders of magnitude apart,
and a run declines to *begin* a regeneration it has not the time to finish - the first live run took
69 seconds and would have been killed mid-write. A regeneration that gets deferred deliberately does
not record the new sitemap fingerprint: recording it would make the next run's cheap tier say
"unchanged" and the change would be lost.

**A partial crawl is never recorded.** One cut short by its safety valve depends on how fast the
network was, and comparing against it would report a change every run.

## Accounts

Sign-in is email and password, through Supabase. Two details differ from every Supabase guide you
will find, because this is Next 16:

- Session refresh lives in **`proxy.ts`**, not `middleware.ts`. The middleware convention is
  deprecated and renamed in Next 16.
- `cookies()` is **async**, so the server client is async too.

The session is verified with `getUser()` rather than read from `getSession()`. getSession trusts the
cookie; getUser checks the token with Supabase. For deciding whether to spend money on a crawl and
two model passes, the cookie's own claim is not good enough - and the difference is not theoretical:
altering the last six characters of a real token is refused by one and accepted by the other.

With the Supabase variables unset the app still runs and still reads: the saved list and every saved
file are served as normal, and generating answers 503 rather than 401, since the caller did nothing
wrong and there is no account for them to sign in to.

## Tests

```bash
npm test          # 171 tests, node --test, no framework and no dependencies
npm run lint
npm run typecheck
```

All three run in CI on every pull request. Two more need a key and a network, so they do not:
`npm run bench` times the candidate models, and `npm run integration` grades the output against
sites that publish their own file (it needs `npm run dev` in another terminal and the
`TEST_ACCOUNT_*` credentials, since generating is gated).

Node 24 runs TypeScript directly, so the suites are `.ts` and import the modules they test. That is
why `lib` modules import each other by full filename (`./dom.ts`) and why type-only imports carry an
inline `type` marker: Node strips types when it runs a file and cannot otherwise tell an interface
from a value.

`tests/fixtures.ts` holds mock pages, one per genre the extractor actually meets - a documentation
site with a sidebar and cards, a marketing site reaching one page by four URLs, an application
shell, locale-prefixed paths, a chrome-heavy page, and deliberately malformed markup. Several encode
a specific bug found against live sites, so a regression has somewhere to fail loudly.

**The routes are tested as functions.** `tests/routes.test.ts` calls each handler with a `Request`
and stubs the two things a unit test must not reach - the network and the store - so what is
asserted is the handler's own decisions: the gate refusing a signed-out caller *before* the fetch
(a stub that throws on any request is what proves the order), a stored file served without
crawling, `regenerate` skipping it, a site's own llms.txt saved as theirs rather than as ours, and
`/api/refresh` answering 401 to a token of the wrong length rather than letting `timingSafeEqual`
throw.

Two things had to give way for that. `lib/monitor.ts` gained `RunBudget`, which was arithmetic
closed over two mutable counters inside the refresh loop - the one part of monitoring most worth
testing and the one part that could not be. And `tests/setup.mjs` registers a resolve hook, because
route handlers import through the `@/` alias (a tsconfig `paths` entry Next resolves at build time
and Node knows nothing about) and import `next/server` (a package with no `exports` map, so Node
will not guess the `.js`). Both are resolution problems rather than behaviour, so they are fixed in
the runner rather than by contorting the routes to suit it.

The tests were checked by breaking the code: moving the auth gate after the fetch, ignoring
`regenerate`, mislabelling a published file as generated, and removing the length guard before
`timingSafeEqual` each fail exactly one test.

Writing them found five real defects: `<p>` inside a `<div>` closed the `<div>` (the implicit-close
table was keyed backwards), `stem("guides")` did not match `stem("guide")`, `stripBrandSuffix` left
a two-word brand in place, deduping a link kept the nav copy and threw away the card's description,
and a card description was repeated as orienting prose.

## Environment

[`.env.example`](.env.example) documents every variable with what it does and where to get it.
The short version:

| variable | what it switches on |
|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | accounts; without them generating answers 503 |
| `SUPABASE_SECRET_KEY` | the store, and therefore monitoring. Server only, never `NEXT_PUBLIC_` |
| `OPENROUTER_API_KEY` | the summary, the section names and the per-link notes |
| `CRON_SECRET` | `POST /api/refresh`; without it the endpoint refuses everything |
| `ALLOW_PRIVATE_CRAWL_TARGETS` | testing against a local server, past the SSRF guard |

The crawl and monitor tunables (`CRAWL_MAX_PAGES`, `MONITOR_*`) have working defaults and are
documented in `.env.example` beside the reasoning for each.

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

## Reading the history

`SEQUENCE.md` lists what was built in what order and why, one entry per merged PR. It is the
narrative the commit log cannot carry - including the two decisions that were made and then reversed
after testing failed to support them.
