/**
 * missed-opportunity.ts — WHAT WAS COIN DOING WHEN WE DID NOT PROMOTE IT.
 *
 * WHY THIS EXISTS. The coverage work made the whole universe visible, which
 * means the system now makes ~1,600 decisions a cycle instead of 25. Almost all
 * of them are "not this one". Those decisions are the product's actual behaviour
 * and until now they left no trace: a symbol that was passed over was
 * indistinguishable from a symbol that was never seen, and neither could be
 * reviewed after the fact.
 *
 * This records the SKIPS. Not to second-guess them live — nothing here feeds
 * back into selection — but so that a week later the question "was the system
 * right to pass on that" has an answer made of what was actually observed at the
 * time, rather than of hindsight.
 *
 * TWO RULES THAT KEEP IT HONEST.
 *
 *  1. UNDERLYING-ONLY OUTCOMES STAY UNDERLYING-ONLY. When no contract was
 *     selected there is no option price, no fill, no P&L, and none is invented.
 *     This record has NO option fields at all — not nullable ones, none — so a
 *     later reader cannot mistake a reconstruction for an observation. A
 *     "what the option would have done" number computed from a chain nobody
 *     fetched is fiction, and fiction in a research corpus is worse than a gap.
 *
 *  2. IT IS BOUNDED, AND THE BOUND IS DELIBERATE. Recording every skip would be
 *     ~1,600 rows per cycle: at a 60s cadence that is ~624,000 rows per session,
 *     to answer a question about a handful of them. Only decisions that were
 *     genuinely CLOSE are kept — a symbol that scored well enough to be worth
 *     asking about, or that was refused for a reason that is about US rather
 *     than about it (quota, no chain). A quiet name that scored 3 and was
 *     ignored is not a missed opportunity, it is the system working.
 *
 * WHAT THIS IS NOT. Not a signal, not a backfill, not a shadow strategy. It
 * writes rows nothing reads at decision time.
 *
 * PURE except for the explicit `persist*OnDb` functions, which are the only
 * place it touches storage.
 */
import type { AwarenessRow } from "./awareness.ts";

const num = (v: string | undefined, d: number, min = -Infinity): number => {
  const x = Number(v);
  return Number.isFinite(x) && x >= min ? x : d;
};

/**
 * Why a symbol did not get expensive work this cycle.
 *
 * Deliberately distinguishes decisions ABOUT THE SYMBOL from decisions ABOUT
 * US. `NOT_PROMOTED` is a judgement that can be reviewed; `QUOTA_BLOCKED` is a
 * capacity failure wearing a judgement's clothes, and conflating them would hide
 * exactly the thing worth fixing.
 */
export type SkipReason =
  /** Cheaply observed, ranked, and did not make the promotion cut. */
  | "NOT_PROMOTED"
  /** Promoted, but deep analysis had no capacity for it this cycle. */
  | "DEEP_DEFERRED"
  /** Refused by the provider budget. About us, not the symbol. */
  | "QUOTA_BLOCKED"
  /** Analysed, but no usable option chain came back. */
  | "NO_CHAIN"
  /** Analysed with a chain, and no strategy applied. */
  | "STRATEGY_REJECTED";

/**
 * A point-in-time record of one skip.
 *
 * Every field is underlying or decision state. There is no option symbol,
 * strike, expiry, premium or outcome, by construction — see rule 1.
 */
export interface MissedOpportunityRecord {
  sessionDate: string;
  atMs: number;
  symbol: string;
  reason: SkipReason;
  /** Awareness state at the moment of the decision. */
  preScore: number;
  awarenessRank: number;
  band: string;
  normalizedMovePct: number;
  rawMovePct: number;
  leverageMultiplier: number;
  velocityPctPerMin: number | null;
  rangePosition: number | null;
  dollarVolume: number;
  spreadPct: number | null;
  /** Size of the universe it was ranked within, so a rank means something later. */
  universeSize: number;
  /** Promotions available that cycle, so "not promoted" can be read in context. */
  promotionCapacity: number;
  /** Human-readable snapshot reason, carried from the awareness row. */
  observation: string;
}

export interface MissedOpportunityConfig {
  /**
   * Pre-score at or above which a NOT_PROMOTED decision is worth recording.
   * Below this the system passing is not a near miss; it is the design working.
   */
  minPreScore: number;
  /**
   * Hard cap on records per cycle. A bad config or a violent open must not turn
   * this into an unbounded writer — the cap binds regardless of score.
   */
  maxPerCycle: number;
  /** Days of history kept. Bounds total storage independently of write rate. */
  retentionDays: number;
}

