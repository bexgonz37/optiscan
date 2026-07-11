/**
 * paper-stock.ts — pure momentum-stock entry / exit decisions (rebuild).
 *
 * The old path filled instantly at the tape's LAST price. This replaces that
 * with the same conservative, verified-quote fill model the options path uses,
 * and enforces two hard policies:
 *
 *  - Decision 8 (bearish): the rebuilt momentum path NEVER opens a short stock
 *    paper position while bearish actionability is disabled. A short/bearish
 *    candidate is rejected here — long only.
 *  - Decision 7 (extended hours): an extended-hours entry only proceeds when the
 *    session is explicitly permitted AND a fresh, valid two-sided quote fills
 *    through the extended-slippage rules — the tape price is never a guaranteed
 *    executable fill.
 *
 * PURE: no DB, no I/O, no clock in the output (the caller passes nowMs and the
 * already-fetched quote). The engine owns persistence, sizing, and the risk /
 * capital gates.
 */
import type { OptionQuote } from "./execution/broker.ts";
import type { MarketSession } from "./trading-session.ts";
import type { PaperState, OrderState } from "./paper-trading.ts";
import type { PaperEventType } from "./paper-events.ts";
import { simulateFill, type FillAssumptions, type FillConfig } from "./paper-fill-model.ts";

export interface StockEntryDecision {
  /** fill = open the position; reject = terminal (never enter); retry = no verified fill yet, try a later sweep. */
  action: "fill" | "reject" | "retry";
  fillPrice: number | null;
  fees: number;
  slippage: number;
  assumptions: FillAssumptions | null;
  reason: string;
  events: PaperEventType[];
  toStatus: PaperState | null;
  toOrderState: OrderState;
}

/** A no-fill reason that will not improve within the entry window → terminal. */
function terminalNoFill(reason: string): boolean {
  return /one-sided|missing|non-positive|crossed|invalid/i.test(reason);
}

/**
 * Decide whether a momentum-stock entry fills. Long only (no short/bearish
 * paper entries), session-gated, and filled only from a verified quote.
 */
export function decideStockEntry(input: {
  side: "call" | "put";
  sessionAllowed: boolean;
  quote: OptionQuote;
  shares: number;
  session: MarketSession;
  fillCfg: FillConfig;
  nowMs: number;
}): StockEntryDecision {
  const base = { fillPrice: null, fees: 0, slippage: 0, assumptions: null } as const;

  // Decision 8: bearish actionability disabled → never open a short stock paper trade.
  if (input.side === "put") {
    return { ...base, action: "reject", reason: "short/bearish stock paper entries are disabled (bearish actionability off) — long only", events: ["rejected"], toStatus: "CANCELLED", toOrderState: "REJECTED" };
  }
  // Decision 7: extended-hours entries only when the session is permitted.
  if (!input.sessionAllowed) {
    return { ...base, action: "reject", reason: "stock paper entries are not permitted in this session", events: ["rejected"], toStatus: "CANCELLED", toOrderState: "REJECTED" };
  }

  const fill = simulateFill(
    { side: "buy_to_open", assetClass: "stock", units: input.shares, limit: null, session: input.session },
    input.quote,
    input.fillCfg,
    input.nowMs,
  );
  if (!fill.filled || fill.price == null) {
    const terminal = terminalNoFill(fill.reason);
    return {
      ...base,
      action: terminal ? "reject" : "retry",
      reason: terminal ? `no verified quote to fill against — ${fill.reason}` : `waiting for a fillable quote — ${fill.reason}`,
      events: terminal ? ["no_fill", "rejected"] : ["no_fill"],
      toStatus: terminal ? "CANCELLED" : null,
      toOrderState: terminal ? "REJECTED" : "PENDING",
    };
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

export interface StockExitDecision {
  kind: "stop_loss" | "take_profit" | "smart" | null;
  reason: string;
}

/**
 * Evaluate a long stock scalp exit from the MARK (mid) move — pure, no quote.
 * Stops outrank targets; a hard tape reversal or the max-hold clock triggers a
 * smart exit. (Long only, so direction is always +1.)
 */
export function evaluateStockExit(input: {
  movePct: number;
  stopPct: number;
  targetPct: number;
  speed: number | null;
  maxHold: boolean;
  maxHoldMinutes: number;
}): StockExitDecision {
  if (input.movePct <= -Math.abs(input.stopPct)) {
    return { kind: "stop_loss", reason: `stock scalp stop hit (${input.movePct.toFixed(2)}%)` };
  }
  if (input.movePct >= Math.abs(input.targetPct)) {
    return { kind: "take_profit", reason: `quick stock scalp target hit (+${input.movePct.toFixed(2)}%)` };
  }
  if (input.speed != null && Number.isFinite(input.speed) && input.speed < -0.04) {
    return { kind: "smart", reason: `tape reversed against scalp (speed ${input.speed.toFixed(2)}%/min)` };
  }
  if (input.maxHold) {
    return { kind: "smart", reason: `quick scalp max hold reached (${input.maxHoldMinutes}m)` };
  }
  return { kind: null, reason: "" };
}

export interface StockExitFill {
  fillPrice: number;
  fees: number;
  slippage: number;
  assumptions: FillAssumptions | null;
  /** True when no usable quote → caller keeps the position open (no fabricated exit). */
  unresolved: boolean;
  note: string;
}

/** Resolve a long stock exit at bid − slippage; unresolved when the quote is unusable. */
export function resolveStockExitFill(input: {
  quote: OptionQuote;
  shares: number;
  session: MarketSession;
  fillCfg: FillConfig;
  nowMs: number;
}): StockExitFill {
  const fill = simulateFill(
    { side: "sell_to_close", assetClass: "stock", units: input.shares, limit: null, marketableExit: true, session: input.session },
    input.quote,
    input.fillCfg,
    input.nowMs,
  );
  if (!fill.filled || fill.price == null) {
    return { fillPrice: 0, fees: 0, slippage: 0, assumptions: null, unresolved: true, note: `exit could not fill against the current quote (${fill.reason}) — position kept open` };
  }
  return { fillPrice: fill.price, fees: fill.fees, slippage: fill.assumptions?.slippageApplied ?? 0, assumptions: fill.assumptions, unresolved: false, note: fill.reason };
}
