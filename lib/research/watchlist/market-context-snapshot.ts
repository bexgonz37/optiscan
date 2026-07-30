/**
 * market-context-snapshot.ts — deterministic, persisted market context for
 * next-session Watchlist planning.
 *
 * The live context engine (lib/market-context.ts) reads the running scanner tape,
 * so it is UNKNOWN overnight — exactly when Watchlist planning needs it. This
 * module derives context from completed session candles instead, which are
 * available after the close and produce the same answer every time they are run.
 *
 * HONESTY RULES:
 *  - Nothing is inferred from a missing index. One absent index degrades the
 *    broad direction to UNAVAILABLE rather than guessing from the other.
 *  - No AI, no narrative generation, no heuristic "probably bullish". Every
 *    state is a pure function of prior close / high / low / VWAP.
 *  - Quality status is reported, not hidden: a partial snapshot stays partial.
 */

export type ContextDirection = "BULLISH" | "BEARISH" | "MIXED" | "NEUTRAL" | "UNAVAILABLE";
export type ContextQuality = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
export type RelativeStrength = "QQQ_STRONGER" | "SPY_STRONGER" | "IN_LINE" | "UNAVAILABLE";

/** Default band (in %) inside which a session close is treated as directionless. */
export const DEFAULT_NEUTRAL_BAND_PCT = 0.25;

/** One index's completed prior session, derived from candles. */
export interface IndexSession {
  symbol: string;
  priorClose: number | null;
  priorHigh: number | null;
  priorLow: number | null;
  vwap: number | null;
  /** Close of the session BEFORE priorClose — the change denominator. */
  previousClose: number | null;
  tradingDay: string | null;
  asOfMs: number | null;
  source: string | null;
}

export interface IndexContext {
  symbol: string;
  direction: ContextDirection;
  changePct: number | null;
  priorClose: number | null;
  priorHigh: number | null;
  priorLow: number | null;
  vwap: number | null;
  /** Whether the prior close finished above its own session VWAP. */
  closedAboveVwap: boolean | null;
  tradingDay: string | null;
  asOfMs: number | null;
  source: string | null;
  quality: ContextQuality;
  reasons: string[];
}

export interface NextSessionMarketContext {
  contextVersion: number;
  tradingDay: string;
  builtAtMs: number;
  spy: IndexContext;
  qqq: IndexContext;
  broadDirection: ContextDirection;
  relativeStrength: RelativeStrength;
  freshness: string;
  dataSource: string;
  quality: ContextQuality;
  /** True only when both indices are COMPLETE and the broad direction is real. */
  usableForPlanning: boolean;
  spyNote: string;
  qqqNote: string;
  reasons: string[];
}

export const NEXT_SESSION_CONTEXT_VERSION = 1;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function unavailableIndex(symbol: string, reason: string): IndexContext {
  return {
    symbol,
    direction: "UNAVAILABLE",
    changePct: null,
    priorClose: null,
    priorHigh: null,
    priorLow: null,
    vwap: null,
    closedAboveVwap: null,
    tradingDay: null,
    asOfMs: null,
    source: null,
    quality: "UNAVAILABLE",
    reasons: [reason],
  };
}

