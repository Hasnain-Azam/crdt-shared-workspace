import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the workspace root so stray lockfiles in parent directories are not mistaken for it.
  outputFileTracingRoot: path.resolve("."),
  // Linting runs as its own step (`npm run lint`) with typescript-eslint.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
