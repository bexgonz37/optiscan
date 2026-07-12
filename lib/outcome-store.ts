/**
 * outcome-store.ts — persistence for setup fingerprints + authoritative outcomes.
 *
 * The DECISION logic lives in the pure modules (setup-fingerprint.ts,
 * trade-outcome.ts). This module is the thin, idempotent persistence layer:
 *
 *  - freezeFingerprint: written ONCE per filled trade (COALESCE guard) and
 *    upserted into `setup_fingerprints` (INSERT OR IGNORE) — immutable once set.
 *  - generateOutcome: exactly one `paper_trade_outcomes` row per FILLED, TERMINAL
 *    trade (UNIQUE(paper_trade_id) + INSERT OR IGNORE) — restart/re-sweep safe.
 *
 * Only actually-filled trades produce outcomes. Rejected candidates, failed
 * revalidations, unfilled/cancelled-before-fill orders never reach the terminal
 * FILLED gate below, so they can never be graded. A filled+terminal trade with
 * incomplete exit data is graded UNGRADABLE (recorded, never dropped).
 *
 * The `*OnDb` core takes a better-sqlite3 handle so it is unit-testable against a
 * real DB; the public wrappers resolve `@/lib/db` lazily (like paper-events.ts)
 * so the module stays importable by the node test runner.
 */
import { buildFingerprint, type FingerprintInput } from "./setup-fingerprint.ts";
import { gradeOutcome, terminalKind, type OutcomeInput } from "./trade-outcome.ts";
import { marketSession } from "./trading-session.ts";

const TERMINAL_FILLED = new Set(["EXITED", "STOPPED_OUT", "TAKE_PROFIT", "EXPIRED"]);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ── Row → pure-input mapping ─────────────────────────────────────────────────

/** Best-effort secondary lookup that never throws if a table/column is absent. */
function safeGet(db: any, sql: string, ...params: unknown[]): any {
  try {
    return db.prepare(sql).get(...params);
  } catch {
    return null;
  }
}

function fingerprintInputFromRow(db: any, r: any): FingerprintInput {
  const instrument: "option" | "stock" = r.option_symbol ? "option" : "stock";
  const alert = r.alert_id != null
    ? safeGet(db, "SELECT capture_action, move_classification, move_status FROM alerts WHERE id=?", r.alert_id)
    : null;
  const opp = r.opportunity_id != null
    ? safeGet(db, "SELECT current_status FROM opportunities WHERE opportunity_id=?", r.opportunity_id)
    : null;
  return {
    strategy: r.strategy ?? r.selector_profile ?? null,
    instrument,
    optionType: r.option_type === "put" ? "put" : "call",
    triggerFamily: alert?.capture_action ?? null,
    session: r.session_at_entry ?? null,
    entryAtMs: r.entry_at_ms ?? null,
    dte: r.dte_at_entry ?? null,
    delta: r.entry_delta ?? null,
    spreadPct: r.entry_spread_pct ?? null,
    relVol: r.rel_vol_entry ?? null,
    aboveVwap: r.above_vwap_entry == null ? null : Boolean(r.above_vwap_entry),
    lifecycleState: opp?.current_status ?? null,
    selectorProfile: r.selector_profile ?? null,
    momentum: r.short_rate_entry ?? null,
    moveClassification: alert?.move_classification ?? alert?.move_status ?? null,
  };
}

function outcomeInputFromRow(r: any): OutcomeInput {
  const instrumentOption = Boolean(r.option_symbol);
  const direction: 1 | -1 = !instrumentOption && r.option_type === "put" ? -1 : 1;
  return {
    filled: r.entry_price != null,
    terminal: TERMINAL_FILLED.has(r.status),
    entryPrice: r.entry_price ?? null,
    exitPrice: r.exit_price ?? null,
    quantity: r.contracts ?? null,
    multiplier: instrumentOption ? 100 : 1,
    direction,
    entryFees: r.entry_fees ?? null,
    exitFees: r.exit_fees ?? null,
    entrySlippage: r.entry_slippage ?? null,
    exitSlippage: r.exit_slippage ?? null,
    riskAmount: r.risk_amount ?? null,
    mfePct: r.mfe_pct ?? null,
    maePct: r.mae_pct ?? null,
    entryAtMs: r.entry_at_ms ?? null,
    exitAtMs: r.exit_at_ms ?? null,
    legacy: r.snapshot_version == null,
  };
}

