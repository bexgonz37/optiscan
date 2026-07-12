/**
 * market-context.ts — deterministic, versioned Market Context engine.
 *
 * PURE: no I/O. Given verified, freshness-checked index reads it produces a
 * versioned context snapshot for strategy agents and (later) prediction models.
 *
 * HONESTY RULES (non-negotiable):
 *  - Any dimension without real, fresh supporting data is `UNKNOWN` with a
 *    reason code. UNKNOWN never masquerades as bullish or bearish confirmation.
 *  - The legacy, mislabeled `market_regime` value is NOT trusted here.
 *  - Nothing is fabricated; a stale or missing quote degrades to UNKNOWN.
 *
 * Versioned: `MARKET_CONTEXT_VERSION` is stamped on every snapshot. A logic
 * change bumps it. (Fingerprints are NOT expanded with these fields — a future
 * fingerprint schema change requires its own new fingerprint version.)
 */
export const MARKET_CONTEXT_VERSION = 1;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export type TrendState = "UP" | "DOWN" | "FLAT" | "UNKNOWN";
export type RiskState = "RISK_ON" | "RISK_OFF" | "MIXED" | "UNKNOWN";
export type StructureState = "TRENDING" | "CHOPPY" | "UNKNOWN";
export type VolBucket = "LOW" | "ELEVATED" | "HIGH" | "UNKNOWN";
export type VwapState = "ABOVE" | "BELOW" | "UNKNOWN";
export type Freshness = "FRESH" | "STALE" | "UNKNOWN";

/** One verified index read. `freshnessOk=false` ⇒ the quote is not trustworthy. */
export interface IndexRead {
  symbol: string;
  changePercent: number | null;
  aboveVwap: boolean | null;
  freshnessOk: boolean;
}

export interface MarketContextInput {
  session: string;
  spy: IndexRead | null;
  qqq: IndexRead | null;
  /** Optional volatility proxy (e.g. VIX). Null ⇒ volatility UNKNOWN. */
  vix?: number | null;
  nowMs: number;
  trendThresholdPct?: number;
}

export interface MarketContext {
  contextVersion: number;
  session: string;
  spyTrend: TrendState;
  qqqTrend: TrendState;
  vwapState: VwapState;      // SPY vs its VWAP (index reference)
  riskState: RiskState;
  structure: StructureState;
  volatility: VolBucket;
  freshness: Freshness;
  conflictFlags: string[];
  reasons: string[];
  at: number;
}

function trendOf(read: IndexRead | null, thr: number, reasons: string[], label: string): TrendState {
  if (!read) { reasons.push(`${label}_missing`); return "UNKNOWN"; }
  if (!read.freshnessOk) { reasons.push(`${label}_stale`); return "UNKNOWN"; }
  if (!isNum(read.changePercent)) { reasons.push(`${label}_no_change`); return "UNKNOWN"; }
  if (read.changePercent > thr) return "UP";
  if (read.changePercent < -thr) return "DOWN";
  return "FLAT";
}

function riskFrom(spy: TrendState, qqq: TrendState, flags: string[]): RiskState {
  if (spy === "UNKNOWN" || qqq === "UNKNOWN") return "UNKNOWN";
  if (spy === "UP" && qqq === "UP") return "RISK_ON";
  if (spy === "DOWN" && qqq === "DOWN") return "RISK_OFF";
  if ((spy === "UP" && qqq === "DOWN") || (spy === "DOWN" && qqq === "UP")) {
    flags.push("spy_qqq_direction_conflict");
    return "MIXED";
  }
  return "MIXED"; // one/both FLAT
}

function structureFrom(spyTrend: TrendState, spy: IndexRead | null, vwap: VwapState, flags: string[]): StructureState {
  if (spyTrend === "UNKNOWN") return "UNKNOWN";
  if (spyTrend === "FLAT") return "CHOPPY";
  // Trending only when the VWAP relationship agrees with the day's direction.
  if (vwap === "UNKNOWN") return "UNKNOWN";
  const agrees = (spyTrend === "UP" && vwap === "ABOVE") || (spyTrend === "DOWN" && vwap === "BELOW");
  if (!agrees) { flags.push("trend_vwap_conflict"); return "CHOPPY"; }
  return "TRENDING";
}

function volFrom(vix: number | null | undefined, reasons: string[]): VolBucket {
  if (!isNum(vix)) { reasons.push("volatility_unknown"); return "UNKNOWN"; }
  if (vix < 15) return "LOW";
  if (vix < 25) return "ELEVATED";
  return "HIGH";
}

function freshnessFrom(spy: IndexRead | null, qqq: IndexRead | null): Freshness {
  const reads = [spy, qqq].filter((r): r is IndexRead => r != null);
  if (!reads.length) return "UNKNOWN";
  if (reads.some((r) => !r.freshnessOk)) return "STALE";
  return "FRESH";
}

/** Build the deterministic, versioned market context. UNKNOWN when unproven. */
export function buildMarketContext(input: MarketContextInput): MarketContext {
  const thr = isNum(input.trendThresholdPct) ? input.trendThresholdPct : 0.3;
  const reasons: string[] = [];
  const conflictFlags: string[] = [];

  const spyTrend = trendOf(input.spy, thr, reasons, "spy");
  const qqqTrend = trendOf(input.qqq, thr, reasons, "qqq");

  let vwapState: VwapState = "UNKNOWN";
  if (input.spy && input.spy.freshnessOk && input.spy.aboveVwap != null) {
    vwapState = input.spy.aboveVwap ? "ABOVE" : "BELOW";
  } else {
    reasons.push("spy_vwap_unknown");
  }

  const riskState = riskFrom(spyTrend, qqqTrend, conflictFlags);
  const structure = structureFrom(spyTrend, input.spy, vwapState, conflictFlags);
  const volatility = volFrom(input.vix ?? null, reasons);
  const freshness = freshnessFrom(input.spy, input.qqq);
  if (freshness === "STALE") conflictFlags.push("stale_index_data");

  return {
    contextVersion: MARKET_CONTEXT_VERSION,
    session: input.session,
    spyTrend,
    qqqTrend,
    vwapState,
    riskState,
    structure,
    volatility,
    freshness,
    conflictFlags,
    reasons,
    at: input.nowMs,
  };
}

/** True when the context is trustworthy enough to condition a decision on. */
export function contextIsUsable(ctx: MarketContext): boolean {
  return ctx.freshness === "FRESH" && ctx.riskState !== "UNKNOWN";
}
