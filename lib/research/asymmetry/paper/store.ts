/**
 * store.ts — durable persistence for the High-Asymmetry paper lane.
 *
 * Additive and repeat-safe: every statement is CREATE ... IF NOT EXISTS or an
 * upsert keyed so a replayed write is a no-op. No existing table is altered, no
 * existing row is ever written, and there is no destructive DDL in this file.
 *
 * ONE ACTIVE POSITION PER FINGERPRINT is enforced by the PRIMARY KEY
 * (session_date, position_fingerprint) and an INSERT OR IGNORE, so a duplicate
 * is refused by SQLite itself. A read-then-write check would race against the
 * 60-second sweep and the live loop running in the same process.
 *
 * Every function swallows its own errors and returns a result. A persistence
 * fault here must never reach the scanner, the delivery path, or Discord — the
 * paper lane is research and is always the thing that gives way.
 *
 * NO AI. Nothing here imports, calls, or awaits a model.
 */
import { ASYMMETRY_PAPER_LANE, PAPER_RULES_VERSION, type PaperPositionState } from "./lane.ts";

type StoreDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

/** Idempotent schema. Safe to call on every write, and called on every write. */
export function ensureAsymmetryPaperSchema(db: StoreDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asymmetry_paper_positions (
      session_date TEXT NOT NULL,
      position_fingerprint TEXT NOT NULL,
      lane TEXT NOT NULL,
      rules_version TEXT NOT NULL,
      code_version TEXT,
      case_fingerprint TEXT NOT NULL,
      alert_id TEXT,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      option_symbol TEXT NOT NULL,
      setup_family TEXT,
      state_at_entry TEXT NOT NULL,
      entry_at_ms INTEGER NOT NULL,
      entry_fill REAL NOT NULL,
      entry_bid REAL, entry_ask REAL, entry_spread_pct REAL,
      entry_underlying_price REAL,
      entry_quote_at_ms INTEGER,
      evidence_json TEXT,
      missing_evidence_json TEXT,
      stop_loss_pct REAL NOT NULL,
      fixed_risk_qty INTEGER,
      fixed_risk_reason TEXT,
      fixed_risk_cost_usd REAL,
      fixed_risk_at_risk_usd REAL,
      position_state TEXT NOT NULL,
      last_bid REAL, last_mark_at_ms INTEGER, last_return_pct REAL,
      mfe_pct REAL, mae_pct REAL, highest_milestone INTEGER,
      exit_at_ms INTEGER, exit_fill REAL, exit_reason TEXT,
      final_return_pct REAL,
      pnl_one_contract_usd REAL,
      pnl_sized_usd REAL,
      outcome_state TEXT NOT NULL,
      missing_data_reason TEXT,
      exit_attempts INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_date, position_fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_asym_paper_pos_session ON asymmetry_paper_positions(session_date, entry_at_ms);
    CREATE INDEX IF NOT EXISTS idx_asym_paper_pos_open ON asymmetry_paper_positions(session_date, position_state);
    CREATE INDEX IF NOT EXISTS idx_asym_paper_pos_case ON asymmetry_paper_positions(case_fingerprint, session_date);

    CREATE TABLE IF NOT EXISTS asymmetry_paper_marks (
      session_date TEXT NOT NULL,
      position_fingerprint TEXT NOT NULL,
      marked_at_ms INTEGER NOT NULL,
      bid REAL, ask REAL, quote_age_ms INTEGER,
      return_pct REAL,
      rejected_reason TEXT,
      PRIMARY KEY (session_date, position_fingerprint, marked_at_ms)
    );
    CREATE INDEX IF NOT EXISTS idx_asym_paper_marks_pos ON asymmetry_paper_marks(session_date, position_fingerprint, marked_at_ms);

    CREATE TABLE IF NOT EXISTS asymmetry_paper_skips (
      session_date TEXT NOT NULL,
      position_fingerprint TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT,
      state_at_skip TEXT,
      first_seen_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (session_date, position_fingerprint, reason)
    );
    CREATE INDEX IF NOT EXISTS idx_asym_paper_skips_session ON asymmetry_paper_skips(session_date, last_seen_at_ms);

    CREATE TABLE IF NOT EXISTS asymmetry_paper_report_delivery (
      session_date TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      reason TEXT,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asymmetry_quant_reports (
      session_date TEXT NOT NULL,
      rules_version TEXT NOT NULL,
      built_at_ms INTEGER NOT NULL,
      report_json TEXT NOT NULL,
      PRIMARY KEY (session_date, rules_version)
    );
  `);
}

function hasTable(db: StoreDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

export interface OpenPaperPositionRow {
  sessionDate: string;
  positionFingerprint: string;
  caseFingerprint: string;
  alertId: string | null;
  symbol: string;
  direction: "CALL" | "PUT";
  optionSymbol: string;
  setupFamily: string | null;
  stateAtEntry: string;
  entryAtMs: number;
  entryFill: number;
  entryBid: number | null;
  entryAsk: number | null;
  entrySpreadPct: number | null;
  entryUnderlyingPrice: number | null;
  entryQuoteAtMs: number | null;
  evidenceJson: string | null;
  missingEvidenceJson: string | null;
  stopLossPct: number;
  fixedRiskQty: number | null;
  fixedRiskReason: string | null;
  fixedRiskCostUsd: number | null;
  fixedRiskAtRiskUsd: number | null;
  codeVersion: string | null;
}

export interface PaperStoreResult {
  ok: boolean;
  /** True only when THIS call created the position. */
  created: boolean;
  error: string | null;
}

/**
 * Open a simulated position. Repeat-safe by PRIMARY KEY: a second call for the
 * same (session, fingerprint) does NOT overwrite the original — the frozen
 * entry timestamp and premium are the whole point of the measurement.
 */
export function openPaperPositionOnDb(db: StoreDb, row: OpenPaperPositionRow, nowMs: number): PaperStoreResult {
  try {
    ensureAsymmetryPaperSchema(db);
    const res = db.prepare(`
      INSERT OR IGNORE INTO asymmetry_paper_positions
        (session_date, position_fingerprint, lane, rules_version, code_version,
         case_fingerprint, alert_id, symbol, direction, option_symbol, setup_family,
         state_at_entry, entry_at_ms, entry_fill, entry_bid, entry_ask, entry_spread_pct,
         entry_underlying_price, entry_quote_at_ms, evidence_json, missing_evidence_json,
         stop_loss_pct, fixed_risk_qty, fixed_risk_reason, fixed_risk_cost_usd, fixed_risk_at_risk_usd,
         position_state, mfe_pct, mae_pct, highest_milestone, outcome_state, exit_attempts, updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'OPEN',NULL,NULL,NULL,'UNVERIFIED',0,?)
    `).run(
      row.sessionDate, row.positionFingerprint, ASYMMETRY_PAPER_LANE, PAPER_RULES_VERSION, row.codeVersion,
      row.caseFingerprint, row.alertId, row.symbol, row.direction, row.optionSymbol, row.setupFamily,
      row.stateAtEntry, row.entryAtMs, row.entryFill, row.entryBid, row.entryAsk, row.entrySpreadPct,
      row.entryUnderlyingPrice, row.entryQuoteAtMs, row.evidenceJson, row.missingEvidenceJson,
      row.stopLossPct, row.fixedRiskQty, row.fixedRiskReason, row.fixedRiskCostUsd, row.fixedRiskAtRiskUsd,
      nowMs,
    );
    return { ok: true, created: Number(res.changes ?? 0) > 0, error: null };
  } catch (err: any) {
    return { ok: false, created: false, error: String(err?.message ?? err) };
  }
}

/** Record why an entry did not happen. Repeat-safe: recurring reasons increment. */
export function recordPaperSkipOnDb(db: StoreDb, i: {
  sessionDate: string; positionFingerprint: string; reason: string;
  detail: string | null; stateAtSkip: string | null; nowMs: number;
}): PaperStoreResult {
  try {
    ensureAsymmetryPaperSchema(db);
    const res = db.prepare(`
      INSERT INTO asymmetry_paper_skips
        (session_date, position_fingerprint, reason, detail, state_at_skip, first_seen_at_ms, last_seen_at_ms, occurrences)
      VALUES (?,?,?,?,?,?,?,1)
      ON CONFLICT(session_date, position_fingerprint, reason) DO UPDATE SET
        last_seen_at_ms=excluded.last_seen_at_ms,
        occurrences=asymmetry_paper_skips.occurrences+1,
        detail=excluded.detail
    `).run(i.sessionDate, i.positionFingerprint, i.reason, i.detail, i.stateAtSkip, i.nowMs, i.nowMs);
    return { ok: true, created: Number(res.changes ?? 0) > 0, error: null };
  } catch (err: any) {
    return { ok: false, created: false, error: String(err?.message ?? err) };
  }
}

export interface PaperPositionRecord {
  sessionDate: string;
  positionFingerprint: string;
  caseFingerprint: string;
  alertId: string | null;
  symbol: string;
  direction: "CALL" | "PUT";
  optionSymbol: string;
  setupFamily: string | null;
  stateAtEntry: string;
  rulesVersion: string;
  entryAtMs: number;
  entryFill: number;
  entryBid: number | null;
  entryAsk: number | null;
  entrySpreadPct: number | null;
  stopLossPct: number;
  fixedRiskQty: number | null;
  positionState: PaperPositionState;
  lastBid: number | null;
  lastMarkAtMs: number | null;
  lastReturnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  highestMilestone: number | null;
  exitAtMs: number | null;
  exitFill: number | null;
  exitReason: string | null;
  finalReturnPct: number | null;
  pnlOneContractUsd: number | null;
  pnlSizedUsd: number | null;
  outcomeState: "VERIFIED" | "UNVERIFIED";
  missingDataReason: string | null;
  exitAttempts: number;
  missingEvidence: string[];
}

const SELECT_COLS = `session_date, position_fingerprint, case_fingerprint, alert_id, symbol, direction,
  option_symbol, setup_family, state_at_entry, rules_version, entry_at_ms, entry_fill, entry_bid, entry_ask,
  entry_spread_pct, stop_loss_pct, fixed_risk_qty, position_state, last_bid, last_mark_at_ms, last_return_pct,
  mfe_pct, mae_pct, highest_milestone, exit_at_ms, exit_fill, exit_reason, final_return_pct,
  pnl_one_contract_usd, pnl_sized_usd, outcome_state, missing_data_reason, exit_attempts, missing_evidence_json`;

function mapRow(r: any): PaperPositionRecord {
  return {
    sessionDate: String(r.session_date),
    positionFingerprint: String(r.position_fingerprint),
    caseFingerprint: String(r.case_fingerprint),
    alertId: r.alert_id == null ? null : String(r.alert_id),
    symbol: String(r.symbol),
    direction: r.direction === "PUT" ? "PUT" : "CALL",
    optionSymbol: String(r.option_symbol),
    setupFamily: r.setup_family == null ? null : String(r.setup_family),
    stateAtEntry: String(r.state_at_entry),
    rulesVersion: String(r.rules_version),
    entryAtMs: Number(r.entry_at_ms),
    entryFill: Number(r.entry_fill),
    entryBid: nullNum(r.entry_bid),
    entryAsk: nullNum(r.entry_ask),
    entrySpreadPct: nullNum(r.entry_spread_pct),
    stopLossPct: Number(r.stop_loss_pct),
    fixedRiskQty: nullNum(r.fixed_risk_qty),
    positionState: String(r.position_state) as PaperPositionState,
    lastBid: nullNum(r.last_bid),
    lastMarkAtMs: nullNum(r.last_mark_at_ms),
    lastReturnPct: nullNum(r.last_return_pct),
    mfePct: nullNum(r.mfe_pct),
    maePct: nullNum(r.mae_pct),
    highestMilestone: nullNum(r.highest_milestone),
    exitAtMs: nullNum(r.exit_at_ms),
    exitFill: nullNum(r.exit_fill),
    exitReason: r.exit_reason == null ? null : String(r.exit_reason),
    finalReturnPct: nullNum(r.final_return_pct),
    pnlOneContractUsd: nullNum(r.pnl_one_contract_usd),
    pnlSizedUsd: nullNum(r.pnl_sized_usd),
    outcomeState: r.outcome_state === "VERIFIED" ? "VERIFIED" : "UNVERIFIED",
    missingDataReason: r.missing_data_reason == null ? null : String(r.missing_data_reason),
    exitAttempts: Number(r.exit_attempts ?? 0),
    missingEvidence: safeArray(r.missing_evidence_json),
  };
}

/** All positions for a session. Read path for the runner, EOD, and diagnostics. */
export function listPaperPositionsOnDb(db: StoreDb, sessionDate: string, limit = 500): PaperPositionRecord[] {
  if (!hasTable(db, "asymmetry_paper_positions")) return [];
  try {
    return (db.prepare(
      `SELECT ${SELECT_COLS} FROM asymmetry_paper_positions WHERE session_date=? ORDER BY entry_at_ms DESC LIMIT ?`,
    ).all(sessionDate, Math.max(1, Math.min(2000, limit))) as any[]).map(mapRow);
  } catch {
    return [];
  }
}

/** Only positions still open. */
export function listOpenPaperPositionsOnDb(db: StoreDb, sessionDate: string): PaperPositionRecord[] {
  if (!hasTable(db, "asymmetry_paper_positions")) return [];
  try {
    return (db.prepare(
      `SELECT ${SELECT_COLS} FROM asymmetry_paper_positions
        WHERE session_date=? AND position_state='OPEN' ORDER BY entry_at_ms ASC`,
    ).all(sessionDate) as any[]).map(mapRow);
  } catch {
    return [];
  }
}

/** Does a position already exist for this fingerprint? Diagnostics and guards. */
export function hasPaperPosition(db: StoreDb, sessionDate: string, positionFingerprint: string): boolean {
  if (!hasTable(db, "asymmetry_paper_positions")) return false;
  try {
    return Boolean(db.prepare(
      "SELECT 1 FROM asymmetry_paper_positions WHERE session_date=? AND position_fingerprint=?",
    ).get(sessionDate, positionFingerprint));
  } catch {
    return false;
  }
}

/** Record a forward mark. Repeat-safe on (session, fingerprint, instant). */
export function writePaperMarkOnDb(db: StoreDb, m: {
  sessionDate: string; positionFingerprint: string; markedAtMs: number;
  bid: number | null; ask: number | null; quoteAgeMs: number | null;
  returnPct: number | null; rejectedReason: string | null;
}): boolean {
  try {
    const res = db.prepare(`
      INSERT OR IGNORE INTO asymmetry_paper_marks
        (session_date, position_fingerprint, marked_at_ms, bid, ask, quote_age_ms, return_pct, rejected_reason)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(m.sessionDate, m.positionFingerprint, m.markedAtMs, m.bid, m.ask, m.quoteAgeMs, m.returnPct, m.rejectedReason);
    return Number(res.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Apply a mark to the open position: last mark, MFE, MAE, milestone. */
export function applyPaperMarkOnDb(db: StoreDb, i: {
  sessionDate: string; positionFingerprint: string; markedAtMs: number;
  bid: number | null; returnPct: number | null; mfePct: number | null; maePct: number | null;
  highestMilestone: number | null;
}): boolean {
  try {
    const res = db.prepare(`
      UPDATE asymmetry_paper_positions
         SET last_bid=?, last_mark_at_ms=?, last_return_pct=?,
             mfe_pct=?, mae_pct=?, highest_milestone=?, updated_at_ms=?
       WHERE session_date=? AND position_fingerprint=? AND position_state='OPEN'
    `).run(i.bid, i.markedAtMs, i.returnPct, i.mfePct, i.maePct, i.highestMilestone,
      i.markedAtMs, i.sessionDate, i.positionFingerprint);
    return Number(res.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Close a position at a VERIFIED exit price. Guarded on position_state='OPEN'
 * so a replayed close is a no-op rather than a second exit.
 */
export function closePaperPositionOnDb(db: StoreDb, i: {
  sessionDate: string; positionFingerprint: string; exitAtMs: number; exitFill: number;
  exitReason: string; finalReturnPct: number | null;
  pnlOneContractUsd: number | null; pnlSizedUsd: number | null;
  positionState: "CLOSED" | "EXPIRED_SESSION";
}): boolean {
  try {
    const res = db.prepare(`
      UPDATE asymmetry_paper_positions
         SET position_state=?, exit_at_ms=?, exit_fill=?, exit_reason=?,
             final_return_pct=?, pnl_one_contract_usd=?, pnl_sized_usd=?,
             outcome_state='VERIFIED', missing_data_reason=NULL, updated_at_ms=?
       WHERE session_date=? AND position_fingerprint=? AND position_state='OPEN'
    `).run(i.positionState, i.exitAtMs, i.exitFill, i.exitReason, i.finalReturnPct,
      i.pnlOneContractUsd, i.pnlSizedUsd, i.exitAtMs, i.sessionDate, i.positionFingerprint);
    return Number(res.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * An exit was WANTED but no valid quote exists. The position stays OPEN and
 * UNVERIFIED with the reason recorded. It is never marked a loss and never
 * assigned a zero — an absent exit price is missing data, not a result.
 */
export function recordUnverifiedExitOnDb(db: StoreDb, i: {
  sessionDate: string; positionFingerprint: string; reason: string; nowMs: number;
}): boolean {
  try {
    const res = db.prepare(`
      UPDATE asymmetry_paper_positions
         SET outcome_state='UNVERIFIED', missing_data_reason=?,
             exit_attempts=exit_attempts+1, updated_at_ms=?
       WHERE session_date=? AND position_fingerprint=? AND position_state='OPEN'
    `).run(i.reason, i.nowMs, i.sessionDate, i.positionFingerprint);
    return Number(res.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Link a position to the subscriber alert that later covered the same contract. */
export function attachPaperAlertLinkOnDb(db: StoreDb, i: {
  sessionDate: string; optionSymbol: string; alertId: string; nowMs: number;
}): boolean {
  try {
    if (!hasTable(db, "asymmetry_paper_positions")) return false;
    const res = db.prepare(`
      UPDATE asymmetry_paper_positions SET alert_id=?, updated_at_ms=?
       WHERE session_date=? AND option_symbol=? AND alert_id IS NULL
    `).run(i.alertId, i.nowMs, i.sessionDate, i.optionSymbol);
    return Number(res.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

export interface PaperSkipRow { reason: string; count: number; lastSeenAtMs: number | null }

/** Skip reasons for a session, most frequent first. */
export function listPaperSkipsOnDb(db: StoreDb, sessionDate: string): PaperSkipRow[] {
  if (!hasTable(db, "asymmetry_paper_skips")) return [];
  try {
    return (db.prepare(`
      SELECT reason, SUM(occurrences) n, MAX(last_seen_at_ms) t
        FROM asymmetry_paper_skips WHERE session_date=? GROUP BY reason ORDER BY n DESC
    `).all(sessionDate) as any[]).map((r) => ({
      reason: String(r.reason), count: Number(r.n ?? 0), lastSeenAtMs: nullNum(r.t),
    }));
  } catch {
    return [];
  }
}

/** Mark rejection reasons for a session. Data-quality visibility, not performance. */
export function listPaperMarkRejectionsOnDb(db: StoreDb, sessionDate: string): Array<{ reason: string; count: number }> {
  if (!hasTable(db, "asymmetry_paper_marks")) return [];
  try {
    return (db.prepare(`
      SELECT rejected_reason reason, COUNT(*) n FROM asymmetry_paper_marks
       WHERE session_date=? AND rejected_reason IS NOT NULL
       GROUP BY rejected_reason ORDER BY n DESC
    `).all(sessionDate) as any[]).map((r) => ({ reason: String(r.reason), count: Number(r.n ?? 0) }));
  } catch {
    return [];
  }
}

/** Marks for one position, oldest first. Diagnostics and outcome inspection. */
export function listPaperMarksOnDb(db: StoreDb, sessionDate: string, positionFingerprint: string): Array<{
  markedAtMs: number; bid: number | null; returnPct: number | null; rejectedReason: string | null;
}> {
  if (!hasTable(db, "asymmetry_paper_marks")) return [];
  try {
    return (db.prepare(`
      SELECT marked_at_ms, bid, return_pct, rejected_reason FROM asymmetry_paper_marks
       WHERE session_date=? AND position_fingerprint=? ORDER BY marked_at_ms ASC
    `).all(sessionDate, positionFingerprint) as any[]).map((r) => ({
      markedAtMs: Number(r.marked_at_ms),
      bid: nullNum(r.bid),
      returnPct: nullNum(r.return_pct),
      rejectedReason: r.rejected_reason == null ? null : String(r.rejected_reason),
    }));
  } catch {
    return [];
  }
}

/** Persist a deterministic Quant report, separated by rules version. */
export function persistQuantReportOnDb(db: StoreDb, i: {
  sessionDate: string; rulesVersion: string; builtAtMs: number; reportJson: string;
}): boolean {
  try {
    ensureAsymmetryPaperSchema(db);
    db.prepare(`
      INSERT INTO asymmetry_quant_reports (session_date, rules_version, built_at_ms, report_json)
      VALUES (?,?,?,?)
      ON CONFLICT(session_date, rules_version) DO UPDATE SET
        built_at_ms=excluded.built_at_ms, report_json=excluded.report_json
    `).run(i.sessionDate, i.rulesVersion, i.builtAtMs, i.reportJson);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record the delivery outcome. Its own table rather than a column on the
 * review, so the schema stays purely additive — no ALTER against a table that
 * already exists in production.
 */
export function recordReportDeliveryOnDb(db: StoreDb, i: {
  sessionDate: string; status: string; reason: string | null; nowMs: number;
}): boolean {
  try {
    ensureAsymmetryPaperSchema(db);
    db.prepare(`
      INSERT INTO asymmetry_paper_report_delivery (session_date, status, reason, updated_at_ms)
      VALUES (?,?,?,?)
      ON CONFLICT(session_date) DO UPDATE SET
        status=excluded.status, reason=excluded.reason, updated_at_ms=excluded.updated_at_ms
    `).run(i.sessionDate, i.status, i.reason, i.nowMs);
    return true;
  } catch {
    return false;
  }
}

export function readReportDeliveryOnDb(db: StoreDb, sessionDate: string): { status: string; reason: string | null } | null {
  if (!hasTable(db, "asymmetry_paper_report_delivery")) return null;
  try {
    const row = db.prepare(
      "SELECT status, reason FROM asymmetry_paper_report_delivery WHERE session_date=?",
    ).get(sessionDate) as any;
    return row ? { status: String(row.status), reason: row.reason == null ? null : String(row.reason) } : null;
  } catch {
    return null;
  }
}

/** Read back a persisted Quant report. */
export function readQuantReportOnDb(db: StoreDb, sessionDate: string, rulesVersion: string = PAPER_RULES_VERSION): unknown | null {
  if (!hasTable(db, "asymmetry_quant_reports")) return null;
  try {
    const row = db.prepare(
      "SELECT report_json FROM asymmetry_quant_reports WHERE session_date=? AND rules_version=?",
    ).get(sessionDate, rulesVersion) as any;
    return row ? JSON.parse(String(row.report_json)) : null;
  } catch {
    return null;
  }
}

const nullNum = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
function safeArray(v: unknown): string[] {
  try {
    const parsed = JSON.parse(String(v ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