/** Classify one index's completed session. Pure. */
export function indexContextFromSession(
  session: IndexSession | null,
  neutralBandPct: number = DEFAULT_NEUTRAL_BAND_PCT,
): IndexContext {
  if (!session) return unavailableIndex("UNKNOWN", "index_session_missing");
  const symbol = session.symbol.toUpperCase();
  if (!isNum(session.priorClose) || session.priorClose <= 0) {
    return unavailableIndex(symbol, "prior_close_missing");
  }
  const reasons: string[] = [];
  const changePct = isNum(session.previousClose) && session.previousClose > 0
    ? +(((session.priorClose - session.previousClose) / session.previousClose) * 100).toFixed(4)
    : null;
  if (changePct == null) reasons.push("previous_close_missing");

  let direction: ContextDirection;
  if (changePct == null) {
    direction = "UNAVAILABLE";
  } else if (changePct > neutralBandPct) {
    direction = "BULLISH";
  } else if (changePct < -neutralBandPct) {
    direction = "BEARISH";
  } else {
    direction = "NEUTRAL";
  }

  const vwap = isNum(session.vwap) && session.vwap > 0 ? session.vwap : null;
  if (vwap == null) reasons.push("session_vwap_unavailable");
  const priorHigh = isNum(session.priorHigh) ? session.priorHigh : null;
  const priorLow = isNum(session.priorLow) ? session.priorLow : null;
  if (priorHigh == null || priorLow == null) reasons.push("session_range_incomplete");

  // COMPLETE requires a real direction AND the levels a plan would reference.
  const quality: ContextQuality = direction === "UNAVAILABLE"
    ? "UNAVAILABLE"
    : (vwap != null && priorHigh != null && priorLow != null) ? "COMPLETE" : "PARTIAL";

  return {
    symbol,
    direction,
    changePct,
    priorClose: session.priorClose,
    priorHigh,
    priorLow,
    vwap,
    closedAboveVwap: vwap == null ? null : session.priorClose >= vwap,
    tradingDay: session.tradingDay,
    asOfMs: session.asOfMs,
    source: session.source,
    quality,
    reasons,
  };
}

function broadFrom(spy: IndexContext, qqq: IndexContext, reasons: string[]): ContextDirection {
  if (spy.direction === "UNAVAILABLE" || qqq.direction === "UNAVAILABLE") {
    reasons.push("broad_direction_requires_both_indices");
    return "UNAVAILABLE";
  }
  if (spy.direction === qqq.direction) return spy.direction;
  const opposed = (spy.direction === "BULLISH" && qqq.direction === "BEARISH")
    || (spy.direction === "BEARISH" && qqq.direction === "BULLISH");
  if (opposed) {
    reasons.push("spy_qqq_direction_conflict");
    return "MIXED";
  }
  return "MIXED"; // one directional, one neutral
}

function relativeFrom(spy: IndexContext, qqq: IndexContext, bandPct: number): RelativeStrength {
  if (!isNum(spy.changePct) || !isNum(qqq.changePct)) return "UNAVAILABLE";
  const delta = qqq.changePct - spy.changePct;
  if (delta > bandPct) return "QQQ_STRONGER";
  if (delta < -bandPct) return "SPY_STRONGER";
  return "IN_LINE";
}

function note(index: IndexContext): string {
  if (index.direction === "UNAVAILABLE" || index.priorClose == null) {
    return `${index.symbol} context unavailable`;
  }
  const parts = [`${index.symbol} ${index.direction.toLowerCase()}`];
  if (index.changePct != null) parts.push(`${index.changePct >= 0 ? "+" : ""}${index.changePct.toFixed(2)}%`);
  parts.push(`prior close $${index.priorClose.toFixed(2)}`);
  if (index.vwap != null) {
    parts.push(`${index.closedAboveVwap ? "closed above" : "closed below"} session VWAP $${index.vwap.toFixed(2)}`);
  }
  return parts.join(" · ");
}

