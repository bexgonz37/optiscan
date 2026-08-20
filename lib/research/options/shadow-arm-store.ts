/**
 * Persistence for the prospective shadow arm, the experiment registry and the lifecycle.
 *
 * Impure (SQLite) with a testable OnDb core, matching the shape used everywhere else in this
 * codebase. Three properties are load-bearing:
 *
 * 1. REGISTRY IS WRITE-ONCE. `registerExperimentOnDb` is INSERT OR IGNORE, and if a row
 *    already exists with a DIFFERENT `definition_hash` it reports a conflict rather than
 *    overwriting. A rule that changed mid-sample invalidates that sample, and the database is
 *    where that has to be caught — a source-level guard test only catches it before deploy.
 *
 * 2. DECISIONS ARE IDEMPOTENT AND IMMUTABLE. `decision_key` buckets on the same 5-minute grain
 *    the alert dedup uses, so a re-run of a batch cannot double-count an opportunity, and a
 *    second write never revises the first. The decision was made at a point in time; editing it
 *    later is exactly the failure this whole arm exists to prevent.
 *
 * 3. OUTCOMES ARRIVE SEPARATELY. `linkOutcomeOnDb` writes only the outcome columns and never
 *    touches a decision column. Nothing in the write path can let a known result change a
 *    recorded decision.
 *
 * Every writer is isolated: a failure here must never propagate into delivery.
 */

import type { ShadowRecord } from "./prospective-shadow.ts";
import {
  LHC_SELECT_V1, type FrozenExperiment, type ExperimentStatus, assertTransition,
} from "./experiment-registry.ts";

export interface ShadowDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number; lastInsertRowid?: number | bigint };
  };
}

const j = (v: unknown): string => JSON.stringify(v ?? null);

function hasTable(db: ShadowDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch { return false; }
}

// ── registry ────────────────────────────────────────────────────────────────

export type RegisterResult =
  | { ok: true; created: boolean; conflict: false }
  | { ok: false; created: false; conflict: true; storedHash: string; currentHash: string; message: string };

/**
 * Record the frozen experiment. Idempotent, and REFUSES to update: if the stored definition
 * hash differs from the one being registered, the rule changed underneath a live sample.
 */