export const DEFAULT_MISSED_OPPORTUNITY: Readonly<MissedOpportunityConfig> = Object.freeze({
  minPreScore: 45,
  maxPerCycle: 25,
  retentionDays: 30,
});

export function missedOpportunityConfig(env: NodeJS.ProcessEnv = process.env): MissedOpportunityConfig {
  const d = DEFAULT_MISSED_OPPORTUNITY;
  return {
    minPreScore: num(env.OPTIONS_MISSED_MIN_PRESCORE, d.minPreScore, 0),
    maxPerCycle: num(env.OPTIONS_MISSED_MAX_PER_CYCLE, d.maxPerCycle, 1),
    retentionDays: num(env.OPTIONS_MISSED_RETENTION_DAYS, d.retentionDays, 1),
  };
}

/**
 * Reasons that are recorded regardless of score.
 *
 * These are failures of OUR capacity or of the data, not judgements about the
 * symbol. A quota block on a mediocre candidate is still evidence that the lane
 * ran out of room, and that is precisely what the Phase-9 work needs to see.
 */
const ALWAYS_RECORD: ReadonlySet<SkipReason> = new Set<SkipReason>([
  "QUOTA_BLOCKED", "DEEP_DEFERRED", "NO_CHAIN",
]);

/** Should this skip be written down? */
export function shouldRecordSkip(
  row: Pick<AwarenessRow, "preScore" | "band">,
  reason: SkipReason,
  cfg: MissedOpportunityConfig = DEFAULT_MISSED_OPPORTUNITY,
): boolean {
  if (ALWAYS_RECORD.has(reason)) return true;
  if (row.band === "HIGH_PRIORITY" || row.band === "NEWLY_ACCELERATING") return true;
  return row.preScore >= cfg.minPreScore;
}

/** Build one record from the awareness row that produced the decision. */
export function buildMissedOpportunity(
  row: AwarenessRow,
  reason: SkipReason,
  ctx: { sessionDate: string; universeSize: number; promotionCapacity: number },
): MissedOpportunityRecord {
  return {
    sessionDate: ctx.sessionDate,
    atMs: row.observedAtMs,
    symbol: row.symbol,
    reason,
    preScore: row.preScore,
    awarenessRank: row.rank,
    band: row.band,
    normalizedMovePct: row.normalizedMovePct,
    rawMovePct: row.rawMovePct,
    leverageMultiplier: row.leverageMultiplier,
    velocityPctPerMin: row.velocityPctPerMin,
    rangePosition: row.rangePosition,
    dollarVolume: row.dollarVolume,
    spreadPct: row.spreadPct,
    universeSize: ctx.universeSize,
    promotionCapacity: ctx.promotionCapacity,
    observation: row.reason,
  };
}

/**
 * Select and build this cycle's records, hardest-to-explain first.
 *
 * Ordering matters because the per-cycle cap truncates: when more skips qualify
 * than the cap allows, the ones kept must be the ones most worth reviewing.
 * Capacity failures sort above judgements, then by pre-score.
 */
export function collectMissedOpportunities(
  candidates: readonly { row: AwarenessRow; reason: SkipReason }[],
  ctx: { sessionDate: string; universeSize: number; promotionCapacity: number },
  cfg: MissedOpportunityConfig = DEFAULT_MISSED_OPPORTUNITY,
): { records: MissedOpportunityRecord[]; considered: number; recorded: number; truncated: number } {
  const eligible = candidates.filter((c) => c?.row && shouldRecordSkip(c.row, c.reason, cfg));
  eligible.sort((a, b) => {
    const aCap = ALWAYS_RECORD.has(a.reason) ? 1 : 0;
    const bCap = ALWAYS_RECORD.has(b.reason) ? 1 : 0;
    return bCap - aCap
      || b.row.preScore - a.row.preScore
      || (a.row.symbol < b.row.symbol ? -1 : a.row.symbol > b.row.symbol ? 1 : 0);
  });
  const kept = eligible.slice(0, cfg.maxPerCycle);
  return {
    records: kept.map((c) => buildMissedOpportunity(c.row, c.reason, ctx)),
    considered: candidates.length,
    recorded: kept.length,
    truncated: Math.max(0, eligible.length - kept.length),
  };
}

/* ---------------------------------------------------------------------------
 * STORAGE
 * -------------------------------------------------------------------------*/

type StoreDb = {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes?: number };
  };
  exec: (sql: string) => unknown;
};

