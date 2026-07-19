/**
 * lib/research/experiment-ledger.ts — the research experiment ledger (Phase 5).
 * Impure (SQLite) with a testable OnDb core.
 *
 * Turns routed Research/Challenge candidates into honest, attributable experiment
 * ENROLLMENTS. Fills reuse the Phase-3 paper_trades path (createLanePaperTrade) — ONE
 * execution model, never a second incompatible one. Enrollment records distinguish:
 *   FILLED                — a real paper fill exists (defensible quote + sizing/risk ok)
 *   OBSERVED_UNFILLED     — valid candidate seen, but no defensible fill (never fabricated)
 *   NOT_FILLABLE_REJECTED — REJECTED_INVALID: analyzed only, NEVER filled, no P&L
 *
 * Hard guarantees: experiments never touch Production Discord or production gates;
 * enrollment is idempotent (UNIQUE(experiment,version,setup)); the live wrapper is a
 * HARD no-op unless RESEARCH_LANE_ENABLED; nothing here fabricates a quote/fill/contract.
 */
import { researchFlags } from "./flags.ts";
import type { Lane, SetupTier } from "./types.ts";

export type ExperimentStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETED" | "INACTIVE_MISSING_DATA";
export type FillStatus = "FILLED" | "OBSERVED_UNFILLED" | "NOT_FILLABLE_REJECTED";

export interface ExperimentConfig {
  acceptedTiers: SetupTier[];
  acceptedLanes: Lane[];
  /** null ⇒ all symbols. */
  symbols: string[] | null;
  /** null ⇒ all horizons. */
  horizons: string[] | null;
  /** null ⇒ all sessions. */
  sessions: string[] | null;
  /** Max spread% a research fill will tolerate. */
  researchMaxSpreadPct: number;
  entryRules?: string | null;
  exitRules?: string | null;
  sizingProfile?: string | null;
  fillModel?: string | null;
  successMetrics?: string | null;
}

export interface ExperimentDefinition {
  id: string;
  version: number;
  hypothesis: string;
  status: ExperimentStatus;
  config: ExperimentConfig;
  strategyAgents: string[];
  minSampleTarget: number;
  /** Non-empty ⇒ status forced INACTIVE_MISSING_DATA. */
  missingRequirements: string[];
}

interface LedgerDb {
  prepare(sql: string): { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => { changes: number; lastInsertRowid: number | bigint } };
}

export type FillFn = (input: {
  ticker: string; optionSymbol: string; optionType: "call" | "put"; strike: number | null;
  expiration: string | null; dte: number | null; entryLimit: number; thesis: string; portfolio: string;
  setupId: string; strategyAgent: string | null; setupTier: string; lane: string;
}) => { ok: boolean; id?: number; reason?: string };

const j = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/** Effective status: missing requirements always force INACTIVE_MISSING_DATA. */
export function effectiveStatus(def: Pick<ExperimentDefinition, "status" | "missingRequirements">): ExperimentStatus {
  if (def.missingRequirements.length > 0) return "INACTIVE_MISSING_DATA";
  return def.status;
}

export function experimentAcceptsEntries(status: ExperimentStatus): boolean {
  return status === "ACTIVE";
}

