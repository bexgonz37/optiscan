/**
 * instrumentation.ts — Next.js server-startup hook (stable in Next 15).
 * Background loops are started from lib/server-boot.ts on first API hit so dev
 * webpack does not try to bundle better-sqlite3 into the instrumentation graph.
 */
export async function register() {
  // Intentionally empty — see lib/server-boot.ts
}
