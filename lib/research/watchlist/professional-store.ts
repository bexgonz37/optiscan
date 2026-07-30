/**
 * professional-store.ts — additive, idempotent persistence for the professional
 * Watchlist. Every statement is CREATE ... IF NOT EXISTS or an upsert, so the
 * migration is repeat-safe and no existing table is altered.
 *
 * These tables are NOT in ENTERPRISE_REQUIRED_TABLES: a missing table degrades
 * to a no-op rather than failing schema readiness, and every write is
 * hasTable-guarded. A persistence failure here can never block the scanner,
 * Discord delivery, or paper linkage — callers treat these as best-effort.
 */
import type { WatchlistPlan, WatchlistRow } from "./professional-plan.ts";
import type { WatchlistOutcome } from "./outcomes.ts";

type StoreDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

export function ensureProfessionalWatchlistSchema(db: StoreDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist_professional_plans (
      trading_day TEXT NOT NULL,
      phase TEXT NOT NULL,
      plan_version TEXT NOT NULL,
      built_at_ms INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (trading_day, phase)
    );
    CREATE TABLE IF NOT EXISTS watchlist_setup_rows (
      trading_day TEXT NOT NULL,
      phase TEXT NOT NULL,
      symbol TEXT NOT NULL,
      rank INTEGER NOT NULL,
      family TEXT NOT NULL,
      setup_type TEXT NOT NULL,
      call_above REAL,
      put_below REAL,
      state TEXT NOT NULL,
      evidence_as_of_ms INTEGER NOT NULL,
      changed_since_overnight INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (trading_day, phase, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_setup_rows_day ON watchlist_setup_rows(trading_day, rank);
    CREATE TABLE IF NOT EXISTS watchlist_setup_outcomes (
      trading_day TEXT NOT NULL,
      symbol TEXT NOT NULL,
      family TEXT NOT NULL,
      status TEXT NOT NULL,
      triggered_side TEXT,
      triggered_at_ms INTEGER,
      favorable_movement INTEGER,
      became_verified_send INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (trading_day, symbol, family)
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_setup_outcomes_day ON watchlist_setup_outcomes(trading_day);
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
 * Persist one phase of the plan. Replacing a phase clears that phase's rows
 * first, so a correctly-empty plan cannot leave yesterday's rows published.
 */
export function persistProfessionalPlanOnDb(db: StoreDb, plan: WatchlistPlan): { persisted: boolean; error: string | null } {
  try {
    ensureProfessionalWatchlistSchema(db);
    db.prepare(`
      INSERT INTO watchlist_professional_plans (trading_day, phase, plan_version, built_at_ms, payload_json)
      VALUES (?,?,?,?,?)
      ON CONFLICT(trading_day, phase) DO UPDATE SET
        plan_version = excluded.plan_version,
        built_at_ms = excluded.built_at_ms,
        payload_json = excluded.payload_json
    `).run(plan.tradingDay, plan.phase, plan.planVersion, plan.builtAtMs, JSON.stringify(plan));
    db.prepare(`DELETE FROM watchlist_setup_rows WHERE trading_day = ? AND phase = ?`).run(plan.tradingDay, plan.phase);
    const insert = db.prepare(`
      INSERT INTO watchlist_setup_rows
        (trading_day, phase, symbol, rank, family, setup_type, call_above, put_below, state,
         evidence_as_of_ms, changed_since_overnight, payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const row of plan.rows) {
      insert.run(
        plan.tradingDay, plan.phase, row.symbol, row.rank, row.family, row.setupType,
        row.callAbove?.price ?? null, row.putBelow?.price ?? null, row.state,
        row.evidenceAsOfMs, row.changedSinceOvernight ? 1 : 0, JSON.stringify(row),
      );
    }
    return { persisted: true, error: null };
  } catch (err: any) {
    return { persisted: false, error: String(err?.message ?? err) };
  }
}

export function loadProfessionalPlanOnDb(db: StoreDb, tradingDay: string, phase: WatchlistPlan["phase"]): WatchlistPlan | null {
  if (!hasTable(db, "watchlist_professional_plans")) return null;
  try {
    const row = db.prepare(
      `SELECT payload_json FROM watchlist_professional_plans WHERE trading_day = ? AND phase = ?`,
    ).get(tradingDay, phase) as { payload_json?: string } | undefined;
    return row?.payload_json ? (JSON.parse(row.payload_json) as WatchlistPlan) : null;
  } catch {
    return null;
  }
}

/** Upsert one outcome. Repeat-safe: re-recording the same outcome changes nothing. */
export function recordWatchlistOutcomeOnDb(
  db: StoreDb,
  outcome: WatchlistOutcome,
  nowMs: number,
): { persisted: boolean; error: string | null } {
  try {
    ensureProfessionalWatchlistSchema(db);
    db.prepare(`
      INSERT INTO watchlist_setup_outcomes
        (trading_day, symbol, family, status, triggered_side, triggered_at_ms,
         favorable_movement, became_verified_send, payload_json, updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(trading_day, symbol, family) DO UPDATE SET
        status = excluded.status,
        triggered_side = excluded.triggered_side,
        triggered_at_ms = excluded.triggered_at_ms,
        favorable_movement = excluded.favorable_movement,
        became_verified_send = excluded.became_verified_send,
        payload_json = excluded.payload_json,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      outcome.tradingDay, outcome.symbol, outcome.family, outcome.status,
      outcome.triggeredSide, outcome.triggeredAtMs,
      outcome.favorableMovement == null ? null : outcome.favorableMovement ? 1 : 0,
      outcome.becameVerifiedSend ? 1 : 0, JSON.stringify(outcome), nowMs,
    );
    return { persisted: true, error: null };
  } catch (err: any) {
    return { persisted: false, error: String(err?.message ?? err) };
  }
}

export function loadWatchlistOutcomesOnDb(db: StoreDb, opts: { tradingDay?: string; limit?: number } = {}): WatchlistOutcome[] {
  if (!hasTable(db, "watchlist_setup_outcomes")) return [];
  try {
    const limit = Math.max(1, Math.min(2000, opts.limit ?? 500));
    const rows = opts.tradingDay
      ? db.prepare(`SELECT payload_json FROM watchlist_setup_outcomes WHERE trading_day = ? ORDER BY symbol LIMIT ?`).all(opts.tradingDay, limit)
      : db.prepare(`SELECT payload_json FROM watchlist_setup_outcomes ORDER BY trading_day DESC, symbol LIMIT ?`).all(limit);
    return (rows as Array<{ payload_json: string }>)
      .map((r) => { try { return JSON.parse(r.payload_json) as WatchlistOutcome; } catch { return null; } })
      .filter((o): o is WatchlistOutcome => o != null);
  } catch {
    return [];
  }
}

/** Published rows for a day/phase, for the read-only UI and API. */
export function loadPublishedRowsOnDb(db: StoreDb, tradingDay: string, phase: WatchlistPlan["phase"]): WatchlistRow[] {
  if (!hasTable(db, "watchlist_setup_rows")) return [];
  try {
    const rows = db.prepare(
      `SELECT payload_json FROM watchlist_setup_rows WHERE trading_day = ? AND phase = ? ORDER BY rank ASC`,
    ).all(tradingDay, phase) as Array<{ payload_json: string }>;
    return rows
      .map((r) => { try { return JSON.parse(r.payload_json) as WatchlistRow; } catch { return null; } })
      .filter((r): r is WatchlistRow => r != null);
  } catch {
    return [];
  }
}
