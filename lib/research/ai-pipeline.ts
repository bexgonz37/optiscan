/**
 * lib/research/ai-pipeline.ts — the research-only AI pipeline (Phase 6).
 *
 * DETERMINISTIC / STATISTICAL. It reads persisted evidence (Phase-5 ledger,
 * counterfactuals, reused paper_trades outcomes) and writes ADVISORY findings +
 * normalized training rows. It has NO authority over production: it never sends
 * Discord, creates trades, routes, changes balances, enables flags, or alters
 * thresholds/config. Language-model narrative components are intentionally NOT
 * implemented here (they stay inactive in lib/ai/) rather than fabricated.
 *
 * Failure isolation: each stage runs in its own try/catch; one failure never stops
 * the others or anything outside the pipeline. HARD no-op unless
 * AI_RESEARCH_PIPELINE_ENABLED=1.
 */
import { researchFlags } from "./flags.ts";
import { gateEffectivenessOnDb, strategyAnalyticsOnDb } from "./counterfactual.ts";

interface PipeDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number } };
}

const j = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

// ── findings helper ──────────────────────────────────────────────────────────
export interface FindingInput {
  stage: string; findingType: string; subject: string;
  strategyAgent?: string | null; strategyVersion?: number | null; lane?: string | null; tier?: string | null;
  regime?: string | null; session?: string | null; horizon?: string | null;
  metrics?: unknown; sampleSize: number; sufficiency: "SUFFICIENT" | "EXPLORATORY" | "INSUFFICIENT";
  confidence?: string | null; observationOnly?: boolean; evidenceRefs?: unknown;
}

function insertFinding(db: PipeDb, runId: string, f: FindingInput, nowMs: number): number {
  const info = db.prepare(
    `INSERT OR IGNORE INTO ai_research_findings
      (run_id, stage, finding_type, subject, strategy_agent, strategy_version, lane, tier, regime, session, horizon,
       metrics_json, sample_size, sufficiency, confidence, observation_only, evidence_refs_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?)`,
  ).run(
    runId, f.stage, f.findingType, f.subject, f.strategyAgent ?? null, f.strategyVersion ?? null, f.lane ?? null, f.tier ?? null,
    f.regime ?? null, f.session ?? null, f.horizon ?? null, j(f.metrics), f.sampleSize, f.sufficiency, f.confidence ?? null,
    f.observationOnly ? 1 : 0, j(f.evidenceRefs), nowMs,
  );
  return info.changes;
}

function sufficiencyFor(n: number, minSample: number): "SUFFICIENT" | "EXPLORATORY" | "INSUFFICIENT" {
  if (n >= minSample) return "SUFFICIENT";
  if (n > 0) return "EXPLORATORY";
  return "INSUFFICIENT";
}

// ── stages ───────────────────────────────────────────────────────────────────
export interface Stage { name: string; run: (db: PipeDb, runId: string, nowMs: number, minSample: number) => number }

/** A. Trade Review — per executed, graded paper trade (bounded). */
const tradeReview: Stage = { name: "trade_review", run(db, runId, nowMs) {
  const rows = db.prepare(
    `SELECT id, setup_id, strategy_agent, lane, setup_tier, entry_price, exit_price, option_symbol, option_type, mfe_pct, mae_pct
     FROM paper_trades WHERE status='EXITED' AND entry_price IS NOT NULL AND exit_price IS NOT NULL AND setup_id IS NOT NULL
     ORDER BY id DESC LIMIT 200`,
  ).all() as any[];
  let n = 0;
  for (const t of rows) {
    const mult = t.option_symbol ? 100 : 1;
    const dir = !t.option_symbol && t.option_type === "put" ? -1 : 1;
    const ret = ((t.exit_price - t.entry_price) * dir) / t.entry_price * 100;
    n += insertFinding(db, runId, {
      stage: "trade_review", findingType: ret > 0 ? "win_review" : "loss_review", subject: `trade:${t.setup_id}`,
      strategyAgent: t.strategy_agent, lane: t.lane, tier: t.setup_tier,
      metrics: { returnPct: +ret.toFixed(2), mfePct: t.mfe_pct ?? null, maePct: t.mae_pct ?? null, mult },
      sampleSize: 1, sufficiency: "EXPLORATORY", observationOnly: false,
    }, nowMs);
  }
  return n;
} };

