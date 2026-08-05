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
  //
  // IMPORTANT — these globs are a LITERAL file list. Next copies what they match; it does NOT
  // parse those files and follow their imports. Every transitive dependency of the worker must
  // therefore be matched by some glob here. Getting this wrong is silent: the build succeeds and
  // the worker dies at runtime. That is exactly what happened when lib/provider-timestamp.js was
  // added as a new dependency of the already-listed lib/polygon-provider.js — the worker
  // crashlooped on "Cannot find module '/app/lib/provider-timestamp.js'" and disabled itself.
  //
  // tests/runtime-artifact-modules.test.mjs recomputes the worker's real import closure from
  // source and fails if any file is not covered here, so this cannot drift again unnoticed.
  outputFileTracingIncludes: {
    "/api/healthz": ["./lib/db-schema-readiness.ts", "./lib/db.ts"],
    "/api/runtime/schema": ["./lib/db-schema-readiness.ts", "./lib/db.ts"],
    "/api/research/seed": ["./worker/**/*.ts", "./lib/research/**/*.ts", "./lib/polygon-provider.js", "./lib/provider-*.ts", "./lib/provider-*.js", "./lib/data-freshness.ts", "./lib/timestamps.ts", "./lib/trading-session.ts"],
    "/api/research/seed/[runId]": ["./worker/**/*.ts", "./lib/research/**/*.ts", "./lib/polygon-provider.js", "./lib/provider-*.ts", "./lib/provider-*.js", "./lib/data-freshness.ts", "./lib/timestamps.ts", "./lib/trading-session.ts"],
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
