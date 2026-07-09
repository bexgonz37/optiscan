/**
 * paper-trading.ts — pure trade lifecycle for the paper trading system.
 *
 * No I/O here: the engine (lib/paper-engine.ts) feeds quotes/tape in and
 * persists results out. Everything in this file is unit-testable.
 *
 * State machine:
 *   WATCHING  — created from an alert; waiting to be armed
 *   READY     — entry limit order active
 *   ENTERED   — position open, marks/exits evaluated every sweep
 *   EXITED    — closed by smart exit or manual close
 *   STOPPED_OUT / TAKE_PROFIT — closed by hard exits
 *   CANCELLED — never filled and was withdrawn (or entry window lapsed)
 *   EXPIRED   — contract reached expiration without an exit fill
 */

import type { OptionQuote } from "./execution/broker.ts";
import { paperBroker } from "./execution/paper-broker.ts";

export const PAPER_STATES = [
  "WATCHING", "READY", "ENTERED", "EXITED", "STOPPED_OUT", "TAKE_PROFIT", "CANCELLED", "EXPIRED",
] as const;
export type PaperState = (typeof PAPER_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<PaperState> = new Set([
  "EXITED", "STOPPED_OUT", "TAKE_PROFIT", "CANCELLED", "EXPIRED",
]);

const TRANSITIONS: Record<PaperState, PaperState[]> = {
  WATCHING: ["READY", "CANCELLED"],
  READY: ["ENTERED", "CANCELLED", "EXPIRED"],
  ENTERED: ["EXITED", "STOPPED_OUT", "TAKE_PROFIT", "EXPIRED"],
  EXITED: [], STOPPED_OUT: [], TAKE_PROFIT: [], CANCELLED: [], EXPIRED: [],
};

export function canTransition(from: PaperState, to: PaperState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export interface PaperTrade {
  id?: number;
  alertId: number | null;
  ticker: string;
  optionSymbol: string | null;
  optionType: "call" | "put";
  strike: number | null;
  expiration: string | null; // YYYY-MM-DD
  dteAtEntry: number | null;
  contracts: number;
  status: PaperState;
  thesis: string | null;
  confidence: number | null; // scanner setup score at creation
  entryLimit: number | null;
  entryPrice: number | null;
  entryAtMs: number | null;
  stopLossPct: number | null;   // e.g. 25 = exit at -25% of entry premium
  takeProfitPct: number | null; // e.g. 40 = exit at +40%
  exitPrice: number | null;
  exitAtMs: number | null;
  exitReason: string | null;
  mfePct: number | null;
  maePct: number | null;
  lastMark: number | null;
  lastMarkAtMs: number | null;
  createdAtMs: number;
}

/** Entry window: a READY order that never fills goes stale (momentum trade). */
export const ENTRY_WINDOW_MS = Number(process.env.PAPER_ENTRY_WINDOW_MS ?? 10 * 60_000);

// ── Entry ────────────────────────────────────────────────────────────────────

export interface EntryResult {
  trade: PaperTrade;
  event: "filled" | "waiting" | "cancelled";
  note: string;
}

/** Advance a READY trade against a fresh quote. */
export function evaluateEntry(trade: PaperTrade, quote: OptionQuote | null, nowMs: number): EntryResult {
  if (trade.status !== "READY" || trade.entryLimit == null || !trade.optionSymbol) {
    return { trade, event: "waiting", note: "not an active entry order" };
  }
  if (nowMs - trade.createdAtMs > ENTRY_WINDOW_MS) {
    return {
      trade: { ...trade, status: "CANCELLED", exitReason: `entry never filled within ${Math.round(ENTRY_WINDOW_MS / 60000)} min — momentum entries go stale` },
      event: "cancelled",
      note: "entry window lapsed",
    };
  }
  if (!quote) return { trade, event: "waiting", note: "no quote yet" };
  const fill = paperBroker.tryFill(
    { side: "buy_to_open", optionSymbol: trade.optionSymbol, contracts: trade.contracts, limit: trade.entryLimit },
    quote,
  );
  if (!fill.filled || fill.price == null) return { trade, event: "waiting", note: fill.reason };
  return {
    trade: {
      ...trade,
      status: "ENTERED",
      entryPrice: fill.price,
      entryAtMs: nowMs,
      lastMark: quote.mid ?? fill.price,
      lastMarkAtMs: nowMs,
      mfePct: 0,
      maePct: 0,
    },
    event: "filled",
    note: fill.reason,
  };
}

// ── Mark-to-market (MFE / MAE) ───────────────────────────────────────────────

/** Update excursions from a fresh mid mark. Pure; returns a new trade. */
export function markToMarket(trade: PaperTrade, quote: OptionQuote, nowMs: number): PaperTrade {
  if (trade.status !== "ENTERED" || trade.entryPrice == null || quote.mid == null || quote.mid <= 0) {
    return trade;
  }
  const movePct = ((quote.mid - trade.entryPrice) / trade.entryPrice) * 100;
  return {
    ...trade,
    lastMark: quote.mid,
    lastMarkAtMs: nowMs,
    mfePct: Math.max(trade.mfePct ?? 0, movePct),
    maePct: Math.min(trade.maePct ?? 0, movePct),
  };
}

// ── Exit application ─────────────────────────────────────────────────────────

export interface ExitDecision {
  kind: "stop_loss" | "take_profit" | "smart" | "expired" | "manual";
  reason: string;
  /** Premium to fill at (bid for stops/smart, limit-checked for targets). */
  fillPrice: number;
}

const EXIT_STATE: Record<ExitDecision["kind"], PaperState> = {
  stop_loss: "STOPPED_OUT",
  take_profit: "TAKE_PROFIT",
  smart: "EXITED",
  manual: "EXITED",
  expired: "EXPIRED",
};

export function applyExit(trade: PaperTrade, decision: ExitDecision, nowMs: number): PaperTrade {
  const to = EXIT_STATE[decision.kind];
  if (!canTransition(trade.status, to)) return trade;
  return {
    ...trade,
    status: to,
    exitPrice: decision.fillPrice,
    exitAtMs: nowMs,
    exitReason: `${decision.kind}: ${decision.reason}`,
  };
}

// ── P/L ──────────────────────────────────────────────────────────────────────

export function pnlDollars(trade: PaperTrade): number | null {
  if (trade.entryPrice == null || trade.exitPrice == null) return null;
  return +((trade.exitPrice - trade.entryPrice) * 100 * trade.contracts).toFixed(2);
}

export function pnlPct(trade: PaperTrade): number | null {
  if (trade.entryPrice == null || trade.exitPrice == null || trade.entryPrice <= 0) return null;
  return +(((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100).toFixed(2);
}

/** Dollars at risk when the trade is opened (what the risk engine budgets). */
export function dollarsAtRisk(entryPremium: number, contracts: number, stopLossPct: number | null): number {
  const full = entryPremium * 100 * contracts;
  if (stopLossPct == null) return full; // no stop = full premium at risk
  return +(full * Math.min(1, stopLossPct / 100)).toFixed(2);
}

// ── Post-trade lesson (explainability) ───────────────────────────────────────

/** Rule-based "what to learn" summary written when a trade closes. */
export function lessonsLearned(trade: PaperTrade): string {
  const pct = pnlPct(trade);
  if (pct == null) return "Trade never filled — no lesson beyond entry discipline.";
  const mfe = trade.mfePct ?? 0;
  const mae = trade.maePct ?? 0;
  const lines: string[] = [];

  if (pct > 0) {
    lines.push(`Closed +${pct.toFixed(1)}%.`);
    if (mfe > pct * 1.75 && mfe - pct > 15) {
      lines.push(`Peak was +${mfe.toFixed(0)}% — exit captured ${Math.round((pct / mfe) * 100)}% of the best move; a trailing exit may have kept more.`);
    } else {
      lines.push("Exit captured most of the available move — good management.");
    }
  } else {
    lines.push(`Closed ${pct.toFixed(1)}%.`);
    if (mfe >= 10) {
      lines.push(`It was +${mfe.toFixed(0)}% at its best — the setup worked but the exit gave it back. Consider taking partials or tightening the target.`);
    } else {
      lines.push("It never really worked — the entry was the problem, not the exit.");
    }
  }
  if (mae <= -25 && pct > 0) {
    lines.push(`Warning: it drew down ${mae.toFixed(0)}% before paying — this win took more heat than a sane stop allows. Don't let the result excuse the risk.`);
  }
  if (trade.exitReason?.startsWith("smart:")) {
    lines.push("Exited on thesis invalidation — check whether the invalidation signal fired early or saved you.");
  }
  return lines.join(" ");
}
