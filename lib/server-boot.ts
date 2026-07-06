/**
 * server-boot.ts — start background scanner + alert tracker once per Node process.
 * Called from server routes (not instrumentation) so dev webpack never bundles sqlite.
 */
let started = false;

export function ensureServerBoot(): void {
  if (started) return;
  started = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/lib/alert-tracker").startAlertTracker();
  } catch (err) {
    console.warn("[alert-lab] tracker not started:", (err as Error)?.message);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/lib/scanner-loop").startScannerLoop();
  } catch (err) {
    console.warn("[0dte-loop] not started:", (err as Error)?.message);
  }
}
