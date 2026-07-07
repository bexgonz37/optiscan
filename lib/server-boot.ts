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
    const cleared = require("@/lib/notifications").enforceDiscordAutoSend();
    if (cleared > 0) console.info(`[discord] auto-send enforced; cleared ${cleared} pending_confirm event(s)`);
  } catch (err) {
    console.warn("[discord] auto-send enforcement skipped:", (err as Error)?.message);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSettingNum, setSetting } = require("@/lib/alert-store");
    const rate = getSettingNum("scanner_min_rate_pct_min", 0.12);
    const surge = getSettingNum("scanner_min_vol_surge", 1.25);
    if (rate >= 0.17 || surge >= 1.35) {
      setSetting("scanner_min_rate_pct_min", "0.12");
      setSetting("scanner_min_vol_surge", "1.25");
      setSetting("scanner_min_efficiency", "0.28");
      setSetting("scanner_min_level_surge", "1.15");
      setSetting("alert_min_momentum_score", "58");
      console.info("[0dte-loop] calibrated scanner thresholds to recommended callout gates");
    }
  } catch (err) {
    console.warn("[0dte-loop] threshold calibration skipped:", (err as Error)?.message);
  }
}