/** Create (or version) an experiment. Idempotent per (id, version). */
export function createExperimentOnDb(db: LedgerDb, def: ExperimentDefinition, nowMs: number = Date.now()): { created: boolean } {
  const status = effectiveStatus(def);
  const info = db.prepare(
    `INSERT OR IGNORE INTO research_experiments
       (id, version, hypothesis, status, config_json, strategy_agents_json, min_sample_target, missing_requirements_json, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(def.id, def.version, def.hypothesis, status, j(def.config), j(def.strategyAgents), def.minSampleTarget, j(def.missingRequirements), nowMs, nowMs);
  return { created: info.changes > 0 };
}

export function setExperimentStatusOnDb(db: LedgerDb, id: string, version: number, status: ExperimentStatus, nowMs: number = Date.now()): void {
  db.prepare("UPDATE research_experiments SET status=?, updated_at_ms=? WHERE id=? AND version=?").run(status, nowMs, id, version);
}

export function latestExperimentOnDb(db: LedgerDb, id: string): any | null {
  return db.prepare("SELECT * FROM research_experiments WHERE id=? ORDER BY version DESC LIMIT 1").get(id) ?? null;
}

export interface EnrollInput {
  setupId: string;
  setupTier: SetupTier;
  lane: Lane;
  portfolio: string;
  strategyAgent: string | null;
  strategyVersion: number | null;
  strategyFamily: string | null;
  ticker: string;
  assetClass: string;
  direction: string;
  horizon: string;
  optionSymbol: string | null;
  expiration: string | null;
  strike: number | null;
  callPut: string | null;
  session: string;
  regime: string | null;
  optionMid: number | null;
  optionAsk: number | null;
  freshnessOk: boolean;
  spreadPct: number | null;
  quoteTsMs: number | null;
  dataQuality: string | null;
  gateResults: unknown;
  featureSnapshot: unknown;
  providerLimitations: string | null;
}

export interface EnrollResult {
  enrolled: boolean;
  fillStatus?: FillStatus;
  paperTradeId?: number | null;
  reason?: string;
}

/** Policy eligibility (pure): tier/lane/symbol/horizon/session must match the experiment. */
export function enrollmentEligibility(cfg: ExperimentConfig, input: Pick<EnrollInput, "setupTier" | "lane" | "ticker" | "horizon" | "session">): { ok: boolean; reason: string } {
  if (!cfg.acceptedTiers.includes(input.setupTier)) return { ok: false, reason: `tier ${input.setupTier} not accepted` };
  if (!cfg.acceptedLanes.includes(input.lane)) return { ok: false, reason: `lane ${input.lane} not accepted` };
  if (cfg.symbols && !cfg.symbols.includes(input.ticker.toUpperCase())) return { ok: false, reason: `symbol ${input.ticker} not in universe` };
  if (cfg.horizons && !cfg.horizons.includes(input.horizon)) return { ok: false, reason: `horizon ${input.horizon} not accepted` };
  if (cfg.sessions && !cfg.sessions.includes(input.session)) return { ok: false, reason: `session ${input.session} not accepted` };
  return { ok: true, reason: "eligible" };
}

/** Does this candidate have a defensible, fillable quote right now? Pure. */
export function hasDefensibleFill(cfg: ExperimentConfig, input: EnrollInput): { ok: boolean; reason: string } {
  if (!input.optionSymbol) return { ok: false, reason: "no option contract (stock research fill not yet supported)" };
  if (!input.freshnessOk) return { ok: false, reason: "data stale/unverifiable — no defensible fill" };
  const px = input.optionMid ?? input.optionAsk ?? null;
  if (!(typeof px === "number" && px > 0)) return { ok: false, reason: "no genuine two-sided quote to fill" };
  if (input.spreadPct != null && input.spreadPct > cfg.researchMaxSpreadPct) return { ok: false, reason: `spread ${input.spreadPct}% exceeds research max ${cfg.researchMaxSpreadPct}%` };
  return { ok: true, reason: "defensible quote" };
}

/**
 * Enroll one routed candidate into an ACTIVE experiment. Idempotent. Creates a real
 * fill (via `fill`) only for a tradeable tier WITH a defensible quote; REJECTED_INVALID
 * is recorded NOT_FILLABLE_REJECTED and never filled; anything else without a defensible
 * quote is recorded OBSERVED_UNFILLED. Never fabricates a fill.
 */
export function enrollCandidateOnDb(
  db: LedgerDb,
  experiment: { id: string; version: number; status: ExperimentStatus; config: ExperimentConfig },
  input: EnrollInput,
  fill: FillFn,
  nowMs: number = Date.now(),
): EnrollResult {
  if (!experimentAcceptsEntries(experiment.status)) return { enrolled: false, reason: `experiment not ACTIVE (${experiment.status})` };
  const elig = enrollmentEligibility(experiment.config, input);
  if (!elig.ok) return { enrolled: false, reason: elig.reason };

  const existing = db.prepare("SELECT 1 FROM research_enrollments WHERE experiment_id=? AND experiment_version=? AND setup_id=? LIMIT 1")
    .get(experiment.id, experiment.version, input.setupId);
  if (existing) return { enrolled: false, reason: "already enrolled (idempotent)" };

  let fillStatus: FillStatus;
  let nonFillReason: string | null = null;
  let paperTradeId: number | null = null;

  if (input.setupTier === "REJECTED_INVALID") {
    fillStatus = "NOT_FILLABLE_REJECTED";
    nonFillReason = "rejected-invalid: never filled, analysis only";
  } else {
    const defensible = hasDefensibleFill(experiment.config, input);
    if (!defensible.ok) {
      fillStatus = "OBSERVED_UNFILLED";
      nonFillReason = defensible.reason;
    } else {
      const px = (input.optionMid ?? input.optionAsk) as number;
      const res = fill({
        ticker: input.ticker, optionSymbol: input.optionSymbol as string,
        optionType: (input.callPut as "call" | "put" | null) ?? (input.direction === "bearish" ? "put" : "call"),
        strike: input.strike, expiration: input.expiration, dte: null, entryLimit: px,
        thesis: `experiment ${experiment.id}@${experiment.version} ${input.setupTier} [${input.strategyAgent}]`,
        portfolio: input.portfolio, setupId: input.setupId, strategyAgent: input.strategyAgent,
        setupTier: input.setupTier, lane: input.lane,
      });
      if (res.ok) { fillStatus = "FILLED"; paperTradeId = res.id ?? null; }
      else { fillStatus = "OBSERVED_UNFILLED"; nonFillReason = res.reason ?? "fill refused (sizing/risk/capital)"; }
    }
  }

  db.prepare(
    `INSERT OR IGNORE INTO research_enrollments
      (experiment_id, experiment_version, setup_id, lane, portfolio, strategy_agent, strategy_version, strategy_family,
       setup_tier, ticker, asset_class, direction, horizon, option_symbol, expiration, strike, call_put, market_session, regime,
       fill_status, non_fill_reason, paper_trade_id, entry_quote_source, quote_ts_ms, data_quality,
       gate_results_json, feature_snapshot_json, provider_limitations, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)`,
  ).run(
    experiment.id, experiment.version, input.setupId, input.lane, input.portfolio, input.strategyAgent, input.strategyVersion, input.strategyFamily,
    input.setupTier, input.ticker, input.assetClass, input.direction, input.horizon, input.optionSymbol, input.expiration, input.strike, input.callPut, input.session, input.regime,
    fillStatus, nonFillReason, paperTradeId, input.optionSymbol ? "captured_two_sided_quote" : null, input.quoteTsMs, input.dataQuality,
    j(input.gateResults), j(input.featureSnapshot), input.providerLimitations, nowMs,
  );

  return { enrolled: true, fillStatus, paperTradeId };
}

/** Experiment-level enrollment/fill summary. */
export function experimentSummaryOnDb(db: LedgerDb, id: string, version: number): {
  enrolled: number; filled: number; observedUnfilled: number; rejectedNotFilled: number;
} {
  const n = (sql: string, ...a: any[]) => Number((db.prepare(sql).get(...a) as any)?.n ?? 0);
  return {
    enrolled: n("SELECT COUNT(*) n FROM research_enrollments WHERE experiment_id=? AND experiment_version=?", id, version),
    filled: n("SELECT COUNT(*) n FROM research_enrollments WHERE experiment_id=? AND experiment_version=? AND fill_status='FILLED'", id, version),
    observedUnfilled: n("SELECT COUNT(*) n FROM research_enrollments WHERE experiment_id=? AND experiment_version=? AND fill_status='OBSERVED_UNFILLED'", id, version),
    rejectedNotFilled: n("SELECT COUNT(*) n FROM research_enrollments WHERE experiment_id=? AND experiment_version=? AND fill_status='NOT_FILLABLE_REJECTED'", id, version),
  };
}

// ── live wrapper (flag-gated; NOT auto-wired into the cycle in Phase 5) ───────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveDb = () => require("@/lib/db").getDb();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const liveFill: FillFn = (input) => {
  const r = require("@/lib/paper-engine").createLanePaperTrade(input);
  return { ok: r.ok, id: r.id, reason: r.ok ? undefined : (r.risk?.failures ?? []).join("; ") };
};

/** Live enrollment for an ACTIVE experiment. HARD no-op unless RESEARCH_LANE_ENABLED. */
export function enrollRoutedCandidates(experimentId: string, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): { ran: boolean; enrolled: number; skippedReason: string | null } {
  if (!researchFlags(env).researchLane) return { ran: false, enrolled: 0, skippedReason: "RESEARCH_LANE_ENABLED!=1" };
  try {
    const db = liveDb() as LedgerDb;
    const exp = latestExperimentOnDb(db, experimentId);
    if (!exp) return { ran: true, enrolled: 0, skippedReason: "experiment not found" };
    const status = exp.status as ExperimentStatus;
    if (!experimentAcceptsEntries(status)) return { ran: true, enrolled: 0, skippedReason: `experiment not ACTIVE (${status})` };
    const config = JSON.parse(exp.config_json ?? "{}") as ExperimentConfig;
    const rows = db.prepare(
      `SELECT lr.lane AS lane, sc.* FROM lane_routes lr JOIN setup_candidates sc ON sc.setup_id = lr.setup_id
       WHERE lr.routed=1 AND lr.lane IN ('RESEARCH','CHALLENGE_PAPER') ORDER BY lr.id ASC`,
    ).all() as any[];
    let enrolled = 0;
    for (const r of rows) {
      const res = enrollCandidateOnDb(db, { id: exp.id, version: exp.version, status, config }, rowToEnrollInput(r), liveFill, nowMs);
      if (res.enrolled) enrolled += 1;
    }
    return { ran: true, enrolled, skippedReason: null };
  } catch (err: any) {
    return { ran: false, enrolled: 0, skippedReason: `ledger error (isolated): ${err?.message ?? String(err)}` };
  }
}

function rowToEnrollInput(r: any): EnrollInput {
  return {
    setupId: r.setup_id, setupTier: r.setup_tier, lane: r.lane, portfolio: r.lane === "CHALLENGE_PAPER" ? "CHALLENGE" : "RESEARCH",
    strategyAgent: r.strategy_agent ?? null, strategyVersion: r.strategy_version ?? null, strategyFamily: r.strategy_family ?? null,
    ticker: r.ticker, assetClass: r.asset_class, direction: r.direction, horizon: r.horizon,
    optionSymbol: r.option_symbol ?? null, expiration: r.expiration ?? null, strike: r.strike ?? null, callPut: r.side ?? null,
    session: r.session, regime: null, optionMid: r.option_mid ?? null, optionAsk: r.option_ask ?? null,
    freshnessOk: (r.freshness_state ?? "") === "fresh", spreadPct: r.spread_pct ?? null, quoteTsMs: null,
    dataQuality: r.freshness_state ?? null, gateResults: r.gate_results_json ? JSON.parse(r.gate_results_json) : null,
    featureSnapshot: r.feature_snapshot_json ? JSON.parse(r.feature_snapshot_json) : null, providerLimitations: null,
  };
}
