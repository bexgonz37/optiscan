/**
 * paper-exits.ts — hard + smart exit evaluation (pure).
 *
 * Hard exits: configurable stop loss / take profit on the option premium.
 * Smart exits: leave early when the ORIGINAL THESIS is invalidated by live
 * tape, even if neither hard level has been touched. Every exit explains
 * itself — the exit reason is a teaching moment, not a log line.
 *
 * Evaluation order (first hit wins):
 *   1. expiration  (can't hold what no longer exists)
 *   2. stop loss   (risk always outranks opportunity)
 *   3. take profit
 *   4. smart invalidation (2+ independent signals, or 1 catastrophic)
 */

import type { OptionQuote } from "./execution/broker.ts";
import type { PaperTrade, ExitDecision } from "./paper-trading.ts";

export interface LiveTapeSnapshot {
  /** Short-window velocity %/min for the underlying (signed). */
  shortRate: number | null;
  /** Whether price is above session VWAP. */
  aboveVwap: boolean | null;
  /** Relative volume vs baseline. */
  relVol: number | null;
  /** Current option spread %. */
  spreadPct: number | null;
  /** Direction read: "bullish" | "bearish" | "choppy". */
  direction: string | null;
}

export interface EntryThesisSnapshot {
  /** Velocity at entry (signed) — the momentum we bought. */
  shortRateAtEntry: number | null;
  /** VWAP side at entry. */
  aboveVwapAtEntry: boolean | null;
  /** RVOL at entry. */
  relVolAtEntry: number | null;
}

export interface ExitConfig {
  stopLossPct: number;    // default 30 → exit at -30% of entry premium
  takeProfitPct: number;  // default 50 → exit at +50%
  smartExitsEnabled: boolean;
  /** Momentum considered dead below this fraction of entry velocity. */
  momentumDecayFraction: number; // default 0.25
  /** Spread beyond this % = exits get expensive; leave while you can. */
  maxSpreadPct: number; // default 12
  /** RVOL below this fraction of entry RVOL = participation gone. */
  rvolFadeFraction: number; // default 0.4
}

export function defaultExitConfig(): ExitConfig {
  return {
    stopLossPct: Number(process.env.PAPER_STOP_LOSS_PCT ?? 30),
    takeProfitPct: Number(process.env.PAPER_TAKE_PROFIT_PCT ?? 50),
    smartExitsEnabled: process.env.PAPER_SMART_EXITS !== "0",
    momentumDecayFraction: Number(process.env.PAPER_MOMENTUM_DECAY_FRACTION ?? 0.25),
    maxSpreadPct: Number(process.env.PAPER_EXIT_MAX_SPREAD_PCT ?? 12),
    rvolFadeFraction: Number(process.env.PAPER_RVOL_FADE_FRACTION ?? 0.4),
  };
}

/** Expiration check — expired contracts settle at intrinsic-ish last mark. */
export function checkExpiration(trade: PaperTrade, nowMs: number): ExitDecision | null {
  if (!trade.expiration) return null;
  // 16:00 ET close on expiration day; parse as ET-agnostic date + generous UTC buffer (21:00 UTC ≥ 16:00 ET year-round).
  const expiryMs = Date.parse(`${trade.expiration}T21:00:00Z`);
  if (!Number.isFinite(expiryMs) || nowMs < expiryMs) return null;
  return {
    kind: "expired",
    reason: `contract expired ${trade.expiration} — settled at last mark`,
    fillPrice: trade.lastMark ?? 0,
  };
}

/** Hard exits: stop loss / take profit on the premium. */
export function checkHardExits(
  trade: PaperTrade,
  quote: OptionQuote,
  cfg: ExitConfig,
): ExitDecision | null {
  if (trade.entryPrice == null || trade.entryPrice <= 0) return null;
  const stopPct = trade.stopLossPct ?? cfg.stopLossPct;
  const targetPct = trade.takeProfitPct ?? cfg.takeProfitPct;

  // Stops evaluate on the BID (what you could actually get out at).
  if (quote.bid != null && quote.bid > 0) {
    const bidMovePct = ((quote.bid - trade.entryPrice) / trade.entryPrice) * 100;
    if (bidMovePct <= -stopPct) {
      return {
        kind: "stop_loss",
        reason: `bid ${quote.bid.toFixed(2)} is ${bidMovePct.toFixed(0)}% below entry ${trade.entryPrice.toFixed(2)} (stop ${stopPct}%)`,
        fillPrice: quote.bid,
      };
    }
    if (bidMovePct >= targetPct) {
      return {
        kind: "take_profit",
        reason: `bid ${quote.bid.toFixed(2)} is +${bidMovePct.toFixed(0)}% over entry (target ${targetPct}%)`,
        fillPrice: quote.bid,
      };
    }
  }
  return null;
}

