/**
 * lib/research/options/research-queue.ts — the autonomous AI RESEARCH QUEUE. The deterministic engine
 * does ALL live work (scan → contract → alert → mirror paper); this queue receives only HIGH-VALUE
 * COMPLETED work, harvested from the DB after the fact. The AI is NEVER on the live alert path:
 * nothing here is called by the scanner, delivery, or paper modules — a worker tick reads completed
 * truth (exited trades, TOO_LATE alerts) and queues it for asynchronous analysis.
 *
 * Priorities (1 = highest):
 *   1 delivered_trade_analysis   — closed DELIVERED_ALERT_PAPER trades (what subscribers actually got)
 *   2 experiment_vs_mirror       — closed RESEARCH_ONLY_PAPER trades comparable to a delivered mirror
 *   3 missed_opportunity         — alerts rejected TOO_LATE (what we almost caught)
 *   4 strategy_recommendation    — periodic evidence-based synthesis over completed analyses
 *   5 research_experiment        — remaining closed research trades (lowest value)
 *
 * Budget-aware: each tick consults the existing lib/ai cost gate (monthly soft/hard limits) and PAUSES
 * processing at the hard limit — tasks stay QUEUED, harvesting continues (free), and the live scanner /
 * Discord / paper / grading are entirely unaffected. Degrades gracefully on AI-disabled or errors:
 * bounded retries, then FAILED; a worker error never propagates. HARD no-op unless
 * AI_RESEARCH_QUEUE_ENABLED=1.
 */

export type ResearchTaskKind = "delivered_trade_analysis" | "experiment_vs_mirror" | "missed_opportunity" | "strategy_recommendation" | "research_experiment";
export const TASK_PRIORITY: Record<ResearchTaskKind, number> = {
  delivered_trade_analysis: 1, experiment_vs_mirror: 2, missed_opportunity: 3, strategy_recommendation: 4, research_experiment: 5,
};

interface QDb { prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } } }
const hasQueue = (db: QDb) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_research_queue'").get());

export interface ResearchTask { id: number; kind: ResearchTaskKind; priority: number; refId: string; payloadJson: string | null; attempts: number }

/** Enqueue one task. IDEMPOTENT by (kind, ref_id) — re-harvesting the same completed work is a no-op. */
export function enqueueResearchTaskOnDb(db: QDb, kind: ResearchTaskKind, refId: string, payload: unknown, nowMs: number): { enqueued: boolean } {
  if (!hasQueue(db)) return { enqueued: false };
  const r = db.prepare(
    "INSERT INTO ai_research_queue (kind, priority, ref_id, payload_json, status, attempts, created_at_ms, updated_at_ms) SELECT ?,?,?,?,'QUEUED',0,?,? WHERE NOT EXISTS (SELECT 1 FROM ai_research_queue WHERE kind=? AND ref_id=?)",
  ).run(kind, TASK_PRIORITY[kind], refId, payload == null ? null : JSON.stringify(payload), nowMs, nowMs, kind, refId);
  return { enqueued: (r.changes ?? 0) > 0 };
}

/** Claim the single best task: lowest priority number first, then oldest. Sets RUNNING with a lease so
 *  a crashed worker's task is reclaimable after the lease expires. */
export function claimNextTaskOnDb(db: QDb, nowMs: number, leaseMs = 120_000): ResearchTask | null {
  if (!hasQueue(db)) return null;
  const row = db.prepare(
    "SELECT id, kind, priority, ref_id, payload_json, attempts FROM ai_research_queue WHERE status='QUEUED' OR (status='RUNNING' AND lease_until_ms IS NOT NULL AND lease_until_ms < ?) ORDER BY priority ASC, created_at_ms ASC LIMIT 1",
  ).get(nowMs) as any;
  if (!row) return null;
  const r = db.prepare("UPDATE ai_research_queue SET status='RUNNING', lease_until_ms=?, updated_at_ms=? WHERE id=? AND (status='QUEUED' OR (status='RUNNING' AND lease_until_ms < ?))").run(nowMs + leaseMs, nowMs, row.id, nowMs);
  if ((r.changes ?? 0) === 0) return null; // lost a race — next tick retries
  return { id: row.id, kind: row.kind, priority: row.priority, refId: row.ref_id, payloadJson: row.payload_json, attempts: row.attempts };
}

