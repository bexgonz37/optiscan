/**
 * Mark-to-market policy for brokerage V2 (B3).
 *
 * PRINCIPLES
 * - Never fabricate a price from a missing or unusable quote.
 * - Prefer conservative marks for long option inventory (toward the bid).
 * - Incomplete marks must surface as completeness status — never silently inflate equity.
 * - Append-only: marks and equity snapshots are immutable once written.
 *
 * ENTRY VALUATION
 * - Long option / equity BUY fills value inventory at the fill price (premium per share
 *   for options). Contract multiplier converts to dollar notional (×100 for options).
 *
 * OPEN-POSITION MARK SOURCE
 * - Primary: two-sided quote (bid+ask).
 * - Long inventory mark: conservativeExitMark = mid - (mid-bid)*slipFraction (default 0.6).
 * - Short inventory mark: conservative toward ask.
 * - Equity shares: midpoint when two-sided; otherwise last trade if provided and fresh.
 *
 * BID / ASK / MIDPOINT
 * - Mid = (bid+ask)/2 when both > 0.
 * - If only one side is present, mark is INCOMPLETE (do not invent the other side).
 *
 * STALE QUOTES
 * - quoteAgeMs > maxQuoteAgeMs ⇒ STALE. Last good mark may be retained only if
 *   retainStaleMarks=true AND age ≤ maxStaleRetainMs; otherwise mark is unusable.
 *
 * SPREAD HANDLING
 * - spreadPct = (ask-bid)/mid*100. If spreadPct > maxSpreadPct, mark is WIDE_SPREAD
 *   and completeness is INCOMPLETE (value still computed but flagged).
 *
 * MARKET CLOSED
 * - Use last usable mark if not stale beyond maxStaleRetainMs; else MISSING.
 *
 * EXPIRATION
 * - At/after expiration cutoff: if a fresh quote exists, mark normally; if no quote,
 *   WORTHLESS ⇒ markPrice=0 (honest zero, not a fabricated mid).
 *
 * MISSING QUOTE
 * - markPrice=null, status=MISSING. Equity snapshots must set completeness≠COMPLETE
 *   and must NOT treat missing marks as last-known-good without an explicit retain policy.
 */

export const MARK_POLICY_VERSION = 1;

export type MarkStatus =
  | "OK"
  | "STALE"
  | "WIDE_SPREAD"
  | "MISSING"
  | "WORTHLESS"
  | "ONE_SIDED"
  | "MARKET_CLOSED";

export interface MarkPolicyConfig {
  slipFraction: number;
  maxQuoteAgeMs: number;
  maxStaleRetainMs: number;
  maxSpreadPct: number;
  retainStaleMarks: boolean;
}

export function defaultMarkPolicyConfig(env: NodeJS.ProcessEnv = process.env): MarkPolicyConfig {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  };
  return {
    slipFraction: Math.min(1, Math.max(0, n(env.BROKER_V2_MARK_SLIP_FRACTION, 0.6))),
    maxQuoteAgeMs: n(env.BROKER_V2_MARK_MAX_QUOTE_AGE_MS, 900_000),
    maxStaleRetainMs: n(env.BROKER_V2_MARK_MAX_STALE_RETAIN_MS, 3_600_000),
    maxSpreadPct: n(env.BROKER_V2_MARK_MAX_SPREAD_PCT, 40),
    retainStaleMarks: env.BROKER_V2_MARK_RETAIN_STALE === "1",
  };
}

export interface QuoteInput {
  bid: number | null;
  ask: number | null;
  last?: number | null;
  quoteAgeMs?: number | null;
  asOfMs?: number | null;
  marketOpen?: boolean;
  expired?: boolean;
}

export interface MarkDecision {
  markPrice: number | null;
  status: MarkStatus;
  usable: boolean;
  mid: number | null;
  spreadPct: number | null;
  policyVersion: number;
  reason: string;
}

function spreadPct(bid: number, ask: number): number | null {
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 100 : null;
}

/** Conservative long-inventory mark (sell toward bid). */
export function conservativeLongMark(bid: number, ask: number, slipFraction: number): number {
  const mid = (bid + ask) / 2;
  return +(mid - (mid - bid) * slipFraction).toFixed(4);
}

/** Conservative short-inventory mark (cover toward ask). */
export function conservativeShortMark(bid: number, ask: number, slipFraction: number): number {
  const mid = (bid + ask) / 2;
  return +(mid + (ask - mid) * slipFraction).toFixed(4);
}

/**
 * Decide a mark for an open position. Never invents prices from thin air.
 * @param side LONG uses sell-side conservatism; SHORT uses buy-side.
 */
