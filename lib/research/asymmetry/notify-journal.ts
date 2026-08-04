/**
 * notify-journal.ts — durable record of EVERY notification decision, with the
 * evidence and the thresholds that produced it.
 *
 * WHY THIS EXISTS. ASYM_NOTIFY_V2 shipped with a 120-second staleness window
 * and a 50% premium give-back threshold. Both are PROVISIONAL, VERSIONED
 * DEFAULTS — they were reasoned about, not fitted to outcomes. They cannot be
 * validated later unless, at the moment of each decision, we wrote down:
 *
 *   - what the gate saw (quote, age, underlying, peak, entry, spread, chase),
 *   - what it decided and why (notify, timing class, machine reason),
 *   - and WHICH THRESHOLD VALUES were in force at that instant.
 *
 * asymmetry_transitions records only `notified` and `notify_outcome`. That is
 * enough to count suppressions and nothing else: it cannot answer "would a
 * 180-second window have let this winner through", because the age at decision
 * was never stored. This table closes that gap.
 *
 * COUNTERFACTUAL EVALUATION IS THE POINT. Because the raw inputs are stored
 * beside the decision, a later analysis can re-run decideNotification() at any
 * candidate threshold over the real population, WITHOUT any provider call and
 * without changing production behaviour. That is how a threshold earns a
 * change — not from one NVDA example.
 *
 * SAFETY. Additive, repeat-safe DDL. Every write is hasTable-guarded and
 * swallows its own errors: a journal fault must never reach the scanner, the
 * delivery path, or Discord. Losing a journal row is acceptable; losing an
 * alert is not.
 */
import type { AsymmetryResearchState } from "./states.ts";
import type { NotificationDecision, NotificationStrengthConfig } from "./notification-gate.ts";

type JournalDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

export const NOTIFY_JOURNAL_VERSION = "ASYM_NOTIFY_JOURNAL_V2" as const;

