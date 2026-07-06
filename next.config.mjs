/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Native module — must not be webpack-bundled (breaks fs/path in dev + API routes).
  serverExternalPackages: ["better-sqlite3"],
  // Pin the tracing root to this project (a stray pnpm-lock.yaml in the home
  // dir otherwise makes Next infer the wrong workspace root).
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
