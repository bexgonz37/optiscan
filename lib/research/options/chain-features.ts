/**
 * lib/research/options/chain-features.ts — decision-time OPTIONS-chain feature summary (Stage 2).
 * PURE. Uses only real snapshot fields (vol, OI, bid/ask/spread, DTE, strike, IV). NEVER labels
 * "sweep"/"institutional"/directional flow — the snapshot has no trade tape. Reuses the abstain-safe
 * classifyOptionsActivity for the abnormal-activity signal.
 */
import { classifyOptionsActivity, defaultOptionsActivityConfig, type OptionContract } from "../discovery/options-activity.ts";

export type ChainContractIn = OptionContract & { optionSymbol?: string };
export interface ChainFeatureInput { symbol: string; underlyingPrice: number | null; underlyingDollarVolume: number | null; contracts: ChainContractIn[]; chainAvailable: boolean; baselineDailyOptionVolume?: number | null; nowMs: number }

export interface ChainFeatures {
  available: boolean; chainAgeMs: number | null;
  callVol: number; putVol: number; callPutVolRatio: number | null;
  aggregateVolOI: number | null; strikesActive: number; expirationsActive: number; ntmConcentration: number | null;
  ivLevel: number | null; medianSpreadPct: number | null; zeroBidRate: number | null;
  bestByDte: Record<string, string | null>;  // best (tightest, liquid) contract symbol per DTE band
  abnormal: boolean; direction: "call_skew" | "put_skew" | "ambiguous" | null; flowClassification: string; reasons: string[];
}

const band = (dte: number) => (dte <= 0 ? "0dte" : dte <= 7 ? "1-7dte" : dte <= 14 ? "8-14dte" : dte <= 30 ? "15-30dte" : dte <= 90 ? "31-90dte" : "longer");

export function summarizeChainFeatures(input: ChainFeatureInput): ChainFeatures {
  const empty: ChainFeatures = { available: false, chainAgeMs: null, callVol: 0, putVol: 0, callPutVolRatio: null, aggregateVolOI: null, strikesActive: 0, expirationsActive: 0, ntmConcentration: null, ivLevel: null, medianSpreadPct: null, zeroBidRate: null, bestByDte: {}, abnormal: false, direction: null, flowClassification: "unclassified_no_trade_data", reasons: ["chain_unavailable"] };
  if (!input.chainAvailable || input.contracts.length === 0) return empty;
  const cs = input.contracts;
  const stamps = cs.map((c) => c.providerTimestamp).filter((x): x is number => typeof x === "number");
  const chainAgeMs = stamps.length ? input.nowMs - Math.max(...stamps) : null;

  const callVol = cs.filter((c) => c.side === "call").reduce((a, c) => a + (c.volume ?? 0), 0);
  const putVol = cs.filter((c) => c.side === "put").reduce((a, c) => a + (c.volume ?? 0), 0);
  const callPutVolRatio = putVol > 0 ? +(callVol / putVol).toFixed(3) : null;
  const totVol = callVol + putVol, totOI = cs.reduce((a, c) => a + (c.openInterest ?? 0), 0);
  const aggregateVolOI = totOI > 0 ? +(totVol / totOI).toFixed(3) : null;
  const activeContracts = cs.filter((c) => (c.volume ?? 0) > 0);
  const strikesActive = new Set(activeContracts.map((c) => c.strike)).size;
  const expirationsActive = new Set(activeContracts.map((c) => c.dte)).size;
  const px = input.underlyingPrice ?? 0;
  const ntmVol = px > 0 ? activeContracts.filter((c) => Math.abs((c.strike - px) / px) <= 0.03).reduce((a, c) => a + (c.volume ?? 0), 0) : 0;
  const ntmConcentration = totVol > 0 ? +(ntmVol / totVol).toFixed(3) : null;
  const ivs = cs.map((c) => c.iv).filter((x): x is number => typeof x === "number" && x > 0);
  const ivLevel = ivs.length ? +(ivs.reduce((a, x) => a + x, 0) / ivs.length).toFixed(4) : null;
  const spreads = cs.map((c) => c.spreadPct).filter((x): x is number => typeof x === "number");
  const medianSpreadPct = spreads.length ? +median(spreads).toFixed(3) : null;
  const zeroBidRate = cs.length ? +(cs.filter((c) => (c.bid ?? 0) <= 0).length / cs.length).toFixed(3) : null;

  const bestByDte: Record<string, string | null> = {};
  for (const b of ["0dte", "1-7dte", "8-14dte", "15-30dte", "31-90dte", "longer"]) {
    const inBand = cs.filter((c) => band(c.dte ?? 0) === b && (c.bid ?? 0) > 0 && (c.spreadPct == null || c.spreadPct <= 12) && (c.openInterest ?? 0) >= 200);
    bestByDte[b] = inBand.sort((a, b2) => (a.spreadPct ?? 999) - (b2.spreadPct ?? 999))[0]?.optionSymbol ?? null;
  }

  const act = classifyOptionsActivity({ symbol: input.symbol, underlyingPrice: input.underlyingPrice, underlyingDollarVolume: input.underlyingDollarVolume, contracts: cs, chainAvailable: true, baselineDailyOptionVolume: input.baselineDailyOptionVolume }, input.nowMs, defaultOptionsActivityConfig());
  return {
    available: true, chainAgeMs, callVol, putVol, callPutVolRatio, aggregateVolOI, strikesActive, expirationsActive, ntmConcentration,
    ivLevel, medianSpreadPct, zeroBidRate, bestByDte,
    abnormal: !act.abstain, direction: act.direction, flowClassification: act.flowClassification, reasons: act.reasons,
  };
}

/** Map chain features → the optionsActivity block the candidate scorer consumes. */
export function chainFeaturesToActivity(f: ChainFeatures): { volOIRatio: number | null; volVsBaseline: number | null; direction: string | null; multiStrike: boolean; multiExpiration: boolean; ivChange: number | null } {
  return { volOIRatio: f.aggregateVolOI, volVsBaseline: null, direction: f.direction, multiStrike: f.strikesActive >= 3, multiExpiration: f.expirationsActive >= 2, ivChange: null };
}

/** OptionContract type re-export type for callers that build chains. */
export type { OptionContract };

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
