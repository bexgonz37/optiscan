/**
 * lib/research/options/strategy-catalog.ts — the OPTIONS Opportunity Scanner strategy catalog
 * (Options product, distinct from the Stock Momentum Radar). PURE. No I/O.
 *
 * The Stock Momentum Radar's ~+10% broad-mover rule is intentional and untouched. Options
 * strategies here have their OWN triggers/gates/DTE/moneyness/spread/liquidity/freshness/chase/
 * stop/targets/holding/session/grading and do NOT require the underlying to already be up 10%.
 * This catalog is a formal definition set (data), used by the shadow pipeline and reporting; it is
 * NOT actionable and does not send alerts. Puts remain RESEARCH_ONLY; bearish-gate.ts is authority.
 */
export type OptionSide = "call" | "put" | "either";
export type TenorBand = "0dte" | "1-7dte" | "8-14dte" | "15-30dte" | "31-90dte" | "longer";
export type Session = "premarket" | "regular" | "afterhours" | "any";
export type GradingMethod = "underlying_forward_return" | "real_option_pl" | "modeled_option_reprice";

export interface StrategyDef {
  key: string;
  label: string;
  side: OptionSide;
  /** Deterministic EARLY entry trigger — NOT "underlying up 10%". Human-readable + machine keys. */
  entryTrigger: string;
  earlySignals: string[];                 // strategy-appropriate early signals it keys on
  underlyingLiquidity: { minDollarVol: number; minPrice: number };
  optionsLiquidity: { minOpenInterest: number; minContractVolume: number; maxSpreadPct: number };
  preferredDte: TenorBand[];
  preferredDelta: [number, number];       // |delta| band
  moneyness: "ITM" | "ATM" | "OTM" | "ATM_OTM";
  freshnessMaxMs: number;                 // decision-to-delivery freshness limit
  chaseLimitPct: number;                  // max favorable underlying move already elapsed
  stop: string;                           // invalidation rule
  targets: string;                        // target rule
  holdingHorizon: string;
  sessions: Session[];
  grading: GradingMethod;
}

const CORE_LIQ = { minDollarVol: 20_000_000, minPrice: 5 };
const OPT_LIQ = { minOpenInterest: 500, minContractVolume: 100, maxSpreadPct: 8 };
const IDX_LIQ = { minDollarVol: 500_000_000, minPrice: 20 };
const IDX_OPT = { minOpenInterest: 2000, minContractVolume: 500, maxSpreadPct: 4 };