/** B. Counterfactual Review — gate effectiveness (evidence = factual reached-target). */
const counterfactualReview: Stage = { name: "counterfactual_review", run(db, runId, nowMs, minSample) {
  let n = 0;
  for (const g of gateEffectivenessOnDb(db as any, { minSample })) {
    n += insertFinding(db, runId, {
      stage: "counterfactual_review", findingType: "gate_effectiveness", subject: `gate:${g.gate}`,
      metrics: g, sampleSize: g.rejectedWithKnownOutcome,
      sufficiency: g.insufficientSample ? "INSUFFICIENT" : "SUFFICIENT",
      confidence: g.insufficientSample ? "low (small sample)" : null,
      observationOnly: true, // reached-target is a market-movement fact, not filled P&L
    }, nowMs);
  }
  return n;
} };

/** C. Pattern Discovery — recurring (agent × call/put) win-rate cohorts. Exploratory-marked. */
const patternDiscovery: Stage = { name: "pattern_discovery", run(db, runId, nowMs, minSample) {
  const rows = db.prepare(
    `SELECT strategy_agent, option_type, COUNT(*) n,
            SUM(CASE WHEN (exit_price - entry_price) * (CASE WHEN option_type='put' AND option_symbol IS NULL THEN -1 ELSE 1 END) > 0 THEN 1 ELSE 0 END) wins
     FROM paper_trades WHERE status='EXITED' AND entry_price IS NOT NULL AND exit_price IS NOT NULL AND strategy_agent IS NOT NULL
     GROUP BY strategy_agent, option_type`,
  ).all() as any[];
  let n = 0;
  for (const r of rows) {
    const sufficiency = sufficiencyFor(r.n, minSample);
    n += insertFinding(db, runId, {
      stage: "pattern_discovery", findingType: "cohort_win_rate", subject: `pattern:${r.strategy_agent}:${r.option_type}`,
      strategyAgent: r.strategy_agent,
      metrics: { n: r.n, wins: r.wins, winRatePct: r.n ? +((r.wins / r.n) * 100).toFixed(1) : null, note: "correlation only — not causal" },
      sampleSize: r.n, sufficiency, confidence: sufficiency === "SUFFICIENT" ? null : "exploratory (small sample)",
    }, nowMs);
  }
  return n;
} };

/** D. Strategy Evaluation — per agent/version analytics with sufficiency. */
const strategyEvaluation: Stage = { name: "strategy_evaluation", run(db, runId, nowMs, minSample) {
  let n = 0;
  for (const s of strategyAnalyticsOnDb(db as any, { minSample })) {
    n += insertFinding(db, runId, {
      stage: "strategy_evaluation", findingType: "strategy_metrics", subject: `agent:${s.strategyAgent}:v${s.strategyVersion ?? "?"}`,
      strategyAgent: s.strategyAgent, strategyVersion: s.strategyVersion,
      metrics: s, sampleSize: s.graded, sufficiency: s.insufficientSample ? "INSUFFICIENT" : "SUFFICIENT",
      confidence: s.insufficientSample ? "low (insufficient graded sample)" : null,
    }, nowMs);
  }
  return n;
} };

