/**
 * sizing.ts — deterministic simulated position sizing. PURE. No AI.
 *
 * THIS IS SIZING FOR COMPARABLE PAPER RESULTS, NOT PERSONALIZED FINANCIAL
 * ADVICE. It exists so two research cohorts can be compared on the same basis,
 * and for no other purpose.
 *
 * Two cohorts are always computed for every position, so results can be read
 * either way without re-deriving anything:
 *
 *   FIXED_CONTRACT — exactly one simulated contract. The normalization cohort:
 *                    it removes sizing entirely so contract selection and
 *                    management can be compared without a sizing confound.
 *   FIXED_RISK     — a configured simulated dollar risk, converted to WHOLE
 *                    contracts. Never fractional, never zero, never negative.
 *
 * Kelly, Monte Carlo, and probability-density optimization are deliberately NOT
 * here. They may be computed as advisory research once adequate samples exist;
 * they may never size a live paper position.
 */

export type SizingCohort = "FIXED_CONTRACT" | "FIXED_RISK";

export interface SizingConfig {
  /** Simulated dollars risked per position in the FIXED_RISK cohort. */
  fixedRiskUsd: number;
  /** Ceiling so a single cheap contract cannot produce an absurd simulated size. */
  maxContracts: number;
  /** Percent of entry premium treated as at risk (the deterministic stop). */
  stopLossPct: number;
}

export const DEFAULT_SIZING: Readonly<SizingConfig> = Object.freeze({
  fixedRiskUsd: 500,
  maxContracts: 10,
  stopLossPct: 35,
});

/** Configuration from env, clamped. An unparseable value falls back, never throws. */
export function resolveSizingConfig(env: NodeJS.ProcessEnv = process.env): SizingConfig {
  const n = (raw: string | undefined, dflt: number, lo: number, hi: number): number => {
    const x = Number(raw);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
  };
  return {
    fixedRiskUsd: n(env.HIGH_ASYMMETRY_PAPER_RISK_USD, DEFAULT_SIZING.fixedRiskUsd, 50, 100_000),
    maxContracts: Math.floor(n(env.HIGH_ASYMMETRY_PAPER_MAX_CONTRACTS, DEFAULT_SIZING.maxContracts, 1, 100)),
    stopLossPct: n(env.HIGH_ASYMMETRY_PAPER_STOP_PCT, DEFAULT_SIZING.stopLossPct, 5, 95),
  };
}

export interface SizingResult {
  /** Always 1. The normalization cohort. */
  fixedContractQty: 1;
  /** Whole contracts for the configured risk, or null when it cannot be sized. */
  fixedRiskQty: number | null;
  /** Why fixedRiskQty is null. Never silently converted to zero. */
  fixedRiskReason: string | null;
  /** Simulated dollars committed by the FIXED_RISK cohort at entry. */
  fixedRiskCostUsd: number | null;
  /** Simulated dollars at risk to the deterministic stop. */
  fixedRiskAtRiskUsd: number | null;
  config: SizingConfig;
}

const CONTRACT_MULTIPLIER = 100;

/**
 * Size one position. `entryFill` is the per-share option premium actually used
 * for the simulated fill.
 *
 * A premium too expensive to buy even one contract within the risk budget
 * yields null with a reason — NOT zero contracts, and not a fractional
 * contract. Zero would silently enter the cohort as a position that risked
 * nothing and returned nothing, which is a fabricated data point.
 */
export function sizePaperPosition(entryFill: number | null, cfg: SizingConfig = DEFAULT_SIZING): SizingResult {
  const base: SizingResult = {
    fixedContractQty: 1,
    fixedRiskQty: null,
    fixedRiskReason: null,
    fixedRiskCostUsd: null,
    fixedRiskAtRiskUsd: null,
    config: cfg,
  };
  if (entryFill == null || !Number.isFinite(entryFill) || entryFill <= 0) {
    return { ...base, fixedRiskReason: "NO_ENTRY_PREMIUM" };
  }

  // Dollars at risk per contract = premium × 100 × the fraction the stop gives up.
  const riskPerContract = entryFill * CONTRACT_MULTIPLIER * (cfg.stopLossPct / 100);
  if (riskPerContract <= 0) return { ...base, fixedRiskReason: "NO_RISK_PER_CONTRACT" };

  const raw = Math.floor(cfg.fixedRiskUsd / riskPerContract);
  if (raw < 1) {
    return { ...base, fixedRiskReason: "PREMIUM_EXCEEDS_RISK_BUDGET" };
  }
  const qty = Math.min(cfg.maxContracts, raw);
  return {
    ...base,
    fixedRiskQty: qty,
    fixedRiskCostUsd: round2(entryFill * CONTRACT_MULTIPLIER * qty),
    fixedRiskAtRiskUsd: round2(riskPerContract * qty),
  };
}

/**
 * Simulated P&L in dollars for a cohort. Returns null when either leg is
 * missing — an unverified exit is never worth zero.
 */
export function paperPnlUsd(entryFill: number | null, exitFill: number | null, contracts: number | null): number | null {
  if (entryFill == null || exitFill == null || contracts == null) return null;
  if (!Number.isFinite(entryFill) || !Number.isFinite(exitFill) || !Number.isFinite(contracts)) return null;
  return round2((exitFill - entryFill) * CONTRACT_MULTIPLIER * contracts);
}

/** Percent return of a long option position. Null when it cannot be computed. */
export function paperReturnPct(entryFill: number | null, markPrice: number | null): number | null {
  if (entryFill == null || markPrice == null || !(entryFill > 0)) return null;
  if (!Number.isFinite(markPrice)) return null;
  return round2(((markPrice - entryFill) / entryFill) * 100);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
