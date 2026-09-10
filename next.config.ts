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
};

export default nextConfig;
