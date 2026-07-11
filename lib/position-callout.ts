/**
 * position-callout.ts — longer-dated callouts from major moves (2026-07-09).
 *
 * The user's ask, verbatim: "one META call for mid July for 650 went crazy —
 * I want it to call out ones like that too." This is the bridge:
 *
 *   major-move detector (day-timeframe grind, META-miss fix)
 *        → fetch the 1–5 week chain (budget-bounded, once per symbol/day)
 *        → pick a swing contract with the PROVEN gates (pickSwingContract:
 *          spread ≤8%, OI ≥250, 0.40–0.70Δ, 21–28 DTE preferred)
 *        → persist a WATCH-tier "position" alert with full explanation
 *
 * It reuses the existing alert pipeline, so position callouts automatically
 * get: dashboard visibility, checkpoint tracking/grading, quant setup stats,
 * one-click paper trading, and Discord WATCH dedup. It never uses the 0DTE
 * BUY path — a multi-week position idea is research, not a scalp directive.
 */

import { getDb } from "@/lib/db";
import { insertAlert } from "@/lib/alert-store";
import { fetchOptionChain, getCallStats } from "@/lib/polygon-provider";
import { nearMinuteBudget } from "@/lib/near-miss";
import type { SwingContract } from "@/lib/swing-score";
import { selectContract, type ChainContract } from "@/lib/contract-selector";
import { tradingDay, marketSession } from "@/lib/trading-session";
import type { MajorMoveRead } from "@/lib/major-move";

export const POSITION_CALLOUTS_ENABLED = () => process.env.POSITION_CALLOUTS !== "0";

export interface PositionQuote {
  symbol: string;
  price: number | null;
  movePct: number | null;
  volume: number | null;
  relVol: number | null;
}

/** One position callout per symbol per trading day — these are theses, not ticks. */
export function alreadyCalledToday(symbol: string, nowMs: number): boolean {
  const row = getDb().prepare(
    "SELECT 1 FROM alerts WHERE ticker=? AND source='major_move' AND trading_day=? LIMIT 1",
  ).get(symbol, tradingDay(nowMs));
  return Boolean(row);
}

/** Plain-English thesis for the callout (specific evidence, no vague fluff). */
export function buildPositionExplanation(
  symbol: string,
  major: MajorMoveRead,
  quote: PositionQuote,
  contract: SwingContract,
): string {
  const dir = major.direction === "down" ? "bearish" : "bullish";
  const entryHint = major.status === "extended"
    ? "EXTENDED — do not chase; a pullback toward VWAP is the next reasonable entry zone"
    : "move still developing — entries near current level or on the first pullback hold";
  return [
    `${symbol} major ${dir} move: ${major.why.join("; ")}.`,
    `Position idea (1–5 week horizon): $${contract.strike} ${String(contract.side).toUpperCase()} exp ${contract.expiration} (${contract.dte} DTE, Δ ${Math.abs(contract.delta ?? 0).toFixed(2)}, spread ${contract.spreadPct?.toFixed(1)}%).`,
    `Status: ${entryHint}.`,
    `Invalidation: day-move thesis fails if it closes back through VWAP against the move.`,
  ].join(" ");
}

/**
 * Fire-and-forget from the scanner loop when a major move is recorded.
 * Budget: at most ONE chain fetch per symbol per day, skipped near minute cap.
 */
export async function maybeEmitPositionCallout(
  quote: PositionQuote,
  major: MajorMoveRead,
  nowMs: number,
): Promise<number | null> {
  if (!POSITION_CALLOUTS_ENABLED()) return null;
  if (!major.detected || !major.direction) return null;
  if (alreadyCalledToday(quote.symbol, nowMs)) return null;
  if (nearMinuteBudget(getCallStats(nowMs))) return null;

  const side = major.direction === "down" ? "put" : "call";
  const chain: any = await fetchOptionChain(quote.symbol, { dteMin: 7, dteMax: 35, maxPages: 2 });
  if (!chain?.available) return null;

  // Centralized selection (swing_position profile): the same proven gates
  // (spread ≤8%, OI ≥250, 0.40–0.70Δ, 7–35 DTE, 21–28 preferred) now applied
  // through the one selector, with structured rejection reasons and staleness.
  const contracts = (chain.contracts ?? []) as ChainContract[];
  const chainAsOfMs = contracts.reduce<number | null>(
    (max, c) => (typeof c.providerTimestamp === "number" && (max == null || c.providerTimestamp > max) ? c.providerTimestamp : max),
    null,
  );
  const selection = selectContract(
    {
      underlying: quote.symbol, spot: quote.price, side,
      contracts, session: marketSession(nowMs),
      chainAvailable: Boolean(chain.available), chainAsOfMs, nowMs,
    },
    "swing_position",
  );
  if (!selection.ok) {
    console.log(`[position] ${quote.symbol}: major move but no fillable 1–5 week ${side} — ${selection.reason}`);
    return null;
  }
  const contract = selection.contract as unknown as SwingContract;

  const explanation = buildPositionExplanation(quote.symbol, major, quote, contract);
  const id = insertAlert({
    ticker: quote.symbol,
    source: "major_move",
    alertType: "position_momentum",
    direction: major.direction === "down" ? "bearish" : "bullish",
    optionSymbol: contract.optionSymbol,
    optionSide: side,
    strike: contract.strike,
    expiration: contract.expiration,
    dte: contract.dte,
    alertTime: new Date(nowMs).toISOString(),
    tradingDay: tradingDay(nowMs),
    priceAtAlert: quote.price,
    percentMoveAtAlert: quote.movePct,
    volume: quote.volume,
    relativeVolume: quote.relVol,
    catalystType: null, catalystQuality: null, catalystSummary: null, catalystSource: "pending",
    signalScore: major.status === "extended" ? 68 : 78, // research-tier, honest: uncalibrated
    riskScore: major.status === "extended" ? 62 : 45,
    optionsLiquidityScore: contract.spreadPct != null ? Math.max(0, Math.round(100 - contract.spreadPct * 8)) : null,
    scannerScore: null,
    aiExplanation: explanation,
    publicExplanation: explanation,
    privateLabel: major.status === "extended"
      ? `${quote.symbol} position ${side} — extended, wait for pullback`
      : `${quote.symbol} position ${side} watch (1–5 wk)`,
    publicLabel: `${major.direction === "down" ? "Bearish" : "Bullish"} Position Momentum Watch`,
    moveStatus: major.status === "extended" ? "extended_risky" : "continuing",
    shortRateAtAlert: null,
    volumeSurgeAtAlert: null,
    alertTier: "research",       // never the live-TRADE tier — no speed proof
    captureAction: "WATCH",      // position ideas are watches, not scalp BUYs
    captureConfidence: major.status === "extended" ? 55 : 70,
    assetClass: "options",
    session: "regular",
  } as any);

  if (id != null) console.log(`[position] callout #${id}: ${quote.symbol} $${contract.strike} ${side} ${contract.expiration} (${major.status})`);
  return id;
}
