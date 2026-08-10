/**
 * market-context.ts — market regime at a historical instant, DERIVED from stored bars.
 *
 * ── Why the store was empty ──────────────────────────────────────────────────
 *
 * `market_context_snapshots` had 0 rows in production, and the cause was not a broken
 * writer. `recordMarketContext` works; nothing scheduled ever calls it. Its only caller
 * is an on-demand HTTP route, so a snapshot exists only if somebody happens to load a
 * page. Meanwhile the scheduled watchlist job writes a DIFFERENT table
 * (`watchlist_market_context`, keyed by trading day), which is why regime never looked
 * missing from the product side.
 *
 * The fix is not to schedule the old writer. Regime at an INSTANT is what replay needs,
 * and a once-a-day snapshot cannot answer it for 09:47 on a Tuesday. This module
 * derives it from the durable bar store, at any instant, for any past date.
 *
 * ── Derived is not observed ──────────────────────────────────────────────────
 *
 *     origin = DERIVED_FROM_HISTORICAL_BARS
 *
 * A reconstruction and a live measurement are different claims, and once written to the
 * same table with the same shape they become indistinguishable. Every row states its
 * origin, and the primary key includes it, so a derived row can never silently overwrite
 * an observed one.
 *
 * Time-fenced exactly like the rest of replay: everything comes from
 * `replayUnderlyingStateOnDb`, which reads only bars at or before the instant.
 */
import { replayUnderlyingStateOnDb, sessionDateOf } from "./replay.ts";
import { sessionState } from "../options/session-state.ts";
import type { StoreDb } from "./store.ts";

export const HISTORICAL_CONTEXT_VERSION = "HIST_CONTEXT_V1" as const;

export type ContextOrigin = "DERIVED_FROM_HISTORICAL_BARS" | "OBSERVED_LIVE";

export interface HistoricalMarketContext {
  version: typeof HISTORICAL_CONTEXT_VERSION;
  origin: ContextOrigin;
  sessionDate: string | null;
  asOfMs: number;

  broadDirection: "RISK_ON" | "RISK_OFF" | "MIXED" | "UNKNOWN";
  spyTrend: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  qqqTrend: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  spyChangePct: number | null;
  qqqChangePct: number | null;
  spyAboveVwap: boolean | null;
  qqqAboveVwap: boolean | null;

  /** Session-to-date realized range on SPY, as a share of price. */
  volatilityState: "COMPRESSED" | "NORMAL" | "EXPANDED" | "UNKNOWN";
  trendState: "TRENDING" | "RANGING" | "UNKNOWN";
  sessionState: string;

  barsUsed: number;
  missing: string[];
  quality: "COMPLETE" | "PARTIAL" | "INSUFFICIENT";
  note: string;
}

/** Direction from a session-to-date percentage move. Thresholds are versioned with the module. */
export const CONTEXT_THRESHOLDS = {
  /** Below this absolute move the index is flat rather than trending. */
  flatPct: 0.15,
  /** Session-to-date range share below which the tape is compressed. */
  compressedRangePct: 0.4,
  /** ...and above which it is expanded. */
  expandedRangePct: 1.2,
} as const;

function trendOf(changePct: number | null): "UP" | "DOWN" | "FLAT" | "UNKNOWN" {
  if (changePct == null) return "UNKNOWN";
  if (Math.abs(changePct) < CONTEXT_THRESHOLDS.flatPct) return "FLAT";
  return changePct > 0 ? "UP" : "DOWN";
}

/**
 * Reconstruct market context at an instant from stored SPY/QQQ bars.
 *
 * Deliberately reports UNKNOWN rather than a neutral-looking default when the bars are
 * absent. "MIXED" and "UNKNOWN" are different findings: mixed means the indices
 * disagreed, unknown means we could not see them, and a cohort stratified on a regime
 * that silently means "no data" is stratified on nothing.
 */
