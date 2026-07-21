/**
 * lib/research/discovery/options-activity.ts — ABNORMAL OPTIONS ACTIVITY discovery source
 * (shadow-only). PURE classifier over REAL provider chain snapshots (fetchOptionChain). It uses ONLY
 * what the snapshot proves: per-contract volume, open interest, bid/ask spread, DTE, strike, IV, and
 * aggregate call/put balance.
 *
 * HONESTY (hard rule): the present-time snapshot has NO trade-level tape, so this NEVER labels
 * activity as sweeps / aggressive / institutional / opening-vs-closing flow — `flowClassification`
 * is always "unclassified_no_trade_data". It abstains when the data cannot support a conclusion.
 * Nothing here is actionable; puts stay RESEARCH_ONLY; no alert is created.
 */
export interface OptionContract {
  side: "call" | "put";
  strike: number; dte: number | null; bid: number | null; ask: number | null; spreadPct: number | null;
  volume: number; openInterest: number; iv: number | null; providerTimestamp: number | null;
}
export interface OptionsActivityInput {
  symbol: string;
  underlyingPrice: number | null;
  underlyingDollarVolume: number | null;
  contracts: OptionContract[];
  chainAvailable: boolean;         // provider provenance — false ⇒ abstain (no fabrication)
  baselineDailyOptionVolume?: number | null; // normal total option volume, if known
}
export interface OptionsActivityConfig {
  maxChainStaleMs: number; minContractOI: number; minContractVolume: number; maxSpreadPct: number;
  unusualVolOIRatio: number; unusualVolVsBaseline: number; directionalImbalance: number; minLiquidContracts: number; minUnderlyingDollarVol: number;
}
export function defaultOptionsActivityConfig(env: NodeJS.ProcessEnv = process.env): OptionsActivityConfig {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  return {
    maxChainStaleMs: n(env.OA_MAX_CHAIN_STALE_MS, 120_000), minContractOI: n(env.OA_MIN_OI, 200), minContractVolume: n(env.OA_MIN_VOL, 100),
    maxSpreadPct: n(env.OA_MAX_SPREAD_PCT, 15), unusualVolOIRatio: n(env.OA_UNUSUAL_VOL_OI, 2), unusualVolVsBaseline: n(env.OA_UNUSUAL_VS_BASELINE, 2),
    directionalImbalance: n(env.OA_DIRECTIONAL_IMBALANCE, 0.7), minLiquidContracts: n(env.OA_MIN_LIQUID_CONTRACTS, 3), minUnderlyingDollarVol: n(env.OA_MIN_UNDERLYING_DOLLAR_VOL, 5_000_000),
  };
}

export interface OptionsActivityResult {
  symbol: string;
  abstain: boolean;
  reasons: string[];
  flowClassification: "unclassified_no_trade_data"; // NEVER "institutional"/"sweep" from a snapshot
  callPutVolRatio: number | null;
  directionalImbalance: number | null;   // call share of (call+put) liquid volume; null when ambiguous
  direction: "call_skew" | "put_skew" | "ambiguous" | null;
  totalOptionVolume: number;
  volVsBaselineRatio: number | null;
  liquidUnusualContracts: number;        // contracts with vol/OI ≥ threshold that also pass liquidity gates
  strikesInvolved: number; expirationsInvolved: number;
  maxContractVolOI: number | null;
}

export function classifyOptionsActivity(input: OptionsActivityInput, nowMs: number, cfg: OptionsActivityConfig = defaultOptionsActivityConfig()): OptionsActivityResult {
  const reasons: string[] = [];
  const base = (extra: Partial<OptionsActivityResult> = {}): OptionsActivityResult => ({
    symbol: input.symbol.toUpperCase(), abstain: true, reasons, flowClassification: "unclassified_no_trade_data",
    callPutVolRatio: null, directionalImbalance: null, direction: null, totalOptionVolume: 0, volVsBaselineRatio: null,
    liquidUnusualContracts: 0, strikesInvolved: 0, expirationsInvolved: 0, maxContractVolOI: null, ...extra,
  });

  if (!input.chainAvailable) { reasons.push("chain_unavailable_or_no_provenance"); return base(); }
  if (input.underlyingDollarVolume == null || input.underlyingDollarVolume < cfg.minUnderlyingDollarVol) reasons.push("insufficient_underlying_dollar_volume");
  const stamps = input.contracts.map((c) => c.providerTimestamp).filter((x): x is number => typeof x === "number");
  if (stamps.length === 0) { reasons.push("no_provenance_timestamp"); return base(); }
  const chainAgeMs = nowMs - Math.max(...stamps);
  if (chainAgeMs > cfg.maxChainStaleMs) { reasons.push("stale_option_chain"); return base(); }

  // Liquidity-gate each contract; only liquid contracts count toward "unusual" evidence.
  const liquid = input.contracts.filter((c) => {
    if (c.bid != null && c.bid <= 0) return false;          // zero-bid
    if (c.spreadPct != null && c.spreadPct > cfg.maxSpreadPct) return false; // excessive spread
    if ((c.openInterest ?? 0) < cfg.minContractOI) return false;
    if ((c.volume ?? 0) < cfg.minContractVolume) return false;
    return true;
  });
  if (liquid.length < cfg.minLiquidContracts) { reasons.push("insufficient_liquid_contracts"); return base({ totalOptionVolume: input.contracts.reduce((a, c) => a + (c.volume ?? 0), 0) }); }

  const callVol = liquid.filter((c) => c.side === "call").reduce((a, c) => a + c.volume, 0);
  const putVol = liquid.filter((c) => c.side === "put").reduce((a, c) => a + c.volume, 0);
  const totalOptionVolume = callVol + putVol;
  const callPutVolRatio = putVol > 0 ? +(callVol / putVol).toFixed(3) : null;
  const share = totalOptionVolume > 0 ? callVol / totalOptionVolume : null;
  let direction: OptionsActivityResult["direction"] = null;
  let directionalImbalance: number | null = null;
  if (share != null) {
    if (share >= cfg.directionalImbalance) { direction = "call_skew"; directionalImbalance = +share.toFixed(3); }
    else if (1 - share >= cfg.directionalImbalance) { direction = "put_skew"; directionalImbalance = +share.toFixed(3); }
    else { direction = "ambiguous"; directionalImbalance = null; reasons.push("directionally_ambiguous"); }
  }

  const unusual = liquid.filter((c) => c.openInterest > 0 && c.volume / c.openInterest >= cfg.unusualVolOIRatio);
  const volVsBaselineRatio = input.baselineDailyOptionVolume && input.baselineDailyOptionVolume > 0 ? +(totalOptionVolume / input.baselineDailyOptionVolume).toFixed(3) : null;
  const strikesInvolved = new Set(unusual.map((c) => c.strike)).size;
  const expirationsInvolved = new Set(unusual.map((c) => c.dte)).size;
  const maxContractVolOI = unusual.length ? +Math.max(...unusual.map((c) => c.volume / c.openInterest)).toFixed(3) : null;

  // "Abnormal" requires unusual vol/OI OR vol-vs-baseline — and never claims flow type.
  const abnormal = unusual.length >= 1 || (volVsBaselineRatio != null && volVsBaselineRatio >= cfg.unusualVolVsBaseline);
  if (!abnormal) reasons.push("no_abnormal_activity");

  return base({
    abstain: !abnormal, reasons,
    callPutVolRatio, directionalImbalance, direction, totalOptionVolume, volVsBaselineRatio,
    liquidUnusualContracts: unusual.length, strikesInvolved, expirationsInvolved, maxContractVolOI,
  });
}
