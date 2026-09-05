import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle, which is what Dockerfile.vercel
  // copies. Harmless when deploying without a container.
  output: "standalone",
  // playwright ships native bindings / dynamic requires that break when
  // webpack tries to bundle it into the API route — run it as a plain
  // Node.js dependency instead.
  serverExternalPackages: ["playwright"],
};

export default nextConfig;