export function deriveHistoricalMarketContext(
  db: StoreDb,
  asOfMs: number,
  opts: { spySymbol?: string; qqqSymbol?: string; timeframe?: "1m" | "5m" | "1d"; env?: NodeJS.ProcessEnv } = {},
): HistoricalMarketContext {
  const missing: string[] = [];
  const tf = opts.timeframe ?? "1m";
  const spy = replayUnderlyingStateOnDb(db, opts.spySymbol ?? "SPY", asOfMs, { timeframe: tf });
  const qqq = replayUnderlyingStateOnDb(db, opts.qqqSymbol ?? "QQQ", asOfMs, { timeframe: tf });

  const pctFromOpen = (s: typeof spy): number | null =>
    s.price != null && s.sessionOpen != null && s.sessionOpen > 0
      ? +(((s.price - s.sessionOpen) / s.sessionOpen) * 100).toFixed(4)
      : null;

  const spyChangePct = pctFromOpen(spy);
  const qqqChangePct = pctFromOpen(qqq);
  if (spyChangePct == null) missing.push("spy");
  if (qqqChangePct == null) missing.push("qqq");

  const spyTrend = trendOf(spyChangePct);
  const qqqTrend = trendOf(qqqChangePct);

  let broadDirection: HistoricalMarketContext["broadDirection"] = "UNKNOWN";
  if (spyTrend !== "UNKNOWN" && qqqTrend !== "UNKNOWN") {
    if (spyTrend === "UP" && qqqTrend === "UP") broadDirection = "RISK_ON";
    else if (spyTrend === "DOWN" && qqqTrend === "DOWN") broadDirection = "RISK_OFF";
    else broadDirection = "MIXED";
  }

  // Volatility from SPY's session-to-date range. Session-to-date, not the day's final
  // range — the same fence as everywhere else in replay.
  let volatilityState: HistoricalMarketContext["volatilityState"] = "UNKNOWN";
  const spyRangePct = spy.sessionHigh != null && spy.sessionLow != null && spy.price
    ? ((spy.sessionHigh - spy.sessionLow) / spy.price) * 100
    : null;
  if (spyRangePct == null) missing.push("volatility");
  else if (spyRangePct < CONTEXT_THRESHOLDS.compressedRangePct) volatilityState = "COMPRESSED";
  else if (spyRangePct > CONTEXT_THRESHOLDS.expandedRangePct) volatilityState = "EXPANDED";
  else volatilityState = "NORMAL";

  // Trending vs ranging: how much of the session's range the net move actually captured.
  let trendState: HistoricalMarketContext["trendState"] = "UNKNOWN";
  if (spyRangePct != null && spyRangePct > 0 && spyChangePct != null) {
    trendState = Math.abs(spyChangePct) / spyRangePct >= 0.5 ? "TRENDING" : "RANGING";
  } else {
    missing.push("trendState");
  }

  let session = "UNKNOWN";
  try { session = String(sessionState(asOfMs, opts.env ?? process.env)); } catch { /* stays UNKNOWN */ }

  const barsUsed = spy.barsUsed + qqq.barsUsed;
  const quality: HistoricalMarketContext["quality"] = missing.length === 0
    ? "COMPLETE"
    : broadDirection !== "UNKNOWN"
      ? "PARTIAL"
      : "INSUFFICIENT";

  return {
    version: HISTORICAL_CONTEXT_VERSION,
    origin: "DERIVED_FROM_HISTORICAL_BARS",
    sessionDate: sessionDateOf(asOfMs),
    asOfMs,
    broadDirection, spyTrend, qqqTrend, spyChangePct, qqqChangePct,
    spyAboveVwap: spy.aboveVwap, qqqAboveVwap: qqq.aboveVwap,
    volatilityState, trendState, sessionState: session,
    barsUsed, missing, quality,
    note:
      "DERIVED from stored bars at or before this instant — a reconstruction, not a live "
      + "observation. UNKNOWN means the bars were absent; MIXED means the indices disagreed. "
      + "They are different findings and are never collapsed.",
  };
}

function hasTable(db: StoreDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name));
  } catch {
    return false;
  }
}

/**
 * Persist a context row. The primary key includes `origin`, so a derived row and an
 * observed row for the same instant coexist rather than one silently replacing the
 * other — which is the only way a later audit can tell a reconstruction from a
 * measurement.
 */