// ── Injectable core (unit-testable against a real DB handle) ─────────────────

/** Freeze the fingerprint for one filled trade row (write-once). Returns the id. */
export function freezeFingerprintOnDb(db: any, r: any, nowMs: number): string | null {
  if (r.entry_price == null) return null; // only FILLED trades get a fingerprint
  const fp = buildFingerprint(fingerprintInputFromRow(db, r));
  db.prepare(
    `UPDATE paper_trades SET
       fingerprint_id = COALESCE(fingerprint_id, ?),
       fingerprint_version = COALESCE(fingerprint_version, ?),
       fingerprint_dimensions_json = COALESCE(fingerprint_dimensions_json, ?),
       strategy_version = COALESCE(strategy_version, ?)
     WHERE id=?`,
  ).run(fp.id, fp.version, JSON.stringify(fp.dimensions), fp.strategyVersion, r.id);
  db.prepare(
    `INSERT OR IGNORE INTO setup_fingerprints
       (fingerprint_id, fingerprint_version, strategy, strategy_version, dimensions_json, human_summary, first_seen_at_ms)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(fp.id, fp.version, fp.dimensions.strategy ?? null, fp.strategyVersion, JSON.stringify(fp.dimensions), fp.humanSummary, nowMs);
  return fp.id;
}

/** Generate the one authoritative outcome for a filled, terminal trade row. */
export function generateOutcomeOnDb(db: any, r: any, nowMs: number): boolean {
  if (!TERMINAL_FILLED.has(r.status) || r.entry_price == null) return false; // never grade non-filled / non-terminal
  const existing = db.prepare("SELECT 1 FROM paper_trade_outcomes WHERE paper_trade_id=?").get(r.id);
  if (existing) return false; // idempotent

  const graded = gradeOutcome(outcomeInputFromRow(r));
  const fp = buildFingerprint(fingerprintInputFromRow(db, r));
  const exitSession = isNum(r.exit_at_ms) ? marketSession(r.exit_at_ms) : null;

  const res = db.prepare(
    `INSERT OR IGNORE INTO paper_trade_outcomes (
       paper_trade_id, alert_id, opportunity_id, fingerprint_id, fingerprint_version,
       strategy, strategy_version, instrument_type, direction, selector_profile,
       option_symbol, strike, expiration, dte_at_entry,
       entry_time_ms, exit_time_ms, hold_minutes, entry_price, exit_price, quantity,
       gross_pnl, entry_fees, exit_fees, entry_slippage, exit_slippage, net_pnl, return_pct,
       risk_amount, r_multiple, mfe_pct, mae_pct, terminal_kind, exit_reason, close_reason,
       entry_session, exit_session, grade, grading_status, data_quality_status,
       data_quality_reasons_json, snapshot_version, outcome_version, created_at_ms
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    r.id, r.alert_id ?? null, r.opportunity_id ?? null, fp.id, fp.version,
    r.strategy ?? r.selector_profile ?? null, fp.strategyVersion,
    r.option_symbol ? "option" : "stock", fp.dimensions.direction ?? null, r.selector_profile ?? null,
    r.option_symbol ?? null, r.strike ?? null, r.expiration ?? null, r.dte_at_entry ?? null,
    r.entry_at_ms ?? null, r.exit_at_ms ?? null, graded.holdMinutes, r.entry_price ?? null, r.exit_price ?? null, r.contracts ?? null,
    graded.grossPnl, graded.entryFees, graded.exitFees, graded.entrySlippage, graded.exitSlippage, graded.netPnl, graded.returnPct,
    r.risk_amount ?? null, graded.rMultiple, graded.mfePct, graded.maePct, terminalKind(r.status, r.exit_reason), r.exit_reason ?? null, r.close_reason ?? null,
    r.session_at_entry ?? null, exitSession, graded.grade, graded.gradingStatus, graded.dataQualityStatus,
    JSON.stringify(graded.dataQualityReasons), r.snapshot_version ?? null, graded.outcomeVersion, nowMs,
  );
  return res.changes > 0;
}

/** Sweep: freeze fingerprints for filled trades, then grade terminal ones. Idempotent. */
export function syncOutcomesOnDb(db: any, nowMs: number): { fingerprints: number; outcomes: number } {
  let fingerprints = 0;
  let outcomes = 0;

  const needFp = db.prepare(
    "SELECT * FROM paper_trades WHERE entry_price IS NOT NULL AND fingerprint_id IS NULL ORDER BY id ASC",
  ).all() as any[];
  for (const r of needFp) if (freezeFingerprintOnDb(db, r, nowMs)) fingerprints += 1;

  const needOutcome = db.prepare(
    `SELECT p.* FROM paper_trades p
     WHERE p.status IN ('EXITED','STOPPED_OUT','TAKE_PROFIT','EXPIRED')
       AND p.entry_price IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM paper_trade_outcomes o WHERE o.paper_trade_id = p.id)
     ORDER BY p.id ASC`,
  ).all() as any[];
  for (const r of needOutcome) if (generateOutcomeOnDb(db, r, nowMs)) outcomes += 1;

  return { fingerprints, outcomes };
}

// ── Public wrappers (lazy @/lib/db) ──────────────────────────────────────────

function lazyDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  return getDb();
}

