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
    require("@/lib/scheduler").startScheduler();
  } catch (err) {
    console.warn("[scheduler] not started:", (err as Error)?.message);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cleared = require("@/lib/notifications").enforceDiscordAutoSend();
    if (cleared > 0) console.info(`[discord] auto-send enforced; cleared ${cleared} pending_confirm event(s)`);
  } catch (err) {
    console.warn("[discord] auto-send enforcement skipped:", (err as Error)?.message);
  }
  try {
    // Reconcile stale/malformed seed runs left RUNNING by a prior process (canceled-but-stuck →
    // CANCELED, unresumable legacy rows → FAILED). Only touches rows with no active lease. This is
    // a boot-time WRITE (never in a GET handler), so GET status stays read-only.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reconciled = require("@/lib/research/episode/seed-jobs").reconcileStaleSeedRuns(require("@/lib/db").getDb());
    if (reconciled.length > 0) console.info(`[seed-worker] reconciled ${reconciled.length} stale run(s) at boot`);
  } catch (err) {
    console.warn("[seed-worker] boot reconciliation skipped:", (err as Error)?.message);
  }
  try {
    // Start the out-of-process historical-replay seed worker (no-op unless replay flags are on).
    // A fresh boot reclaims any run whose lease expired when the previous process died.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/lib/research/episode/seed-worker-manager").ensureSeedWorker(process.env);
  } catch (err) {
    console.warn("[seed-worker] not started:", (err as Error)?.message);
  }
  try {
    // Independent OPTIONS monitoring loop (in-process, bounded, SEPARATE from the stock radar).
    // HARD no-op unless INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1. Never sends Discord; paper/shadow only.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { startOptionsMonitor } = require("@/lib/research/options/monitor");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const started = startOptionsMonitor(require("@/lib/research/options/live-deps").buildLiveOptionsDeps(), process.env);
    if (started.started) console.info("[options-monitor] started");
  } catch (err) {
    console.warn("[options-monitor] not started:", (err as Error)?.message);
  }
  // (removed) A boot-time block used to force-lower scanner gates to
  // 0.12%/min / 1.25x on every start — it silently undid any tightening the
  // user saved in Settings and was a root cause of the noisy-callout audit
  // (2026-07-07: 7% hit rate @5m). Settings are user-owned; defaults live in
  // scanner-loop env fallbacks only.
}