interface Invalidation { signal: string; catastrophic: boolean }

/** Collect thesis-invalidation signals from live tape vs the entry snapshot. */
export function invalidationSignals(
  trade: PaperTrade,
  live: LiveTapeSnapshot,
  entry: EntryThesisSnapshot,
  cfg: ExitConfig,
): Invalidation[] {
  const out: Invalidation[] = [];
  const isCall = trade.optionType === "call";

  // 1. Momentum death: velocity collapsed vs what we bought.
  if (entry.shortRateAtEntry != null && live.shortRate != null) {
    const entryMag = Math.abs(entry.shortRateAtEntry);
    if (entryMag > 0) {
      const sameDirection = Math.sign(live.shortRate) === Math.sign(entry.shortRateAtEntry);
      const nowMag = sameDirection ? Math.abs(live.shortRate) : 0;
      if (nowMag < entryMag * cfg.momentumDecayFraction) {
        out.push({ signal: `momentum decayed to ${nowMag.toFixed(2)}%/min from ${entryMag.toFixed(2)} at entry`, catastrophic: false });
      }
    }
  }

  // 2. Velocity flipped hard against the position — catastrophic.
  if (live.shortRate != null && Math.abs(live.shortRate) >= 0.15) {
    const against = isCall ? live.shortRate < 0 : live.shortRate > 0;
    if (against) out.push({ signal: `tape moving ${live.shortRate.toFixed(2)}%/min AGAINST the position`, catastrophic: true });
  }

  // 3. VWAP break against the position (structure lost).
  if (live.aboveVwap != null) {
    const broke = isCall ? !live.aboveVwap : live.aboveVwap;
    const hadStructure = entry.aboveVwapAtEntry == null || (isCall ? entry.aboveVwapAtEntry : !entry.aboveVwapAtEntry);
    if (broke && hadStructure) out.push({ signal: `price broke VWAP against the ${trade.optionType}`, catastrophic: false });
  }

  // 4. Participation gone: RVOL faded to a fraction of entry.
  if (entry.relVolAtEntry != null && live.relVol != null && entry.relVolAtEntry > 0) {
    if (live.relVol < entry.relVolAtEntry * cfg.rvolFadeFraction) {
      out.push({ signal: `relative volume faded to ${live.relVol.toFixed(1)}x from ${entry.relVolAtEntry.toFixed(1)}x`, catastrophic: false });
    }
  }

  // 5. Spread blowout: exits are getting expensive — leave while fills exist.
  if (live.spreadPct != null && live.spreadPct > cfg.maxSpreadPct) {
    out.push({ signal: `spread blew out to ${live.spreadPct.toFixed(1)}% (max ${cfg.maxSpreadPct}%)`, catastrophic: false });
  }

  // 6. Direction read flipped to opposite trend — structure break.
  if (live.direction === (isCall ? "bearish" : "bullish")) {
    out.push({ signal: `direction read flipped ${live.direction} against the ${trade.optionType}`, catastrophic: false });
  }

  return out;
}

/**
 * Smart exit: 1 catastrophic signal, or 2+ independent invalidations.
 * (A single soft signal is noise; two independent ones is a dead thesis.)
 */
export function checkSmartExit(
  trade: PaperTrade,
  quote: OptionQuote,
  live: LiveTapeSnapshot,
  entry: EntryThesisSnapshot,
  cfg: ExitConfig,
): ExitDecision | null {
  if (!cfg.smartExitsEnabled) return null;
  if (quote.bid == null || quote.bid <= 0) return null;
  const signals = invalidationSignals(trade, live, entry, cfg);
  const catastrophic = signals.find((s) => s.catastrophic);
  if (!catastrophic && signals.length < 2) return null;
  const why = signals.map((s) => s.signal).join(" + ");
  return {
    kind: "smart",
    reason: `thesis invalidated — ${why}`,
    fillPrice: quote.bid,
  };
}

/** Full evaluation in priority order. */
export function evaluateExit(
  trade: PaperTrade,
  quote: OptionQuote,
  live: LiveTapeSnapshot | null,
  entry: EntryThesisSnapshot,
  nowMs: number,
  cfg: ExitConfig = defaultExitConfig(),
): ExitDecision | null {
  const expired = checkExpiration(trade, nowMs);
  if (expired) return expired;
  const hard = checkHardExits(trade, quote, cfg);
  if (hard) return hard;
  if (live) {
    const smart = checkSmartExit(trade, quote, live, entry, cfg);
    if (smart) return smart;
  }
  return null;
}
