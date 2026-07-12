/**
 * market-context-store.ts — gather + persist the market context.
 *
 * Gathering reuses the EXISTING scanner tape (no new provider calls; all live
 * data already flows through the metered `polyFetch`). Index dimensions activate
 * ONLY when SPY/QQQ are present AND fresh — otherwise the context is honestly
 * UNKNOWN. The pure engine (market-context.ts) makes every decision.
 *
 * The `*OnDb` core takes a better-sqlite3 handle so it is unit-testable; the
 * public wrappers resolve runtime singletons lazily.
 */
import { buildMarketContext, MARKET_CONTEXT_VERSION, type IndexRead, type MarketContext } from "./market-context.ts";

/** Read one index symbol from the live scanner tape (existing data path). */
function indexReadFromTape(symbol: string): IndexRead | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loopState } = require("@/lib/scanner-loop");
    const row = (loopState().tape ?? loopState().movers ?? []).find((r: any) => r.symbol === symbol);
    if (!row) return null;
    let freshnessOk = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { actionableFreshness } = require("@/lib/data-freshness");
      freshnessOk = Boolean(actionableFreshness(symbol, ["stock_quote"])?.ok);
    } catch {
      freshnessOk = false; // cannot verify freshness ⇒ do not trust it
    }
    const changePercent = typeof row.changePercent === "number" ? row.changePercent : null;
    const aboveVwap = row.aboveVwap == null ? null : Boolean(row.aboveVwap);
    return { symbol, changePercent, aboveVwap, freshnessOk };
  } catch {
    return null;
  }
}

function vixProxy(): number | null {
  // No trustworthy VIX feed is wired; volatility stays UNKNOWN rather than guessed.
  return null;
}

/** Build the current market context from live, freshness-checked index reads. */
export function buildCurrentMarketContext(nowMs: number = Date.now()): MarketContext {
  let session = "regular";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { marketSession } = require("@/lib/trading-session");
    session = marketSession(nowMs);
  } catch { /* default */ }
  return buildMarketContext({
    session,
    spy: indexReadFromTape("SPY"),
    qqq: indexReadFromTape("QQQ"),
    vix: vixProxy(),
    nowMs,
  });
}

/** Persist a context snapshot (never mutates prior rows). */
export function persistMarketContextOnDb(db: any, ctx: MarketContext, nowMs: number): number {
  const info = db.prepare(
    `INSERT INTO market_context_snapshots
       (context_version, session, risk_state, structure, volatility, freshness,
        spy_trend, qqq_trend, vwap_state, conflict_flags, context_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    ctx.contextVersion, ctx.session, ctx.riskState, ctx.structure, ctx.volatility, ctx.freshness,
    ctx.spyTrend, ctx.qqqTrend, ctx.vwapState, JSON.stringify(ctx.conflictFlags), JSON.stringify(ctx), nowMs,
  );
  return Number(info.lastInsertRowid);
}

function lazyDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  return getDb();
}

/** Build the current context and persist the snapshot. Returns the context + id. */
export function recordMarketContext(nowMs: number = Date.now()): { context: MarketContext; snapshotId: number | null } {
  const context = buildCurrentMarketContext(nowMs);
  try {
    const id = persistMarketContextOnDb(lazyDb(), context, nowMs);
    return { context, snapshotId: id };
  } catch (err: any) {
    console.warn("[market-context] persist skipped:", err?.message);
    return { context, snapshotId: null };
  }
}

/** The most recent persisted context snapshot, or null. */
export function latestMarketContext(): MarketContext | null {
  try {
    const r = lazyDb().prepare("SELECT context_json FROM market_context_snapshots ORDER BY id DESC LIMIT 1").get() as any;
    return r ? (JSON.parse(r.context_json) as MarketContext) : null;
  } catch {
    return null;
  }
}

export { MARKET_CONTEXT_VERSION };
