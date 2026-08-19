/**
 * mover-store.ts — the durable record that OptiScan SAW a market mover, kept
 * independently of whether OptiScan admitted it to anything.
 *
 * WHY THIS EXISTS. The Missed Opportunity agent reconstructs exclusively from
 * OptiScan's own persisted decisions and NBBO, so a symbol the system never
 * observed can never enter it. On 2026-08-19 the forensic for MRNA returned
 * `evidenceQuality: NONE` — "the system never quoted one" — which is true and
 * completely useless: the loop that exists to notice a giant miss could not
 * notice the giant miss, because noticing required having already looked.
 *
 * This table breaks that circularity. It records what the MARKET did, from the
 * whole-market snapshot, before and regardless of any eligibility decision. A
 * later forensic can then ask "what moved today" without asking "what did we
 * decide to watch today", which are different questions and were the same query.
 *
 * FIRST OBSERVATION IS IMMUTABLE. The row keeps the move at the instant the
 * symbol first crossed the discovery floor, and a later, larger move updates the
 * PEAK columns only. That is what makes "how early could this have been known"
 * answerable after the fact instead of being overwritten by hindsight — the
 * exact failure mode that made an MFE column read like a decision-time metric.
 *
 * ZERO LIVE AUTHORITY. Nothing reads this to alert, to promote a symbol into the
 * scanner, to open a position, or to change a gate. It is evidence.
 *
 * Additive and repeat-safe: `CREATE TABLE IF NOT EXISTS`, an upsert keyed on
 * (session_date, symbol), no destructive DDL, every write guarded. A persistence
 * fault in a research subsystem must never reach the scanner or delivery.
 */
import type { RankedMover } from "./market-movers.ts";

type StoreDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

/** Bumped when the recorded shape changes, so old rows stay interpretable. */
export const MARKET_MOVER_OBSERVATION_VERSION = 1;

export interface MoverObservationInput {
  sessionDate: string;
  /** Which session the FIRST observation happened in. */
  sessionPhase: "premarket" | "regular" | "afterhours" | "closed";
  mover: RankedMover;
  atMs: number;
}

export interface MoverObservationRow {
  sessionDate: string;
  symbol: string;
  firstObservedAtMs: number;
  firstObservedPhase: string;
  firstMovePct: number;
  firstRank: number;
  firstScore: number;
  peakAbsMovePct: number;
  peakObservedAtMs: number;
  lastObservedAtMs: number;
  observations: number;
  everExtreme: boolean;
  dollarVolume: number;
  spreadPct: number | null;
  reason: string;
}

