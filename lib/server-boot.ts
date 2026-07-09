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
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/lib/paper-engine").startPaperEngine();
  } catch (err) {
    console.warn("[paper] engine not started:", (err as Error)?.message);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cleared = require("@/lib/notifications").enforceDiscordAutoSend();
    if (cleared > 0) console.info(`[discord] auto-send enforced; cleared ${cleared} pending_confirm event(s)`);
  } catch (err) {
    console.warn("[discord] auto-send enforcement skipped:", (err as Error)?.message);
  }
  // (removed) A boot-time block used to force-lower scanner gates to
  // 0.12%/min / 1.25x on every start — it silently undid any tightening the
  // user saved in Settings and was a root cause of the noisy-callout audit
  // (2026-07-07: 7% hit rate @5m). Settings are user-owned; defaults live in
  // scanner-loop env fallbacks only.
}
