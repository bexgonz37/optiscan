/**
 * thesis-lane.ts — durable "one open idea per thesis" authority for the LIVE
 * subscriber alert path.
 *
 * THE INCIDENT. On 2026-07-29 production sent three AAPL PUT alerts — 14:50:15,
 * 15:02:18, 15:44:15 — all for the SAME exact OCC O:AAPL260729P00340000, while
 * the first was still open and had already hit Target 1.
 *
 * WHY THE EXISTING GUARD DID NOT STOP IT. `alertRecentDuplicate` is a TIME
 * WINDOW: 8 minutes for a core symbol like AAPL, 10 otherwise. The repeats were
 * 12 and 42 minutes apart, so the window had simply expired. It asks "did we
 * alert recently", never "is this idea still open". Those are different
 * questions, and only the second one protects a trader.
 *
 * THE KEY DELIBERATELY EXCLUDES strike, expiration, and strategy label. A
 * different strike on the same symbol, direction and session is the SAME trade
 * idea to a human holding it, and letting a strike change mint a fresh alert is
 * exactly how a thesis gets re-sent under a new name.
 *
 * Authority is atomic: the claim is an INSERT guarded by a PRIMARY KEY, so two
 * concurrent ticks cannot both open. A later signal on a held lane becomes
 * EVIDENCE, never a second opening send.
 *
 * FAILURE YIELDS TO THE SCANNER. Every function swallows its own errors. A
 * fault here must never abort a scan; the worst case is falling back to the
 * pre-existing time-window behaviour.
 */

type LaneDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

export type LaneDirection = "bullish" | "bearish";
export type LaneOptionType = "CALL" | "PUT";

/** Minimum quiet time after a lane closes before the same idea may reopen. */
export const REENTRY_COOLDOWN_MS = Number(process.env.THESIS_REENTRY_COOLDOWN_MS ?? 30 * 60_000);

/**
 * The lane key. symbol + direction + optionType + session ONLY.
 * Strike, expiration and strategy are excluded on purpose — see the header.
 */
export function thesisLaneKey(i: {
  symbol: string; direction: LaneDirection; optionType: LaneOptionType; sessionDate: string;
}): string {
  return [i.sessionDate, String(i.symbol).trim().toUpperCase(), i.direction, i.optionType].join("|");
}

export function optionTypeFor(direction: LaneDirection): LaneOptionType {
  return direction === "bearish" ? "PUT" : "CALL";
}

