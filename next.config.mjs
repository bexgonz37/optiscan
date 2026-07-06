/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Pin the tracing root to this project (a stray pnpm-lock.yaml in the home
  // dir otherwise makes Next infer the wrong workspace root).
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
