/**
 * Strategy family labels for Aggressive 0DTE Research (distinct; not one generic label).
 */

export const STRATEGY_FAMILIES = [
  "opening_range_breakout",
  "opening_range_rejection",
  "vwap_reclaim",
  "vwap_rejection",
  "trend_continuation",
  "pullback_continuation",
  "momentum_breakout",
  "failed_breakout_reversal",
  "gamma_squeeze_continuation",
  "liquidity_sweep_reversal",
  "support_bounce",
  "resistance_rejection",
  "high_of_day_break",
  "low_of_day_break",
  "power_hour_continuation",
  "power_hour_reversal",
] as const;

export type StrategyFamily = (typeof STRATEGY_FAMILIES)[number];

/** Map research family → nearest existing catalog strategy key (for signal reuse). */
export const FAMILY_TO_CATALOG: Record<StrategyFamily, string> = {
  opening_range_breakout: "opening_range_breakout",
  opening_range_rejection: "failed_breakout",
  vwap_reclaim: "sr_reclaim",
  vwap_rejection: "failed_breakout",
  trend_continuation: "trend_continuation",
  pullback_continuation: "pullback_continuation",
  momentum_breakout: "momentum_acceleration",
  failed_breakout_reversal: "failed_breakout",
  gamma_squeeze_continuation: "vol_compression_expansion",
  liquidity_sweep_reversal: "reversal_bounce",
  support_bounce: "reversal_bounce",
  resistance_rejection: "failed_breakout",
  high_of_day_break: "confirmed_breakout",
  low_of_day_break: "confirmed_breakout",
  power_hour_continuation: "index_intraday_momentum",
  power_hour_reversal: "reversal_bounce",
};

export type TimeBucket =
  | "pre_open"
  | "open_drive"
  | "mid_morning"
  | "lunch"
  | "afternoon"
  | "power_hour"
  | "other";

/** America/New_York wall-clock bucket for research tagging. */
export function timeBucketEt(nowMs: number): TimeBucket {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const m = hour * 60 + minute;
  if (m < 9 * 60 + 30) return "pre_open";
  if (m < 10 * 60) return "open_drive";
  if (m < 11 * 60 + 30) return "mid_morning";
  if (m < 13 * 60 + 30) return "lunch";
  if (m < 15 * 60) return "afternoon";
  if (m < 16 * 60) return "power_hour";
  return "other";
}

export function tradingSessionDateEt(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

export function researchFingerprint(input: {
  symbol: string;
  family: string;
  side: string;
  sessionDate: string;
  timeBucket: string;
}): string {
  return [
    input.symbol.toUpperCase(),
    input.family,
    input.side.toLowerCase(),
    input.sessionDate,
    input.timeBucket,
  ].join("|");
}
