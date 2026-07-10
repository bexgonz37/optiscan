/**
 * Opportunity lifecycle persistence. Wraps the pure logic in
 * lib/opportunity-lifecycle.ts with SQLite so the Command Center reads a stable,
 * evolving set of opportunities instead of a fresh grid every scan cycle.
 *
 * Imports getDb via the "@/lib/db" alias like the rest of the store layer — so
 * this module is source-spec tested (tests/opportunity-persistence.test.mjs),
 * while the transition/hysteresis math is runtime-tested through the pure module.
 */
import { getDb } from "@/lib/db";
import { tradingDay } from "@/lib/trading-session";
import {
  reconcile,
  groupByBucket,
  stableOrder,
  defaultLifecycleConfig,
  type OppSignal,
  type OpportunityRecord,
  type LifecycleBucket,
} from "./opportunity-lifecycle.ts";

function keyFor(ticker: string, setupType: string, day: string): string {
  return `opp_${ticker}_${setupType}_${day}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function rowToRecord(row: any): OpportunityRecord {
  return {
    opportunity_id: row.opportunity_id,
    ticker: row.ticker,
    setup_type: row.setup_type,
    first_detected_at: row.first_detected_at,
    last_updated_at: row.last_updated_at,
    highest_score: Number(row.highest_score) || 0,
    current_score: Number(row.current_score) || 0,
    previous_status: row.previous_status ?? null,
    current_status: row.current_status,
    trigger_level: row.trigger_level ?? null,
    entry_zone: row.entry_zone ?? null,
    invalidation_level: row.invalidation_level ?? null,
    expiration_time: row.expiration_time ?? null,
    demote_streak: Number(row.demote_streak) || 0,
    status_since: row.status_since,
  };
}

/**
 * Upsert a single signal into its lifecycle record. Loads the prior record for
 * (ticker, setup_type, trading_day), folds the signal in with hysteresis, and
 * persists. Returns the resulting record.
 */
export function upsertOpportunity(signal: OppSignal, nowMs = Date.now()): OpportunityRecord {
  const db = getDb();
  const ticker = String(signal.ticker || "").toUpperCase();
  const setupType = String(signal.setupType || "generic");
  const day = tradingDay(nowMs);
  const id = keyFor(ticker, setupType, day);

  const prevRow = db.prepare("SELECT * FROM opportunities WHERE opportunity_id=?").get(id) as any;
  const prev = prevRow ? rowToRecord(prevRow) : null;
  const next = reconcile(prev, signal, nowMs, defaultLifecycleConfig(process.env));
  next.opportunity_id = id; // ensure day-scoped id on first insert

  db.prepare(
    `INSERT INTO opportunities
       (opportunity_id, ticker, setup_type, trading_day, first_detected_at, last_updated_at,
        highest_score, current_score, previous_status, current_status,
        trigger_level, entry_zone, invalidation_level, expiration_time, demote_streak, status_since)
     VALUES (@opportunity_id, @ticker, @setup_type, @trading_day, @first_detected_at, @last_updated_at,
        @highest_score, @current_score, @previous_status, @current_status,
        @trigger_level, @entry_zone, @invalidation_level, @expiration_time, @demote_streak, @status_since)
     ON CONFLICT(opportunity_id) DO UPDATE SET
        last_updated_at=excluded.last_updated_at,
        highest_score=excluded.highest_score,
        current_score=excluded.current_score,
        previous_status=excluded.previous_status,
        current_status=excluded.current_status,
        trigger_level=excluded.trigger_level,
        entry_zone=excluded.entry_zone,
        invalidation_level=excluded.invalidation_level,
        expiration_time=excluded.expiration_time,
        demote_streak=excluded.demote_streak,
        status_since=excluded.status_since`,
  ).run({ ...next, trading_day: day });

  return next;
}

/** Bulk upsert — used by the scanner loop. Silently no-ops on empty input. */
export function upsertOpportunities(signals: OppSignal[], nowMs = Date.now()): number {
  if (!signals?.length) return 0;
  const db = getDb();
  const tx = db.transaction((rows: OppSignal[]) => {
    for (const s of rows) upsertOpportunity(s, nowMs);
  });
  tx(signals);
  return signals.length;
}

export function listOpportunities(opts: { day?: string; limit?: number } = {}): OpportunityRecord[] {
  const day = opts.day ?? tradingDay();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const rows = getDb()
    .prepare("SELECT * FROM opportunities WHERE trading_day=? ORDER BY last_updated_at DESC LIMIT ?")
    .all(day, limit) as any[];
  return stableOrder(rows.map(rowToRecord));
}

export function groupedOpportunities(opts: { day?: string; limit?: number } = {}): Record<LifecycleBucket, OpportunityRecord[]> {
  return groupByBucket(listOpportunities(opts));
}
