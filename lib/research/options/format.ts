/**
 * Discord copy for options callouts. Pure formatting only.
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
  momentum_breakdown: "Support broke with downside momentum and put flow confirmation.",
  failed_breakout_reversal: "Breakout failed and reversed through the trigger area.",
  vwap_rejection: "VWAP rejected and sellers kept control.",
  support_break_retest: "Support broke and failed its retest.",
  lower_high_continuation: "Lower high continuation with bearish structure intact.",
  bearish_opening_range_break: "Opening range broke lower with confirmation.",
  gap_failure: "Gap failed and downside continuation confirmed.",
  relative_weakness_continuation: "Relative weakness continued versus the broader tape.",
  downside_catalyst_continuation: "Bearish catalyst continuation with contract confirmation.",
  index_intraday_momentum: "Index trend leg with breadth.",
  zero_dte_index: "0DTE index level break/hold.",
  short_dated_directional: "Clean short-dated directional setup.",
  longer_dated_swing: "Higher-conviction multi-week setup.",
  earnings_continuation: "Post-earnings gap holding; continuation.",
  earnings_reversal: "Post-earnings gap failing; reversal.",
  unusual_options_activity: "Unusual options flow with directional skew.",
};

export function setupSentence(strategyKey: string): string {
  return SETUP_SENTENCE[strategyKey] ?? "Early forming setup near a decision level.";
}

const mmdd = (iso: string): string => {
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}` : iso;
};
const strikeStr = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2));
const px = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(2));

export interface CompactAlertInput {
  symbol: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
  entryMid: number;
  t1: number;
  t2: number;
  stop: number;
  strategyKey: string;
  underlyingPrice?: number | null;
  keyLevel?: number | null;
  dte?: number | null;
}

export function formatCompactAlert(i: CompactAlertInput): string {
  const call = i.side === "call";
  const sym = i.symbol.toUpperCase();
  const lines: string[] = [];
  lines.push(`**WATCHING ${sym} $${strikeStr(i.strike)} ${call ? "CALL" : "PUT"}** - exp ${mmdd(i.expiration)}`);
  lines.push(setupSentence(i.strategyKey));
  if (i.underlyingPrice != null && i.underlyingPrice > 0) {
    const level = i.keyLevel != null && i.keyLevel > 0 ? ` | watching $${px(i.keyLevel)}` : "";
    lines.push(`${sym} @ $${px(i.underlyingPrice)}${level}`);
  }
  lines.push(`Entry around $${i.entryMid.toFixed(2)} | Targets $${i.t1.toFixed(2)} / $${i.t2.toFixed(2)}`);
  if (i.dte != null && i.dte <= 0) lines.push("0DTE: high risk, small size.");
  else if (i.dte != null && i.dte <= 2) lines.push("Short-dated: manage risk.");
  return lines.join("\n");
}

export interface PrivateLiveAlertInput extends CompactAlertInput {
  optionSymbol?: string | null;
  alertTimeEt?: string | null;
  timingClass?: "EARLY" | "TIMELY";
  actionableReason?: string | null;
  invalidation?: string | null;
  bid?: number | null;
  ask?: number | null;
  spreadPct?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  delta?: number | null;
  quoteAgeMs?: number | null;
  confidence?: number | null;
}

const etTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** Private live Discord alert with decision-first hierarchy. */
export function formatPrivateLiveAlert(i: PrivateLiveAlertInput): string {
  const call = i.side === "call";
  const sym = i.symbol.toUpperCase();
  const entryZone = i.bid != null && i.ask != null
    ? `$${i.bid.toFixed(2)}-$${i.ask.toFixed(2)}`
    : `$${i.entryMid.toFixed(2)}`;
  const freshness = i.quoteAgeMs == null ? "unknown" : `${Math.round(i.quoteAgeMs / 1000)}s`;
  const liquidity = [
    i.spreadPct != null ? `Spread ${i.spreadPct.toFixed(1)}%` : null,
    i.volume != null ? `Volume ${Math.round(i.volume).toLocaleString("en-US")}` : null,
    i.openInterest != null ? `OI ${Math.round(i.openInterest).toLocaleString("en-US")}` : null,
    i.delta != null ? `Delta ${i.delta.toFixed(2)}` : null,
    `Freshness ${freshness}`,
  ].filter(Boolean).join(" | ");

  const lines: string[] = [];
  lines.push(`**${sym} ${call ? "CALL" : "PUT"} - ${call ? "TRADE NOW CANDIDATE" : "BEARISH TRADE CANDIDATE"}**`);
  lines.push(`Contract: ${sym} ${mmdd(i.expiration)} $${strikeStr(i.strike)}${call ? "C" : "P"}${i.optionSymbol ? ` (${i.optionSymbol})` : ""}`);
  lines.push(`Entry: ${entryZone}`);
  lines.push(`Target 1: $${i.t1.toFixed(2)}`);
  lines.push(`Target 2: $${i.t2.toFixed(2)}`);
  lines.push(`Stop: $${i.stop.toFixed(2)}`);
  if (i.underlyingPrice != null && i.underlyingPrice > 0) {
    lines.push(`${sym} underlying: $${px(i.underlyingPrice)}`);
  }
  const alertEt = i.alertTimeEt ?? etTimeFmt.format(new Date());
  lines.push(`Alert: ${alertEt} ET | ${i.timingClass ?? "TIMELY"} | DTE ${i.dte ?? "unknown"}`);
  lines.push(`${call ? "Why now" : "Trigger"}: ${i.actionableReason ?? setupSentence(i.strategyKey)}`);
  lines.push(`Main risk: ${i.invalidation ?? (i.dte != null && i.dte <= 0 ? "0DTE premium decay and reversal risk." : "Premium decay or thesis invalidation.")}`);
  lines.push(`Confidence: ${i.confidence != null ? Math.round(i.confidence) : "n/a"}`);
  lines.push(`Setup: ${i.strategyKey}`);
  if (liquidity) lines.push(liquidity);
  if (i.dte != null && i.dte <= 0) lines.push("0DTE: high risk, small size.");
  else if (i.dte != null && i.dte <= 2) lines.push("Short-dated: manage risk.");
  return lines.join("\n");
}
