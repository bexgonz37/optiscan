/**
 * instrumentation.ts — Next.js server-startup hook (stable in Next 15).
 * Starts the Alert Lab checkpoint sweeper AND the every-second 0DTE scanner
 * loop inside the long-lived Node process. Skipped during `next build` and in
 * non-Node runtimes. Both systems degrade gracefully if better-sqlite3 or the
 * API key is missing — the UI keeps working.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    const { startAlertTracker } = await import("@/lib/alert-tracker");
    startAlertTracker();
  } catch (err) {
    console.warn("[alert-lab] tracker not started:", (err as Error)?.message);
  }
  try {
    const { startScannerLoop } = await import("@/lib/scanner-loop");
    startScannerLoop();
  } catch (err) {
    console.warn("[0dte-loop] not started:", (err as Error)?.message);
  }
}