export function decideMark(
  quote: QuoteInput | null,
  side: "LONG" | "SHORT" = "LONG",
  cfg: MarkPolicyConfig = defaultMarkPolicyConfig(),
): MarkDecision {
  const base = {
    mid: null as number | null,
    spreadPct: null as number | null,
    policyVersion: MARK_POLICY_VERSION,
  };

  if (quote?.expired) {
    const bid = quote.bid;
    const ask = quote.ask;
    if (bid != null && bid > 0 && ask != null && ask > 0) {
      const mark =
        side === "LONG"
          ? conservativeLongMark(bid, ask, cfg.slipFraction)
          : conservativeShortMark(bid, ask, cfg.slipFraction);
      return {
        ...base,
        markPrice: mark,
        status: "OK",
        usable: true,
        mid: (bid + ask) / 2,
        spreadPct: spreadPct(bid, ask),
        reason: "expired with usable two-sided quote",
      };
    }
    return {
      ...base,
      markPrice: 0,
      status: "WORTHLESS",
      usable: true,
      reason: "expired with no usable quote — marked worthless at 0",
    };
  }

  if (!quote) {
    return { ...base, markPrice: null, status: "MISSING", usable: false, reason: "no quote" };
  }

  if (quote.marketOpen === false) {
    const age = quote.quoteAgeMs;
    if (
      cfg.retainStaleMarks &&
      age != null &&
      age <= cfg.maxStaleRetainMs &&
      quote.bid != null &&
      quote.ask != null &&
      quote.bid > 0 &&
      quote.ask > 0
    ) {
      const mark =
        side === "LONG"
          ? conservativeLongMark(quote.bid, quote.ask, cfg.slipFraction)
          : conservativeShortMark(quote.bid, quote.ask, cfg.slipFraction);
      return {
        ...base,
        markPrice: mark,
        status: "MARKET_CLOSED",
        usable: true,
        mid: (quote.bid + quote.ask) / 2,
        spreadPct: spreadPct(quote.bid, quote.ask),
        reason: "market closed — retained last usable quote within retain window",
      };
    }
    return {
      ...base,
      markPrice: null,
      status: "MARKET_CLOSED",
      usable: false,
      reason: "market closed and no retainable quote",
    };
  }

  const bid = quote.bid;
  const ask = quote.ask;
  const oneSided =
    (bid != null && bid > 0 && (ask == null || !(ask > 0))) ||
    (ask != null && ask > 0 && (bid == null || !(bid > 0)));
  if (oneSided) {
    return {
      ...base,
      markPrice: null,
      status: "ONE_SIDED",
      usable: false,
      reason: "one-sided quote — refusing to invent the other side",
    };
  }

  if (bid == null || !(bid > 0) || ask == null || !(ask > 0)) {
    if (quote.last != null && quote.last > 0) {
      const age = quote.quoteAgeMs;
      if (age != null && age > cfg.maxQuoteAgeMs) {
        return {
          ...base,
          markPrice: null,
          status: "STALE",
          usable: false,
          reason: "last-trade mark is stale",
        };
      }
      return {
        ...base,
        markPrice: +quote.last.toFixed(4),
        status: "OK",
        usable: true,
        reason: "last-trade fallback (no two-sided book)",
      };
    }
    return { ...base, markPrice: null, status: "MISSING", usable: false, reason: "missing bid/ask" };
  }

  const mid = (bid + ask) / 2;
  const sp = spreadPct(bid, ask);
  const age = quote.quoteAgeMs;
  if (age != null && age > cfg.maxQuoteAgeMs) {
    if (cfg.retainStaleMarks && age <= cfg.maxStaleRetainMs) {
      const mark =
        side === "LONG"
          ? conservativeLongMark(bid, ask, cfg.slipFraction)
          : conservativeShortMark(bid, ask, cfg.slipFraction);
      return {
        ...base,
        markPrice: mark,
        status: "STALE",
        usable: true,
        mid,
        spreadPct: sp,
        reason: "stale quote retained within retain window",
      };
    }
    return {
      ...base,
      markPrice: null,
      status: "STALE",
      usable: false,
      mid,
      spreadPct: sp,
      reason: "stale quote — not usable for equity",
    };
  }

  const mark =
    side === "LONG"
      ? conservativeLongMark(bid, ask, cfg.slipFraction)
      : conservativeShortMark(bid, ask, cfg.slipFraction);

  if (sp != null && sp > cfg.maxSpreadPct) {
    return {
      ...base,
      markPrice: mark,
      status: "WIDE_SPREAD",
      usable: true,
      mid,
      spreadPct: sp,
      reason: `wide spread ${sp.toFixed(1)}% > ${cfg.maxSpreadPct}% — flagged incomplete`,
    };
  }

  return {
    ...base,
    markPrice: mark,
    status: "OK",
    usable: true,
    mid,
    spreadPct: sp,
    reason: "fresh two-sided quote",
  };
}

export function contractMultiplier(assetClass: string, override?: number | null): number {
  if (override != null && Number.isFinite(override) && override > 0) return override;
  return assetClass === "OPTION" ? 100 : 1;
}