export function ensureNotifyJournalSchema(db: JournalDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asymmetry_notify_decisions (
      session_date TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      decided_at_ms INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      option_symbol TEXT NOT NULL,
      direction TEXT,
      from_state TEXT,
      to_state TEXT NOT NULL,

      -- What the gate decided.
      notify INTEGER NOT NULL,
      timing TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      gate_version TEXT NOT NULL,
      silent_capture INTEGER NOT NULL,
      setup_family TEXT,
      freshness_source TEXT,
      quality_score REAL,
      delivery_level TEXT,

      -- What the gate saw. Raw, unrounded, never inferred.
      bid REAL, ask REAL, quote_at_ms INTEGER, quote_age_ms INTEGER,
      underlying_price REAL, spread_pct REAL, premium_chase_pct REAL,
      open_interest INTEGER, contract_volume INTEGER,
      entry_ask_at_capture REAL, peak_ask_since_capture REAL,
      give_back_fraction REAL,
      missing_evidence_count INTEGER,
      first_detected_at_ms INTEGER,
      capture_to_notify_ms INTEGER,

      -- WHICH THRESHOLDS WERE IN FORCE. Without these the row cannot be
      -- re-evaluated against a different configuration honestly.
      cfg_max_quote_age_ms INTEGER,
      cfg_max_giveback_fraction REAL,
      cfg_max_spread_pct REAL,
      cfg_max_chase_pct REAL,
      cfg_min_open_interest INTEGER,
      cfg_min_contract_volume INTEGER,
      cfg_max_missing_for_confirming INTEGER,
      cfg_max_capture_to_notify_ms INTEGER,
      strategy_policy_json TEXT,
      decision_metrics_json TEXT,

      -- Delivery, filled in after the send attempt resolves.
      notify_outcome TEXT,
      sent_at_ms INTEGER,
      send_latency_ms INTEGER,

      journal_version TEXT NOT NULL,
      PRIMARY KEY (session_date, fingerprint, to_state, decided_at_ms)
    );
    CREATE INDEX IF NOT EXISTS idx_asym_notify_decisions_session
      ON asymmetry_notify_decisions(session_date, decided_at_ms);
    CREATE INDEX IF NOT EXISTS idx_asym_notify_decisions_occ
      ON asymmetry_notify_decisions(option_symbol, session_date);
    CREATE INDEX IF NOT EXISTS idx_asym_notify_decisions_timing
      ON asymmetry_notify_decisions(session_date, timing);
  `);
  addColumnIfMissing(db, "asymmetry_notify_decisions", "action", "TEXT");
  addColumnIfMissing(db, "asymmetry_notify_decisions", "cfg_max_capture_to_notify_ms", "INTEGER");
  addColumnIfMissing(db, "asymmetry_notify_decisions", "setup_family", "TEXT");
  addColumnIfMissing(db, "asymmetry_notify_decisions", "freshness_source", "TEXT");
  addColumnIfMissing(db, "asymmetry_notify_decisions", "quality_score", "REAL");
  addColumnIfMissing(db, "asymmetry_notify_decisions", "delivery_level", "TEXT");
  addColumnIfMissing(db, "asymmetry_notify_decisions", "strategy_policy_json", "TEXT");
  addColumnIfMissing(db, "asymmetry_notify_decisions", "decision_metrics_json", "TEXT");
}

function hasTable(db: JournalDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function hasColumn(db: JournalDb, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((r) => String(r.name) === column);
  } catch {
    return false;
  }
}

function addColumnIfMissing(db: JournalDb, table: string, column: string, ddl: string): void {
  try {
    if (!hasTable(db, table) || hasColumn(db, table, column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch {
    // Journal schema upgrades must never break the live scanner or delivery path.
  }
}

/** Everything worth knowing about one decision, gathered by the caller. */
export interface NotifyJournalEntry {
  sessionDate: string;
  fingerprint: string;
  decidedAtMs: number;
  symbol: string;
  optionSymbol: string;
  direction: "CALL" | "PUT" | null;
  fromState: AsymmetryResearchState | null;
  toState: AsymmetryResearchState;

  decision: NotificationDecision;
  config: NotificationStrengthConfig;

  bid: number | null;
  ask: number | null;
  quoteAtMs: number | null;
  underlyingPrice: number | null;
  spreadPct: number | null;
  premiumChasePct: number | null;
  openInterest: number | null;
  contractVolume: number | null;
  entryAskAtCapture: number | null;
  peakAskSinceCapture: number | null;
  missingEvidenceCount: number;
  firstDetectedAtMs: number | null;
  setupFamily?: string | null;
  currentUnderlyingPrice?: number | null;
  underlyingQuoteAtMs?: number | null;
  dte?: number | null;
  delta?: number | null;
  underlyingMoveBeforeDetectionPct?: number | null;
  roomToNextLevelPct?: number | null;
  targetT1?: number | null;
  targetStop?: number | null;
}

export interface JournalResult { ok: boolean; created: boolean; error: string | null }

/**
 * Give-back as a fraction of the peak gain, recomputed here so the stored value
 * is auditable rather than trusted. Null when there is no measurable peak gain,
 * which is NOT the same as zero give-back.
 */
export function giveBackFraction(
  entryAsk: number | null, peakAsk: number | null, currentAsk: number | null,
): number | null {
  if (entryAsk == null || peakAsk == null || currentAsk == null) return null;
  if (!(entryAsk > 0) || !(peakAsk > entryAsk)) return null;
  const peakGain = peakAsk - entryAsk;
  if (!(peakGain > 0)) return null;
  return Math.round(((peakAsk - currentAsk) / peakGain) * 10_000) / 10_000;
}

/** Record one decision. Never throws. */
export function recordNotifyDecisionOnDb(db: JournalDb, e: NotifyJournalEntry): JournalResult {
  try {
    ensureNotifyJournalSchema(db);
    const quoteAgeMs = e.quoteAtMs != null ? e.decidedAtMs - e.quoteAtMs : null;
    const captureToNotifyMs = e.firstDetectedAtMs != null ? e.decidedAtMs - e.firstDetectedAtMs : null;
    const res = db.prepare(`
      INSERT OR IGNORE INTO asymmetry_notify_decisions (
        session_date, fingerprint, decided_at_ms, symbol, option_symbol, direction,
        from_state, to_state,
        notify, timing, action, reason, gate_version, silent_capture,
        setup_family, freshness_source, quality_score, delivery_level,
        bid, ask, quote_at_ms, quote_age_ms, underlying_price, spread_pct, premium_chase_pct,
        open_interest, contract_volume, entry_ask_at_capture, peak_ask_since_capture,
        give_back_fraction, missing_evidence_count, first_detected_at_ms, capture_to_notify_ms,
        cfg_max_quote_age_ms, cfg_max_giveback_fraction, cfg_max_spread_pct, cfg_max_chase_pct,
        cfg_min_open_interest, cfg_min_contract_volume, cfg_max_missing_for_confirming,
        cfg_max_capture_to_notify_ms, strategy_policy_json, decision_metrics_json,
        journal_version
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      e.sessionDate, e.fingerprint, e.decidedAtMs, e.symbol, e.optionSymbol, e.direction,
      e.fromState, e.toState,
      e.decision.notify ? 1 : 0, e.decision.timing, e.decision.action, e.decision.reason, e.decision.version,
      e.decision.silentCapture ? 1 : 0,
      e.setupFamily ?? null, e.config.freshnessSource, e.decision.qualityScore, e.decision.deliveryLevel,
      e.bid, e.ask, e.quoteAtMs, quoteAgeMs, e.underlyingPrice, e.spreadPct, e.premiumChasePct,
      e.openInterest, e.contractVolume, e.entryAskAtCapture, e.peakAskSinceCapture,
      giveBackFraction(e.entryAskAtCapture, e.peakAskSinceCapture, e.ask),
      e.missingEvidenceCount, e.firstDetectedAtMs, captureToNotifyMs,
      e.config.maxQuoteAgeAtNotifyMs, e.config.maxRolloverGiveBackFraction,
      e.config.maxSpreadPct, e.config.maxPremiumChasePct,
      e.config.minOpenInterest, e.config.minContractVolume, e.config.maxMissingEvidenceForConfirming,
      e.config.maxCaptureToNotifyMs,
      JSON.stringify({
        strategyKey: e.config.strategyKey,
        freshnessSource: e.config.freshnessSource,
        strategySide: e.config.strategySide,
        maxUnderlyingQuoteAgeAtNotifyMs: e.config.maxUnderlyingQuoteAgeAtNotifyMs,
        maxUnderlyingMoveBeforeEntryPct: e.config.maxUnderlyingMoveBeforeEntryPct,
        minRewardRemainingPct: e.config.minRewardRemainingPct,
        minDistanceFromInvalidationPct: e.config.minDistanceFromInvalidationPct,
        preferredDteBands: e.config.preferredDteBands,
        preferredDelta: e.config.preferredDelta,
        minImmediateScore: e.config.minImmediateScore,
      }),
      JSON.stringify({
        currentUnderlyingPrice: e.currentUnderlyingPrice ?? null,
        underlyingQuoteAtMs: e.underlyingQuoteAtMs ?? null,
        dte: e.dte ?? null,
        delta: e.delta ?? null,
        underlyingMoveBeforeDetectionPct: e.underlyingMoveBeforeDetectionPct ?? null,
        roomToNextLevelPct: e.roomToNextLevelPct ?? null,
        targetT1: e.targetT1 ?? null,
        targetStop: e.targetStop ?? null,
        candidateAgeMs: e.decision.candidateAgeMs,
        optionQuoteAgeMs: e.decision.optionQuoteAgeMs,
        underlyingQuoteAgeMs: e.decision.underlyingQuoteAgeMs,
        underlyingMoveBeforeEntryPct: e.decision.underlyingMoveBeforeEntryPct,
        rewardRemainingPct: e.decision.rewardRemainingPct,
        distanceToInvalidationPct: e.decision.distanceToInvalidationPct,
      }),
      NOTIFY_JOURNAL_VERSION,
    );
    return { ok: true, created: Number(res.changes ?? 0) > 0, error: null };
  } catch (err: any) {
    return { ok: false, created: false, error: String(err?.message ?? err) };
  }
}

