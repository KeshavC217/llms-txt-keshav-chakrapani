import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A small, self-contained website served over real HTTP on a random local
 * port, so the crawl -> extract -> section -> render pipeline can be tested
 * end to end without depending on a third-party site being up, unchanged, or
 * reachable from CI.
 *
 * Every branch the crawler has to get right is represented by a route here:
 * a nav with a dropdown and flat links, a sitemap listing pages the homepage
 * never links to, a robots.txt Disallow, a non-HTML link, a junk /login link,
 * an external link, a client-rendered SPA shell, and a page that bot-walls
 * plain fetch() but serves a real browser.
 */

export interface FixtureOptions {
  /**
   * Link the client-rendered (/spa) and bot-walled (/walled) pages from the
   * homepage. Off by default so the deterministic pipeline test stays fully
   * offline and fast — those two routes are the only ones that make the
   * crawler escalate to a real headless browser.
   */
  includeRenderPages?: boolean;
}

export interface FixtureServer {
  url: string;
  close(): Promise<void>;
  /** Every path requested so far, in order — lets a test assert what we did and didn't fetch. */
  requests: string[];
  /** Arrival time of each request, so a test can assert pacing rather than just count. */
  requestTimes: number[];
  /** How many times the throttling route answered 429. */
  throttleResponses: number;
}

