/**
 * contract-discovery.ts — targeted, side-specific option contract discovery.
 *
 * THE DEFECT THIS FIXES, measured rather than assumed.
 *
 * On 2026-08-03, SPY and QQQ produced 98 bullish candidate rows each and **zero
 * priced call contracts**. Session-wide, `no eligible contract in the preferred
 * delta/DTE band` terminated 5,039 of 9,214 candidates — 54.7% of the funnel.
 *
 * The obvious suspect was page truncation. It was wrong. A bounded probe of the
 * exact Stage-2 request showed calls arriving in quantity: 330 SPY calls and 296
 * QQQ calls inside the first two pages. The real cause is one line of filtering:
 *
 *     cand = chain.filter(c => ... && c.delta != null)
 *
 * The provider does not publish greeks for a large share of SHORT-DATED
 * contracts — precisely the ones a 0DTE or 1-7DTE strategy wants. Measured on
 * the same probe:
 *
 *     SPY 0DTE calls: 170 returned,  55 with delta,  1 in the 0.35-0.65 band
 *     QQQ 0DTE calls: 204 returned,  71 with delta,  0 in the band
 *     NVDA (control):                              8 in the band → calls priced
 *
 * And the contracts being discarded were not marginal:
 *
 *     O:SPY260803C00736000  bid 21.85  ask 22.17  OI 1705  delta NULL
 *     O:QQQ260803C00685000  bid 15.06  ask 15.55  OI 6352  delta NULL
 *
 * Liquid, two-sided, near-the-money 0DTE calls, thrown away because a greek was
 * missing. A missing model output is a gap in the DATA, not evidence about the
 * CONTRACT, and treating the two as the same thing silently deleted the entire
 * call side on the two most liquid underlyings in the market.
 *
 * WHAT THIS MODULE CHANGES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 *  1. Discovery is SIDE-SPECIFIC. A bullish candidate asks the provider for
 *     calls (`contract_type=call`) instead of pulling a mixed chain and throwing
 *     half of it away. Same request budget, roughly twice the usable coverage.
 *  2. Discovery is PARTITIONED SHORT-DTE-FIRST, so a 0DTE strategy spends its
 *     first request on 0DTE rather than on whatever ticker-ascending ordering
 *     happens to return.
 *  3. When delta is ABSENT, the contract falls back to a deterministic MONEYNESS
 *     proxy and is labelled `MONEYNESS_PROXY`. It is never presented as though a
 *     delta were known.
 *
 * It does NOT weaken liquidity or spread. Those gates run DOWNSTREAM of
 * selection (the "contract gate"), are untouched by this module, and still
 * reject anything thin or wide. This module decides what reaches the gate; it
 * never decides what survives it. Nothing here raises a provider cap.
 */
import { getStrategy, type TenorBand } from "./strategy-catalog.ts";
import type { ChainContract, ChainFetchOutcome } from "./loop.ts";

/** Why contract discovery ended the way it did. Persisted verbatim. */
export type ContractTerminalReason =
  | "CONTRACT_SELECTED"
  | "NO_CALLS_RETURNED"
  | "NO_PUTS_RETURNED"
  | "WRONG_SIDE_RETURNED"
  | "PAGE_LIMIT_REACHED"
  | "CHAIN_TRUNCATION_SUSPECTED"
  | "NO_CONTRACT_IN_DTE_RANGE"
  | "NO_CONTRACT_IN_DELTA_RANGE"
  | "NO_CONTRACT_IN_MONEYNESS_RANGE"
  | "NO_TWO_SIDED_MARKET"
  | "LIQUIDITY_REJECTED"
  | "SPREAD_REJECTED"
  | "PREMIUM_REJECTED"
  | "CONTRACT_RANKING_EMPTY"
  | "PROVIDER_BUDGET_BLOCKED"
  /* Distinct outcomes that a bare `chain.length === 0` used to collapse into
   * PROVIDER_ERROR. A successful empty response is not a failure; our own budget
   * refusing the call is not the provider's fault; an absent API key is not a
   * market-data result at all. */
  | "NO_CONTRACTS_RETURNED"
  | "PROVIDER_QUOTA_EXCEEDED"
  | "PROVIDER_CONFIGURATION_MISSING"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ERROR"
  | "INSUFFICIENT_EVIDENCE";

/** How the selected contract's delta was established. Never implied. */
export type DeltaSource = "PROVIDER_DELTA" | "MONEYNESS_PROXY";

/** Version stamps so a stored funnel row records the rules that produced it. */
export const DISCOVERY_VERSION = "contract-discovery@2";
export const SELECTION_VERSION = "contract-selection@3";