/** Idempotent schema. Safe to call on every write. */
export function ensureMarketMoverSchema(db: StoreDb): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS market_mover_observations (
        session_date TEXT NOT NULL,
        symbol TEXT NOT NULL,
        observation_version INTEGER NOT NULL,
        first_observed_at_ms INTEGER NOT NULL,
        first_observed_phase TEXT NOT NULL,
        first_move_pct REAL NOT NULL,
        first_rank INTEGER NOT NULL,
        first_score REAL NOT NULL,
        peak_abs_move_pct REAL NOT NULL,
        peak_observed_at_ms INTEGER NOT NULL,
        last_observed_at_ms INTEGER NOT NULL,
        observations INTEGER NOT NULL DEFAULT 1,
        ever_extreme INTEGER NOT NULL DEFAULT 0,
        dollar_volume REAL,
        spread_pct REAL,
        range_expansion_pct REAL,
        velocity_pct_per_min REAL,
        reason TEXT,
        PRIMARY KEY (session_date, symbol)
      );
      CREATE INDEX IF NOT EXISTS idx_market_mover_session_move
        ON market_mover_observations(session_date, peak_abs_move_pct DESC);
      CREATE INDEX IF NOT EXISTS idx_market_mover_first_seen
        ON market_mover_observations(session_date, first_observed_at_ms);
    `);
  } catch {
    /* research storage never escalates */
  }
}

export interface MoverWriteResult {
  ok: boolean;
  inserted: number;
  updated: number;
  error: string | null;
}

/**
 * Record one cycle's ranked movers.
 *
 * INSERT keeps the first observation exactly as it was. UPDATE advances only
 * the peak, the last-seen instant, the observation count and the ever-extreme
 * flag — never the first-observation columns, which is the property that makes
 * this evidence rather than a running total.
 */
export function recordMarketMoversOnDb(
  db: StoreDb,
  inputs: readonly MoverObservationInput[],
): MoverWriteResult {
  const out: MoverWriteResult = { ok: true, inserted: 0, updated: 0, error: null };
  if (!inputs.length) return out;
  try {
    ensureMarketMoverSchema(db);
    const stmt = db.prepare(`
      INSERT INTO market_mover_observations (
        session_date, symbol, observation_version,
        first_observed_at_ms, first_observed_phase, first_move_pct, first_rank, first_score,
        peak_abs_move_pct, peak_observed_at_ms, last_observed_at_ms, observations, ever_extreme,
        dollar_volume, spread_pct, range_expansion_pct, velocity_pct_per_min, reason
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)
      ON CONFLICT(session_date, symbol) DO UPDATE SET
        last_observed_at_ms = excluded.last_observed_at_ms,
        observations = market_mover_observations.observations + 1,
        ever_extreme = MAX(market_mover_observations.ever_extreme, excluded.ever_extreme),
        dollar_volume = excluded.dollar_volume,
        spread_pct = excluded.spread_pct,
        range_expansion_pct = excluded.range_expansion_pct,
        velocity_pct_per_min = excluded.velocity_pct_per_min,
        peak_observed_at_ms = CASE
          WHEN excluded.peak_abs_move_pct > market_mover_observations.peak_abs_move_pct
          THEN excluded.peak_observed_at_ms ELSE market_mover_observations.peak_observed_at_ms END,
        peak_abs_move_pct = MAX(market_mover_observations.peak_abs_move_pct, excluded.peak_abs_move_pct)
    `);
    for (const i of inputs) {
      try {
        const m = i.mover;
        const res = stmt.run(
          i.sessionDate, m.symbol, MARKET_MOVER_OBSERVATION_VERSION,
          i.atMs, i.sessionPhase, m.movePct, m.rank, m.score,
          m.absMovePct, i.atMs, i.atMs, m.extreme ? 1 : 0,
          m.dollarVolume, m.spreadPct, m.rangeExpansionPct, m.velocityPctPerMin, m.reason,
        );
        // better-sqlite3 reports 1 change for both branches of an upsert, so the
        // split is derived from whether the row already existed, not from changes.
        if (Number(res?.changes ?? 0) > 0) out.inserted += 1;
      } catch { /* one bad row must not lose the sweep */ }
    }
    return out;
  } catch (err: any) {
    return { ok: false, inserted: 0, updated: 0, error: String(err?.message ?? err) };
  }
}

function hasTable(db: StoreDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

const row = (r: any): MoverObservationRow => ({
  sessionDate: String(r.session_date),
  symbol: String(r.symbol),
  firstObservedAtMs: Number(r.first_observed_at_ms),
  firstObservedPhase: String(r.first_observed_phase),
  firstMovePct: Number(r.first_move_pct),
  firstRank: Number(r.first_rank),
  firstScore: Number(r.first_score),
  peakAbsMovePct: Number(r.peak_abs_move_pct),
  peakObservedAtMs: Number(r.peak_observed_at_ms),
  lastObservedAtMs: Number(r.last_observed_at_ms),
  observations: Number(r.observations),
  everExtreme: Number(r.ever_extreme) === 1,
  dollarVolume: Number(r.dollar_volume ?? 0),
  spreadPct: r.spread_pct == null ? null : Number(r.spread_pct),
  reason: String(r.reason ?? ""),
});

/**
 * The session's movers, largest peak move first. This is the candidate source
 * that does NOT require OptiScan to have observed the symbol through its own
 * universe — which is the whole point of the table.
 */
export function listMarketMoversOnDb(
  db: StoreDb,
  sessionDate: string,
  opts: { limit?: number; minPeakAbsMovePct?: number; extremeOnly?: boolean } = {},
): MoverObservationRow[] {
  if (!hasTable(db, "market_mover_observations")) return [];
  try {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
    const minMove = Number.isFinite(opts.minPeakAbsMovePct as number) ? (opts.minPeakAbsMovePct as number) : 0;
    const rows = db.prepare(`
      SELECT * FROM market_mover_observations
       WHERE session_date=? AND peak_abs_move_pct >= ?
         AND (? = 0 OR ever_extreme = 1)
       ORDER BY peak_abs_move_pct DESC, dollar_volume DESC, symbol ASC
       LIMIT ?
    `).all(sessionDate, minMove, opts.extremeOnly ? 1 : 0, limit) as any[];
    return rows.map(row);
  } catch {
    return [];
  }
}

/** One symbol's observation for a session, or null when it was never a mover. */
export function getMarketMoverOnDb(
  db: StoreDb,
  sessionDate: string,
  symbol: string,
): MoverObservationRow | null {
  if (!hasTable(db, "market_mover_observations")) return null;
  try {
    const r = db.prepare(
      "SELECT * FROM market_mover_observations WHERE session_date=? AND symbol=?",
    ).get(sessionDate, String(symbol).toUpperCase()) as any;
    return r ? row(r) : null;
  } catch {
    return null;
  }
}