function html(body: string, head = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

const NAV = `
<nav>
  <ul>
    <li><a href="/">Home</a></li>
    <li>
      <a href="/docs">Docs</a>
      <ul>
        <li><a href="/docs/getting-started">Getting Started</a></li>
        <li><a href="/docs/config">Configuration</a></li>
      </ul>
    </li>
    <li><a href="/pricing">Pricing</a></li>
    <li><a href="/login">Log in</a></li>
  </ul>
</nav>`;

const PAGES: Record<string, { title: string; description?: string; body?: string }> = {
  "/docs": { title: "Docs - Acme", description: "Everything you need to build on Acme." },
  "/docs/getting-started": { title: "Getting Started - Acme", description: "Install Acme and ship your first widget in five minutes." },
  "/docs/config": { title: "Configuration - Acme", description: "Every configuration option Acme accepts, with defaults." },
  // Reachable only via sitemap.xml — nothing on the homepage links to it.
  "/docs/api": { title: "API Reference - Acme", description: "The complete Acme HTTP API, endpoint by endpoint." },
  "/pricing": { title: "Pricing - Acme", description: "Simple per-seat pricing that starts at $0 and scales with you." },
  "/blog/post-one": { title: "Shipping Widgets Faster - Acme", description: "How the widget pipeline got three times faster this quarter." },
  "/blog/post-two": { title: "Why We Rewrote the Scheduler - Acme", description: "The scheduler rewrite, and what it cost us." },
  // No meta description anywhere — exercises the prose-sentence fallback.
  "/about": {
    title: "About - Acme",
    body: "<main><p>Acme builds widget infrastructure for teams that ship every day.</p></main>",
  },
  // Disallowed in robots.txt — must never be fetched.
  "/private/secret": { title: "Internal Roadmap - Acme", description: "Not for crawlers." },

  // Same page served at two paths with no canonical tag — deduped by
  // identical title + description, keeping the shorter URL.
  "/integrations": { title: "Integrations - Acme", description: "Connect Acme to the tools your team already runs on." },
  "/integrations.htm": { title: "Integrations - Acme", description: "Connect Acme to the tools your team already runs on." },

  // Square brackets in a title close a markdown link early; parentheses in a
  // path close the URL early. Both appear in real published llms.txt files.
  "/pricing-guide": {
    title: "Website Cost in 2026? [Complete Breakdown] - Acme",
    description: "What a widget pipeline costs to run at each tier.",
  },
  "/docs/api_(legacy)": { title: "Legacy API - Acme", description: "The pre-2.0 widget API, kept for existing integrations." },

  // Two distinct pages that a CMS gave one boilerplate description; the
  // description carries no per-page information and should be dropped.
  "/security": { title: "Security - Acme", description: "Acme: widget infrastructure for modern teams." },
  "/careers": { title: "Careers - Acme", description: "Acme: widget infrastructure for modern teams." },
};

const SITEMAP_PATHS = [
  "/",
  "/docs/getting-started",
  "/docs/config",
  "/docs/api",
  "/blog/post-one",
  "/blog/post-two",
  "/about",
  "/private/secret",
];

export async function startFixtureServer(options: FixtureOptions = {}): Promise<FixtureServer> {
  const requests: string[] = [];
  const requestTimes: number[] = [];
  // The rate-limited route answers 429 twice before serving, so a test can
  // prove the crawler waits and retries instead of dropping the page.
  const THROTTLE_TIMES = 2;
  let throttleHits = 0;
  let throttleResponses = 0;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    requests.push(path);
    requestTimes.push(Date.now());

    const send = (status: number, contentType: string, body: string) => {
      res.writeHead(status, { "Content-Type": contentType });
      res.end(body);
    };

    if (path === "/") {
      return send(
        200,
        "text/html; charset=utf-8",
        html(
          `${NAV}
           <main>
             <h1>Acme</h1>
             <p>Acme is widget infrastructure for teams that ship every day.</p>
             <a href="/about">About</a>
             <a href="/integrations">Integrations</a>
             <a href="/integrations.htm">Integrations (legacy URL)</a>
             <a href="/security">Security</a>
             <a href="/rate-limited">Popular Page</a>
             <a href="/pricing-guide">Pricing Guide</a>
             <a href="/docs/api_(legacy)">Legacy API</a>
             <a href="/careers">Careers</a>
             <a href="/legacy-pricing">Pricing (old link)</a>
             <a href="/blog/post-one">Shipping Widgets Faster</a>
             <a href="/whitepaper.pdf">Whitepaper (PDF)</a>
             ${options.includeRenderPages ? '<a href="/spa">Dashboard</a><a href="/walled">Changelog</a><a href="/dashboard">Analytics</a>' : ""}
             <a href="https://external.example.com/partner">A partner</a>
             <a href="mailto:hi@acme.test">Email us</a>
           </main>`,
          `<title>Acme - Widget Infrastructure</title><meta name="description" content="Acme is widget infrastructure for teams that ship every day.">`
        )
      );
    }

    // Apex-to-www style redirect: entering here must end up crawling "/",
    // and every emitted URL must be post-redirect.
    if (path === "/start-here") {
      res.writeHead(301, { Location: baseUrl() + "/" });
      return res.end();
    }

    // Answers 429 with Retry-After the first few times, then serves normally.
    if (path === "/rate-limited") {
      if (throttleHits++ < THROTTLE_TIMES) {
        throttleResponses++;
        res.writeHead(429, { "Content-Type": "text/html", "Retry-After": "1" });
        return res.end("slow down");
      }
      return send(
        200,
        "text/html; charset=utf-8",
        html("<main><h1>Rate Limited Page</h1></main>", `<title>Popular Page - Acme</title><meta name="description" content="The page everyone asks for at once.">`)
      );
    }

    if (path === "/robots.txt") {
      return send(
        200,
        "text/plain",
        [`User-agent: *`, `Disallow: /private/`, ``, `Sitemap: ${baseUrl()}/sitemap.xml`].join("\n")
      );
    }

    if (path === "/sitemap.xml") {
      const urls = SITEMAP_PATHS.map((p) => `<url><loc>${baseUrl()}${p}</loc></url>`).join("");
      return send(200, "application/xml", `<?xml version="1.0"?><urlset>${urls}</urlset>`);
    }

    if (path === "/whitepaper.pdf") {
      return send(200, "application/pdf", "%PDF-1.4 not really a pdf");
    }

    if (path === "/login") {
      return send(200, "text/html", html("<h1>Log in</h1>", "<title>Log in - Acme</title>"));
    }

    // A client-rendered page: the initial HTML is an empty shell, and the real
    // title/description only exist after the browser runs the script.
    if (path === "/spa") {
      return send(
        200,
        "text/html; charset=utf-8",
        html(
          `<div id="root"></div>
           <script>
             document.title = "Dashboard - Acme";
             var meta = document.createElement("meta");
             meta.name = "description";
             meta.content = "Watch every widget run in real time, with per-stage timings.";
             document.head.appendChild(meta);
             document.getElementById("root").innerHTML =
               "<main><h1>Dashboard</h1><p>Watch every widget run in real time, with per-stage timings and a live event feed for each pipeline.</p></main>";
           </script>`,
          `<title>Loading…</title>`
        )
      );
    }

    // The realistic JS-app case, and the one the thin-content heuristic
    // misses: the shell is NOT empty — it ships a nav, a footer and a cookie
    // banner, comfortably over the 200-character threshold — but every word
    // of actual content arrives from JS *after* load, the way a React app
    // that fetches on mount behaves. A crawler that only escalates on an
    // empty shell sees the chrome, decides the page is fine, and indexes a
    // generic title with no description.
    if (path === "/dashboard") {
      return send(
        200,
        "text/html; charset=utf-8",
        html(
          `<nav><a href="/">Home</a><a href="/docs">Documentation</a><a href="/pricing">Pricing</a>
             <a href="/about">About us</a><a href="/security">Security</a></nav>
           <div id="root"></div>
           <footer>Acme Inc. All rights reserved. Terms of service, privacy policy, cookie
             settings, and our accessibility statement are available in the footer navigation.
             This site uses cookies to improve your experience.</footer>
           <script>
             setTimeout(function () {
               document.title = "Analytics Dashboard - Acme";
               var m = document.createElement("meta");
               m.name = "description";
               m.content = "Track widget throughput, error rates and per-stage latency in real time.";
               document.head.appendChild(m);
               document.getElementById("root").innerHTML =
                 "<main><h1>Analytics Dashboard</h1><p>Track widget throughput, error rates and per-stage latency across every pipeline you run.</p></main>";
             }, 250);
           </script>`,
          `<title>Acme</title>`
        )
      );
    }

    // A bot wall: plain fetch() gets a 403 challenge page, a real browser gets
    // the content. Browsers send Sec-Fetch-* headers; node's fetch does not.
    if (path === "/walled") {
      if (!req.headers["sec-fetch-mode"]) {
        return send(403, "text/html", html("<h1>Checking your browser…</h1>", "<title>Just a moment...</title>"));
      }
      return send(
        200,
        "text/html; charset=utf-8",
        html(
          "<main><h1>Changelog</h1><p>Every release of Acme, newest first, with upgrade notes.</p></main>",
          `<title>Changelog - Acme</title><meta name="description" content="Every release of Acme, newest first, with upgrade notes.">`
        )
      );
    }

    // Declares /pricing as its canonical URL, so it must not appear as a
    // second entry alongside it.
    if (path === "/legacy-pricing") {
      return send(
        200,
        "text/html; charset=utf-8",
        html(
          "<main><h1>Pricing</h1></main>",
          `<title>Pricing - Acme</title><link rel="canonical" href="${baseUrl()}/pricing"><meta name="description" content="Simple per-seat pricing that starts at $0 and scales with you.">`
        )
      );
    }

    const page = PAGES[path];
    if (page) {
      const head = `<title>${page.title}</title>${
        page.description ? `<meta name="description" content="${page.description}">` : ""
      }`;
      return send(200, "text/html; charset=utf-8", html(page.body ?? `${NAV}<main><h1>${page.title}</h1></main>`, head));
    }

    return send(404, "text/html", html("<h1>Not found</h1>", "<title>404</title>"));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  function baseUrl(): string {
    return `http://127.0.0.1:${port}`;
  }

  return {
    url: baseUrl(),
    requests,
    requestTimes,
    get throttleResponses() {
      return throttleResponses;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
