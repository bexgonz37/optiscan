/**
 * server-boot.ts — start background scanner + alert tracker once per Node process.
 * Called from server routes (not instrumentation) so dev webpack never bundles sqlite.
 */
// The once-per-process guard lives in lib/boot-guard.ts (see the note there on why
// it must be process-level rather than module-level). claimBootStart/-Schedule test
// and set in one step, so two copies of this module can never both start the runtime.
import { claimBootStart, claimBootSchedule } from "@/lib/boot-guard";

/** Schedule background boot after the HTTP response — never block read-only API handlers. */
export function deferServerBoot(): void {
  if (!claimBootSchedule()) return;
  setImmediate(() => {
    try {
      ensureServerBoot();
    } catch {
      /* boot is best-effort */
    }
  });
}

export function ensureServerBoot(): void {
  if (!claimBootStart()) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { validateSubscriberConfigWithSchema, persistSubscriberConfigValidation } = require("@/lib/subscriber-config-validator");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = require("@/lib/db").getDb();
    const validation = validateSubscriberConfigWithSchema(db, process.env);
    persistSubscriberConfigValidation(db, validation, Date.now());
    if (!validation.ok) console.error("[subscriber-config] FATAL:", validation.fatal.join("; "));
    if (validation.warnings.length) console.warn("[subscriber-config] warnings:", validation.warnings.join("; "));
  } catch (err) {
    console.warn("[subscriber-config] validation skipped:", (err as Error)?.message);
  }
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
    const { validateSubscriberConfigWithSchema, shouldBlockIndependentDelivery } = require("@/lib/subscriber-config-validator");
    const cfgVal = validateSubscriberConfigWithSchema(require("@/lib/db").getDb(), process.env);
    if (shouldBlockIndependentDelivery(cfgVal, process.env)) {
      console.error("[options-monitor] not started: subscriber config invalid under strict mode —", cfgVal.fatal.join("; "));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { startOptionsMonitor } = require("@/lib/research/options/monitor");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const started = startOptionsMonitor(require("@/lib/research/options/live-deps").buildLiveOptionsDeps(), process.env);
      if (started.started) console.info("[options-monitor] started");
    }
  } catch (err) {
    console.warn("[options-monitor] not started:", (err as Error)?.message);
  }
  try {
    // Boot self-check: verify options deps WITHOUT exposing secrets; persist blockers; fail closed.
    // Never blocks the web app — a missing required dep just marks the feature inactive.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runOptionsSelfCheck } = require("@/lib/research/options/runtime");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sc = runOptionsSelfCheck(process.env, require("@/lib/db").getDb());
    if (!sc.healthy) console.warn("[options-selfcheck] blockers:", sc.blockers.join(", "));
  } catch (err) {
    console.warn("[options-selfcheck] skipped:", (err as Error)?.message);
  }
  try {
    // AUTOMATIC outcome grader (in-process, gated). Restart-safe: open ENTERED positions persist in the
    // DB so grading resumes after a deploy. Each tick also runs the once-per-day private summary.
    // HARD no-op unless INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1 AND REAL_OPTION_PAPER_ENABLED=1.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { startOptionsGrader } = require("@/lib/research/options/grade");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const gradeDeps = require("@/lib/research/options/live-deps").buildLiveGradeDeps();
    const started = startOptionsGrader({
      ...gradeDeps,
      onCycle: () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { maybeSendDailySummary } = require("@/lib/research/options/daily-summary");
          void maybeSendDailySummary({ getDb: gradeDeps.getDb }).catch(() => {});
        } catch { /* isolated */ }
      },
    }, process.env);
    if (started.started) console.info("[options-grader] started");
  } catch (err) {
    console.warn("[options-grader] not started:", (err as Error)?.message);
  }
  try {
    // Autonomous AI Research Queue worker: harvests COMPLETED work (closed trades, TOO_LATE alerts)
    // and analyzes it asynchronously under the monthly AI budget. NEVER on the live alert path — the
    // scanner/delivery/paper/grading run identically whether this starts or not.
    // HARD no-op unless AI_RESEARCH_QUEUE_ENABLED=1.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { startAiResearchWorker } = require("@/lib/research/options/research-queue");
    const started = startAiResearchWorker({ getDb: () => require("@/lib/db").getDb() }, process.env); // eslint-disable-line @typescript-eslint/no-require-imports
    if (started.started) console.info("[ai-research-queue] started");
  } catch (err) {
    console.warn("[ai-research-queue] not started:", (err as Error)?.message);
  }
  try {
    // Shadow outcome grader — forward marks for soak evidence (isolated from delivered-alert paper).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { startShadowOutcomeGrader } = require("@/lib/research/options/shadow-outcomes");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildLiveGradeDeps } = require("@/lib/research/options/live-deps");
    const gradeDeps = buildLiveGradeDeps();
    const started = startShadowOutcomeGrader({
      getDb: gradeDeps.getDb,
      now: gradeDeps.now,
      fetchOptionQuote: gradeDeps.getQuote,
      fetchUnderlying: gradeDeps.fetchUnderlying,
    }, process.env);
    if (started.started) console.info("[shadow-outcomes] grader started");
  } catch (err) {
    console.warn("[shadow-outcomes] grader not started:", (err as Error)?.message);
  }
  try {
    // Aggressive 0DTE Research — simulated $100k ledger. HARD no-op unless PAPER_0DTE_RESEARCH_ENABLED=1.
    // Never Discord; never readiness. Separate cadence from subscriber monitor.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { startZeroDteResearchRuntime } = require("@/lib/research/options/zero-dte-research");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildLiveOptionsDeps, buildLiveGradeDeps } = require("@/lib/research/options/live-deps");
    const mon = buildLiveOptionsDeps();
    const gradeDeps = buildLiveGradeDeps();
    const started = startZeroDteResearchRuntime({
      getDb: mon.getDb,
      gradeDeps,
      getUnderlying: async (symbol: string) => {
        const batch = await mon.getUnderlyingBatch([symbol]);
        const snap = batch.get(symbol.toUpperCase());
        if (!snap || !(Number(snap.price) > 0)) return null;
        return { price: Number(snap.price), session: String(snap.session ?? mon.session?.() ?? "") };
      },
      getChain: async (symbol: string) => {
        const chain = await mon.getChain(symbol);
        return (chain.contracts ?? []).map((c: any) => ({
          optionSymbol: c.optionSymbol ?? c.option_symbol,
          side: c.side,
          strike: Number(c.strike),
          expiration: String(c.expiration ?? ""),
          dte: Number(c.dte ?? 0),
          bid: c.bid ?? null,
          ask: c.ask ?? null,
          delta: c.delta ?? null,
          volume: c.volume ?? null,
          openInterest: c.openInterest ?? c.open_interest ?? null,
          iv: c.iv ?? null,
          quoteAgeMs: c.quoteAgeMs ?? null,
          providerTimestamp: c.providerTimestamp ?? null,
        }));
      },
    }, process.env);
    if (started) console.info("[zero-dte-research] started");
  } catch (err) {
    console.warn("[zero-dte-research] not started:", (err as Error)?.message);
  }
  // (removed) A boot-time block used to force-lower scanner gates to
  // 0.12%/min / 1.25x on every start — it silently undid any tightening the
  // user saved in Settings and was a root cause of the noisy-callout audit
  // (2026-07-07: 7% hit rate @5m). Settings are user-owned; defaults live in
  // scanner-loop env fallbacks only.
}