/**
 * How many in-band contracts make the delta subset a RANKING rather than a
 * SURVIVOR of missing data.
 *
 * `contract-selection@2` tested representativeness as `passedDeltaBand === 0`.
 * That is a knife-edge, and the chain it was validated against (QQQ, 0 in band)
 * happened to sit on the safe side of it. **SPY did not.** The same measurement
 * that produced the QQQ row recorded, for SPY 0DTE:
 *
 *     170 calls returned · 55 with delta · **1** inside the 0.35-0.65 band
 *
 * One is not zero, so `deltaSubsetUnrepresentative` stayed false, the primary
 * path ran, and selection was forced onto that single contract — the only
 * candidate a "ranking" of one can produce. Replayed against the shipped
 * selector on the measured SPY shape, it returns a strike **75 points from
 * spot at bid 0.02 / ask 0.04**: the same worthless far-OTM lottery ticket,
 * with the same ~66% spread, that the QQQ fix was written to stop selecting.
 * The downstream gate then correctly rejects it and SPY prices zero calls.
 *
 * A band holding one or two contracts, on a chain where greeks are missing
 * elsewhere, carries no more information than a band holding none: in both
 * cases the contracts that would have populated it are exactly the ones the
 * provider declined to publish greeks for. Three is the smallest count that
 * can express a preference between neighbours rather than report a survivor.
 * The NVDA control of 2026-08-03 measured 8 in band and is unaffected.
 */
export const MIN_IN_BAND_SAMPLE = 3;

/** One bounded provider partition. Short DTE first, widening only as permitted. */
export interface DiscoveryPartition {
  side: "call" | "put";
  dteMin: number;
  dteMax: number;
  label: string;
}

const BAND_RANGES: Record<TenorBand, [number, number]> = {
  "0dte": [0, 0],
  "1-7dte": [1, 7],
  "8-14dte": [8, 14],
  "15-30dte": [15, 30],
  "31-90dte": [31, 90],
  longer: [91, 365],
};

/** Search order within a permitted band: nearest expiry first. */
const SUBDIVISIONS: Partial<Record<TenorBand, [number, number][]>> = {
  // A 1-7dte strategy should try tomorrow before it tries next Friday.
  "1-7dte": [[1, 1], [2, 3], [4, 7]],
};

/**
 * The ordered, bounded partitions to request for one candidate.
 *
 * Only bands the strategy actually permits are searched — this widens coverage
 * inside the strategy's own rules and never outside them. The result is capped
 * so a single candidate can never fan out into an unbounded sweep.
 */
export function planPartitions(
  side: "call" | "put",
  strategyKey: string,
  maxPartitions = 4,
): DiscoveryPartition[] {
  const strat = getStrategy(strategyKey);
  if (!strat) return [];
  const out: DiscoveryPartition[] = [];
  // Preserve the catalog's declared preference order, nearest-expiry first.
  const bands = [...strat.preferredDte].sort(
    (a, b) => BAND_RANGES[a][0] - BAND_RANGES[b][0],
  );
  for (const band of bands) {
    for (const [lo, hi] of SUBDIVISIONS[band] ?? [BAND_RANGES[band]]) {
      out.push({ side, dteMin: lo, dteMax: hi, label: `${side}:${lo}-${hi}dte` });
      if (out.length >= maxPartitions) return out;
    }
  }
  return out;
}

/** Deterministic evidence for one candidate's contract search. */
export interface ContractFunnelEvidence {
  symbol: string;
  direction: string | null;
  requestedSide: "call" | "put";
  strategyKey: string;
  atMs: number;
  discoveryVersion: string;
  selectionVersion: string;
  partitionsAttempted: string[];
  requestedDteBuckets: string[];
  preferredDelta: [number, number];
  moneyness: string;
  contractsReceived: number;
  callsReceived: number;
  putsReceived: number;
  passedSide: number;
  passedDte: number;
  withBid: number;
  withAsk: number;
  twoSided: number;
  withDelta: number;
  /**
   * Share of TRADEABLE contracts carrying a provider delta, 0..1. Recorded, never
   * gated on: it is how "missing-data fallback rate" becomes a measurable number
   * rather than an assertion. 1 means greeks were complete.
   */
  deltaCoverage: number;
  passedDeltaBand: number;
  rankedCount: number;
  deltaSource: DeltaSource | null;
  selectedOcc: string | null;
  terminalReason: ContractTerminalReason;
  /** True when the provider returned the side but every one lacked greeks. */
  greeksMissingOnSide: boolean;
  pageLimitReached: boolean;
}