/** The catalog. Each strategy is INDEPENDENT of the stock +10% rule. */
export const OPTIONS_STRATEGIES: StrategyDef[] = [
  { key: "breakout_forming", label: "Breakout forming", side: "call", entryTrigger: "price compressing into a key level with volume acceleration BEFORE the break", earlySignals: ["compression_near_level", "rel_volume", "volume_acceleration", "breakout_proximity"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["1-7dte", "8-14dte"], preferredDelta: [0.35, 0.55], moneyness: "ATM_OTM", freshnessMaxMs: 30_000, chaseLimitPct: 0.6, stop: "loss of the pre-breakout level", targets: "measured move / prior swing", holdingHorizon: "hours–2 days", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "confirmed_breakout", label: "Confirmed breakout", side: "call", entryTrigger: "level broken + hold with sustained volume", earlySignals: ["hod_break", "rel_volume", "above_vwap"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["0dte", "1-7dte"], preferredDelta: [0.45, 0.65], moneyness: "ATM", freshnessMaxMs: 20_000, chaseLimitPct: 0.8, stop: "back below the broken level", targets: "1R / 2R extension", holdingHorizon: "intraday–1 day", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "opening_range_breakout", label: "Opening-range breakout", side: "either", entryTrigger: "break of the opening range (5/15m) with volume", earlySignals: ["opening_range_development", "rel_volume", "price_acceleration"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["0dte", "1-7dte"], preferredDelta: [0.40, 0.60], moneyness: "ATM", freshnessMaxMs: 20_000, chaseLimitPct: 0.7, stop: "opposite side of the opening range", targets: "OR width extension", holdingHorizon: "intraday", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "premarket_level_break", label: "Premarket high/low break", side: "either", entryTrigger: "break of premarket high/low near the open", earlySignals: ["premarket_level_testing", "rel_volume"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["0dte", "1-7dte"], preferredDelta: [0.40, 0.60], moneyness: "ATM", freshnessMaxMs: 20_000, chaseLimitPct: 0.7, stop: "reclaim of the level", targets: "gap fill / extension", holdingHorizon: "intraday", sessions: ["premarket", "regular"], grading: "underlying_forward_return" },
  { key: "sr_reclaim", label: "Support/resistance reclaim", side: "either", entryTrigger: "reclaim of a lost level with acceptance", earlySignals: ["compression_near_level", "above_vwap", "rel_volume"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["1-7dte", "8-14dte"], preferredDelta: [0.35, 0.55], moneyness: "ATM_OTM", freshnessMaxMs: 30_000, chaseLimitPct: 0.6, stop: "loss of the reclaimed level", targets: "next level", holdingHorizon: "hours–2 days", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "pullback_continuation", label: "Pullback continuation", side: "either", entryTrigger: "shallow pullback in an established trend resuming", earlySignals: ["price_acceleration", "above_vwap"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["1-7dte", "8-14dte"], preferredDelta: [0.35, 0.55], moneyness: "ATM_OTM", freshnessMaxMs: 30_000, chaseLimitPct: 0.6, stop: "trend structure break", targets: "prior high / extension", holdingHorizon: "hours–2 days", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "trend_continuation", label: "Trend continuation", side: "either", entryTrigger: "with-trend momentum resuming at VWAP/MA", earlySignals: ["above_vwap", "price_acceleration"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["8-14dte", "15-30dte"], preferredDelta: [0.30, 0.50], moneyness: "ATM_OTM", freshnessMaxMs: 45_000, chaseLimitPct: 0.5, stop: "MA/VWAP loss", targets: "trend extension", holdingHorizon: "1–5 days", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "vol_compression_expansion", label: "Volatility compression→expansion", side: "either", entryTrigger: "range compression resolving into expansion", earlySignals: ["compression_near_level", "volatility_expansion", "iv_change"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["1-7dte", "8-14dte"], preferredDelta: [0.35, 0.55], moneyness: "ATM", freshnessMaxMs: 30_000, chaseLimitPct: 0.6, stop: "back inside the range", targets: "range height", holdingHorizon: "hours–2 days", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "momentum_acceleration", label: "Momentum acceleration", side: "either", entryTrigger: "accelerating price + volume off a base (early, not extended)", earlySignals: ["price_acceleration", "volume_acceleration", "rel_volume"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["0dte", "1-7dte"], preferredDelta: [0.40, 0.60], moneyness: "ATM", freshnessMaxMs: 15_000, chaseLimitPct: 0.8, stop: "acceleration failure", targets: "1R/2R", holdingHorizon: "intraday", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "reversal_bounce", label: "Reversal / bounce", side: "either", entryTrigger: "exhaustion + reclaim at a support/resistance extreme", earlySignals: ["compression_near_level", "volatility_expansion"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["1-7dte", "8-14dte"], preferredDelta: [0.35, 0.50], moneyness: "ATM_OTM", freshnessMaxMs: 30_000, chaseLimitPct: 0.5, stop: "new extreme", targets: "mean reversion to VWAP/MA", holdingHorizon: "hours–2 days", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "failed_breakout", label: "Failed breakout (fade)", side: "put", entryTrigger: "breakout reclaimed/rejected → fade", earlySignals: ["hod_break", "volatility_expansion"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["0dte", "1-7dte"], preferredDelta: [0.40, 0.60], moneyness: "ATM", freshnessMaxMs: 20_000, chaseLimitPct: 0.6, stop: "reclaim of the breakout high", targets: "back to range low", holdingHorizon: "intraday", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "earnings_continuation", label: "Earnings continuation", side: "either", entryTrigger: "post-earnings gap holding + continuation", earlySignals: ["earnings_timing", "earnings_gap", "abnormal_premarket_vol", "rel_volume"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["1-7dte", "8-14dte"], preferredDelta: [0.35, 0.55], moneyness: "ATM_OTM", freshnessMaxMs: 60_000, chaseLimitPct: 0.6, stop: "gap fill", targets: "measured continuation", holdingHorizon: "1–3 days", sessions: ["premarket", "regular"], grading: "underlying_forward_return" },
  { key: "earnings_reversal", label: "Earnings reversal (fade)", side: "either", entryTrigger: "post-earnings gap failing/reversing", earlySignals: ["earnings_timing", "earnings_gap", "volatility_expansion"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["1-7dte", "8-14dte"], preferredDelta: [0.35, 0.55], moneyness: "ATM_OTM", freshnessMaxMs: 60_000, chaseLimitPct: 0.5, stop: "new post-earnings extreme", targets: "gap fill", holdingHorizon: "1–3 days", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "unusual_options_activity", label: "Unusual options activity", side: "either", entryTrigger: "abnormal vol/OI + baseline with directional skew (NEVER 'sweep/institutional' without tape)", earlySignals: ["option_vol_vs_oi", "option_vol_vs_baseline", "multi_strike_activity", "multi_expiration_activity", "call_put_concentration", "iv_change"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["1-7dte", "8-14dte", "15-30dte"], preferredDelta: [0.30, 0.55], moneyness: "ATM_OTM", freshnessMaxMs: 120_000, chaseLimitPct: 0.6, stop: "underlying invalidation", targets: "strategy-dependent", holdingHorizon: "hours–days", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "index_intraday_momentum", label: "Index intraday momentum", side: "either", entryTrigger: "SPY/QQQ trend leg with breadth", earlySignals: ["above_vwap", "price_acceleration"], underlyingLiquidity: IDX_LIQ, optionsLiquidity: IDX_OPT, preferredDte: ["0dte", "1-7dte"], preferredDelta: [0.40, 0.60], moneyness: "ATM", freshnessMaxMs: 15_000, chaseLimitPct: 0.7, stop: "VWAP loss", targets: "prior swing", holdingHorizon: "intraday", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "zero_dte_index", label: "0DTE index setup", side: "either", entryTrigger: "index level break/hold intraday with time-decay awareness", earlySignals: ["opening_range_development", "above_vwap", "price_acceleration"], underlyingLiquidity: IDX_LIQ, optionsLiquidity: IDX_OPT, preferredDte: ["0dte"], preferredDelta: [0.45, 0.65], moneyness: "ATM", freshnessMaxMs: 10_000, chaseLimitPct: 0.8, stop: "level reclaim", targets: "1R fast", holdingHorizon: "minutes–hours", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "short_dated_directional", label: "Short-dated directional swing", side: "either", entryTrigger: "clean directional setup with a 1–14d thesis", earlySignals: ["above_vwap", "breakout_proximity", "rel_volume"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["8-14dte"], preferredDelta: [0.30, 0.50], moneyness: "ATM_OTM", freshnessMaxMs: 45_000, chaseLimitPct: 0.5, stop: "thesis level", targets: "swing target", holdingHorizon: "2–10 days", sessions: ["regular"], grading: "underlying_forward_return" },
  { key: "longer_dated_swing", label: "Longer-dated swing", side: "either", entryTrigger: "higher-conviction multi-week thesis (only when the swing is clearly stronger)", earlySignals: ["breakout_proximity", "compression_near_level"], underlyingLiquidity: CORE_LIQ, optionsLiquidity: OPT_LIQ, preferredDte: ["15-30dte", "31-90dte"], preferredDelta: [0.30, 0.45], moneyness: "ATM_OTM", freshnessMaxMs: 120_000, chaseLimitPct: 0.4, stop: "thesis invalidation", targets: "multi-week target", holdingHorizon: "1–8 weeks", sessions: ["regular"], grading: "underlying_forward_return" },
];

const BY_KEY = new Map(OPTIONS_STRATEGIES.map((s) => [s.key, s]));
export function getStrategy(key: string): StrategyDef | null { return BY_KEY.get(key) ?? null; }
export function strategyKeys(): string[] { return OPTIONS_STRATEGIES.map((s) => s.key); }

/** Map a DTE to its tenor band. */
export function tenorBand(dte: number): TenorBand {
  if (dte <= 0) return "0dte";
  if (dte <= 7) return "1-7dte";
  if (dte <= 14) return "8-14dte";
  if (dte <= 30) return "15-30dte";
  if (dte <= 90) return "31-90dte";
  return "longer";
}

/** Report buckets required by section L (kept SEPARATE — never one blended win rate). */
export const REPORT_TENOR_BUCKETS: TenorBand[] = ["0dte", "1-7dte", "8-14dte", "15-30dte", "31-90dte", "longer"];
