/**
 * lib/research/options/discovery.ts — INDEPENDENT options-opportunity discovery (Options product).
 * PURE. No I/O. Does NOT call shouldTrigger() and does NOT require the underlying to be up ~10%.
 *
 * Pipeline (deterministic, decision-time only):
 *   tiered universe → active early signals → per-strategy applicability + score → select the
 *   strongest valid strategy + direction + DTE, recording every considered strategy + rejection.
 * Nothing here is actionable, sends an alert, or changes a threshold. Puts stay RESEARCH_ONLY.
 */
import { OPTIONS_STRATEGIES, tenorBand, type StrategyDef, type TenorBand } from "./strategy-catalog.ts";

/** Tier-1 continuously-monitored core (high-liquidity options names). */
export const OPTIONS_TIER1 = [
  "SPY", "QQQ", "IWM", "NVDA", "TSLA", "AMD", "AMZN", "META", "AAPL", "MSFT", "GOOGL", "AVGO", "NFLX", "HOOD",
] as const;
export function optionsTier1(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = String(env.OPTIONS_TIER1_EXTRA ?? "").split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  return Array.from(new Set([...OPTIONS_TIER1, ...extra]));
}

export type Session = "premarket" | "regular" | "afterhours" | "closed";

/** Decision-time features for one candidate (only data available now). */
export interface OptionsCandidateInput {
  symbol: string;
  nowMs: number;
  session: Session;
  tier: 1 | 2;
  underlying: {
    price: number | null; dayDollarVolume: number | null; relVolume: number | null;
    velPct: number | null; accelPct: number | null; gapPct: number | null;
    aboveVwap: boolean | null; hodBreak: boolean | null;
    nearResistancePct: number | null;   // distance to a key level (small = close)
    compressionPct: number | null;      // range compression (small = tight)
    realizedVolExpanding: boolean | null;
    openingRange: boolean | null;       // early regular session ORB context
    premarketLevelTest: boolean | null;
  };
  optionsActivity?: { volOIRatio: number | null; volVsBaseline: number | null; direction: string | null; multiStrike: boolean; multiExpiration: boolean; ivChange: number | null } | null;
  earnings?: { hoursUntil: number | null; gapPct: number | null; abnormalPremarketVol: boolean } | null;
}

/** Which early-signal keys are ACTIVE for this candidate (deterministic thresholds). */
export function activeSignals(c: OptionsCandidateInput): Set<string> {
  const u = c.underlying, o = c.optionsActivity, e = c.earnings;
  const s = new Set<string>();
  if ((u.relVolume ?? 0) >= 2) s.add("rel_volume");
  if ((u.accelPct ?? 0) > 0) { s.add("price_acceleration"); s.add("volume_acceleration"); }
  if (u.nearResistancePct != null && u.nearResistancePct <= 0.5) s.add("breakout_proximity");
  if (u.compressionPct != null && u.compressionPct <= 1.0) s.add("compression_near_level");
  if (u.hodBreak) s.add("hod_break");
  if (u.aboveVwap) s.add("above_vwap");
  if (u.openingRange) s.add("opening_range_development");
  if (u.premarketLevelTest) s.add("premarket_level_testing");
  if (u.realizedVolExpanding) s.add("volatility_expansion");
  if (o) {
    if ((o.volOIRatio ?? 0) >= 2) s.add("option_vol_vs_oi");
    if ((o.volVsBaseline ?? 0) >= 2) s.add("option_vol_vs_baseline");
    if (o.multiStrike) s.add("multi_strike_activity");
    if (o.multiExpiration) s.add("multi_expiration_activity");
    if (o.direction && o.direction !== "ambiguous") s.add("call_put_concentration");
    if (o.ivChange != null && Math.abs(o.ivChange) >= 0.02) s.add("iv_change");
  }
  if (e) {
    if (e.hoursUntil != null && Math.abs(e.hoursUntil) <= 48) s.add("earnings_timing");
    if (e.gapPct != null && Math.abs(e.gapPct) >= 4) s.add("earnings_gap");
    if (e.abnormalPremarketVol) s.add("abnormal_premarket_vol");
  }
  return s;
}

export interface StrategyScore { key: string; label: string; applicable: boolean; score: number; matched: string[]; rejection: string | null }

/** Score every strategy against the candidate (decision-time only). */
export function scoreStrategies(c: OptionsCandidateInput, minMatch = 0.5): StrategyScore[] {
  const active = activeSignals(c);
  const sessionOk = (st: StrategyDef) => st.sessions.includes("any") || st.sessions.includes(c.session as any);
  return OPTIONS_STRATEGIES.map((st) => {
    const matched = st.earlySignals.filter((sig) => active.has(sig));
    const score = st.earlySignals.length ? matched.length / st.earlySignals.length : 0;
    let rejection: string | null = null;
    if (!sessionOk(st)) rejection = `session ${c.session} not allowed`;
    else if (score < minMatch) rejection = `insufficient early signals (${matched.length}/${st.earlySignals.length})`;
    return { key: st.key, label: st.label, applicable: rejection == null, score: +score.toFixed(3), matched, rejection };
  });
}

