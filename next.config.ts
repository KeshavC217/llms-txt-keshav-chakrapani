import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // playwright ships native bindings / dynamic requires that break when
  // webpack tries to bundle it into the API route — run it as a plain
  // Node.js dependency instead.
  serverExternalPackages: ["playwright"],
};

export default nextConfig;
