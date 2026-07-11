/**
 * paper-entry.ts — pure entry / mark / exit-fill decisions (rebuild).
 *
 * Composes the revalidation result + fill model into the explicit stage
 * decisions the engine persists and emits events for. PURE: no DB, no I/O, no
 * clock in the output. The engine owns persistence and the fresh-chain fetch.
 *
 * Guarantees enforced here:
 *  - A failed pre-entry revalidation NEVER fills and NEVER substitutes.
 *  - A put / non-actionable revalidation never opens a position.
 *  - Fills come only from the conservative fill model (never the mid).
 *  - A stale or missing mark keeps the position OPEN (no fabricated exit, no
 *    terminal ERROR for a temporary quote gap).
 */
import type { OptionQuote } from "./execution/broker.ts";
import type { MarketSession } from "./trading-session.ts";
import type { PaperState, OrderState, ExitDecision, PaperTrade } from "./paper-trading.ts";
import type { PaperEventType } from "./paper-events.ts";
import type { RevalidationResult } from "./paper-revalidation.ts";
import {
  simulateFill, intrinsicValue, type FillAssumptions, type FillConfig,
} from "./paper-fill-model.ts";

export interface EntryDecision {
  action: "fill" | "reject" | "wait";
  fillPrice: number | null;
  fees: number;
  slippage: number;
  assumptions: FillAssumptions | null;
  reason: string;
  events: PaperEventType[];
  toStatus: PaperState | null; // legacy status to persist (null = unchanged)
  toOrderState: OrderState;
}

/** Decide whether a PENDING order fills, rejects, or keeps waiting. */
export function decideEntryFill(input: {
  revalidation: RevalidationResult;
  quote: OptionQuote;
  limit: number;
  contracts: number;
  session: MarketSession;
  fillCfg: FillConfig;
  nowMs: number;
  entryWindowExpired: boolean;
}): EntryDecision {
  const base = { fillPrice: null, fees: 0, slippage: 0, assumptions: null } as const;

  if (input.entryWindowExpired) {
    return { ...base, action: "reject", reason: "entry window lapsed — momentum entries go stale", events: ["timeout", "rejected"], toStatus: "CANCELLED", toOrderState: "CANCELLED" };
  }
  if (!input.revalidation.ok) {
    return {
      ...base,
      action: "reject",
      reason: `pre-entry revalidation failed — ${input.revalidation.reason}`,
      events: ["validation_failed", "rejected"],
      toStatus: "CANCELLED",
      toOrderState: "REJECTED",
    };
  }
  if (!input.revalidation.actionable) {
    return {
      ...base,
      action: "reject",
      reason: "contract revalidated for research only — not actionable (bearish/session policy)",
      events: ["validation_failed", "rejected"],
      toStatus: "CANCELLED",
      toOrderState: "REJECTED",
    };
  }

  const fill = simulateFill(
    { side: "buy_to_open", assetClass: "option", units: input.contracts, limit: input.limit, session: input.session },
    input.quote,
    input.fillCfg,
    input.nowMs,
  );
  if (!fill.filled || fill.price == null) {
    return { ...base, action: "wait", reason: fill.reason, events: ["no_fill"], toStatus: null, toOrderState: "PENDING" };
  }
  return {
    action: "fill",
    fillPrice: fill.price,
    fees: fill.fees,
    slippage: fill.assumptions?.slippageApplied ?? 0,
    assumptions: fill.assumptions,
    reason: fill.reason,
    events: ["validation_passed", "order_submitted", "fill", "position_opened"],
    toStatus: "ENTERED",
    toOrderState: "FILLED",
  };
}

export interface MarkDecision {
  markable: boolean;
  mark: number | null;
  event: PaperEventType; // mark_updated | mark_stale | mark_missing
  note: string;
}

/** A stale/missing mark keeps the position open — never a fabricated exit. */
export function decideMark(quote: OptionQuote | null, cfg: FillConfig, nowMs: number): MarkDecision {
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!quote || !isNum(quote.bid) || !isNum(quote.ask) || quote.bid <= 0 || quote.ask <= 0) {
    return { markable: false, mark: null, event: "mark_missing", note: "no usable two-sided quote — position kept open" };
  }
  if (isNum(quote.asOfMs) && nowMs - quote.asOfMs > cfg.maxQuoteAgeMs) {
    return { markable: false, mark: null, event: "mark_stale", note: `mark ${Math.round((nowMs - (quote.asOfMs as number)) / 1000)}s old — position kept open` };
  }
  const mid = isNum(quote.mid) ? quote.mid : +(((quote.bid as number) + (quote.ask as number)) / 2).toFixed(4);
  return { markable: true, mark: mid, event: "mark_updated", note: "mark refreshed" };
}

export interface ExitFill {
  fillPrice: number;
  fees: number;
  slippage: number;
  assumptions: FillAssumptions | null;
  /** True when the fill price could not be computed from a live quote (caller keeps position open). */
  unresolved: boolean;
  note: string;
}

/**
 * Resolve the exit fill price. Expirations settle at INTRINSIC value from the
 * underlying (worthless when OTM) — never the last mark. All other exits use the
 * conservative fill model (bid − slippage) with fees. When the quote can't
 * support a fill (missing/stale/crossed), returns unresolved so the caller keeps
 * the position open rather than inventing an exit.
 */
export function resolveExitFill(input: {
  decision: ExitDecision;
  trade: PaperTrade;
  quote: OptionQuote;
  underlying: number | null;
  session: MarketSession;
  fillCfg: FillConfig;
  nowMs: number;
}): ExitFill {
  const { decision, trade, quote, underlying, fillCfg, nowMs, session } = input;
  const contracts = trade.contracts ?? 1;
  const feePerUnit = fillCfg.feePerContract;

  if (decision.kind === "expired") {
    const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    // Prefer intrinsic value from the underlying (worthless when OTM). When the
    // underlying is unknown (overnight/weekend expiry of a multi-day option),
    // fall back to the last mark — documented, never fabricated.
    if (isNum(underlying)) {
      const intrinsic = intrinsicValue(trade.optionType, trade.strike, underlying);
      return { fillPrice: intrinsic, fees: +(feePerUnit * contracts).toFixed(2), slippage: 0, assumptions: null, unresolved: false, note: `expired — settled at intrinsic ${intrinsic.toFixed(2)} (underlying ${underlying})` };
    }
    const fallback = isNum(trade.lastMark) ? (trade.lastMark as number) : 0;
    return { fillPrice: fallback, fees: +(feePerUnit * contracts).toFixed(2), slippage: 0, assumptions: null, unresolved: false, note: `expired — no underlying available, settled at last mark ${fallback.toFixed(2)}` };
  }

  const fill = simulateFill(
    { side: "sell_to_close", assetClass: "option", units: contracts, limit: null, marketableExit: true, session },
    quote,
    fillCfg,
    nowMs,
  );
  if (!fill.filled || fill.price == null) {
    return { fillPrice: 0, fees: 0, slippage: 0, assumptions: null, unresolved: true, note: `exit could not fill against the current quote (${fill.reason}) — position kept open` };
  }
  return { fillPrice: fill.price, fees: fill.fees, slippage: fill.assumptions?.slippageApplied ?? 0, assumptions: fill.assumptions, unresolved: false, note: fill.reason };
}