/** E. Portfolio Allocation Research — advisory weights; never concentrate on weak evidence. */
const portfolioAllocation: Stage = { name: "portfolio_allocation", run(db, runId, nowMs, minSample) {
  const analytics = strategyAnalyticsOnDb(db as any, { minSample });
  const eligible = analytics.filter((a) => !a.insufficientSample && (a.avgReturnPct ?? 0) > 0);
  const totalEdge = eligible.reduce((s, a) => s + (a.avgReturnPct ?? 0), 0);
  let n = 0;
  for (const a of analytics) {
    const eligibleNow = !a.insufficientSample && (a.avgReturnPct ?? 0) > 0 && totalEdge > 0;
    const weight = eligibleNow ? +(((a.avgReturnPct ?? 0) / totalEdge)).toFixed(3) : 0;
    n += insertFinding(db, runId, {
      stage: "portfolio_allocation", findingType: "research_weight", subject: `alloc:${a.strategyAgent}`,
      strategyAgent: a.strategyAgent, strategyVersion: a.strategyVersion,
      metrics: { recommendedResearchWeight: weight, avgReturnPct: a.avgReturnPct, graded: a.graded, note: "paper-only research weight; never auto-rebalances" },
      sampleSize: a.graded, sufficiency: a.insufficientSample ? "INSUFFICIENT" : "SUFFICIENT",
      confidence: a.insufficientSample ? "excluded from allocation (weak evidence)" : null,
    }, nowMs);
  }
  return n;
} };

export function defaultStages(): Stage[] {
  return [tradeReview, counterfactualReview, patternDiscovery, strategyEvaluation, portfolioAllocation];
}

export interface StageResult { name: string; status: "COMPLETED" | "ERROR"; emitted: number; error: string | null }

/** Run stages with per-stage failure isolation. */
export function runStages(db: PipeDb, runId: string, stages: Stage[], nowMs: number, minSample: number): StageResult[] {
  const results: StageResult[] = [];
  for (const s of stages) {
    try {
      const emitted = s.run(db, runId, nowMs, minSample);
      results.push({ name: s.name, status: "COMPLETED", emitted, error: null });
    } catch (err: any) {
      results.push({ name: s.name, status: "ERROR", emitted: 0, error: String(err?.message ?? err).slice(0, 200) });
    }
  }
  return results;
}

export interface PipelineSummary {
  runId: string; ran: boolean; skippedReason: string | null; stages: StageResult[]; trainingRows: number;
}

/** Run the full deterministic pipeline on an explicit db (idempotent per runId). */
export function runResearchPipelineOnDb(db: PipeDb, opts: { runId: string; nowMs?: number; minSample?: number; stages?: Stage[] }): PipelineSummary {
  const nowMs = opts.nowMs ?? Date.now();
  const minSample = opts.minSample ?? 20;
  db.prepare("INSERT OR IGNORE INTO ai_research_runs (run_id, pipeline, started_at_ms, status) VALUES (?,?,?,?)")
    .run(opts.runId, "deterministic_research_v1", nowMs, "RUNNING");
  const stages = runStages(db, opts.runId, opts.stages ?? defaultStages(), nowMs, minSample);
  const trainingRows = buildTrainingRowsOnDb(db, nowMs);
  const anyError = stages.some((s) => s.status === "ERROR");
  db.prepare("UPDATE ai_research_runs SET finished_at_ms=?, status=?, stages_json=? WHERE run_id=?")
    .run(nowMs, anyError ? "ERROR" : "COMPLETED", j(stages), opts.runId);
  return { runId: opts.runId, ran: true, skippedReason: null, stages, trainingRows };
}

// ── training rows (distinct source kinds; idempotent) ────────────────────────
function insertTraining(db: PipeDb, row: Record<string, any>, nowMs: number): number {
  const info = db.prepare(
    `INSERT OR IGNORE INTO ai_training_rows
      (setup_id, source_kind, executed, experiment_id, experiment_version, lane, portfolio, strategy_agent, strategy_version, strategy_family,
       setup_tier, direction, asset_class, horizon, ticker, option_symbol, expiration, strike, call_put,
       feature_snapshot_json, gate_results_json, data_quality, market_session, regime, fill_status, label, return_pct, mfe_pct, mae_pct,
       entry_ts_ms, exit_ts_ms, provider_limitations, source_table, model_eligibility, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?)`,
  ).run(
    row.setup_id, row.source_kind, row.executed, row.experiment_id ?? null, row.experiment_version ?? null, row.lane ?? null, row.portfolio ?? null,
    row.strategy_agent ?? null, row.strategy_version ?? null, row.strategy_family ?? null, row.setup_tier ?? null, row.direction ?? null,
    row.asset_class ?? null, row.horizon ?? null, row.ticker ?? null, row.option_symbol ?? null, row.expiration ?? null, row.strike ?? null, row.call_put ?? null,
    j(row.feature_snapshot) ?? null, j(row.gate_results) ?? null, row.data_quality ?? null, row.market_session ?? null, row.regime ?? null,
    row.fill_status ?? null, row.label ?? null, row.return_pct ?? null, row.mfe_pct ?? null, row.mae_pct ?? null,
    row.entry_ts_ms ?? null, row.exit_ts_ms ?? null, row.provider_limitations ?? null, row.source_table, row.model_eligibility, nowMs,
  );
  return info.changes;
}