/** Idempotent, additive schema. */
export function ensureThesisLaneSchema(db: LaneDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thesis_lane_authority (
      lane_key TEXT PRIMARY KEY,
      session_date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      option_type TEXT NOT NULL,
      state TEXT NOT NULL,
      alert_id INTEGER,
      option_symbol TEXT,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      suppressed_count INTEGER NOT NULL DEFAULT 0,
      last_evidence_at_ms INTEGER,
      best_score REAL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_thesis_lane_session ON thesis_lane_authority(session_date, state);

    CREATE TABLE IF NOT EXISTS thesis_lane_suppressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane_key TEXT NOT NULL,
      session_date TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      candidate_option_symbol TEXT,
      candidate_score REAL,
      reason TEXT NOT NULL,
      original_alert_id INTEGER,
      lifecycle_event TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_thesis_lane_supp ON thesis_lane_suppressions(session_date, id DESC);
  `);
}

function hasTable(db: LaneDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch { return false; }
}

export interface LaneRecord {
  laneKey: string; sessionDate: string; symbol: string;
  direction: string; optionType: string; state: string;
  alertId: number | null; optionSymbol: string | null;
  openedAtMs: number; closedAtMs: number | null;
  evidenceCount: number; suppressedCount: number; bestScore: number | null;
}

export function readLaneOnDb(db: LaneDb, laneKey: string): LaneRecord | null {
  if (!hasTable(db, "thesis_lane_authority")) return null;
  try {
    const r = db.prepare("SELECT * FROM thesis_lane_authority WHERE lane_key=?").get(laneKey) as any;
    if (!r) return null;
    return {
      laneKey: String(r.lane_key), sessionDate: String(r.session_date), symbol: String(r.symbol),
      direction: String(r.direction), optionType: String(r.option_type), state: String(r.state),
      alertId: r.alert_id == null ? null : Number(r.alert_id),
      optionSymbol: r.option_symbol == null ? null : String(r.option_symbol),
      openedAtMs: Number(r.opened_at_ms), closedAtMs: r.closed_at_ms == null ? null : Number(r.closed_at_ms),
      evidenceCount: Number(r.evidence_count ?? 0), suppressedCount: Number(r.suppressed_count ?? 0),
      bestScore: r.best_score == null ? null : Number(r.best_score),
    };
  } catch { return null; }
}

export type LaneDecision =
  | { allowed: true; laneKey: string; reason: "NEW_LANE" | "REENTRY_AFTER_COOLDOWN" }
  | { allowed: false; laneKey: string; reason: string; existing: LaneRecord };

/**
 * Decide whether an OPENING alert may proceed. PURE over the record.
 *
 * A held lane blocks regardless of how the new candidate differs: a changed
 * strike, expiration, score or scanner tick is the same idea wearing a
 * different hat.
 */
export function decideLaneAuthority(
  laneKey: string, existing: LaneRecord | null, nowMs: number,
  cooldownMs: number = REENTRY_COOLDOWN_MS,
): LaneDecision {
  if (!existing) return { allowed: true, laneKey, reason: "NEW_LANE" };
  if (existing.state === "OPEN") {
    return { allowed: false, laneKey, reason: "THESIS_ALREADY_OPEN", existing };
  }
  // Closed or invalidated: a deterministic quiet period before the same idea
  // may reopen, so a stop-out cannot immediately re-alert on the next tick.
  const since = nowMs - (existing.closedAtMs ?? existing.openedAtMs);
  if (since < cooldownMs) {
    return { allowed: false, laneKey, reason: `REENTRY_COOLDOWN_${Math.ceil((cooldownMs - since) / 60_000)}M`, existing };
  }
  return { allowed: true, laneKey, reason: "REENTRY_AFTER_COOLDOWN" };
}

export interface ClaimResult {
  claimed: boolean;
  laneKey: string;
  reason: string;
  existing: LaneRecord | null;
}

/**
 * Atomically claim the lane for an opening alert.
 *
 * The INSERT is guarded by the PRIMARY KEY and the reopen path is an UPDATE
 * guarded on the row still being CLOSED, so two concurrent ticks cannot both
 * win. Never throws: on any fault it reports `claimed: true` so the caller
 * falls back to the pre-existing time-window dedup rather than losing alerts.
 */
export function claimThesisLane(db: LaneDb, i: {
  symbol: string; direction: LaneDirection; sessionDate: string; nowMs: number;
  optionSymbol?: string | null; score?: number | null; cooldownMs?: number;
}): ClaimResult {
  const optionType = optionTypeFor(i.direction);
  const laneKey = thesisLaneKey({ symbol: i.symbol, direction: i.direction, optionType, sessionDate: i.sessionDate });
  try {
    ensureThesisLaneSchema(db);
    const existing = readLaneOnDb(db, laneKey);
    const decision = decideLaneAuthority(laneKey, existing, i.nowMs, i.cooldownMs ?? REENTRY_COOLDOWN_MS);
    if (!decision.allowed) {
      return { claimed: false, laneKey, reason: decision.reason, existing: decision.existing };
    }

    if (!existing) {
      const res = db.prepare(`
        INSERT OR IGNORE INTO thesis_lane_authority
          (lane_key, session_date, symbol, direction, option_type, state, option_symbol,
           opened_at_ms, evidence_count, suppressed_count, best_score, updated_at_ms)
        VALUES (?,?,?,?,?, 'OPEN', ?, ?, 0, 0, ?, ?)
      `).run(laneKey, i.sessionDate, String(i.symbol).toUpperCase(), i.direction, optionType,
        i.optionSymbol ?? null, i.nowMs, i.score ?? null, i.nowMs);
      if (Number(res.changes ?? 0) !== 1) {
        // Lost the race. Whoever won holds the lane.
        return { claimed: false, laneKey, reason: "THESIS_ALREADY_OPEN", existing: readLaneOnDb(db, laneKey) };
      }
      return { claimed: true, laneKey, reason: decision.reason, existing: null };
    }

    const res = db.prepare(`
      UPDATE thesis_lane_authority
         SET state='OPEN', option_symbol=?, opened_at_ms=?, closed_at_ms=NULL,
             evidence_count=0, best_score=?, updated_at_ms=?
       WHERE lane_key=? AND state<>'OPEN'
    `).run(i.optionSymbol ?? null, i.nowMs, i.score ?? null, i.nowMs, laneKey);
    if (Number(res.changes ?? 0) !== 1) {
      return { claimed: false, laneKey, reason: "THESIS_ALREADY_OPEN", existing: readLaneOnDb(db, laneKey) };
    }
    return { claimed: true, laneKey, reason: decision.reason, existing };
  } catch {
    // Authority is a safety improvement, not a gate on the business. If it is
    // unavailable the scanner keeps its previous behaviour.
    return { claimed: true, laneKey, reason: "AUTHORITY_UNAVAILABLE", existing: null };
  }
}

/** Record the alert id once the opening alert actually exists. */
export function bindLaneAlertOnDb(db: LaneDb, laneKey: string, alertId: number, nowMs: number): void {
  try {
    db.prepare("UPDATE thesis_lane_authority SET alert_id=COALESCE(alert_id, ?), updated_at_ms=? WHERE lane_key=?")
      .run(alertId, nowMs, laneKey);
  } catch { /* diagnostics only */ }
}

/**
 * A suppressed candidate becomes EVIDENCE on the held lane. The original
 * opening alert and its frozen entry are untouched — that is the whole point.
 */
export function attachLaneEvidenceOnDb(db: LaneDb, i: {
  laneKey: string; sessionDate: string; nowMs: number;
  candidateOptionSymbol: string | null; candidateScore: number | null;
  reason: string; originalAlertId: number | null; lifecycleEvent?: string | null;
}): void {
  try {
    ensureThesisLaneSchema(db);
    db.prepare(`
      UPDATE thesis_lane_authority
         SET evidence_count = evidence_count + 1,
             suppressed_count = suppressed_count + 1,
             last_evidence_at_ms = ?,
             best_score = CASE WHEN ? IS NOT NULL AND (best_score IS NULL OR ? > best_score) THEN ? ELSE best_score END,
             updated_at_ms = ?
       WHERE lane_key = ?
    `).run(i.nowMs, i.candidateScore, i.candidateScore, i.candidateScore, i.nowMs, i.laneKey);
    db.prepare(`
      INSERT INTO thesis_lane_suppressions
        (lane_key, session_date, occurred_at_ms, candidate_option_symbol, candidate_score, reason, original_alert_id, lifecycle_event)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(i.laneKey, i.sessionDate, i.nowMs, i.candidateOptionSymbol, i.candidateScore,
      i.reason, i.originalAlertId, i.lifecycleEvent ?? null);
    // Bounded history.
    db.prepare(`
      DELETE FROM thesis_lane_suppressions WHERE session_date=? AND id NOT IN (
        SELECT id FROM thesis_lane_suppressions WHERE session_date=? ORDER BY id DESC LIMIT 100)
    `).run(i.sessionDate, i.sessionDate);
  } catch { /* never blocks the scanner */ }
}