/** Build the deterministic next-session context from two completed sessions. Pure. */
export function buildNextSessionMarketContext(input: {
  tradingDay: string;
  builtAtMs: number;
  spy: IndexSession | null;
  qqq: IndexSession | null;
  neutralBandPct?: number;
  dataSource?: string;
}): NextSessionMarketContext {
  const band = input.neutralBandPct ?? DEFAULT_NEUTRAL_BAND_PCT;
  const spy = indexContextFromSession(input.spy, band);
  const qqq = indexContextFromSession(input.qqq, band);
  const reasons: string[] = [];
  const broadDirection = broadFrom(spy, qqq, reasons);
  const relativeStrength = relativeFrom(spy, qqq, band);

  const quality: ContextQuality = spy.quality === "COMPLETE" && qqq.quality === "COMPLETE"
    ? "COMPLETE"
    : (spy.quality === "UNAVAILABLE" && qqq.quality === "UNAVAILABLE") ? "UNAVAILABLE" : "PARTIAL";

  const sessionDays = [spy.tradingDay, qqq.tradingDay].filter(Boolean) as string[];
  const freshness = sessionDays.length
    ? `Completed session ${sessionDays[0]}`
    : "Unavailable";

  return {
    contextVersion: NEXT_SESSION_CONTEXT_VERSION,
    tradingDay: input.tradingDay,
    builtAtMs: input.builtAtMs,
    spy,
    qqq,
    broadDirection,
    relativeStrength,
    freshness,
    dataSource: input.dataSource ?? "session_candles_1m",
    quality,
    // Planning needs a real broad direction from two complete indices. MIXED is a
    // real reading and remains usable; UNAVAILABLE never is.
    usableForPlanning: quality === "COMPLETE" && broadDirection !== "UNAVAILABLE",
    spyNote: note(spy),
    qqqNote: note(qqq),
    reasons: [...reasons, ...spy.reasons.map((r) => `spy:${r}`), ...qqq.reasons.map((r) => `qqq:${r}`)],
  };
}

type ContextDb = {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => { changes?: number; lastInsertRowid?: number | bigint };
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
  };
};