/**
 * Build normalized training rows, keeping executed trades, executable counterfactuals,
 * market observations, and rejected-invalid records STRICTLY distinct. Idempotent per
 * (setup_id, source_kind). Rejected/observation rows are ANALYSIS_ONLY and are never
 * labeled as executed-return examples.
 */
export function buildTrainingRowsOnDb(db: PipeDb, nowMs: number = Date.now()): number {
  let n = 0;
  // 1) Executed paper trades (the ONLY executed-return examples).
  for (const t of db.prepare(
    `SELECT setup_id, strategy_agent, lane, portfolio, setup_tier, option_symbol, option_type, entry_price, exit_price, mfe_pct, mae_pct, entry_at_ms, exit_at_ms
     FROM paper_trades WHERE status='EXITED' AND entry_price IS NOT NULL AND exit_price IS NOT NULL AND setup_id IS NOT NULL`,
  ).all() as any[]) {
    const mult = t.option_symbol ? 100 : 1; const dir = !t.option_symbol && t.option_type === "put" ? -1 : 1;
    const ret = ((t.exit_price - t.entry_price) * dir) / t.entry_price * 100;
    n += insertTraining(db, {
      setup_id: t.setup_id, source_kind: "EXECUTED_TRADE", executed: 1, lane: t.lane, portfolio: t.portfolio,
      strategy_agent: t.strategy_agent, setup_tier: t.setup_tier, asset_class: t.option_symbol ? "option" : "stock",
      option_symbol: t.option_symbol, call_put: t.option_type, fill_status: "FILLED",
      label: ret > 0 ? "WIN" : "LOSS", return_pct: +ret.toFixed(2), mfe_pct: t.mfe_pct, mae_pct: t.mae_pct,
      entry_ts_ms: t.entry_at_ms, exit_ts_ms: t.exit_at_ms, source_table: "paper_trades", model_eligibility: "ELIGIBLE_EXECUTED",
    }, nowMs);
  }
  // 2) Executable counterfactuals (research-only P&L; NOT executed).
  for (const c of db.prepare("SELECT setup_id, strategy_agent, lane, setup_tier, ticker, horizon, session, regime, return_pct, win FROM counterfactual_outcomes WHERE kind='executable_counterfactual'").all() as any[]) {
    n += insertTraining(db, {
      setup_id: c.setup_id, source_kind: "EXECUTABLE_COUNTERFACTUAL", executed: 0, lane: c.lane, strategy_agent: c.strategy_agent,
      setup_tier: c.setup_tier, ticker: c.ticker, horizon: c.horizon, market_session: c.session, regime: c.regime,
      label: c.win === 1 ? "WIN" : "LOSS", return_pct: c.return_pct, source_table: "counterfactual_outcomes", model_eligibility: "RESEARCH_ONLY",
    }, nowMs);
  }
  // 3) Market observations (NEVER executed P&L — analysis only).
  for (const o of db.prepare("SELECT setup_id, strategy_agent, lane, setup_tier, ticker, horizon, session, regime, reached_target FROM counterfactual_outcomes WHERE kind='market_movement_observation'").all() as any[]) {
    n += insertTraining(db, {
      setup_id: o.setup_id, source_kind: "MARKET_OBSERVATION", executed: 0, lane: o.lane, strategy_agent: o.strategy_agent,
      setup_tier: o.setup_tier, ticker: o.ticker, horizon: o.horizon, market_session: o.session, regime: o.regime,
      label: o.reached_target === 1 ? "REACHED_TARGET" : "NOT_REACHED", source_table: "counterfactual_outcomes", model_eligibility: "ANALYSIS_ONLY",
    }, nowMs);
  }
  // 4) Rejected-invalid enrollments (rejection analysis only — never an executed example).
  for (const r of db.prepare("SELECT setup_id, strategy_agent, strategy_version, strategy_family, lane, portfolio, setup_tier, ticker, direction, asset_class, horizon, option_symbol, expiration, strike, call_put, market_session, gate_results_json, feature_snapshot_json, data_quality FROM research_enrollments WHERE fill_status='NOT_FILLABLE_REJECTED'").all() as any[]) {
    n += insertTraining(db, {
      setup_id: r.setup_id, source_kind: "REJECTED_INVALID", executed: 0, strategy_agent: r.strategy_agent, strategy_version: r.strategy_version,
      strategy_family: r.strategy_family, lane: r.lane, portfolio: r.portfolio, setup_tier: r.setup_tier, ticker: r.ticker, direction: r.direction,
      asset_class: r.asset_class, horizon: r.horizon, option_symbol: r.option_symbol, expiration: r.expiration, strike: r.strike, call_put: r.call_put,
      market_session: r.market_session, data_quality: r.data_quality, label: null, source_table: "research_enrollments", model_eligibility: "ANALYSIS_ONLY",
    }, nowMs);
  }
  return n;
}

