/**
 * instrumentation.ts — Next.js server-startup hook (stable in Next 15).
 * Background loops are started from lib/server-boot.ts on first API hit so dev
 * webpack does not try to bundle better-sqlite3 into the instrumentation graph.
 */
export async function register() {
  // Production VPS/Docker: start scanner + tracker immediately (no browser hit needed).
  if (process.env.NODE_ENV !== "production") return;
  try {
    // webpackIgnore keeps better-sqlite3 out of the instrumentation bundle graph.
    const { ensureServerBoot } = await import(
      /* webpackIgnore: true */ "./lib/server-boot.ts"
    );
    ensureServerBoot();
    console.info("[optiscan] scanner + alert tracker started at process boot");
  } catch (err) {
    console.warn("[optiscan] server boot skipped:", (err as Error)?.message);
  }
}
