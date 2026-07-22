/**
 * lib/research/options/targets.ts — deterministic OPTION-PRICE targets + invalidation from the frozen
 * decision-time midpoint. PURE. No fabricated precision: a fixed per-strategy risk model → a stop a set
 * % below the midpoint, then T1 = +1R and T2 = +2R (R = mid − stop). The methodology string is persisted
 * so grading uses the EXACT levels the subscriber received. Values are option premiums, rounded to cents.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Per-strategy stop distance (fraction of the option midpoint). Fast/0DTE setups decay quicker → a
 *  tighter stop; multi-day swings get more room. Deterministic; overridable via OPTIONS_STOP_PCT. */
const STOP_PCT: Record<string, number> = {
  momentum_acceleration: 0.35, zero_dte_index: 0.35, index_intraday_momentum: 0.35, confirmed_breakout: 0.35,
  opening_range_breakout: 0.38, premarket_level_break: 0.38, failed_breakout: 0.38,
  breakout_forming: 0.45, sr_reclaim: 0.45, pullback_continuation: 0.45, trend_continuation: 0.45,
  vol_compression_expansion: 0.45, reversal_bounce: 0.45, short_dated_directional: 0.45,
  unusual_options_activity: 0.45, earnings_continuation: 0.5, earnings_reversal: 0.5, longer_dated_swing: 0.5,
};

export interface OptionTargets { t1: number; t2: number; stop: number; rMultiple: number; methodology: string }

/** Deterministic T1/T2/Stop from the frozen midpoint. Always returns a valid, ordered set
 *  (stop < mid < T1 < T2), so an alert can never be published with a missing or "n/a" target. */
export function computeOptionTargets(entryMid: number, strategyKey: string, env: NodeJS.ProcessEnv = process.env): OptionTargets {
  const override = Number(env.OPTIONS_STOP_PCT);
  const stopPct = Number.isFinite(override) && override > 0 && override < 1 ? override : (STOP_PCT[strategyKey] ?? 0.45);
  const mid = round2(Math.max(0.01, entryMid));
  const stop = Math.max(0.01, round2(mid * (1 - stopPct)));
  const r = Math.max(0.01, round2(mid - stop));       // one R in option-premium terms
  const t1 = round2(mid + r);
  const t2 = round2(mid + 2 * r);
  return { t1, t2, stop, rMultiple: r, methodology: `mid=${mid.toFixed(2)}; stop=-${Math.round(stopPct * 100)}% (${stop.toFixed(2)}); R=${r.toFixed(2)}; T1=+1R (${t1.toFixed(2)}); T2=+2R (${t2.toFixed(2)})` };
}