export function completeTaskOnDb(db: QDb, id: number, result: unknown, nowMs: number): void {
  db.prepare("UPDATE ai_research_queue SET status='DONE', result_json=?, lease_until_ms=NULL, updated_at_ms=? WHERE id=?").run(result == null ? null : JSON.stringify(result), nowMs, id);
}
/** Bounded retries: attempts+1; below the ceiling the task re-queues, at the ceiling it FAILS closed. */
export function failTaskOnDb(db: QDb, id: number, error: string, nowMs: number, maxAttempts = 3): void {
  const row = db.prepare("SELECT attempts FROM ai_research_queue WHERE id=?").get(id) as any;
  const attempts = (row?.attempts ?? 0) + 1;
  const status = attempts >= maxAttempts ? "FAILED" : "QUEUED";
  db.prepare("UPDATE ai_research_queue SET status=?, attempts=?, error=?, lease_until_ms=NULL, updated_at_ms=? WHERE id=?").run(status, attempts, error.slice(0, 300), nowMs, id);
}

/**
 * HARVEST completed high-value work from the DB into the queue. Deterministic, aggressive filtering:
 * only CLOSED trades and TOO_LATE alerts — never every scanned symbol, never a market tick. Idempotent
 * (unique kind+ref). Bounded per pass. This is the ONLY feed into the AI; the live path has no hooks.
 */
export function harvestResearchTasksOnDb(db: QDb, nowMs: number, opts: { maxPerPass?: number; recommendationEvery?: number } = {}): { enqueued: number } {
  if (!hasQueue(db)) return { enqueued: 0 };
  const cap = opts.maxPerPass ?? 100;
  let enq = 0;
  const has = (t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(t));

  // P1 — closed subscriber mirrors (the highest-value evidence).
  if (has("options_paper_delivered")) {
    for (const r of db.prepare("SELECT id, option_symbol, strategy, side, entry_fill, exit_fill, return_pct, exit_reason, entered_at_ms, exit_at_ms, alert_id FROM options_paper_delivered WHERE status='EXITED' ORDER BY exit_at_ms DESC LIMIT ?").all(cap) as any[]) {
      if (enqueueResearchTaskOnDb(db, "delivered_trade_analysis", `paper:${r.id}`, r, nowMs).enqueued) enq++;
    }
  }
  // P2/P5 — closed research trades: comparable-to-mirror (same strategy has a closed mirror) rank P2,
  // the rest are P5.
  if (has("options_paper_research")) {
    for (const r of db.prepare("SELECT id, option_symbol, strategy, side, entry_fill, exit_fill, return_pct, exit_reason, experiment_id, experiment_variant FROM options_paper_research WHERE status='EXITED' ORDER BY exit_at_ms DESC LIMIT ?").all(cap) as any[]) {
      const mirror = has("options_paper_delivered")
        ? db.prepare("SELECT id, return_pct FROM options_paper_delivered WHERE status='EXITED' AND strategy=? ORDER BY exit_at_ms DESC LIMIT 1").get(r.strategy) as any
        : null;
      const kind: ResearchTaskKind = mirror ? "experiment_vs_mirror" : "research_experiment";
      if (enqueueResearchTaskOnDb(db, kind, `paper:${r.id}`, { experiment: r, mirror: mirror ?? null }, nowMs).enqueued) enq++;
    }
  }
  // P3 — missed opportunities (alerts rejected as TOO_LATE).
  if (has("options_alerts")) {
    for (const r of db.prepare("SELECT alert_id, candidate_symbol, strategy, side, failure_reason, entry_mid, created_at_ms FROM options_alerts WHERE state='TOO_LATE' ORDER BY created_at_ms DESC LIMIT ?").all(cap) as any[]) {
      if (enqueueResearchTaskOnDb(db, "missed_opportunity", `alert:${r.alert_id}`, r, nowMs).enqueued) enq++;
    }
  }
  // P4 — one synthesis task per N completed P1/P2 analyses (evidence-based recommendations).
  const every = opts.recommendationEvery ?? 10;
  const done = Number((db.prepare("SELECT COUNT(*) n FROM ai_research_queue WHERE status='DONE' AND kind IN ('delivered_trade_analysis','experiment_vs_mirror')").get() as any)?.n ?? 0);
  if (done > 0 && done % every === 0) {
    const batch = Math.floor(done / every);
    if (enqueueResearchTaskOnDb(db, "strategy_recommendation", `reco:${batch}`, { completedAnalyses: done }, nowMs).enqueued) enq++;
  }
  return { enqueued: enq };
}