export function persistHistoricalMarketContextOnDb(
  db: StoreDb,
  ctx: HistoricalMarketContext,
  nowMs: number,
): boolean {
  if (!hasTable(db, "historical_market_context")) return false;
  try {
    db.prepare(
      `INSERT INTO historical_market_context
         (session_date, as_of_ms, context_version, origin, broad_direction, spy_trend, qqq_trend,
          spy_change_pct, qqq_change_pct, spy_above_vwap, qqq_above_vwap,
          volatility_state, trend_state, session_state, bars_used, missing_fields_json,
          quality, ingest_version, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_date, as_of_ms, origin) DO UPDATE SET
         broad_direction=excluded.broad_direction, spy_trend=excluded.spy_trend,
         qqq_trend=excluded.qqq_trend, spy_change_pct=excluded.spy_change_pct,
         qqq_change_pct=excluded.qqq_change_pct, spy_above_vwap=excluded.spy_above_vwap,
         qqq_above_vwap=excluded.qqq_above_vwap, volatility_state=excluded.volatility_state,
         trend_state=excluded.trend_state, session_state=excluded.session_state,
         bars_used=excluded.bars_used, missing_fields_json=excluded.missing_fields_json,
         quality=excluded.quality, created_at_ms=excluded.created_at_ms`,
    ).run?.(
      ctx.sessionDate, ctx.asOfMs, ctx.version, ctx.origin,
      ctx.broadDirection, ctx.spyTrend, ctx.qqqTrend,
      ctx.spyChangePct, ctx.qqqChangePct,
      ctx.spyAboveVwap == null ? null : (ctx.spyAboveVwap ? 1 : 0),
      ctx.qqqAboveVwap == null ? null : (ctx.qqqAboveVwap ? 1 : 0),
      ctx.volatilityState, ctx.trendState, ctx.sessionState,
      ctx.barsUsed, JSON.stringify(ctx.missing), ctx.quality,
      HISTORICAL_CONTEXT_VERSION, nowMs,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the context in force at an instant.
 *
 * Prefers an OBSERVED_LIVE row over a DERIVED one for the same moment: a measurement
 * beats a reconstruction when both exist. Never reads forward.
 */
export function readHistoricalMarketContextOnDb(
  db: StoreDb,
  asOfMs: number,
  opts: { maxAgeMs?: number } = {},
): HistoricalMarketContext | null {
  if (!hasTable(db, "historical_market_context")) return null;
  const maxAge = Math.max(60_000, opts.maxAgeMs ?? 6 * 3600_000);
  try {
    const r = db.prepare(
      `SELECT * FROM historical_market_context
        WHERE as_of_ms <= ? AND as_of_ms >= ?
        ORDER BY as_of_ms DESC,
                 CASE origin WHEN 'OBSERVED_LIVE' THEN 0 ELSE 1 END ASC
        LIMIT 1`,
    ).get?.(asOfMs, asOfMs - maxAge);
    if (!r) return null;
    let missing: string[] = [];
    try { missing = r.missing_fields_json ? JSON.parse(r.missing_fields_json) : []; } catch { missing = []; }
    return {
      version: HISTORICAL_CONTEXT_VERSION,
      origin: String(r.origin) as ContextOrigin,
      sessionDate: r.session_date == null ? null : String(r.session_date),
      asOfMs: Number(r.as_of_ms),
      broadDirection: String(r.broad_direction ?? "UNKNOWN") as HistoricalMarketContext["broadDirection"],
      spyTrend: String(r.spy_trend ?? "UNKNOWN") as HistoricalMarketContext["spyTrend"],
      qqqTrend: String(r.qqq_trend ?? "UNKNOWN") as HistoricalMarketContext["qqqTrend"],
      spyChangePct: r.spy_change_pct == null ? null : Number(r.spy_change_pct),
      qqqChangePct: r.qqq_change_pct == null ? null : Number(r.qqq_change_pct),
      spyAboveVwap: r.spy_above_vwap == null ? null : Number(r.spy_above_vwap) === 1,
      qqqAboveVwap: r.qqq_above_vwap == null ? null : Number(r.qqq_above_vwap) === 1,
      volatilityState: String(r.volatility_state ?? "UNKNOWN") as HistoricalMarketContext["volatilityState"],
      trendState: String(r.trend_state ?? "UNKNOWN") as HistoricalMarketContext["trendState"],
      sessionState: String(r.session_state ?? "UNKNOWN"),
      barsUsed: Number(r.bars_used ?? 0),
      missing: Array.isArray(missing) ? missing : [],
      quality: String(r.quality ?? "INSUFFICIENT") as HistoricalMarketContext["quality"],
      note: "read from historical_market_context",
    };
  } catch {
    return null;
  }
}