function emptyEvidence(
  symbol: string, side: "call" | "put", strategyKey: string, atMs: number,
): ContractFunnelEvidence {
  const strat = getStrategy(strategyKey);
  return {
    symbol, direction: null, requestedSide: side, strategyKey, atMs,
    discoveryVersion: DISCOVERY_VERSION, selectionVersion: SELECTION_VERSION,
    partitionsAttempted: [], requestedDteBuckets: strat ? [...strat.preferredDte] : [],
    preferredDelta: strat ? strat.preferredDelta : [0, 1],
    moneyness: strat?.moneyness ?? "ATM",
    contractsReceived: 0, callsReceived: 0, putsReceived: 0,
    passedSide: 0, passedDte: 0, withBid: 0, withAsk: 0, twoSided: 0,
    withDelta: 0, deltaCoverage: 0, passedDeltaBand: 0, rankedCount: 0,
    deltaSource: null, selectedOcc: null,
    terminalReason: "INSUFFICIENT_EVIDENCE",
    greeksMissingOnSide: false, pageLimitReached: false,
  };
}

/**
 * Attribute an EMPTY chain to what actually happened.
 *
 * Without an outcome from the fetch this can only fall back to the old guess,
 * so the fallback is preserved verbatim rather than upgraded — inventing a
 * reason for a caller that supplied no evidence would be the same defect in a
 * new place. A caller that reports nothing gets `PROVIDER_ERROR`, exactly as
 * before, and the funnel can tell the two populations apart by whether the
 * newer reasons appear at all.
 */
function terminalReasonForEmptyChain(
  outcome: ChainFetchOutcome | null,
  pageLimitReached: boolean,
): ContractTerminalReason {
  if (!outcome) return pageLimitReached ? "CHAIN_TRUNCATION_SUSPECTED" : "PROVIDER_ERROR";
  switch (outcome.outcome) {
    case "CHAIN_TRUNCATED_BEFORE_RANGE": return "CHAIN_TRUNCATION_SUSPECTED";
    case "NO_CONTRACTS_IN_REQUESTED_RANGE": return "NO_CONTRACTS_RETURNED";
    case "CONTRACTS_AVAILABLE": return "NO_CONTRACTS_RETURNED";
    case "PROVIDER_QUOTA_EXCEEDED": return "PROVIDER_QUOTA_EXCEEDED";
    case "PROVIDER_CONFIGURATION_MISSING": return "PROVIDER_CONFIGURATION_MISSING";
    case "PROVIDER_TIMEOUT": return "PROVIDER_TIMEOUT";
    case "PROVIDER_FAILURE":
    case "PROVIDER_INVALID_RESPONSE": return "PROVIDER_ERROR";
    default: return "PROVIDER_ERROR";
  }
}

function dteOkFor(strategyKey: string): (dte: number) => boolean {
  const strat = getStrategy(strategyKey);
  const bands = new Set<string>(strat?.preferredDte ?? []);
  return (dte: number) =>
    bands.has(
      dte <= 0 ? "0dte" : dte <= 7 ? "1-7dte" : dte <= 14 ? "8-14dte"
        : dte <= 30 ? "15-30dte" : dte <= 90 ? "31-90dte" : "longer",
    );
}

/**
 * Preferred strike offset from spot, as a fraction, for a moneyness class.
 *
 * This is a PROXY and is only ever used when the provider omitted delta. It is
 * intentionally coarse: near-the-money is where the strategies operate, and a
 * coarse honest proxy beats a precise-looking model fitted to no data.
 */
function moneynessTargetStrike(
  moneyness: string, underlying: number, side: "call" | "put",
): number {
  const otmStep = 0.005; // ~0.5% out of the money for the ATM_OTM classes
  switch (moneyness) {
    case "ITM":
      return side === "call" ? underlying * (1 - otmStep * 2) : underlying * (1 + otmStep * 2);
    case "OTM":
      return side === "call" ? underlying * (1 + otmStep * 2) : underlying * (1 - otmStep * 2);
    case "ATM_OTM":
      return side === "call" ? underlying * (1 + otmStep) : underlying * (1 - otmStep);
    default:
      return underlying;
  }
}

export interface SelectionResult {
  contract: ChainContract | null;
  evidence: ContractFunnelEvidence;
}

/**
 * Select one contract and record exactly how the funnel narrowed.
 *
 * `underlyingPrice` is required for the moneyness fallback. Without it a chain
 * whose greeks are missing yields NO_CONTRACT_IN_DELTA_RANGE rather than a
 * guess — an unknown spot price is not a licence to invent a moneyness.
 */
