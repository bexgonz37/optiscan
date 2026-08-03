/**
 * case-store.ts — durable persistence for the High-Asymmetry radar.
 *
 * Additive and repeat-safe: every statement is CREATE ... IF NOT EXISTS or an
 * upsert keyed so a replayed write is a no-op. No existing table is altered and
 * no destructive DDL exists here.
 *
 * These tables are NOT registered in schema readiness, every write is
 * hasTable-guarded, and every function swallows its own errors and returns a
 * result. A persistence fault here must never reach the scanner, the delivery
 * path, or Discord — the radar is research and is always the thing that gives
 * way.
 *
 * ONE ACTIVE CASE PER FINGERPRINT is enforced by the PRIMARY KEY
 * (session_date, fingerprint), not by a read-then-write race.
 */
import type { AsymmetryResearchState } from "./states.ts";

type StoreDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

export interface AsymmetryCaseRow {
  sessionDate: string;
  fingerprint: string;
  symbol: string;
  direction: "CALL" | "PUT";
  optionSymbol: string;
  state: AsymmetryResearchState;
  firstDetectedAtMs: number;
  /** Ask at first detection — the conservative entry the radar would have paid. */
  earlyAsk: number | null;
  earlyBid: number | null;
  earlySpreadPct: number | null;
  setupFamily: string | null;
  scannerVersion: string | null;
  /** Evidence present at detection, and what was absent. Never fabricated. */
  evidenceJson: string;
  missingEvidence: string[];
  /** Filled in later, only if the subscriber pipeline qualifies the same contract. */
  normalQualifiedAtMs: number | null;
  normalAsk: number | null;
}

export interface StoreResult {
  ok: boolean;
  /** True when this call created a NEW case; false when one already existed. */
  created: boolean;
  error: string | null;
}

