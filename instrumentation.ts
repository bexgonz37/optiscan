/**
 * instrumentation.ts — Next.js server-startup hook (stable in Next 15).
 * Starts the Alert Lab checkpoint sweeper inside the long-lived Node process.
 * Skipped during `next build` and in non-Node runtimes.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    const { startAlertTracker } = await import("@/lib/alert-tracker");
    startAlertTracker();
  } catch (err) {
    // e.g. better-sqlite3 not installed yet — scanner still works without Alert Lab.
    console.warn("[alert-lab] tracker not started:", (err as Error)?.message);
  }
}