export interface QueueMetrics {
  enabled: boolean; byStatus: Record<string, number>; byKind: Record<string, number>;
  paused: boolean; pausedReason: string | null; monthlySpendUsd: number | null;
  lastTickMs: number | null; processed: number; failures: number; harvested: number;
}
export function researchQueueMetricsOnDb(db: QDb, env: NodeJS.ProcessEnv = process.env): QueueMetrics {
  const w = wstate();
  const byStatus: Record<string, number> = {}; const byKind: Record<string, number> = {};
  if (hasQueue(db)) {
    for (const r of db.prepare("SELECT status, COUNT(*) c FROM ai_research_queue GROUP BY status").all() as any[]) byStatus[r.status] = r.c;
    for (const r of db.prepare("SELECT kind, COUNT(*) c FROM ai_research_queue GROUP BY kind").all() as any[]) byKind[r.kind] = r.c;
  }
  return {
    enabled: env.AI_RESEARCH_QUEUE_ENABLED === "1", byStatus, byKind,
    paused: w.paused, pausedReason: w.pausedReason, monthlySpendUsd: w.lastSpendUsd,
    lastTickMs: w.lastTickMs, processed: w.processed, failures: w.failures, harvested: w.harvested,
  };
}

// ── the autonomous worker (in-process singleton, gated, budget-aware, isolated) ─────────────────
export interface AnalyzeResult { ok: boolean; result?: unknown; skipped?: boolean; error?: string }
export interface ResearchWorkerDeps {
  getDb: () => any; now?: () => number;
  /** The AI analysis step (injected for tests; default = the lib/ai analyzer). MUST never be awaited by
   *  any live-alert code — it runs only here, after the fact. */
  analyze?: (task: ResearchTask, db: any) => Promise<AnalyzeResult>;
  /** Budget gate (injected for tests; default = lib/ai aiConfig + costGateOnDb). */
  budget?: (db: any, nowMs: number) => { allowed: boolean; spendUsd: number; reason: string | null };
}
interface WState { running: boolean; timer: any; paused: boolean; pausedReason: string | null; lastSpendUsd: number | null; lastTickMs: number | null; processed: number; failures: number; harvested: number }
type G = typeof globalThis & { __optiscanAiResearchWorker?: WState };
function wstate(): WState { const g = globalThis as G; return (g.__optiscanAiResearchWorker ??= { running: false, timer: null, paused: false, pausedReason: null, lastSpendUsd: null, lastTickMs: null, processed: 0, failures: 0, harvested: 0 }); }

function defaultBudget(db: any, nowMs: number): { allowed: boolean; spendUsd: number; reason: string | null } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { aiConfig } = require("../../ai/config.ts");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { costGateOnDb } = require("../../ai/store.ts");
    const cfg = aiConfig(process.env);
    if (!cfg.enabled) return { allowed: false, spendUsd: 0, reason: "ai_disabled" };
    const gate = costGateOnDb(db, cfg, nowMs);
    return { allowed: gate.allowed, spendUsd: gate.spendUsd, reason: gate.allowed ? null : "monthly_hard_limit" };
  } catch (e: any) { return { allowed: false, spendUsd: 0, reason: `budget_check_failed: ${String(e?.message ?? e).slice(0, 80)}` }; }
}
function defaultAnalyze(task: ResearchTask, db: any): Promise<AnalyzeResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../ai/research-analyzer.ts").analyzeResearchTask(db, task, process.env);
}