/** Idempotent schema. Safe to call on every write. */
export function ensureAsymmetrySchema(db: StoreDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asymmetry_cases (
      session_date TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      option_symbol TEXT NOT NULL,
      state TEXT NOT NULL,
      first_detected_at_ms INTEGER NOT NULL,
      early_ask REAL, early_bid REAL, early_spread_pct REAL,
      setup_family TEXT, scanner_version TEXT,
      evidence_json TEXT NOT NULL,
      missing_evidence TEXT NOT NULL,
      normal_qualified_at_ms INTEGER,
      normal_ask REAL,
      lead_ms INTEGER,
      premium_avoided_pct REAL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_date, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_asymmetry_cases_session ON asymmetry_cases(session_date, first_detected_at_ms);
    CREATE INDEX IF NOT EXISTS idx_asymmetry_cases_occ ON asymmetry_cases(option_symbol, session_date);

    CREATE TABLE IF NOT EXISTS asymmetry_transitions (
      session_date TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      reason TEXT,
      notified INTEGER NOT NULL DEFAULT 0,
      notify_outcome TEXT,
      PRIMARY KEY (session_date, fingerprint, to_state, occurred_at_ms)
    );
    CREATE INDEX IF NOT EXISTS idx_asymmetry_transitions_session ON asymmetry_transitions(session_date, occurred_at_ms);

    CREATE TABLE IF NOT EXISTS asymmetry_marks (
      session_date TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      option_symbol TEXT NOT NULL,
      horizon_minutes INTEGER NOT NULL,
      marked_at_ms INTEGER NOT NULL,
      bid REAL, ask REAL, quote_age_ms INTEGER,
      return_pct REAL,
      rejected_reason TEXT,
      PRIMARY KEY (session_date, fingerprint, horizon_minutes)
    );
    CREATE INDEX IF NOT EXISTS idx_asymmetry_marks_session ON asymmetry_marks(session_date, marked_at_ms);

    /**
     * Per-attempt mark evidence. SEPARATE TABLE ON PURPOSE.
     *
     * asymmetry_marks is keyed (session, fingerprint, horizon) and holds at
     * most one row per horizon — the current best answer. Evidence is a LOG:
     * every attempt, including the ones that failed and the ones later replaced
     * by a retry. Adding 25 columns to the keyed table would have destroyed the
     * attempt history that makes independence measurable at all.
     *
     * Raw provider timestamps are stored as TEXT because a 19-digit nanosecond
     * value exceeds Number.MAX_SAFE_INTEGER; keeping the string preserves the
     * original for audit even though the normalized ms is what we compare.
     */
    CREATE TABLE IF NOT EXISTS asymmetry_mark_evidence (
      mark_attempt_id TEXT PRIMARY KEY,
      session_date TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      option_symbol TEXT NOT NULL,
      underlying TEXT,
      horizon_minutes INTEGER NOT NULL,

      target_at_ms INTEGER,
      acceptable_from_ms INTEGER,
      acceptable_until_ms INTEGER,

      sweep_id TEXT,
      sweep_started_at_ms INTEGER,
      scheduler_selected_at_ms INTEGER,
      provider_request_started_at_ms INTEGER,
      provider_response_received_at_ms INTEGER,
      observed_at_ms INTEGER,

      raw_provider_timestamp TEXT,
      raw_digit_count INTEGER,
      source_field TEXT,
      inferred_unit TEXT,
      normalized_provider_timestamp_ms INTEGER,
      provider_skew_ms INTEGER,
      sweep_drift_ms INTEGER,
      request_latency_ms INTEGER,
      scheduler_delay_ms INTEGER,
      quote_age_ms INTEGER,

      bid REAL, ask REAL, midpoint REAL,
      source_endpoint TEXT,
      cache_status TEXT,

      accepted INTEGER NOT NULL DEFAULT 0,
      independent INTEGER NOT NULL DEFAULT 0,
      reused_from_horizon INTEGER,
      horizon_match_status TEXT,
      mark_quality TEXT,
      rejection_reason TEXT,

      timestamp_policy_version TEXT,
      mark_version TEXT,
      data_quality_version TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_asym_mark_evidence_session
      ON asymmetry_mark_evidence(session_date, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_asym_mark_evidence_fp
      ON asymmetry_mark_evidence(session_date, fingerprint, horizon_minutes);

    CREATE TABLE IF NOT EXISTS asymmetry_outcomes (
      session_date TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      option_symbol TEXT NOT NULL,
      entry_ask REAL,
      mfe_pct REAL, mae_pct REAL,
      final_return_pct REAL,
      hit_25 INTEGER, hit_50 INTEGER, hit_100 INTEGER, hit_200 INTEGER, hit_500 INTEGER,
      time_to_25_ms INTEGER, time_to_50_ms INTEGER, time_to_100_ms INTEGER,
      time_to_200_ms INTEGER, time_to_500_ms INTEGER,
      invalidated INTEGER NOT NULL DEFAULT 0,
      marks_used INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_date, fingerprint)
    );

    CREATE TABLE IF NOT EXISTS asymmetry_daily_reviews (
      session_date TEXT PRIMARY KEY,
      built_at_ms INTEGER NOT NULL,
      review_json TEXT NOT NULL,
      ai_summary TEXT,
      ai_status TEXT
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

/**
 * Open a case. Repeat-safe by PRIMARY KEY: a second call for the same
 * (session, fingerprint) does NOT overwrite the original detection — the whole
 * point is that the FIRST observation is the early one.
 */
export function openAsymmetryCaseOnDb(db: StoreDb, row: AsymmetryCaseRow, nowMs: number): StoreResult {
  try {
    ensureAsymmetrySchema(db);
    const res = db.prepare(`
      INSERT OR IGNORE INTO asymmetry_cases
        (session_date, fingerprint, symbol, direction, option_symbol, state, first_detected_at_ms,
         early_ask, early_bid, early_spread_pct, setup_family, scanner_version,
         evidence_json, missing_evidence, normal_qualified_at_ms, normal_ask, updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      row.sessionDate, row.fingerprint, row.symbol, row.direction, row.optionSymbol, row.state,
      row.firstDetectedAtMs, row.earlyAsk, row.earlyBid, row.earlySpreadPct,
      row.setupFamily, row.scannerVersion, row.evidenceJson, JSON.stringify(row.missingEvidence),
      row.normalQualifiedAtMs, row.normalAsk, nowMs,
    );
    return { ok: true, created: Number(res.changes ?? 0) > 0, error: null };
  } catch (err: any) {
    return { ok: false, created: false, error: String(err?.message ?? err) };
  }
}

/** Does an active case already exist for this fingerprint this session? */
export function hasActiveAsymmetryCase(db: StoreDb, sessionDate: string, fingerprint: string): boolean {
  if (!hasTable(db, "asymmetry_cases")) return false;
  try {
    return Boolean(db.prepare(
      "SELECT 1 FROM asymmetry_cases WHERE session_date=? AND fingerprint=?",
    ).get(sessionDate, fingerprint));
  } catch {
    return false;
  }
}

/** Record a state transition. Repeat-safe on the same state at the same instant. */
export function recordTransitionOnDb(
  db: StoreDb,
  input: {
    sessionDate: string; fingerprint: string;
    fromState: AsymmetryResearchState | null; toState: AsymmetryResearchState;
    occurredAtMs: number; reason: string | null;
    notified: boolean; notifyOutcome: string | null;
  },
): StoreResult {
  try {
    ensureAsymmetrySchema(db);
    const res = db.prepare(`
      INSERT OR IGNORE INTO asymmetry_transitions
        (session_date, fingerprint, from_state, to_state, occurred_at_ms, reason, notified, notify_outcome)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      input.sessionDate, input.fingerprint, input.fromState, input.toState,
      input.occurredAtMs, input.reason, input.notified ? 1 : 0, input.notifyOutcome,
    );
    db.prepare("UPDATE asymmetry_cases SET state=?, updated_at_ms=? WHERE session_date=? AND fingerprint=?")
      .run(input.toState, input.occurredAtMs, input.sessionDate, input.fingerprint);
    return { ok: true, created: Number(res.changes ?? 0) > 0, error: null };
  } catch (err: any) {
    return { ok: false, created: false, error: String(err?.message ?? err) };
  }
}

/** The last state surfaced for a fingerprint, for change detection. */
export function lastStateOnDb(db: StoreDb, sessionDate: string, fingerprint: string): AsymmetryResearchState | null {
  if (!hasTable(db, "asymmetry_cases")) return null;
  try {
    const row = db.prepare("SELECT state FROM asymmetry_cases WHERE session_date=? AND fingerprint=?")
      .get(sessionDate, fingerprint) as { state?: string } | undefined;
    return (row?.state as AsymmetryResearchState) ?? null;
  } catch {
    return null;
  }
}

/**
 * Attach the subscriber pipeline's qualification, when it later happens for the
 * same contract. This is what makes lead time and premium avoided measurable.
 * Only ever fills a NULL — the first qualification wins.
 */
export function attachNormalQualificationOnDb(
  db: StoreDb,
  input: { sessionDate: string; optionSymbol: string; qualifiedAtMs: number; ask: number | null },
): StoreResult {
  try {
    if (!hasTable(db, "asymmetry_cases")) return { ok: true, created: false, error: null };
    const res = db.prepare(`
      UPDATE asymmetry_cases
         SET normal_qualified_at_ms = ?,
             normal_ask = ?,
             lead_ms = ? - first_detected_at_ms,
             premium_avoided_pct = CASE
               WHEN early_ask IS NOT NULL AND early_ask > 0 AND ? IS NOT NULL AND ? > 0
                 THEN ROUND(((? - early_ask) / early_ask) * 100.0, 4)
               ELSE NULL END,
             updated_at_ms = ?
       WHERE session_date = ? AND option_symbol = ? AND normal_qualified_at_ms IS NULL
    `).run(
      input.qualifiedAtMs, input.ask, input.qualifiedAtMs,
      input.ask, input.ask, input.ask,
      input.qualifiedAtMs, input.sessionDate, input.optionSymbol,
    );
    return { ok: true, created: Number(res.changes ?? 0) > 0, error: null };
  } catch (err: any) {
    return { ok: false, created: false, error: String(err?.message ?? err) };
  }
}

export interface ActiveCase {
  sessionDate: string; fingerprint: string; symbol: string; direction: "CALL" | "PUT";
  optionSymbol: string; state: AsymmetryResearchState; firstDetectedAtMs: number;
  earlyAsk: number | null; leadMs: number | null; premiumAvoidedPct: number | null;
  missingEvidence: string[];
  /** Part of the paper lane's position identity. A wrong or absent value would
   *  split one position into two fingerprints, so it is read, never inferred. */
  setupFamily: string | null;
  /**
   * Underlying price AT DETECTION, read back out of the persisted evidence.
   * It was already captured from the live scanner payload, so surfacing it
   * costs ZERO additional provider calls — it was simply never read back, and
   * alerts printed "Underlying: unavailable" for a value we already had.
   */
  underlyingPrice: number | null;
}

/** Cases for a session, newest first. Read path for diagnostics and tracking. */
export function listCasesOnDb(db: StoreDb, sessionDate: string, limit = 200): ActiveCase[] {
  if (!hasTable(db, "asymmetry_cases")) return [];
  try {
    const rows = db.prepare(`
      SELECT session_date, fingerprint, symbol, direction, option_symbol, state,
             first_detected_at_ms, early_ask, lead_ms, premium_avoided_pct, missing_evidence,
             setup_family, evidence_json
        FROM asymmetry_cases WHERE session_date=? ORDER BY first_detected_at_ms DESC LIMIT ?
    `).all(sessionDate, Math.max(1, Math.min(1000, limit))) as any[];
    return rows.map((r) => ({
      sessionDate: String(r.session_date),
      fingerprint: String(r.fingerprint),
      symbol: String(r.symbol),
      direction: r.direction === "PUT" ? "PUT" : "CALL",
      optionSymbol: String(r.option_symbol),
      state: r.state as AsymmetryResearchState,
      firstDetectedAtMs: Number(r.first_detected_at_ms),
      earlyAsk: r.early_ask == null ? null : Number(r.early_ask),
      leadMs: r.lead_ms == null ? null : Number(r.lead_ms),
      premiumAvoidedPct: r.premium_avoided_pct == null ? null : Number(r.premium_avoided_pct),
      missingEvidence: safeParseArray(r.missing_evidence),
      setupFamily: r.setup_family == null ? null : String(r.setup_family),
      underlyingPrice: evidenceNumber(r.evidence_json, "underlyingPrice"),
    }));
  } catch {
    return [];
  }
}

/** Pull one numeric field out of persisted evidence. Never throws, never guesses. */
function evidenceNumber(raw: unknown, field: string): number | null {
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    const v = Number((parsed as Record<string, unknown>)?.[field]);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function safeParseArray(v: unknown): string[] {
  try {
    const parsed = JSON.parse(String(v ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
