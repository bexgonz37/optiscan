/**
 * lib/research/discovery/eligibility.ts — broad-universe eligibility + STRICT exclusion gates for
 * the shadow discovery layer (Broad Discovery Bridge). PURE. No I/O.
 *
 * This is a SUPERSET-then-strictly-gate design: the broad layer may ingest anything, but a
 * candidate is only "eligible" for the shadow analog bridge if it clears every hard exclusion. It
 * never sends an alert and never relaxes the production `broadStockEligibility` floor — it records
 * candidates + rejection reasons so we can measure coverage before anything becomes actionable.
 */

export type SecurityType = "common" | "etf" | "adr" | "otc" | "warrant" | "right" | "unit" | "preferred" | "unknown";

export interface DiscoveryCandidateInput {
  symbol: string;
  securityType?: SecurityType | null;
  price: number | null;
  dayDollarVolume: number | null;   // underlying $ volume (price × shares)
  halted?: boolean;
  lastTradeAgeMs?: number | null;    // staleness of the underlying print
  // optional options-chain liquidity (when entitled); absent ⇒ options gates are SKIPPED (research only)
  optionSpreadPct?: number | null;
  optionBid?: number | null;
  optionChainAgeMs?: number | null;
}

export interface EligibilityConfig {
  minPrice: number; maxPrice: number;
  minDayDollarVolume: number;
  maxUnderlyingStaleMs: number;
  maxOptionSpreadPct: number;
  maxOptionChainStaleMs: number;
}
export function defaultEligibilityConfig(env: NodeJS.ProcessEnv = process.env): EligibilityConfig {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  return {
    minPrice: n(env.DISCOVERY_MIN_PRICE, 1),
    maxPrice: n(env.DISCOVERY_MAX_PRICE, 2000),
    minDayDollarVolume: n(env.DISCOVERY_MIN_DOLLAR_VOL, 5_000_000),
    maxUnderlyingStaleMs: n(env.DISCOVERY_MAX_STALE_MS, 60_000),
    maxOptionSpreadPct: n(env.DISCOVERY_MAX_OPT_SPREAD_PCT, 15),
    maxOptionChainStaleMs: n(env.DISCOVERY_MAX_CHAIN_STALE_MS, 120_000),
  };
}

const EXCLUDED_TYPES: SecurityType[] = ["otc", "warrant", "right", "unit", "preferred"];
// symbol-shape heuristics for warrants/rights/units/preferreds when the type field is absent
function shapeExclusion(sym: string): string | null {
  const s = sym.toUpperCase();
  if (/\.(WS|WT|W|U|R|RT|P)$/.test(s)) return "symbol_suffix_derivative";
  if (/[.\-](WS|WT|U|R|RT|P)$/.test(s)) return "symbol_suffix_derivative";
  if (/W$/.test(s) && s.length >= 5) return "warrant_shape";
  return null;
}

export interface EligibilityResult { eligible: boolean; exclusions: string[]; optionsChecked: boolean }

/** Apply every hard exclusion. Options gates run only when option fields are present (entitlement). */
export function classifyEligibility(input: DiscoveryCandidateInput, cfg: EligibilityConfig = defaultEligibilityConfig()): EligibilityResult {
  const ex: string[] = [];
  const type = input.securityType ?? "unknown";
  if (EXCLUDED_TYPES.includes(type)) ex.push(`security_type_${type}`);
  const shape = shapeExclusion(input.symbol);
  if (shape) ex.push(shape);
  if (input.halted) ex.push("halted");
  if (input.price == null || !Number.isFinite(input.price)) ex.push("no_price");
  else if (input.price < cfg.minPrice) ex.push("price_too_low");
  else if (input.price > cfg.maxPrice) ex.push("price_too_high");
  if (input.dayDollarVolume == null || input.dayDollarVolume < cfg.minDayDollarVolume) ex.push("insufficient_dollar_volume");
  if (input.lastTradeAgeMs != null && input.lastTradeAgeMs > cfg.maxUnderlyingStaleMs) ex.push("stale_underlying");

  // Options-chain gates — ONLY when the caller supplied chain data (i.e. entitled). Absent ⇒ skipped
  // and flagged, never fabricated.
  const optionsChecked = input.optionSpreadPct != null || input.optionBid != null || input.optionChainAgeMs != null;
  if (optionsChecked) {
    if (input.optionBid != null && input.optionBid <= 0) ex.push("zero_bid_contract");
    if (input.optionSpreadPct != null && input.optionSpreadPct > cfg.maxOptionSpreadPct) ex.push("extreme_option_spread");
    if (input.optionChainAgeMs != null && input.optionChainAgeMs > cfg.maxOptionChainStaleMs) ex.push("stale_option_chain");
  }
  return { eligible: ex.length === 0, exclusions: ex, optionsChecked };
}
