/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingRoot: process.cwd(),
  async redirects() {
    return [
      { source: "/scanner", destination: "/?tab=research", permanent: true },
      { source: "/guide", destination: "/settings#help", permanent: true },
      { source: "/review", destination: "/alerts?tab=history#how-it-works", permanent: true },
      { source: "/stocks", destination: "/", permanent: true },
      { source: "/now", destination: "/", permanent: true },
      { source: "/alert-lab", destination: "/alerts", permanent: true },
    ];
  },
};

export default nextConfig;
