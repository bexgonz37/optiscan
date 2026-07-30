/**
 * market-context-job.ts — records the deterministic next-session market context
 * and clears stale Watchlist plans.
 *
 * This is the ONLY place these writes happen. GET /api/now is read-only by design:
 * a page refresh must never mutate production state, so both the context snapshot
 * and stale-plan clearing are owned by the scheduler (or an explicit maintenance
 * POST) where a failure is visible in scheduler state instead of silently
 * happening on someone's page load.
 *
 * Provider access is injected so the whole job is testable without network I/O.
 */
import { tradingDay } from "../../trading-session.ts";
import {
  buildNextSessionMarketContext,
  indexSessionFromBars,
  persistNextSessionContextOnDb,
  type NextSessionMarketContext,
  type ProviderBar,
} from "./market-context-snapshot.ts";

type JobDb = {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => { changes?: number; lastInsertRowid?: number | bigint };
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
  };
};

export interface WatchlistPlanningDeps {
  /** Fetch recent candles for one symbol. Returns null/empty when unavailable. */
  fetchBars: (symbol: string) => Promise<ProviderBar[] | null>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export interface WatchlistPlanningResult {
  ranAtMs: number;
  tradingDay: string;
  contextRecorded: boolean;
  contextQuality: string;
  contextUsableForPlanning: boolean;
  stalePlanDaysCleared: number;
  staleRowsCleared: number;
  errors: string[];
}

function hasTable(db: JobDb, table: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  } catch {
    return false;
  }
}

/**
 * Record the deterministic context snapshot for the current planning day.
 * Returns the context even when persistence fails, so callers can still read it.
 */
export async function recordNextSessionMarketContextOnDb(
  db: JobDb,
  deps: WatchlistPlanningDeps,
): Promise<{ context: NextSessionMarketContext; persisted: boolean; error: string | null }> {
  const nowMs = deps.now?.() ?? Date.now();
  const day = tradingDay(nowMs);
  let spyBars: ProviderBar[] | null = null;
  let qqqBars: ProviderBar[] | null = null;
  const errors: string[] = [];
  try { spyBars = await deps.fetchBars("SPY"); } catch (err: any) { errors.push(`spy:${err?.message}`); }
  try { qqqBars = await deps.fetchBars("QQQ"); } catch (err: any) { errors.push(`qqq:${err?.message}`); }

  const context = buildNextSessionMarketContext({
    tradingDay: day,
    builtAtMs: nowMs,
    spy: indexSessionFromBars("SPY", spyBars),
    qqq: indexSessionFromBars("QQQ", qqqBars),
  });
  try {
    persistNextSessionContextOnDb(db, context, nowMs);
    return { context, persisted: true, error: errors.length ? errors.join("; ") : null };
  } catch (err: any) {
    return { context, persisted: false, error: [...errors, `persist:${err?.message}`].join("; ") };
  }
}

/**
 * Delete overnight_watchlist rows for trading days other than the current planning
 * day. Idempotent: a second run finds nothing to delete and reports 0.
 */
export function clearStaleWatchlistPlansOnDb(
  db: JobDb,
  keepTradingDay: string,
): { daysCleared: number; rowsCleared: number } {
  if (!hasTable(db, "overnight_watchlist")) return { daysCleared: 0, rowsCleared: 0 };
  try {
    const stale = db.prepare(
      "SELECT trading_day AS day, COUNT(*) AS n FROM overnight_watchlist WHERE trading_day <> ? GROUP BY trading_day",
    ).all(keepTradingDay) as Array<{ day: string; n: number }>;
    if (!stale.length) return { daysCleared: 0, rowsCleared: 0 };
    const res = db.prepare("DELETE FROM overnight_watchlist WHERE trading_day <> ?").run(keepTradingDay);
    if (hasTable(db, "overnight_plan_snapshots")) {
      db.prepare("DELETE FROM overnight_plan_snapshots WHERE trading_day <> ?").run(keepTradingDay);
    }
    return {
      daysCleared: stale.length,
      rowsCleared: Number(res.changes ?? stale.reduce((sum, r) => sum + Number(r.n ?? 0), 0)),
    };
  } catch {
    return { daysCleared: 0, rowsCleared: 0 };
  }
}

/**
 * The canonical planning job: record context, clear stale plans, then rebuild and
 * persist the current plan. Safe to run repeatedly.
 */
export async function runWatchlistPlanningJobOnDb(
  db: JobDb,
  deps: WatchlistPlanningDeps,
  planners: {
    buildNextSessionPlan: (db: JobDb, nowMs: number) => unknown;
    persistOvernightPlan: (db: JobDb, plan: unknown) => void;
  },
): Promise<WatchlistPlanningResult> {
  const nowMs = deps.now?.() ?? Date.now();
  const day = tradingDay(nowMs);
  const errors: string[] = [];

  const ctx = await recordNextSessionMarketContextOnDb(db, deps);
  if (ctx.error) errors.push(ctx.error);

  const cleared = clearStaleWatchlistPlansOnDb(db, day);

  try {
    const plan = planners.buildNextSessionPlan(db, nowMs);
    planners.persistOvernightPlan(db, plan);
  } catch (err: any) {
    errors.push(`plan:${err?.message}`);
  }

  return {
    ranAtMs: nowMs,
    tradingDay: day,
    contextRecorded: ctx.persisted,
    contextQuality: ctx.context.quality,
    contextUsableForPlanning: ctx.context.usableForPlanning,
    stalePlanDaysCleared: cleared.daysCleared,
    staleRowsCleared: cleared.rowsCleared,
    errors,
  };
}

/** Live provider-backed deps. Uses the existing metered candles path. */
export function liveWatchlistPlanningDeps(): WatchlistPlanningDeps {
  return {
    fetchBars: async (symbol: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { fetchCandles } = require("@/lib/polygon-provider");
      // 5 calendar days of 1-minute bars covers a completed session plus the
      // prior close across weekends and holidays.
      const res: any = await fetchCandles(symbol, { resolution: "1", timespan: "minute", days: 5 });
      return res?.available && Array.isArray(res.bars) ? (res.bars as ProviderBar[]) : null;
    },
  };
}
