/**
 * lib/research/context/market-context.ts — prospective market-context feature capture (Broad
 * Discovery + Analog Shadow Bridge, part D). PURE. Every field is built from data available AT the
 * decision time (`asOfMs`); a leakage guard REJECTS any input observed after asOfMs so context can
 * never be backfilled with future information.
 */
export type Trend = "up" | "down" | "flat";
export type Regime = "risk_on" | "risk_off" | "neutral";
export type VolRegime = "low" | "normal" | "elevated" | "high";
export type Session = "premarket" | "regular" | "afterhours" | "closed";

export interface MarketContextInput {
  asOfMs: number;
  spy: { trend: Trend; observedAtMs: number } | null;
  qqq: { trend: Trend; observedAtMs: number } | null;
  iwm: { trend: Trend; observedAtMs: number } | null;
  vix: { value: number; observedAtMs: number } | null;
  sector: string | null;
  industry: string | null;
  sectorRelStrengthPct: number | null;   // symbol vs its sector ETF, decision-time
  breadthAdvDeclRatio: number | null;     // advancers/decliners, decision-time
  catalystCategory: string | null;        // earnings|guidance|mna|fda|analyst|macro|none
  earningsInDays: number | null;          // days to next earnings (>=0), null if unknown
  session: Session;
  underlyingLiquidityTier: "high" | "medium" | "low" | null;
  optionsLiquidityTier: "high" | "medium" | "low" | null;
  optionSpreadPct: number | null;
  ivRankPct: number | null;               // IV context when entitled; null otherwise
}

export interface MarketContext {
  asOfMs: number;
  regime: Regime;
  indexTrend: { spy: Trend | null; qqq: Trend | null; iwm: Trend | null };
  volRegime: VolRegime | null;
  sector: string | null; industry: string | null; sectorRelStrengthPct: number | null;
  breadthAdvDeclRatio: number | null;
  catalystCategory: string | null; earningsInDays: number | null;
  session: Session;
  underlyingLiquidityTier: string | null; optionsLiquidityTier: string | null; optionSpreadPct: number | null;
  ivRankPct: number | null;
  missing: string[];        // fields not available at decision time (never fabricated)
}

const volRegime = (vix: number): VolRegime => (vix < 14 ? "low" : vix < 20 ? "normal" : vix < 28 ? "elevated" : "high");

/** Build the decision-time context. Throws if any component was observed AFTER asOfMs (no look-ahead). */
export function buildMarketContext(input: MarketContextInput): MarketContext {
  for (const [k, v] of [["spy", input.spy], ["qqq", input.qqq], ["iwm", input.iwm], ["vix", input.vix]] as const) {
    if (v && v.observedAtMs > input.asOfMs) throw new Error(`market-context leakage: ${k} observed after asOfMs`);
  }
  const missing: string[] = [];
  const track = (name: string, val: unknown) => { if (val == null) missing.push(name); };
  track("spy", input.spy); track("qqq", input.qqq); track("iwm", input.iwm); track("vix", input.vix);
  track("sector", input.sector); track("breadth", input.breadthAdvDeclRatio);
  track("catalyst", input.catalystCategory); track("iv", input.ivRankPct); track("optionsLiquidity", input.optionsLiquidityTier);

  const ups = [input.spy?.trend, input.qqq?.trend, input.iwm?.trend].filter((t) => t === "up").length;
  const downs = [input.spy?.trend, input.qqq?.trend, input.iwm?.trend].filter((t) => t === "down").length;
  const vr = input.vix ? volRegime(input.vix.value) : null;
  const regime: Regime = ups >= 2 && (vr === "low" || vr === "normal" || vr == null) ? "risk_on" : downs >= 2 || vr === "high" ? "risk_off" : "neutral";

  return {
    asOfMs: input.asOfMs, regime,
    indexTrend: { spy: input.spy?.trend ?? null, qqq: input.qqq?.trend ?? null, iwm: input.iwm?.trend ?? null },
    volRegime: vr,
    sector: input.sector, industry: input.industry, sectorRelStrengthPct: input.sectorRelStrengthPct,
    breadthAdvDeclRatio: input.breadthAdvDeclRatio,
    catalystCategory: input.catalystCategory, earningsInDays: input.earningsInDays,
    session: input.session,
    underlyingLiquidityTier: input.underlyingLiquidityTier, optionsLiquidityTier: input.optionsLiquidityTier, optionSpreadPct: input.optionSpreadPct,
    ivRankPct: input.ivRankPct,
    missing,
  };
}