export function registerExperimentOnDb(
  db: ShadowDb,
  e: FrozenExperiment = LHC_SELECT_V1,
  nowMs: number = Date.now(),
): RegisterResult {
  if (!hasTable(db, "options_experiment_registry")) {
    return { ok: true, created: false, conflict: false };
  }
  const existing = db.prepare(
    "SELECT definition_hash FROM options_experiment_registry WHERE experiment_id=? AND experiment_version=?",
  ).get(e.experimentId, e.experimentVersion) as { definition_hash?: string } | undefined;

  if (existing?.definition_hash && existing.definition_hash !== e.definitionHash) {
    return {
      ok: false, created: false, conflict: true,
      storedHash: existing.definition_hash,
      currentHash: e.definitionHash,
      message:
        `${e.experimentId}@${e.experimentVersion} was registered with a different gate definition. ` +
        "Its prospective sample mixes two rules and is invalid. Register a new version instead.",
    };
  }

  const info = db.prepare(
    `INSERT OR IGNORE INTO options_experiment_registry
       (experiment_id, experiment_version, mode, hypothesis, gates_json, definition_hash,
        creation_sha, prospective_start_date, activation_at_ms, source_cohort_id,
        development_sessions_json, validation_sessions_json, historical_result_json,
        robustness_caveats_json, would_be_disproven_by, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    e.experimentId, e.experimentVersion, e.mode, e.hypothesis, j(e.gates), e.definitionHash,
    e.creationSha, e.prospectiveStartDate, e.activationAtMs, e.sourceCohortId,
    j(e.developmentSessions), j(e.validationSessions), j(e.historicalResult),
    j(e.robustnessCaveats), e.wouldBeDisprovenBy, nowMs,
  );
  return { ok: true, created: info.changes > 0, conflict: false };
}

// ── lifecycle ───────────────────────────────────────────────────────────────

export function currentStatusOnDb(
  db: ShadowDb, experimentId: string, version: number,
): ExperimentStatus | null {
  if (!hasTable(db, "options_experiment_status")) return null;
  const row = db.prepare(
    `SELECT status FROM options_experiment_status
      WHERE experiment_id=? AND experiment_version=? ORDER BY id DESC LIMIT 1`,
  ).get(experimentId, version) as { status?: string } | undefined;
  return (row?.status as ExperimentStatus | undefined) ?? null;
}

export interface RecordStatusInput {
  experimentId: string;
  experimentVersion: number;
  status: ExperimentStatus;
  reason: string;
  evidence?: unknown;
  /** 'deterministic' for the nightly aggregator; an AI proposal is still not a human. */
  actor: string;
}

/**
 * Append a lifecycle row. Enforces the transition table, so an experiment cannot jump from
 * PROSPECTIVE_SHADOW straight to PROMISING without closed outcomes having moved it through
 * PAPER_VALIDATION first.
 */
export function recordStatusOnDb(
  db: ShadowDb, i: RecordStatusInput, nowMs: number = Date.now(),
): { recorded: boolean; previous: ExperimentStatus | null; reason?: string } {
  if (!hasTable(db, "options_experiment_status")) return { recorded: false, previous: null, reason: "table missing" };
  const previous = currentStatusOnDb(db, i.experimentId, i.experimentVersion);
  if (previous === i.status) return { recorded: false, previous, reason: "already in this status" };
  if (previous != null) assertTransition(previous, i.status);

  db.prepare(
    `INSERT INTO options_experiment_status
       (experiment_id, experiment_version, status, previous_status, reason, evidence_json, actor, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(i.experimentId, i.experimentVersion, i.status, previous, i.reason, j(i.evidence), i.actor, nowMs);
  return { recorded: true, previous };
}

/** Full append-only history, newest last. A demotion never erases what promoted it. */
export function statusHistoryOnDb(db: ShadowDb, experimentId: string, version: number): {
  status: string; previousStatus: string | null; reason: string; actor: string; createdAtMs: number;
}[] {
  if (!hasTable(db, "options_experiment_status")) return [];
  return (db.prepare(
    `SELECT status, previous_status, reason, actor, created_at_ms
       FROM options_experiment_status WHERE experiment_id=? AND experiment_version=? ORDER BY id ASC`,
  ).all(experimentId, version) as any[]).map((r) => ({
    status: r.status, previousStatus: r.previous_status ?? null,
    reason: r.reason, actor: r.actor, createdAtMs: r.created_at_ms,
  }));
}

// ── decisions ───────────────────────────────────────────────────────────────

/** Same 5-minute grain the alert dedup uses, so a re-run cannot double-count. */
export const DECISION_BUCKET_MS = 300_000;

export function decisionKey(r: Pick<ShadowRecord, "experimentId" | "experimentVersion" | "symbol" | "optionSymbol" | "recordedAtMs">): string {
  const bucket = Math.floor(r.recordedAtMs / DECISION_BUCKET_MS);
  return `${r.experimentId}@${r.experimentVersion}|${r.symbol}|${r.optionSymbol}|${bucket}`;
}

/**
 * Write one shadow decision. INSERT OR IGNORE — a decision is never revised, so a repeated
 * batch is a no-op rather than an update.
 */
export function recordShadowDecisionOnDb(
  db: ShadowDb, r: ShadowRecord, nowMs: number = Date.now(),
): { written: boolean; decisionKey: string } {
  const key = decisionKey(r);
  if (!hasTable(db, "options_experiment_decisions")) return { written: false, decisionKey: key };
  const info = db.prepare(
    `INSERT OR IGNORE INTO options_experiment_decisions
       (decision_key, experiment_id, experiment_version, session_date, recorded_at_ms,
        symbol, strategy, side, direction, option_symbol, opportunity_case_id, alert_id,
        baseline_admitted, baseline_outcome, baseline_reason, baseline_quality,
        experiment_admitted, experiment_blocked_by_json, experiment_unavailable_json,
        experiment_score, experiment_components_json, experiment_reason, arm,
        features_json, confirmation_json, attribution_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    key, r.experimentId, r.experimentVersion, r.sessionDate, r.recordedAtMs,
    r.symbol, r.strategy, r.side, r.direction, r.optionSymbol, r.opportunityCaseId, r.alertId,
    r.baselineAdmitted ? 1 : 0, r.baselineOutcome, r.baselineReason, r.baselineQuality,
    r.experimentAdmitted ? 1 : 0, j(r.experimentBlockedBy), j(r.experimentUnavailable),
    r.experimentScore, j(r.experimentComponents), r.experimentReason, r.arm,
    j(r.features), j(r.confirmation), j(r.attribution), nowMs,
  );
  return { written: info.changes > 0, decisionKey: key };
}

/**
 * Attach the mirror once it exists. Writes ONLY the linkage column — a decision column is
 * never touched after the fact.
 */
export function linkPaperTradeOnDb(
  db: ShadowDb, decisionKeyValue: string, paperTradeId: number, paperEnteredAtMs: number | null,
): { linked: boolean } {
  if (!hasTable(db, "options_experiment_decisions")) return { linked: false };
  const row = db.prepare("SELECT confirmation_json FROM options_experiment_decisions WHERE decision_key=?")
    .get(decisionKeyValue) as { confirmation_json?: string } | undefined;
  if (!row) return { linked: false };
  // paperEnteredAtMs is the one confirmation field only knowable after the reservation.
  let confirmation = row.confirmation_json ?? "null";
  if (paperEnteredAtMs != null) {
    try {
      const c = JSON.parse(confirmation) ?? {};
      if (c.paperEnteredAtMs == null) {
        c.paperEnteredAtMs = paperEnteredAtMs;
        c.fieldQuality = { ...(c.fieldQuality ?? {}), paperEnteredAtMs: "OBSERVED" };
        confirmation = JSON.stringify(c);
      }
    } catch { /* leave as stored */ }
  }
  const info = db.prepare(
    "UPDATE options_experiment_decisions SET paper_trade_id=?, confirmation_json=?, outcome_status='OPEN' WHERE decision_key=? AND paper_trade_id IS NULL",
  ).run(paperTradeId, confirmation, decisionKeyValue);
  return { linked: info.changes > 0 };
}

export interface OutcomeLink {
  paperTradeId: number;
  outcomeStatus: "OPEN" | "CLOSED" | "UNGRADABLE";
  returnPct: number | null;
  exitReason: string | null;
  closedAtMs: number | null;
  sameContractMarks: number | null;
  peakPct: number | null;
  troughPct: number | null;
}

/** Write outcome columns only. Decision columns are untouched by construction. */
export function linkOutcomeOnDb(db: ShadowDb, o: OutcomeLink): { updated: number } {
  if (!hasTable(db, "options_experiment_decisions")) return { updated: 0 };
  const info = db.prepare(
    `UPDATE options_experiment_decisions
        SET outcome_status=?, return_pct=?, exit_reason=?, closed_at_ms=?,
            same_contract_marks=?, peak_pct=?, trough_pct=?
      WHERE paper_trade_id=?`,
  ).run(
    o.outcomeStatus, o.returnPct, o.exitReason, o.closedAtMs,
    o.sameContractMarks, o.peakPct, o.troughPct, o.paperTradeId,
  );
  return { updated: info.changes };
}

// ── reads ───────────────────────────────────────────────────────────────────

export interface ShadowDecisionRow {
  decisionKey: string;
  experimentId: string;
  experimentVersion: number;
  sessionDate: string;
  recordedAtMs: number;
  symbol: string;
  strategy: string;
  side: string | null;
  direction: string | null;
  optionSymbol: string;
  opportunityCaseId: string | null;
  alertId: string | null;
  baselineAdmitted: boolean;
  baselineOutcome: string | null;
  baselineReason: string | null;
  baselineQuality: number | null;
  experimentAdmitted: boolean;
  experimentBlockedBy: string[];
  experimentUnavailable: string[];
  experimentScore: number | null;
  experimentReason: string | null;
  arm: string;
  features: Record<string, unknown> | null;
  confirmation: Record<string, unknown> | null;
  attribution: Record<string, unknown> | null;
  paperTradeId: number | null;
  outcomeStatus: string | null;
  returnPct: number | null;
  exitReason: string | null;
  closedAtMs: number | null;
  sameContractMarks: number | null;
  peakPct: number | null;
  troughPct: number | null;
}

const parse = (s: unknown): any => {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s); } catch { return null; }
};

export function listShadowDecisionsOnDb(
  db: ShadowDb,
  opts: { experimentId?: string; sinceMs?: number; sessionDate?: string; limit?: number } = {},
): ShadowDecisionRow[] {
  if (!hasTable(db, "options_experiment_decisions")) return [];
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.experimentId) { where.push("experiment_id=?"); args.push(opts.experimentId); }
  if (opts.sinceMs != null) { where.push("recorded_at_ms >= ?"); args.push(opts.sinceMs); }
  if (opts.sessionDate) { where.push("session_date=?"); args.push(opts.sessionDate); }
  const sql = `SELECT * FROM options_experiment_decisions${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
               ORDER BY recorded_at_ms ASC LIMIT ${Math.max(1, Math.min(opts.limit ?? 5000, 20000))}`;
  return (db.prepare(sql).all(...args) as any[]).map((r) => ({
    decisionKey: r.decision_key,
    experimentId: r.experiment_id,
    experimentVersion: r.experiment_version,
    sessionDate: r.session_date,
    recordedAtMs: r.recorded_at_ms,
    symbol: r.symbol,
    strategy: r.strategy,
    side: r.side ?? null,
    direction: r.direction ?? null,
    optionSymbol: r.option_symbol,
    opportunityCaseId: r.opportunity_case_id ?? null,
    alertId: r.alert_id ?? null,
    baselineAdmitted: Boolean(r.baseline_admitted),
    baselineOutcome: r.baseline_outcome ?? null,
    baselineReason: r.baseline_reason ?? null,
    baselineQuality: r.baseline_quality ?? null,
    experimentAdmitted: Boolean(r.experiment_admitted),
    experimentBlockedBy: parse(r.experiment_blocked_by_json) ?? [],
    experimentUnavailable: parse(r.experiment_unavailable_json) ?? [],
    experimentScore: r.experiment_score ?? null,
    experimentReason: r.experiment_reason ?? null,
    arm: r.arm,
    features: parse(r.features_json),
    confirmation: parse(r.confirmation_json),
    attribution: parse(r.attribution_json),
    paperTradeId: r.paper_trade_id ?? null,
    outcomeStatus: r.outcome_status ?? null,
    returnPct: r.return_pct ?? null,
    exitReason: r.exit_reason ?? null,
    closedAtMs: r.closed_at_ms ?? null,
    sameContractMarks: r.same_contract_marks ?? null,
    peakPct: r.peak_pct ?? null,
    troughPct: r.trough_pct ?? null,
  }));
}

/**
 * Refresh outcome columns from the paper store for every linked decision. Deterministic,
 * zero provider calls — it reads the same `options_paper_trades` + same-contract marks the
 * cohort loader uses, so a shadow row and a cohort row agree by construction.
 */
export function refreshShadowOutcomesOnDb(db: ShadowDb, opts: { sinceMs?: number } = {}): { refreshed: number } {
  if (!hasTable(db, "options_experiment_decisions") || !hasTable(db, "options_paper_trades")) {
    return { refreshed: 0 };
  }
  const rows = db.prepare(
    `SELECT d.decision_key, d.paper_trade_id, t.status, t.return_pct, t.exit_reason, t.exit_at_ms, t.option_symbol
       FROM options_experiment_decisions d
       JOIN options_paper_trades t ON t.id = d.paper_trade_id
      WHERE d.paper_trade_id IS NOT NULL
        AND (d.outcome_status IS NULL OR d.outcome_status <> 'CLOSED')
        ${opts.sinceMs != null ? "AND d.recorded_at_ms >= ?" : ""}`,
  ).all(...(opts.sinceMs != null ? [opts.sinceMs] : [])) as any[];

  let refreshed = 0;
  for (const r of rows) {
    // Same-contract marks only: a mark on a re-selected OCC is a different instrument, which is
    // the defect that produced the +149% phantom MFE in an earlier packet.
    let marks = 0, peak: number | null = null, trough: number | null = null;
    try {
      const m = db.prepare(
        `SELECT COUNT(*) n, MAX(return_pct) mx, MIN(return_pct) mn
           FROM options_paper_marks WHERE trade_id=? AND option_symbol=?`,
      ).get(r.paper_trade_id, r.option_symbol) as any;
      marks = Number(m?.n ?? 0);
      peak = m?.mx ?? null;
      trough = m?.mn ?? null;
    } catch { /* marks table shape differs on a legacy DB; outcome still records */ }

    const closed = r.status === "EXITED";
    const status = !closed ? "OPEN" : r.return_pct == null ? "UNGRADABLE" : "CLOSED";
    const res = linkOutcomeOnDb(db, {
      paperTradeId: r.paper_trade_id,
      outcomeStatus: status,
      returnPct: r.return_pct ?? null,
      exitReason: r.exit_reason ?? null,
      closedAtMs: r.exit_at_ms ?? null,
      sameContractMarks: marks,
      peakPct: peak,
      troughPct: trough,
    });
    refreshed += res.updated;
  }
  return { refreshed };
}