/** Attach the delivery result once the send attempt resolves. Never throws. */
export function attachNotifyOutcomeOnDb(
  db: JournalDb,
  key: { sessionDate: string; fingerprint: string; toState: string; decidedAtMs: number },
  outcome: { notifyOutcome: string; sentAtMs: number | null },
): JournalResult {
  try {
    if (!hasTable(db, "asymmetry_notify_decisions")) return { ok: true, created: false, error: null };
    const res = db.prepare(`
      UPDATE asymmetry_notify_decisions
         SET notify_outcome = ?,
             sent_at_ms = ?,
             send_latency_ms = CASE WHEN ? IS NULL THEN NULL ELSE ? - decided_at_ms END
       WHERE session_date=? AND fingerprint=? AND to_state=? AND decided_at_ms=?
    `).run(
      outcome.notifyOutcome, outcome.sentAtMs, outcome.sentAtMs, outcome.sentAtMs,
      key.sessionDate, key.fingerprint, key.toState, key.decidedAtMs,
    );
    return { ok: true, created: Number(res.changes ?? 0) > 0, error: null };
  } catch (err: any) {
    return { ok: false, created: false, error: String(err?.message ?? err) };
  }
}

export interface JournalRow {
  sessionDate: string; fingerprint: string; decidedAtMs: number;
  symbol: string; optionSymbol: string; direction: string | null;
  fromState: string | null; toState: string;
  notify: boolean; timing: string; action: string; reason: string; gateVersion: string; silentCapture: boolean;
  bid: number | null; ask: number | null; quoteAtMs: number | null; quoteAgeMs: number | null;
  underlyingPrice: number | null; spreadPct: number | null; premiumChasePct: number | null;
  openInterest: number | null; contractVolume: number | null;
  entryAskAtCapture: number | null; peakAskSinceCapture: number | null;
  giveBackFraction: number | null; missingEvidenceCount: number | null;
  firstDetectedAtMs: number | null; captureToNotifyMs: number | null;
  cfgMaxQuoteAgeMs: number | null; cfgMaxGiveBackFraction: number | null;
  cfgMaxSpreadPct: number | null; cfgMaxChasePct: number | null;
  cfgMaxCaptureToNotifyMs: number | null;
  setupFamily: string | null; freshnessSource: string | null;
  qualityScore: number | null; deliveryLevel: string | null;
  strategyPolicy: Record<string, unknown> | null;
  decisionMetrics: Record<string, unknown> | null;
  notifyOutcome: string | null; sentAtMs: number | null; sendLatencyMs: number | null;
}

