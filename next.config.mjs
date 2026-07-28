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
    "/api/healthz": ["./lib/db-schema-readiness.ts", "./lib/db.ts"],
    "/api/runtime/schema": ["./lib/db-schema-readiness.ts", "./lib/db.ts"],
    "/api/research/seed": ["./worker/**/*.ts", "./lib/research/**/*.ts", "./lib/polygon-provider.js", "./lib/data-freshness.ts", "./lib/timestamps.ts", "./lib/trading-session.ts"],
    "/api/research/seed/[runId]": ["./worker/**/*.ts", "./lib/research/**/*.ts", "./lib/polygon-provider.js", "./lib/data-freshness.ts", "./lib/timestamps.ts", "./lib/trading-session.ts"],
    "/api/opportunity-cases": ["./lib/opportunity-case/**/*.ts", "./lib/strategy/**/*.ts"],
    "/api/opportunity-cases/[id]": ["./lib/opportunity-case/**/*.ts", "./lib/strategy/**/*.ts"],
    "/api/research/options/pipeline-health": ["./lib/research/options/**/*.ts", "./lib/opportunity-case/**/*.ts"],
    "/api/ai": ["./lib/ai/**/*.ts", "./lib/momentum-diagnostics.ts", "./lib/metrics/**/*.ts"],
    "/api/ai/funnel-explorer": ["./lib/metrics/**/*.ts", "./lib/momentum-diagnostics.ts", "./lib/ai/**/*.ts"],
    "/api/research/brokerage-parity": ["./lib/broker/**/*.ts"],
    "/api/research/brokerage-readiness": ["./lib/broker/**/*.ts"],
    "/api/paper/lifecycle": ["./lib/paper-lifecycle.ts", "./lib/broker/**/*.ts"],
    "/api/research/discord-quality": ["./lib/research/options/delivery-quality-report.ts"],
  },
  // Only retired routes belong here. A redirect declared for a route that still
  // has a page.tsx shadows that page and makes its nav entry a dead end, so keep
  // this list in sync with app/ (tests/nav-wiring.test.mjs enforces it).
  async redirects() {
    return [
      { source: "/stocks", destination: "/watchlist", permanent: true },
      { source: "/now", destination: "/", permanent: true },
      { source: "/alert-lab", destination: "/alerts", permanent: true },
      { source: "/review", destination: "/alerts?tab=history#how-it-works", permanent: true },
    ];
  },
};

export default nextConfig;
