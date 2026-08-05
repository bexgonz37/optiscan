/**
 * instrumentation.ts — Next.js server-startup hook (stable in Next 15).
 * Background loops are started from lib/server-boot.ts on first API hit so dev
 * webpack does not try to bundle better-sqlite3 into the instrumentation graph.
 */
export async function register() {
  // Production VPS/Docker: start scanner + tracker immediately (no browser hit needed).
  if (process.env.NODE_ENV !== "production") return;
  try {
    // A LITERAL specifier, so webpack emits server-boot as a lazy chunk and Next
    // traces it deterministically into the standalone build. The previous version
    // built a runtime path to lib/server-boot.ts and told the bundler to skip it:
    // nothing could trace that, the .ts never reached the image, and every
    // production boot logged "server boot skipped" instead of starting the
    // background runtime. Raw .ts could not have loaded anyway — server-boot uses
    // require("@/lib/..."), which only the bundler resolves.
    //
    // better-sqlite3 stays out of the bundle graph via serverExternalPackages in
    // next.config.mjs, and this import is only reached in production, so the dev
    // server still never pulls sqlite through instrumentation.
    const { ensureServerBoot } = await import("@/lib/server-boot");
    ensureServerBoot();
    console.info("[optiscan] scanner + alert tracker started at process boot");
  } catch (err) {
    console.warn("[optiscan] server boot skipped:", (err as Error)?.message);
  }
}