export type OptionSide = "call" | "put";
export interface StrategySelection {
  symbol: string;
  selected: { key: string; label: string; score: number; side: OptionSide; researchOnly: boolean; preferredDte: TenorBand } | null;
  direction: "bullish" | "bearish" | null;
  considered: StrategyScore[];
  reason: string;
}

/** Select the strongest valid strategy + direction + DTE. Records every considered strategy. */
export function selectOptionsStrategy(c: OptionsCandidateInput, opts: { bearishActionable?: boolean } = {}): StrategySelection {
  const considered = scoreStrategies(c).sort((a, b) => b.score - a.score);
  const applicable = considered.filter((s) => s.applicable);
  if (applicable.length === 0) return { symbol: c.symbol, selected: null, direction: null, considered, reason: "no applicable strategy at decision time" };
  const top = applicable[0];
  const def = OPTIONS_STRATEGIES.find((s) => s.key === top.key)!;
  // Direction: from the candidate's velocity unless the strategy is side-locked.
  const vel = c.underlying.velPct ?? 0;
  let side: OptionSide = def.side === "call" ? "call" : def.side === "put" ? "put" : vel >= 0 ? "call" : "put";
  const direction: "bullish" | "bearish" = side === "call" ? "bullish" : "bearish";
  // puts are RESEARCH_ONLY for public actionable output unless bearish is actionable (default off).
  const researchOnly = side === "put" && !opts.bearishActionable;
  return {
    symbol: c.symbol,
    selected: { key: def.key, label: def.label, score: top.score, side, researchOnly, preferredDte: def.preferredDte[0] },
    direction, considered,
    reason: `selected ${def.key} (score ${top.score})`,
  };
}

/** Tier-2 broad-optionable eligibility (underlying + chain-usability gate; options gates optional). */
export interface Tier2GateInput { symbol: string; securityType?: string | null; price: number | null; dayDollarVolume: number | null; halted?: boolean; lastTradeAgeMs?: number | null; hasUsableChain?: boolean | null; bestBid?: number | null; bestSpreadPct?: number | null; optionVolumeOrOI?: number | null }
export interface Tier2Config { minPrice: number; minDollarVol: number; maxStaleMs: number; maxSpreadPct: number; minVolOrOI: number }
export function defaultTier2Config(env: NodeJS.ProcessEnv = process.env): Tier2Config {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  return { minPrice: n(env.OPT_T2_MIN_PRICE, 3), minDollarVol: n(env.OPT_T2_MIN_DOLLAR_VOL, 20_000_000), maxStaleMs: n(env.OPT_T2_MAX_STALE_MS, 60_000), maxSpreadPct: n(env.OPT_T2_MAX_SPREAD_PCT, 12), minVolOrOI: n(env.OPT_T2_MIN_VOL_OI, 250) };
}
const EXCLUDED = new Set(["otc", "warrant", "right", "unit", "preferred"]);
export function tier2Eligible(i: Tier2GateInput, cfg: Tier2Config = defaultTier2Config()): { eligible: boolean; rejections: string[] } {
  const r: string[] = [];
  if (i.securityType && EXCLUDED.has(String(i.securityType).toLowerCase())) r.push(`security_type_${i.securityType}`);
  if (/W$/.test(i.symbol.toUpperCase()) && i.symbol.length >= 5) r.push("warrant_shape");
  if (i.halted) r.push("halted");
  if (i.price == null || i.price < cfg.minPrice) r.push("price_or_missing");
  if (i.dayDollarVolume == null || i.dayDollarVolume < cfg.minDollarVol) r.push("insufficient_underlying_liquidity");
  if (i.lastTradeAgeMs != null && i.lastTradeAgeMs > cfg.maxStaleMs) r.push("stale_underlying");
  if (i.hasUsableChain === false) r.push("no_usable_chain");
  if (i.bestBid != null && i.bestBid <= 0) r.push("zero_bid");
  if (i.bestSpreadPct != null && i.bestSpreadPct > cfg.maxSpreadPct) r.push("spread_too_wide");
  if (i.optionVolumeOrOI != null && i.optionVolumeOrOI < cfg.minVolOrOI) r.push("insufficient_option_liquidity");
  return { eligible: r.length === 0, rejections: r };
}

export { tenorBand };