/**
 * Idempotent schema. Safe to call on every write.
 *
 * NOTE THE ABSENT COLUMNS. There is no option_symbol, strike, expiration,
 * premium or return here, and that is the schema enforcing rule 1: a later
 * writer cannot quietly start filling in an option outcome for a contract that
 * was never selected, because there is nowhere to put it.
 */
export function ensureMissedOpportunitySchema(db: StoreDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS options_missed_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_date TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      reason TEXT NOT NULL,
      pre_score REAL NOT NULL,
      awareness_rank INTEGER NOT NULL,
      band TEXT NOT NULL,
      normalized_move_pct REAL,
      raw_move_pct REAL,
      leverage_multiplier REAL,
      velocity_pct_per_min REAL,
      range_position REAL,
      dollar_volume REAL,
      spread_pct REAL,
      universe_size INTEGER NOT NULL,
      promotion_capacity INTEGER NOT NULL,
      observation TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_missed_opp_session
      ON options_missed_opportunities(session_date, at_ms);
    CREATE INDEX IF NOT EXISTS idx_missed_opp_symbol
      ON options_missed_opportunities(symbol, session_date);
    CREATE INDEX IF NOT EXISTS idx_missed_opp_reason
      ON options_missed_opportunities(session_date, reason);
  `);
}

/**
 * Write this cycle's records.
 *
 * A write fault is RETURNED, never thrown: this is observability, and losing a
 * diagnostic row must never take down the scan that produced it.
 */
export function persistMissedOpportunitiesOnDb(
  db: StoreDb,
  records: readonly MissedOpportunityRecord[],
): { inserted: number; error: string | null } {
  if (!records.length) return { inserted: 0, error: null };
  try {
    ensureMissedOpportunitySchema(db);
    const stmt = db.prepare(`
      INSERT INTO options_missed_opportunities (
        session_date, at_ms, symbol, reason, pre_score, awareness_rank, band,
        normalized_move_pct, raw_move_pct, leverage_multiplier, velocity_pct_per_min,
        range_position, dollar_volume, spread_pct, universe_size, promotion_capacity, observation
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    let inserted = 0;
    for (const r of records) {
      stmt.run(
        r.sessionDate, r.atMs, r.symbol, r.reason, r.preScore, r.awarenessRank, r.band,
        r.normalizedMovePct, r.rawMovePct, r.leverageMultiplier, r.velocityPctPerMin,
        r.rangePosition, r.dollarVolume, r.spreadPct, r.universeSize, r.promotionCapacity, r.observation,
      );
      inserted += 1;
    }
    return { inserted, error: null };
  } catch (e) {
    return { inserted: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Drop records past the retention horizon. Bounds storage independently of write rate. */
export function pruneMissedOpportunitiesOnDb(
  db: StoreDb,
  nowMs: number,
  cfg: MissedOpportunityConfig = DEFAULT_MISSED_OPPORTUNITY,
): { deleted: number; error: string | null } {
  try {
    ensureMissedOpportunitySchema(db);
    const cutoff = nowMs - cfg.retentionDays * 86_400_000;
    const res = db.prepare("DELETE FROM options_missed_opportunities WHERE at_ms < ?").run(cutoff);
    return { deleted: res?.changes ?? 0, error: null };
  } catch (e) {
    return { deleted: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Everything recorded about one symbol, newest first. The COIN question. */
export function missedOpportunitiesForSymbol(
  db: StoreDb,
  symbol: string,
  limit = 100,
): MissedOpportunityRecord[] {
  ensureMissedOpportunitySchema(db);
  const rows = db.prepare(`
    SELECT * FROM options_missed_opportunities
    WHERE symbol = ? ORDER BY at_ms DESC LIMIT ?
  `).all(String(symbol).toUpperCase(), limit) as Record<string, any>[];
  return rows.map((r) => ({
    sessionDate: r.session_date,
    atMs: r.at_ms,
    symbol: r.symbol,
    reason: r.reason as SkipReason,
    preScore: r.pre_score,
    awarenessRank: r.awareness_rank,
    band: r.band,
    normalizedMovePct: r.normalized_move_pct,
    rawMovePct: r.raw_move_pct,
    leverageMultiplier: r.leverage_multiplier,
    velocityPctPerMin: r.velocity_pct_per_min,
    rangePosition: r.range_position,
    dollarVolume: r.dollar_volume,
    spreadPct: r.spread_pct,
    universeSize: r.universe_size,
    promotionCapacity: r.promotion_capacity,
    observation: r.observation,
  }));
}
