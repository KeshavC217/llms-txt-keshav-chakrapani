/**
 * Mock pages, each shaped like a genre the extractor actually meets. Several
 * encode a specific bug found while testing against live sites, so a
 * regression has somewhere to fail loudly.
 */

const wrap = (head: string, body: string) =>
  `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

/**
 * A documentation site: everything under /docs, a sidebar nav grouped by area,
 * cards carrying real descriptions, and a footer of legal links.
 *
 * Covers: grouping a segment deeper than the first, nav read for links but not
 * for prose, notes taken from cards, legal links routed to ## Optional.
 */
export const DOCS_SITE = wrap(
  `<title>Guides &amp; API - Corvid</title>
   <meta property="og:site_name" content="Corvid">
   <meta name="description" content="Corvid is a queue for background jobs that refuses to lose one.">`,
  `<header class="site-header">
     <a href="/">Corvid</a>
     <nav aria-label="Main">
       <a href="/docs/guides/quickstart">Quickstart</a>
       <a href="/docs/guides/retries">Retries</a>
       <a href="/docs/reference/queues">Queues</a>
     </nav>
   </header>
   <main>
     <h1>Corvid documentation</h1>
     <p>Corvid runs background jobs with at-least-once delivery, and keeps a durable record of every attempt so a failed job can be replayed rather than reconstructed.</p>
     <h2>Guides</h2>
     <div class="card">
       <a href="/docs/guides/quickstart">Quickstart</a>
       <p>Enqueue a first job and watch it run, in about five minutes.</p>
     </div>
     <div class="card">
       <a href="/docs/guides/retries">Retries and backoff</a>
       <p>How a failed job is retried, and how to change the schedule it uses.</p>
     </div>
     <h2>Reference</h2>
     <div class="card">
       <a href="/docs/reference/queues">Queues</a>
       <p>Every option accepted when declaring a queue, with defaults.</p>
     </div>
     <div class="card">
       <a href="/docs/reference/workers">Workers</a>
       <p>Worker lifecycle, concurrency limits and graceful shutdown.</p>
     </div>
   </main>
   <footer>
     <a href="/privacy">Privacy Policy</a>
     <a href="/terms">Terms of Service</a>
     <a href="/careers">Careers</a>
   </footer>`,
);

/**
 * A marketing site: links at the top level, a nav labelled with an imperative,
 * and the same page reachable by three URLs.
 *
 * Covers: label cleanup ("Explore Our Services" -> "Services"), duplicate
 * collapsing across trailing slash, index.html and a fragment.
 */
export const MARKETING_SITE = wrap(
  `<title>Thornbury &amp; Co</title>
   <meta property="og:description" content="A structural engineering practice working on bridges and civic buildings.">`,
  `<nav><h2>Explore Our Services</h2>
     <ul>
       <li><a href="/services/bridges">Bridges</a></li>
       <li><a href="/services/civic">Civic buildings</a></li>
       <li><a href="/services/assessment">Structural assessment</a></li>
     </ul>
   </nav>
   <main>
     <h1>Thornbury &amp; Co</h1>
     <p>We have worked on river crossings, footbridges and civic halls since 1974, and take on projects where the existing structure has to be understood before anything new is added.</p>
     <a href="/services/bridges/">Bridges</a>
     <a href="/services/bridges/index.html">Our Bridges Practice</a>
     <a href="/services/bridges#top">Bridges</a>
     <a href="/about">About</a>
   </main>`,
);

/**
 * A page whose links only exist once JavaScript runs - the shape Docusaurus
 * and other single-page docs serve to a plain fetch.
 */
export const APP_SHELL = wrap(
  `<title>Convex Developer Hub</title><meta name="generator" content="Docusaurus">`,
  `<div id="__docusaurus"></div><script src="/main.js"></script>`,
);

/**
 * A small, complete, server-rendered page with nothing to link to - the shape
 * of example.com. It has no internal links and little text, which is exactly
 * what a JavaScript shell looks like from the outside, and it is not one.
 */
export const TINY_PAGE = wrap(
  `<title>Example Domain</title>`,
  `<div>
     <h1>Example Domain</h1>
     <p>This domain is for use in documentation examples without needing permission.</p>
     <p><a href="https://www.iana.org/domains/example">Learn more</a></p>
   </div>`,
);

/**
 * Locale-prefixed paths. /docs/en/... must not produce a section called "En".
 */
export const LOCALE_SITE = wrap(
  `<title>Platform Docs</title>`,
  `<main>
     <h1>Platform</h1>
     <a href="/docs/en/build/streaming">Streaming</a>
     <a href="/docs/en/build/vision">Vision</a>
     <a href="/docs/en/models/overview">Models</a>
     <a href="/docs/en/models/pricing">Model pricing</a>
   </main>`,
);

/**
 * Hostile text: a bracket in a link title, a paragraph that begins with "##",
 * and an anchor whose only content is an icon.
 */
export const HOSTILE_PAGE = wrap(
  `<title>Edge cases</title>`,
  `<main>
     <h1>Edge [cases]</h1>
     <p>## This paragraph opens with two hashes, and is long enough to be kept as orienting prose.</p>
     <a href="/docs/one">Guide [draft]</a>
     <a href="/docs/two">Other (parens)</a>
     <a href="/docs/three"><img src="/icon.svg" alt=""></a>
   </main>`,
);

/**
 * Boilerplate-heavy: a cookie banner, an "on this page" rail and a social row,
 * all of which are text near links but none of which is content.
 */
export const CHROME_HEAVY = wrap(
  `<title>Ledger</title>`,
  `<div class="cookie-banner"><p>We use cookies to improve your experience on this website, and to understand where our visitors come from.</p></div>
   <aside class="on-this-page"><h2>On this page</h2>
     <ul><li><a href="#intro">Intro</a></li><li><a href="#usage">Usage</a></li></ul>
   </aside>
   <main>
     <h1>Ledger</h1>
     <p>Ledger reconciles payouts against bank statements, and flags the differences it cannot explain by itself for a human to look at.</p>
     <a href="/product/reconciliation">Reconciliation</a>
     <a href="/product/reporting">Reporting</a>
   </main>
   <div class="social-links"><a href="https://twitter.com/ledger">Twitter</a><a href="/rss.xml">RSS</a></div>`,
);

/** Malformed markup: unclosed tags, an unmatched close, a stray raw-text block. */
export const MALFORMED = wrap(
  `<title>Broken</title>`,
  `<main>
     <h1>Broken but readable
     <p>An unclosed heading and an unclosed paragraph, with enough words here to be treated as real prose by the extractor.
     </div>
     <script>var a = "<a href='/not-a-link'>no</a>";</script>
     <ul>
       <li><a href="/parts/one">One
       <li><a href="/parts/two">Two</a>
     </ul>
   </main>`,
);
