/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingRoot: process.cwd(),
  // The seed worker runs as a SEPARATE process (`node --experimental-strip-types
  // worker/seed-worker.ts`) that Next never imports, so tracing would prune it from the
  // standalone build. Force-include the worker entry + the TS it needs so the file exists in the
  // deployed image when the worker is enabled. (If it is ever still missing, the worker manager's
  // existence check keeps the web process healthy instead of crashing.)
  outputFileTracingIncludes: {
    "/api/research/seed": ["./worker/**/*.ts", "./lib/research/**/*.ts", "./lib/polygon-provider.js", "./lib/data-freshness.ts", "./lib/timestamps.ts", "./lib/trading-session.ts"],
    "/api/research/seed/[runId]": ["./worker/**/*.ts", "./lib/research/**/*.ts", "./lib/polygon-provider.js", "./lib/data-freshness.ts", "./lib/timestamps.ts", "./lib/trading-session.ts"],
    "/api/opportunity-cases": ["./lib/opportunity-case/**/*.ts", "./lib/strategy/**/*.ts"],
    "/api/opportunity-cases/[id]": ["./lib/opportunity-case/**/*.ts", "./lib/strategy/**/*.ts"],
    "/api/research/options/pipeline-health": ["./lib/research/options/**/*.ts", "./lib/opportunity-case/**/*.ts"],
    "/api/ai": ["./lib/ai/**/*.ts", "./lib/momentum-diagnostics.ts"],
  },
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
