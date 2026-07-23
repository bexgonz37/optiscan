/**
 * lib/research/options/format.ts — the compact, mobile-friendly EDUCATIONAL Discord callout. PURE.
 * Framed as a plain-language "BUYING <ticker> <strike> CALL/PUT" education callout: the setup in one
 * sentence, the underlying price + the chart level it is playing, one approximate entry (the frozen
 * midpoint), aspirational targets, and a risk note for short-dated/0DTE. It deliberately does NOT print
 * a precise stop — the exact invalidation is tracked in the backend paper mirror, not shown to
 * subscribers as advice. No per-block disclaimer (the single disclaimer is appended once by delivery).
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
  // educational context (all optional; the message degrades gracefully when absent)
  underlyingPrice?: number | null;   // where the stock is right now
  keyLevel?: number | null;          // the chart level the setup is playing (e.g. resistance to break)
  dte?: number | null;               // days to expiration → short-dated / 0DTE risk note
}
const px = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(2));
/**
 * The educational callout, e.g.:
 *   🟢 **BUYING SPY $640 CALL** · exp 07/24
 *   Reclaiming a lost level with acceptance.
 *   SPY @ $639.40 · watching $640.50
 *   Entry ~ **$1.21** · Targets **$1.45 / $1.70**
 *   ⚡ 0DTE — high risk, small size
 * (The single "PAPER/BETA TEST — NOT FINANCIAL ADVICE" disclaimer is appended once by delivery.)
 * The precise stop is intentionally NOT shown — it is tracked in the backend, not published as advice.
 */
export function formatCompactAlert(i: CompactAlertInput): string {
  const call = i.side === "call";
  const emoji = call ? "🟢" : "🔴";
  const sym = i.symbol.toUpperCase();
  const lines: string[] = [];
  lines.push(`${emoji} **BUYING ${sym} $${strikeStr(i.strike)} ${call ? "CALL" : "PUT"}** · exp ${mmdd(i.expiration)}`);
  lines.push(setupSentence(i.strategyKey));
  if (i.underlyingPrice != null && i.underlyingPrice > 0) {
    const level = i.keyLevel != null && i.keyLevel > 0 ? ` · watching $${px(i.keyLevel)}` : "";
    lines.push(`${sym} @ $${px(i.underlyingPrice)}${level}`);
  }
  lines.push(`Entry ~ **$${i.entryMid.toFixed(2)}** · Targets **$${i.t1.toFixed(2)} / $${i.t2.toFixed(2)}**`);
  if (i.dte != null && i.dte <= 0) lines.push("⚡ 0DTE — high risk, small size");
  else if (i.dte != null && i.dte <= 2) lines.push("⚡ Short-dated — manage risk");
  return lines.join("\n");
}