// ── research model-activation states (advisory; never PRODUCTION from research) ──
export type ResearchModelState =
  | "INACTIVE_NO_DATA" | "INACTIVE_INSUFFICIENT_SAMPLE" | "EXPERIMENTAL"
  | "VALIDATION_PENDING" | "VALIDATED_RESEARCH" | "PRODUCTION_ELIGIBLE" | "REJECTED_INVALID";

export interface ModelSampleCounts { graded: number; wins: number; losses: number; passedProductionValidation?: boolean }

/**
 * Advisory research-model state. A research-trained model NEVER becomes
 * PRODUCTION_ELIGIBLE from research performance alone — that requires the existing
 * stricter production validation process (passedProductionValidation), which this
 * pipeline cannot grant. Thresholds mirror the experimental tier (30 / 8 / 8).
 */
export function researchModelState(c: ModelSampleCounts, env: NodeJS.ProcessEnv = process.env): ResearchModelState {
  const minGraded = Number(env.MODEL_EXP_MIN_GRADED ?? 30);
  const minWins = Number(env.MODEL_EXP_MIN_WINS ?? 8);
  const minLosses = Number(env.MODEL_EXP_MIN_LOSSES ?? 8);
  if (c.graded <= 0) return "INACTIVE_NO_DATA";
  if (c.graded < minGraded || c.wins < minWins || c.losses < minLosses) return "INACTIVE_INSUFFICIENT_SAMPLE";
  // Sufficient research sample → EXPERIMENTAL / VALIDATED_RESEARCH, never production
  // unless the SEPARATE production validation explicitly passed.
  if (c.passedProductionValidation === true) return "PRODUCTION_ELIGIBLE";
  return "VALIDATED_RESEARCH";
}

// ── live wrapper (flag-gated; NOT auto-wired into the cycle) ──────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveDb = () => require("@/lib/db").getDb();

/** Live pipeline run. HARD no-op unless AI_RESEARCH_PIPELINE_ENABLED=1. */
export function runResearchPipeline(nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): PipelineSummary {
  const runId = `run_${nowMs}`;
  if (!researchFlags(env).aiResearchPipeline) {
    return { runId, ran: false, skippedReason: "AI_RESEARCH_PIPELINE_ENABLED!=1", stages: [], trainingRows: 0 };
  }
  try {
    return runResearchPipelineOnDb(liveDb() as PipeDb, { runId, nowMs });
  } catch (err: any) {
    return { runId, ran: false, skippedReason: `pipeline error (isolated): ${err?.message ?? String(err)}`, stages: [], trainingRows: 0 };
  }
}