/** Additive, repeat-safe schema for the persisted next-session context. */
export function ensureNextSessionContextSchema(db: ContextDb): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS watchlist_market_context (
      trading_day TEXT PRIMARY KEY,
      context_version INTEGER NOT NULL,
      broad_direction TEXT NOT NULL,
      relative_strength TEXT NOT NULL,
      spy_trend TEXT NOT NULL,
      qqq_trend TEXT NOT NULL,
      spy_prior_close REAL, spy_prior_high REAL, spy_prior_low REAL, spy_vwap REAL,
      qqq_prior_close REAL, qqq_prior_high REAL, qqq_prior_low REAL, qqq_vwap REAL,
      freshness TEXT NOT NULL,
      data_source TEXT NOT NULL,
      quality_status TEXT NOT NULL,
      usable_for_planning INTEGER NOT NULL,
      session_ms INTEGER,
      context_json TEXT NOT NULL,
      built_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    )
  `).run();
}

/**
 * Upsert the snapshot for its trading day. Keyed by day so re-running the job is
 * idempotent — a second run for the same session replaces, never duplicates.
 */
export function persistNextSessionContextOnDb(
  db: ContextDb,
  ctx: NextSessionMarketContext,
  nowMs: number,
): void {
  ensureNextSessionContextSchema(db);
  db.prepare(`
    INSERT INTO watchlist_market_context (
      trading_day, context_version, broad_direction, relative_strength, spy_trend, qqq_trend,
      spy_prior_close, spy_prior_high, spy_prior_low, spy_vwap,
      qqq_prior_close, qqq_prior_high, qqq_prior_low, qqq_vwap,
      freshness, data_source, quality_status, usable_for_planning, session_ms,
      context_json, built_at_ms, created_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(trading_day) DO UPDATE SET
      context_version=excluded.context_version,
      broad_direction=excluded.broad_direction,
      relative_strength=excluded.relative_strength,
      spy_trend=excluded.spy_trend,
      qqq_trend=excluded.qqq_trend,
      spy_prior_close=excluded.spy_prior_close,
      spy_prior_high=excluded.spy_prior_high,
      spy_prior_low=excluded.spy_prior_low,
      spy_vwap=excluded.spy_vwap,
      qqq_prior_close=excluded.qqq_prior_close,
      qqq_prior_high=excluded.qqq_prior_high,
      qqq_prior_low=excluded.qqq_prior_low,
      qqq_vwap=excluded.qqq_vwap,
      freshness=excluded.freshness,
      data_source=excluded.data_source,
      quality_status=excluded.quality_status,
      usable_for_planning=excluded.usable_for_planning,
      session_ms=excluded.session_ms,
      context_json=excluded.context_json,
      built_at_ms=excluded.built_at_ms
  `).run(
    ctx.tradingDay, ctx.contextVersion, ctx.broadDirection, ctx.relativeStrength,
    ctx.spy.direction, ctx.qqq.direction,
    ctx.spy.priorClose, ctx.spy.priorHigh, ctx.spy.priorLow, ctx.spy.vwap,
    ctx.qqq.priorClose, ctx.qqq.priorHigh, ctx.qqq.priorLow, ctx.qqq.vwap,
    ctx.freshness, ctx.dataSource, ctx.quality, ctx.usableForPlanning ? 1 : 0,
    ctx.spy.asOfMs ?? ctx.qqq.asOfMs ?? null,
    JSON.stringify(ctx), ctx.builtAtMs, nowMs,
  );
}

function hasTable(db: ContextDb, table: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  } catch {
    return false;
  }
}

/** Most recent persisted next-session context, or null when none exists. */
export function loadNextSessionContextOnDb(
  db: ContextDb,
  tradingDay?: string,
): NextSessionMarketContext | null {
  if (!hasTable(db, "watchlist_market_context")) return null;
  try {
    const row = (tradingDay
      ? db.prepare("SELECT context_json FROM watchlist_market_context WHERE trading_day=?").get(tradingDay)
      : db.prepare("SELECT context_json FROM watchlist_market_context ORDER BY built_at_ms DESC LIMIT 1").get()
    ) as { context_json?: string } | undefined;
    if (!row?.context_json) return null;
    return JSON.parse(row.context_json) as NextSessionMarketContext;
  } catch {
    return null;
  }
}

/** Bars as returned by the candles provider. */
export interface ProviderBar { t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown; v?: unknown }

const etDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/**
 * Reduce raw candles into the most recent COMPLETE session plus the close before
 * it. Pure so the derivation is testable without a provider.
 */
export function indexSessionFromBars(
  symbol: string,
  bars: ProviderBar[] | null | undefined,
  source = "session_candles_1m",
): IndexSession | null {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const clean = bars
    .filter((b) => isNum(Number(b.t)) && isNum(Number(b.c)))
    .map((b) => ({
      t: Number(b.t),
      h: isNum(Number(b.h)) ? Number(b.h) : Number(b.c),
      l: isNum(Number(b.l)) ? Number(b.l) : Number(b.c),
      c: Number(b.c),
      v: isNum(Number(b.v)) ? Number(b.v) : 0,
    }))
    .sort((a, b) => a.t - b.t);
  if (!clean.length) return null;

  const dayOf = (ms: number) => etDayFmt.format(new Date(ms));
  const lastDay = dayOf(clean[clean.length - 1].t);
  const sessionBars = clean.filter((b) => dayOf(b.t) === lastDay);
  if (!sessionBars.length) return null;

  let pv = 0;
  let vol = 0;
  let high = -Infinity;
  let low = Infinity;
  for (const b of sessionBars) {
    const typical = (b.h + b.l + b.c) / 3;
    pv += typical * b.v;
    vol += b.v;
    if (b.h > high) high = b.h;
    if (b.l < low) low = b.l;
  }
  const priorDayBars = clean.filter((b) => dayOf(b.t) !== lastDay);
  const previousClose = priorDayBars.length ? priorDayBars[priorDayBars.length - 1].c : null;

  return {
    symbol: symbol.toUpperCase(),
    priorClose: sessionBars[sessionBars.length - 1].c,
    priorHigh: Number.isFinite(high) ? +high.toFixed(4) : null,
    priorLow: Number.isFinite(low) ? +low.toFixed(4) : null,
    vwap: vol > 0 ? +(pv / vol).toFixed(4) : null,
    previousClose,
    tradingDay: lastDay,
    asOfMs: sessionBars[sessionBars.length - 1].t,
    source,
  };
}
