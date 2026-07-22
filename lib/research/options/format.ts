/**
 * lib/research/options/format.ts — the compact, mobile-friendly Discord alert. PURE. Exactly one entry
 * price (the frozen midpoint), T1/T2/Stop, and one brief setup sentence. No entry range, no "Targets:
 * n/a", no "Why:" label, no per-block disclaimer (the single disclaimer is appended once by delivery).
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Frozen decision-time entry: round((bid + ask) / 2, 2). */
export function entryMidpoint(bid: number, ask: number): number { return round2((bid + ask) / 2); }

const SETUP_SENTENCE: Record<string, string> = {
  breakout_forming: "Compression into the level; breakout pressure building.",
  confirmed_breakout: "Level broke and holding with volume.",
  opening_range_breakout: "Opening-range break with volume.",
  premarket_level_break: "Premarket level break near the open.",
  sr_reclaim: "Reclaiming a lost level with acceptance.",
  pullback_continuation: "Controlled pullback resuming with the trend.",
  trend_continuation: "With-trend momentum resuming at VWAP.",
  vol_compression_expansion: "Compression resolving into expansion.",
  momentum_acceleration: "Momentum accelerating early, not extended.",
  reversal_bounce: "Reclaim at an extreme; early reversal forming.",
  failed_breakout: "Breakout rejected; fade setup.",
  index_intraday_momentum: "Index trend leg with breadth.",
  zero_dte_index: "0DTE index level break/hold.",
  short_dated_directional: "Clean short-dated directional setup.",
  longer_dated_swing: "Higher-conviction multi-week setup.",
  earnings_continuation: "Post-earnings gap holding; continuation.",
  earnings_reversal: "Post-earnings gap failing; reversal.",
  unusual_options_activity: "Unusual options flow with directional skew.",
};
export function setupSentence(strategyKey: string): string { return SETUP_SENTENCE[strategyKey] ?? "Early forming setup near a decision level."; }

const mmdd = (iso: string): string => { const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}` : iso; };
const strikeStr = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2));

export interface CompactAlertInput {
  symbol: string; side: "call" | "put"; strike: number; expiration: string;
  entryMid: number; t1: number; t2: number; stop: number; strategyKey: string;
}
/**
 * The exact compact format:
 *   **SPY CALL — 07/24 $640C**
 *   Entry: **$1.21**
 *   T1: **$1.45** | T2: **$1.70** | Stop: **$0.98**
 *   VWAP reclaim forming near breakout.
 * (The single "Paper beta — not financial advice." disclaimer is appended once by the delivery layer.)
 */
export function formatCompactAlert(i: CompactAlertInput): string {
  const s = i.side.toUpperCase();
  const c = s === "CALL" ? "C" : "P";
  return [
    `**${i.symbol.toUpperCase()} ${s} — ${mmdd(i.expiration)} $${strikeStr(i.strike)}${c}**`,
    `Entry: **$${i.entryMid.toFixed(2)}**`,
    `T1: **$${i.t1.toFixed(2)}** | T2: **$${i.t2.toFixed(2)}** | Stop: **$${i.stop.toFixed(2)}**`,
    setupSentence(i.strategyKey),
  ].join("\n");
}