/** Close a lane so a deterministic re-entry becomes possible after cooldown. */
export function closeThesisLaneOnDb(db: LaneDb, laneKey: string, nowMs: number, state: "CLOSED" | "INVALIDATED" = "CLOSED"): boolean {
  try {
    const res = db.prepare(
      "UPDATE thesis_lane_authority SET state=?, closed_at_ms=?, updated_at_ms=? WHERE lane_key=? AND state='OPEN'",
    ).run(state, nowMs, nowMs, laneKey);
    return Number(res.changes ?? 0) === 1;
  } catch { return false; }
}

export interface LaneDiagnostics {
  activeLanes: LaneRecord[];
  suppressedTotal: number;
  recentSuppressions: Array<{
    laneKey: string; occurredAtMs: number; candidateOptionSymbol: string | null;
    candidateScore: number | null; reason: string; originalAlertId: number | null; lifecycleEvent: string | null;
  }>;
}

export function readLaneDiagnosticsOnDb(db: LaneDb, sessionDate: string): LaneDiagnostics {
  const empty: LaneDiagnostics = { activeLanes: [], suppressedTotal: 0, recentSuppressions: [] };
  if (!hasTable(db, "thesis_lane_authority")) return empty;
  try {
    const activeLanes = (db.prepare(
      "SELECT * FROM thesis_lane_authority WHERE session_date=? ORDER BY opened_at_ms DESC",
    ).all(sessionDate) as any[]).map((r) => readLaneOnDb(db, String(r.lane_key))!).filter(Boolean);
    const suppressedTotal = Number((db.prepare(
      "SELECT COALESCE(SUM(suppressed_count),0) n FROM thesis_lane_authority WHERE session_date=?",
    ).get(sessionDate) as any)?.n ?? 0);
    const recentSuppressions = (db.prepare(
      "SELECT * FROM thesis_lane_suppressions WHERE session_date=? ORDER BY id DESC LIMIT 25",
    ).all(sessionDate) as any[]).map((r) => ({
      laneKey: String(r.lane_key), occurredAtMs: Number(r.occurred_at_ms),
      candidateOptionSymbol: r.candidate_option_symbol == null ? null : String(r.candidate_option_symbol),
      candidateScore: r.candidate_score == null ? null : Number(r.candidate_score),
      reason: String(r.reason),
      originalAlertId: r.original_alert_id == null ? null : Number(r.original_alert_id),
      lifecycleEvent: r.lifecycle_event == null ? null : String(r.lifecycle_event),
    }));
    return { activeLanes, suppressedTotal, recentSuppressions };
  } catch { return empty; }
}