/** Freeze the fingerprint for one trade id at fill time (idempotent, write-once). */
export function freezePaperFingerprintForTrade(id: number, nowMs: number = Date.now()): string | null {
  try {
    const db = lazyDb();
    const r = db.prepare("SELECT * FROM paper_trades WHERE id=?").get(id);
    if (!r) return null;
    return freezeFingerprintOnDb(db, r, nowMs);
  } catch (err: any) {
    console.warn("[outcome] fingerprint freeze skipped:", err?.message);
    return null;
  }
}

/** Idempotent sweep: freeze fingerprints + generate outcomes for all trades. */
export function syncPaperOutcomes(nowMs: number = Date.now()): { fingerprints: number; outcomes: number } {
  try {
    return syncOutcomesOnDb(lazyDb(), nowMs);
  } catch (err: any) {
    console.warn("[outcome] sync skipped:", err?.message);
    return { fingerprints: 0, outcomes: 0 };
  }
}

export interface PaperOutcomeRow {
  paperTradeId: number;
  fingerprintId: string | null;
  fingerprintVersion: number | null;
  grade: string;
  gradingStatus: string;
  dataQualityStatus: string;
  dataQualityReasons: string[];
  grossPnl: number | null;
  netPnl: number | null;
  returnPct: number | null;
  rMultiple: number | null;
  entryFees: number | null;
  exitFees: number | null;
  entrySlippage: number | null;
  exitSlippage: number | null;
  holdMinutes: number | null;
  mfePct: number | null;
  maePct: number | null;
  terminalKind: string | null;
  entrySession: string | null;
  exitSession: string | null;
  outcomeVersion: number | null;
}