export function selectContractWithEvidence(
  chain: ChainContract[],
  side: "call" | "put",
  strategyKey: string,
  nowMs: number,
  opts: {
    symbol?: string;
    underlyingPrice?: number | null;
    partitionsAttempted?: string[];
    pageLimitReached?: boolean;
    chainOutcome?: ChainFetchOutcome | null;
  } = {},
): SelectionResult {
  const ev = emptyEvidence(opts.symbol ?? "", side, strategyKey, nowMs);
  ev.partitionsAttempted = opts.partitionsAttempted ?? [];
  // `pageLimitReached` had no production caller — both call sites omitted it, so
  // `CHAIN_TRUNCATION_SUSPECTED` was unreachable dead code and every truncated
  // chain was attributed to the market instead. The fetch now reports it.
  ev.pageLimitReached = Boolean(opts.pageLimitReached ?? opts.chainOutcome?.truncated);

  const strat = getStrategy(strategyKey);
  if (!strat) {
    ev.terminalReason = "INSUFFICIENT_EVIDENCE";
    return { contract: null, evidence: ev };
  }

  ev.contractsReceived = chain.length;
  ev.callsReceived = chain.filter((c) => c.side === "call").length;
  ev.putsReceived = chain.filter((c) => c.side === "put").length;

  const sameSide = chain.filter((c) => c.side === side);
  ev.passedSide = sameSide.length;

  if (chain.length === 0) {
    // An empty chain is FIVE different facts and this line used to guess one of
    // them. Where the fetch reported its own outcome, use it; `PROVIDER_ERROR`
    // now means only what it says.
    ev.terminalReason = terminalReasonForEmptyChain(opts.chainOutcome ?? null, ev.pageLimitReached);
    return { contract: null, evidence: ev };
  }
  if (sameSide.length === 0) {
    // The provider returned contracts, but none on the side we asked for. That is
    // a discovery fault, and it must never read as "no opportunity existed".
    ev.terminalReason = ev.contractsReceived > 0
      ? (side === "call" ? "NO_CALLS_RETURNED" : "NO_PUTS_RETURNED")
      : "WRONG_SIDE_RETURNED";
    if (ev.pageLimitReached) ev.terminalReason = "CHAIN_TRUNCATION_SUSPECTED";
    return { contract: null, evidence: ev };
  }

  const dteOk = dteOkFor(strategyKey);
  const inDte = sameSide.filter((c) => dteOk(c.dte));
  ev.passedDte = inDte.length;
  if (inDte.length === 0) {
    /**
     * THE DEFECT THIS BRANCH CONCEALED.
     *
     * Measured live on 2026-08-04 RTH: SPY and QQQ chains came back 500
     * contracts over 2 pages, every one expiring that day or the next, because
     * Polygon pages in option-ticker order and an OCC sorts by expiration. The
     * 0-14 DTE window was requested and never sampled past the front. Every
     * strategy not asking for "0dte" therefore reported NO_CONTRACT_IN_DTE_RANGE
     * with certainty — 51 of 52 SPY rows — and that reads as "the market had
     * nothing", which is the opposite of the truth. It had plenty; we stopped
     * reading.
     *
     * Truncation is OUR limit, so it is named as ours.
     */
    ev.terminalReason = ev.pageLimitReached
      ? "CHAIN_TRUNCATION_SUSPECTED"
      : "NO_CONTRACT_IN_DTE_RANGE";
    return { contract: null, evidence: ev };
  }

  ev.withBid = inDte.filter((c) => (c.bid ?? 0) > 0).length;
  ev.withAsk = inDte.filter((c) => (c.ask ?? 0) > 0).length;
  ev.twoSided = inDte.filter((c) => (c.bid ?? 0) > 0 && (c.ask ?? 0) > 0).length;

  // A tradeable contract needs a live bid. This is unchanged from the original
  // selector and is NOT a liquidity gate — the liquidity/spread gate is downstream.
  const tradeable = inDte.filter((c) => (c.bid ?? 0) > 0);
  if (tradeable.length === 0) {
    ev.terminalReason = "NO_TWO_SIDED_MARKET";
    return { contract: null, evidence: ev };
  }

  ev.withDelta = tradeable.filter((c) => c.delta != null).length;
  ev.deltaCoverage = tradeable.length > 0 ? ev.withDelta / tradeable.length : 0;
  // "Greeks missing on this side" means the sample is INCOMPLETE, not empty — a
  // chain with 6 of 208 deltas is missing greeks in every sense that matters.
  ev.greeksMissingOnSide = tradeable.length > 0 && ev.withDelta < tradeable.length;

  const [dLo, dHi] = strat.preferredDelta;
  const target = (dLo + dHi) / 2;

  // --- Primary path: rank on the provider's delta. ---
  const withDelta = tradeable.filter((c) => c.delta != null);
  ev.passedDeltaBand = withDelta.filter(
    (c) => Math.abs(c.delta!) >= dLo && Math.abs(c.delta!) <= dHi,
  ).length;

  /**
   * IS THE DELTA SUBSET TRUSTWORTHY?
   *
   * A counterfactual replay against live chains falsified the first version of
   * this fix, which fell back only when NO contract had a delta. Measured on QQQ:
   *
   *     208 tradeable calls · 6 with delta · 0 of those inside the 0.40-0.60 band
   *
   * So `withDelta > 0` held, the primary path ran, and selection was forced onto
   * the handful of contracts that happened to carry greeks — returning
   * `O:QQQ260803C00701000` at delta 0.209, bid 0.06 / ask 0.08: a near-worthless
   * lottery ticket with a ~33% spread, which the downstream contract gate then
   * correctly rejected. A contract WAS "selected" and yet zero calls were ever
   * priced. That is the SPY/QQQ failure, and a fallback keyed on `withDelta === 0`
   * never fires for it.
   *
   * The honest condition is about REPRESENTATIVENESS, not presence. When too few
   * contracts with a delta land in the band AND contracts without greeks exist,
   * the band is an artifact of missing data rather than a fact about the market —
   * the sample cannot answer the question. When greeks are COMPLETE, whatever the
   * band contains is a real fact about the chain and the provider path stands.
   *
   * `@2` wrote the first clause as `passedDeltaBand === 0`, which is a knife-edge
   * that the measured SPY chain (exactly ONE in band) fell on the wrong side of.
   * See MIN_IN_BAND_SAMPLE for the measurement and the replay.
   */
  const deltaSubsetUnrepresentative =
    ev.passedDeltaBand < MIN_IN_BAND_SAMPLE && withDelta.length < tradeable.length;

  if (withDelta.length > 0 && !deltaSubsetUnrepresentative) {
    const ranked = [...withDelta].sort(
      (a, b) => Math.abs(Math.abs(a.delta!) - target) - Math.abs(Math.abs(b.delta!) - target),
    );
    ev.rankedCount = ranked.length;
    ev.deltaSource = "PROVIDER_DELTA";
    ev.selectedOcc = ranked[0].optionSymbol;
    ev.terminalReason = "CONTRACT_SELECTED";
    return { contract: ranked[0], evidence: ev };
  }

  // --- Fallback: the delta sample cannot answer the question. ---
  // Either the provider published no greeks at all, or the few it did publish
  // miss the band entirely while ungreeked tradeable contracts exist. Rank on
  // moneyness across ALL tradeable contracts, and label the result so no
  // downstream consumer can mistake a proxy for a measured delta.
  const spot = opts.underlyingPrice ?? null;
  if (spot == null || !Number.isFinite(spot) || spot <= 0) {
    ev.terminalReason = "NO_CONTRACT_IN_DELTA_RANGE";
    return { contract: null, evidence: ev };
  }

  const targetStrike = moneynessTargetStrike(strat.moneyness, spot, side);
  const ranked = [...tradeable].sort(
    (a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike),
  );
  ev.rankedCount = ranked.length;
  if (ranked.length === 0) {
    ev.terminalReason = "NO_CONTRACT_IN_MONEYNESS_RANGE";
    return { contract: null, evidence: ev };
  }
  ev.deltaSource = "MONEYNESS_PROXY";
  ev.selectedOcc = ranked[0].optionSymbol;
  ev.terminalReason = "CONTRACT_SELECTED";
  return { contract: ranked[0], evidence: ev };
}

/**
 * Does this evidence indicate a DISCOVERY defect rather than an absent
 * opportunity? Used by the safety monitor. A correct rejection is never a defect.
 */
export function indicatesDiscoveryDefect(ev: ContractFunnelEvidence): boolean {
  if (ev.terminalReason === "CONTRACT_SELECTED") return false;
  return (
    ev.terminalReason === "NO_CALLS_RETURNED" ||
    ev.terminalReason === "NO_PUTS_RETURNED" ||
    ev.terminalReason === "WRONG_SIDE_RETURNED" ||
    ev.terminalReason === "CHAIN_TRUNCATION_SUSPECTED" ||
    ev.terminalReason === "PAGE_LIMIT_REACHED" ||
    // Contracts arrived and were tradeable, but every one lacked greeks and no
    // spot price was available to fall back on. That is the 2026-08-03 defect.
    (ev.terminalReason === "NO_CONTRACT_IN_DELTA_RANGE" && ev.greeksMissingOnSide)
  );
}