export function researchWorkerConfig(env: NodeJS.ProcessEnv = process.env): { tickMs: number; tasksPerTick: number; maxAttempts: number } {
  const n = (v: string | undefined, d: number, min: number) => { const x = Number(v); return Number.isFinite(x) && x >= min ? x : d; };
  return { tickMs: n(env.AI_RESEARCH_TICK_MS, 60_000, 5_000), tasksPerTick: n(env.AI_RESEARCH_TASKS_PER_TICK, 2, 1), maxAttempts: n(env.AI_RESEARCH_MAX_ATTEMPTS, 3, 1) };
}

/** ONE worker tick: harvest completed work (free), check budget, process up to tasksPerTick tasks.
 *  Exposed for tests and callable safely at any time; a failure inside never propagates. */
export async function runResearchWorkerTick(deps: ResearchWorkerDeps, env: NodeJS.ProcessEnv = process.env): Promise<{ harvested: number; processed: number; paused: boolean }> {
  const w = wstate();
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const cfg = researchWorkerConfig(env);
  let harvested = 0, processed = 0;
  try {
    const db = deps.getDb();
    harvested = harvestResearchTasksOnDb(db, nowMs).enqueued;
    w.harvested += harvested;

    const budget = (deps.budget ?? defaultBudget)(db, nowMs);
    w.lastSpendUsd = budget.spendUsd;
    if (!budget.allowed) { w.paused = true; w.pausedReason = budget.reason; w.lastTickMs = nowMs; return { harvested, processed: 0, paused: true }; }
    w.paused = false; w.pausedReason = null;

    const analyze = deps.analyze ?? defaultAnalyze;
    for (let i = 0; i < cfg.tasksPerTick; i++) {
      const task = claimNextTaskOnDb(db, now());
      if (!task) break;
      try {
        const res = await analyze(task, db);
        if (res.ok) { completeTaskOnDb(db, task.id, res.result ?? null, now()); processed++; w.processed++; }
        else if (res.skipped) { failTaskOnDb(db, task.id, res.error ?? "skipped", now(), cfg.maxAttempts); }
        else { failTaskOnDb(db, task.id, res.error ?? "analyze failed", now(), cfg.maxAttempts); w.failures++; }
      } catch (e: any) { failTaskOnDb(db, task.id, String(e?.message ?? e), now(), cfg.maxAttempts); w.failures++; }
    }
  } catch { w.failures += 1; /* the worker NEVER throws into the caller */ }
  w.lastTickMs = nowMs;
  return { harvested, processed, paused: w.paused };
}

/** Start the autonomous worker (singleton). HARD no-op unless AI_RESEARCH_QUEUE_ENABLED=1. The live
 *  scanner/delivery/paper/grading run whether or not this starts — the AI learns, it never gates. */
export function startAiResearchWorker(deps: ResearchWorkerDeps, env: NodeJS.ProcessEnv = process.env): { started: boolean; reason: string } {
  const w = wstate();
  if (w.running) return { started: true, reason: "already running" };
  if (env.AI_RESEARCH_QUEUE_ENABLED !== "1") return { started: false, reason: "AI_RESEARCH_QUEUE_ENABLED!=1" };
  w.running = true;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return; busy = true;
    void runResearchWorkerTick(deps, env).catch(() => {}).finally(() => { busy = false; });
  }, researchWorkerConfig(env).tickMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  w.timer = timer;
  const stop = () => stopAiResearchWorker();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return { started: true, reason: "started" };
}
export function stopAiResearchWorker(): void { const w = wstate(); if (w.timer) clearInterval(w.timer); w.timer = null; w.running = false; }
export function __resetAiResearchWorkerForTest(): void { stopAiResearchWorker(); delete (globalThis as G).__optiscanAiResearchWorker; }