function mapOutcomeRow(r: any): PaperOutcomeRow {
  let reasons: string[] = [];
  try { reasons = r.data_quality_reasons_json ? JSON.parse(r.data_quality_reasons_json) : []; } catch { reasons = []; }
  return {
    paperTradeId: r.paper_trade_id,
    fingerprintId: r.fingerprint_id ?? null,
    fingerprintVersion: r.fingerprint_version ?? null,
    grade: r.grade,
    gradingStatus: r.grading_status,
    dataQualityStatus: r.data_quality_status,
    dataQualityReasons: reasons,
    grossPnl: r.gross_pnl ?? null,
    netPnl: r.net_pnl ?? null,
    returnPct: r.return_pct ?? null,
    rMultiple: r.r_multiple ?? null,
    entryFees: r.entry_fees ?? null,
    exitFees: r.exit_fees ?? null,
    entrySlippage: r.entry_slippage ?? null,
    exitSlippage: r.exit_slippage ?? null,
    holdMinutes: r.hold_minutes ?? null,
    mfePct: r.mfe_pct ?? null,
    maePct: r.mae_pct ?? null,
    terminalKind: r.terminal_kind ?? null,
    entrySession: r.entry_session ?? null,
    exitSession: r.exit_session ?? null,
    outcomeVersion: r.outcome_version ?? null,
  };
}

/**
 * Read-only NBBO preflight diagnostic. Reports COUNTS from the existing DB only.
 * It cannot prove live provider NBBO availability beyond what has already been
 * recorded — if no verified stock fill exists, that is stated honestly rather
 * than guessed. No secrets, no provider calls, no fabrication.
 */
export function nbboDiagnostic(): {
  stockCandidates: number;
  stockFilled: number;
  stockRefusedNoQuote: number;
  stockOutcomes: number;
  optionFilled: number;
  runtimeNbboProven: boolean;
  note: string;
} {
  try {
    const db = lazyDb();
    const one = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as any)?.n ?? 0);
    const stockCandidates = one("SELECT COUNT(*) AS n FROM paper_trades WHERE option_symbol IS NULL");
    const stockFilled = one("SELECT COUNT(*) AS n FROM paper_trades WHERE option_symbol IS NULL AND entry_price IS NOT NULL");
    const stockRefusedNoQuote = one(
      "SELECT COUNT(*) AS n FROM paper_trades WHERE option_symbol IS NULL AND status='CANCELLED' AND (exit_reason LIKE '%quote%' OR exit_reason LIKE '%NBBO%' OR exit_reason LIKE '%data%')",
    );
    const stockOutcomes = one("SELECT COUNT(*) AS n FROM paper_trade_outcomes WHERE instrument_type='stock'");
    const optionFilled = one("SELECT COUNT(*) AS n FROM paper_trades WHERE option_symbol IS NOT NULL AND entry_price IS NOT NULL");
    const runtimeNbboProven = stockFilled > 0;
    const note = runtimeNbboProven
      ? `${stockFilled} verified stock fill(s) exist in this DB — runtime NBBO has produced executable quotes.`
      : "No verified stock fill exists in this DB yet; runtime stock NBBO availability cannot be proven from the repository. This is expected until a live session fills a long stock scalp against a two-sided lastQuote.";
    return { stockCandidates, stockFilled, stockRefusedNoQuote, stockOutcomes, optionFilled, runtimeNbboProven, note };
  } catch (err: any) {
    return { stockCandidates: 0, stockFilled: 0, stockRefusedNoQuote: 0, stockOutcomes: 0, optionFilled: 0, runtimeNbboProven: false, note: `diagnostic unavailable: ${err?.message}` };
  }
}

/** Outcomes keyed by paper_trade_id for a set of trade ids (for the API/dashboard). */
export function outcomesByTradeId(ids: number[]): Map<number, PaperOutcomeRow> {
  const out = new Map<number, PaperOutcomeRow>();
  if (!ids.length) return out;
  try {
    const db = lazyDb();
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`SELECT * FROM paper_trade_outcomes WHERE paper_trade_id IN (${placeholders})`).all(...ids) as any[];
    for (const r of rows) out.set(r.paper_trade_id, mapOutcomeRow(r));
  } catch (err: any) {
    console.warn("[outcome] lookup skipped:", err?.message);
  }
  return out;
}