/** Read decisions for a session, oldest first. Read-only; issues no provider call. */
export function listNotifyDecisionsOnDb(
  db: JournalDb, sessionDate: string, opts: { symbol?: string | null; limit?: number } = {},
): JournalRow[] {
  if (!hasTable(db, "asymmetry_notify_decisions")) return [];
  try {
    const limit = Math.max(1, Math.min(5_000, opts.limit ?? 1_000));
    const sym = opts.symbol ? String(opts.symbol).toUpperCase() : null;
    const rows = (sym
      ? db.prepare(`SELECT * FROM asymmetry_notify_decisions WHERE session_date=? AND symbol=? ORDER BY decided_at_ms ASC LIMIT ?`).all(sessionDate, sym, limit)
      : db.prepare(`SELECT * FROM asymmetry_notify_decisions WHERE session_date=? ORDER BY decided_at_ms ASC LIMIT ?`).all(sessionDate, limit)
    ) as any[];
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

/** Every decision for one exact OCC across a session. The reconstruction feed. */
export function listNotifyDecisionsForOccOnDb(
  db: JournalDb, sessionDate: string, optionSymbol: string,
): JournalRow[] {
  if (!hasTable(db, "asymmetry_notify_decisions")) return [];
  try {
    const rows = db.prepare(
      `SELECT * FROM asymmetry_notify_decisions WHERE session_date=? AND option_symbol=? ORDER BY decided_at_ms ASC`,
    ).all(sessionDate, String(optionSymbol).toUpperCase()) as any[];
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

function mapRow(r: any): JournalRow {
  const n = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const json = (v: unknown): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(String(v ?? ""));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  };
  return {
    sessionDate: String(r.session_date), fingerprint: String(r.fingerprint),
    decidedAtMs: Number(r.decided_at_ms), symbol: String(r.symbol),
    optionSymbol: String(r.option_symbol), direction: r.direction == null ? null : String(r.direction),
    fromState: r.from_state == null ? null : String(r.from_state), toState: String(r.to_state),
    notify: Number(r.notify) === 1, timing: String(r.timing),
    action: r.action == null ? (Number(r.notify) === 1 ? "HIGH_ASYMMETRY_ALERT" : "LEGACY_AMBIGUOUS") : String(r.action),
    reason: String(r.reason),
    gateVersion: String(r.gate_version), silentCapture: Number(r.silent_capture) === 1,
    bid: n(r.bid), ask: n(r.ask), quoteAtMs: n(r.quote_at_ms), quoteAgeMs: n(r.quote_age_ms),
    underlyingPrice: n(r.underlying_price), spreadPct: n(r.spread_pct), premiumChasePct: n(r.premium_chase_pct),
    openInterest: n(r.open_interest), contractVolume: n(r.contract_volume),
    entryAskAtCapture: n(r.entry_ask_at_capture), peakAskSinceCapture: n(r.peak_ask_since_capture),
    giveBackFraction: n(r.give_back_fraction), missingEvidenceCount: n(r.missing_evidence_count),
    firstDetectedAtMs: n(r.first_detected_at_ms), captureToNotifyMs: n(r.capture_to_notify_ms),
    cfgMaxQuoteAgeMs: n(r.cfg_max_quote_age_ms), cfgMaxGiveBackFraction: n(r.cfg_max_giveback_fraction),
    cfgMaxSpreadPct: n(r.cfg_max_spread_pct), cfgMaxChasePct: n(r.cfg_max_chase_pct),
    cfgMaxCaptureToNotifyMs: n(r.cfg_max_capture_to_notify_ms),
    setupFamily: r.setup_family == null ? null : String(r.setup_family),
    freshnessSource: r.freshness_source == null ? null : String(r.freshness_source),
    qualityScore: n(r.quality_score),
    deliveryLevel: r.delivery_level == null ? null : String(r.delivery_level),
    strategyPolicy: json(r.strategy_policy_json),
    decisionMetrics: json(r.decision_metrics_json),
    notifyOutcome: r.notify_outcome == null ? null : String(r.notify_outcome),
    sentAtMs: n(r.sent_at_ms), sendLatencyMs: n(r.send_latency_ms),
  };
}

/**
 * The ratio report, computed from the journal rather than from counters that
 * reset on redeploy. `captured` is the number of distinct cases that reached a
 * gate decision; `notified` is the number actually delivered.
 */
export function journalRatioOnDb(db: JournalDb, sessionDate: string): {
  decisions: number; notified: number; suppressed: number;
  distinctCases: number; alertToCaptureRatioPct: number | null;
  byTiming: Record<string, number>; byAction: Record<string, number>; byReason: Array<{ reason: string; count: number }>;
} {
  const empty = {
    decisions: 0, notified: 0, suppressed: 0, distinctCases: 0,
    alertToCaptureRatioPct: null, byTiming: {}, byAction: {}, byReason: [],
  };
  if (!hasTable(db, "asymmetry_notify_decisions")) return empty;
  try {
    const agg = db.prepare(`
      SELECT COUNT(*) decisions,
             SUM(CASE WHEN notify_outcome='SENT' THEN 1 ELSE 0 END) notified,
             COUNT(DISTINCT fingerprint) distinctCases
        FROM asymmetry_notify_decisions WHERE session_date=?`).get(sessionDate) as any;
    const byTimingRows = db.prepare(
      `SELECT timing, COUNT(*) n FROM asymmetry_notify_decisions WHERE session_date=? GROUP BY timing`,
    ).all(sessionDate) as any[];
    const actionExpr = hasColumn(db, "asymmetry_notify_decisions", "action")
      ? "COALESCE(action, CASE WHEN notify=1 THEN 'HIGH_ASYMMETRY_ALERT' ELSE 'LEGACY_AMBIGUOUS' END)"
      : "CASE WHEN notify=1 THEN 'HIGH_ASYMMETRY_ALERT' ELSE 'LEGACY_AMBIGUOUS' END";
    const byActionRows = db.prepare(
      `SELECT ${actionExpr} action, COUNT(*) n
         FROM asymmetry_notify_decisions WHERE session_date=? GROUP BY 1`,
    ).all(sessionDate) as any[];
    const byReasonRows = db.prepare(
      `SELECT reason, COUNT(*) n FROM asymmetry_notify_decisions
        WHERE session_date=? AND notify=0 GROUP BY reason ORDER BY n DESC LIMIT 50`,
    ).all(sessionDate) as any[];
    const decisions = Number(agg?.decisions ?? 0);
    const notified = Number(agg?.notified ?? 0);
    const distinctCases = Number(agg?.distinctCases ?? 0);
    return {
      decisions, notified, suppressed: decisions - notified, distinctCases,
      alertToCaptureRatioPct: distinctCases > 0 ? Math.round((notified / distinctCases) * 1000) / 10 : null,
      byTiming: Object.fromEntries(byTimingRows.map((r) => [String(r.timing), Number(r.n)])),
      byAction: Object.fromEntries(byActionRows.map((r) => [String(r.action), Number(r.n)])),
      byReason: byReasonRows.map((r) => ({ reason: String(r.reason), count: Number(r.n) })),
    };
  } catch {
    return empty;
  }
}
