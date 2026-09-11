import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Chromium is not something to bundle.
   *
   * @sparticuz/chromium carries a ~66MB brotli-compressed browser and
   * playwright-core loads native pieces at runtime; tracing them into the
   * function output rewrites paths the packages resolve themselves and can
   * push a deployment past its size limit. Declaring them external leaves both
   * in node_modules for the function to require as-is.
   */
  serverExternalPackages: ["@sparticuz/chromium", "playwright-core"],

  /*
   * External is not the same as present.
   *
   * Declaring the two packages external stops Next bundling them, and it was
   * read as also meaning they arrive intact. They do not: the deployment ships
   * the files its static trace discovered, and neither package's runtime reads
   * are discoverable that way. playwright-core opens `browsers.json` by path
   * from its own bundle, and @sparticuz/chromium reads a compressed browser
   * out of `bin/` - so nothing pulled either in, and every render on the
   * deployment died at launch with
   *
   *   Cannot find module '/var/task/node_modules/playwright-core/browsers.json'
   *
   * which nobody saw, because renderPage caught it and returned null. resy.com
   * was recorded as an unexplained gap for a fortnight on the strength of that
   * silence.
   *
   * Scoped to the one route that renders. The browser is ~66MB compressed and
   * is extracted to /tmp at runtime; putting it in every function's trace
   * would spend the size limit on routes that never launch a browser.
   */
  outputFileTracingIncludes: {
    "/api/generate": [
      "./node_modules/playwright-core/browsers.json",
      "./node_modules/@sparticuz/chromium/bin/**",
    ],
  },
};

export default nextConfig;
