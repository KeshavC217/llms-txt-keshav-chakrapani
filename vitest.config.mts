import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors tsconfig's path alias so the API route's "@/lib/..." imports
    // resolve when the route handler is imported directly by a test.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Integration tests each stand up their own HTTP server and (for the
    // render suite) a headless browser; running whole files in parallel makes
    // those fight over ports and CPU, so keep file-level concurrency modest.
    maxConcurrency: 4,
  },
});
