/**
 * stage15-shadow.ts — STAGE15_CHAIN_GATE_SHADOW_V1.
 *
 * WHY THIS EXISTS, in one measurement.
 *
 *   stage1Pass       3,462
 *   stage15Forming       0
 *
 * The plausibility gate that is supposed to stand between "this symbol is liquid
 * and fresh" and "spend a chain request on it" rejected NOBODY across the whole
 * sample. It is not a gate; it is a pass-through with a counter. Downstream,
 * 802 of 1,888 contract-selection attempts returned nothing.
 *
 * WHY THIS IS A SHADOW AND NOT A FIX. The obvious move — put a real threshold
 * in — is exactly the move that must not be made blind. A gate that rejects 40%
 * of chain attempts looks like a 40% saving right up until the rejected 40%
 * contains the day's actionable setups. The cost of a wrong REJECT is invisible
 * (no case, no record, nothing to review), which is the most dangerous shape a
 * change can have.
 *
 * So V1 computes a verdict and NOTHING ELSE. It has no authority, no call site
 * in the decision path, and no way to acquire one: it is a pure function over
 * evidence the caller ALREADY HAS, returning a label. The production gate is
 * untouched. What this buys is the counterfactual — for every chain request
 * production actually made, what would V1 have done, and what would that have
 * cost as well as saved.
 *
 * THE MEASUREMENT THAT DECIDES ITS FUTURE is deliberately two-sided:
 *
 *   wouldSave        REJECTs on attempts that returned zero contracts. The win.
 *   wouldCostChain   REJECTs on attempts that returned usable contracts.
 *   wouldCostCase    REJECTs on attempts that became an opportunity case.
 *   wouldCostWinner  REJECTs on attempts whose delivered case later won.
 *   wouldCostLoser   REJECTs on attempts whose delivered case later lost.
 *
 * `wouldCostLoser` is reported alongside `wouldCostWinner` on purpose. A gate
 * that removes losers is doing its job, and a summary that counted only the
 * winners it destroyed would make every candidate gate look worse than it is.
 *
 * EXACT OPTION OUTCOMES ONLY WHERE PRODUCTION GENUINELY SELECTED AN OCC. Where
 * no contract was chosen there is no option outcome and none is synthesised —
 * such attempts contribute to the chain/case columns only.
 *
 * NO NEW PROVIDER REQUESTS. Every input is evidence already fetched for the
 * production decision. This file imports nothing that can perform I/O.
 *
 * PURE. No clock, no I/O, no env read beyond the explicit config resolver.
 */

const num = (v: string | undefined, d: number, min = -Infinity): number => {
  const x = Number(v);
  return Number.isFinite(x) && x >= min ? x : d;
};

export const STAGE15_SHADOW_VERSION = "STAGE15_CHAIN_GATE_SHADOW_V1" as const;

/**
 * Underlying evidence that ALREADY EXISTS at the moment production decides to
 * fetch a chain. Every field is optional because the real snapshot is sparse,
 * and a missing field must never be read as a bad one.
 */
export interface Stage15Evidence {
  symbol: string;
  /** Signed velocity %/min at decision time. */
  velPct?: number | null;
  /** Acceleration %/min² at decision time. */
  accelPct?: number | null;
  /** Relative volume, where the pipeline has it. */
  relVolume?: number | null;
  dayDollarVolume?: number | null;
  /** Compression 0..1, where computed. */
  compressionPct?: number | null;
  aboveVwap?: boolean | null;
  /** Underlying quoted spread %, where observable. */
  spreadPct?: number | null;
  /** Strategy score at decision time, 0..1. */
  strategyScore?: number | null;
  /** True when the candidate could never reach subscribers. */
  researchOnly?: boolean | null;
  tier?: 0 | 1 | 2;
}

export interface Stage15ShadowConfig {
  /**
   * Minimum |velocity| for a chain to be plausible. A symbol going nowhere at
   * decision time has no move for an option to monetise.
   */
  minAbsVelPct: number;
  /** Minimum underlying dollar volume for a chain to be worth buying. */
  minDollarVolume: number;
  /** Minimum strategy score. */
  minStrategyScore: number;
  /** Widest underlying spread still treated as plausible, when observable. */
  maxSpreadPct: number;
  /**
   * Tiers exempt from the gate entirely. Tier 0 is SPY/QQQ/IWM on a reserved
   * budget — gating them saves nothing worth the risk.
   */
  exemptTiers: readonly number[];
}

export const DEFAULT_STAGE15_SHADOW: Readonly<Stage15ShadowConfig> = Object.freeze({
  minAbsVelPct: 0.15,
  minDollarVolume: 20_000_000,
  minStrategyScore: 0.35,
  maxSpreadPct: 8,
  exemptTiers: Object.freeze([0]) as readonly number[],
});

export function stage15ShadowConfig(env: NodeJS.ProcessEnv = process.env): Stage15ShadowConfig {
  const d = DEFAULT_STAGE15_SHADOW;
  return {
    minAbsVelPct: num(env.OPTIONS_STAGE15_SHADOW_MIN_ABS_VEL_PCT, d.minAbsVelPct, 0),
    minDollarVolume: num(env.OPTIONS_STAGE15_SHADOW_MIN_DOLLAR_VOLUME, d.minDollarVolume, 0),
    minStrategyScore: num(env.OPTIONS_STAGE15_SHADOW_MIN_SCORE, d.minStrategyScore, 0),
    maxSpreadPct: num(env.OPTIONS_STAGE15_SHADOW_MAX_SPREAD_PCT, d.maxSpreadPct, 0),
    exemptTiers: d.exemptTiers,
  };
}

export type Stage15Verdict = "PASS" | "REJECT";

export interface Stage15ShadowResult {
  version: typeof STAGE15_SHADOW_VERSION;
  verdict: Stage15Verdict;
  /** Every floor this evidence failed. Empty on PASS. */
  reasons: string[];
  /** Fields that were absent and therefore could not be judged. */
  unknowns: string[];
}

/**
 * What V1 WOULD have decided. Advisory only — nothing consumes this.
 *
 * MISSING EVIDENCE PASSES. Every threshold is skipped when its input is absent,
 * and the absence is recorded in `unknowns` instead. A gate that rejected on
 * sparse data would reject hardest exactly where the pipeline knows least,
 * which is the opposite of what a plausibility check is for.
 */
export function evaluateStage15Shadow(
  e: Stage15Evidence,
  cfg: Stage15ShadowConfig = DEFAULT_STAGE15_SHADOW,
): Stage15ShadowResult {
  const reasons: string[] = [];
  const unknowns: string[] = [];
  const known = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

  if (e.tier != null && cfg.exemptTiers.includes(e.tier)) {
    return { version: STAGE15_SHADOW_VERSION, verdict: "PASS", reasons: [], unknowns: [`tier_${e.tier}_exempt`] };
  }

  if (known(e.velPct)) {
    if (Math.abs(e.velPct) < cfg.minAbsVelPct) reasons.push(`vel_${e.velPct.toFixed(3)}_below_${cfg.minAbsVelPct}`);
  } else unknowns.push("velPct");

  if (known(e.dayDollarVolume)) {
    if (e.dayDollarVolume < cfg.minDollarVolume) reasons.push(`dollar_volume_below_${cfg.minDollarVolume}`);
  } else unknowns.push("dayDollarVolume");

  if (known(e.strategyScore)) {
    if (e.strategyScore < cfg.minStrategyScore) reasons.push(`score_${e.strategyScore.toFixed(2)}_below_${cfg.minStrategyScore}`);
  } else unknowns.push("strategyScore");

  if (known(e.spreadPct)) {
    if (e.spreadPct > cfg.maxSpreadPct) reasons.push(`spread_${e.spreadPct.toFixed(2)}_above_${cfg.maxSpreadPct}`);
  } else unknowns.push("spreadPct");

  return {
    version: STAGE15_SHADOW_VERSION,
    verdict: reasons.length > 0 ? "REJECT" : "PASS",
    reasons,
    unknowns,
  };
}

/* ---------------------------------------------------------------------------
 * COUNTERFACTUAL MEASUREMENT
 * -------------------------------------------------------------------------*/

/**
 * One chain request production ACTUALLY made, with what it actually produced.
 *
 * `outcome` fields describe observed reality. Where production selected no OCC,
 * `optionOutcome` is null and stays null — see the header.
 */
export interface Stage15Attempt {
  evidence: Stage15Evidence;
  /** Contracts the chain actually returned. */
  contractsReturned: number;
  /** Whether production went on to select an exact contract. */
  selectedOcc: boolean;
  /** Whether the attempt became an opportunity case. */
  becameCase: boolean;
  /**
   * The realised option outcome, ONLY where production genuinely selected an
   * OCC and the case was graded. Null everywhere else, never imputed.
   */
  optionOutcome?: "WIN" | "LOSS" | null;
}

export interface Stage15ShadowReport {
  version: typeof STAGE15_SHADOW_VERSION;
  attempts: number;
  passed: number;
  rejected: number;
  /** REJECTs on attempts that returned nothing. Provider calls V1 would save. */
  wouldSaveChainRequests: number;
  /** REJECTs on attempts that returned usable contracts. */
  wouldCostChainWithContracts: number;
  /** REJECTs on attempts that became an opportunity case. */
  wouldCostCases: number;
  /** REJECTs on graded winners. The number that must be near zero. */
  wouldCostWinners: number;
  /** REJECTs on graded losers. Reported so the trade-off is legible. */
  wouldCostLosers: number;
  /** Graded outcomes available at all — the denominator for the two above. */
  gradedOutcomes: number;
  /** Share of zero-contract attempts V1 would have caught. */
  zeroContractRecallPct: number;
  /** Share of ALL attempts V1 would have refused. */
  rejectRatePct: number;
  /** Per-reason rejection counts, so a bad threshold is attributable. */
  rejectionsByReason: Record<string, number>;
}

/**
 * Replay V1 over attempts production already made. Issues nothing.
 *
 * The verdict this produces is a REPORT, not a decision, and the shape of the
 * report is the point: `wouldSaveChainRequests` alone would make any aggressive
 * gate look good, so it is never returned without the four columns that say
 * what the saving would have cost.
 */
export function measureStage15Shadow(
  attempts: readonly Stage15Attempt[],
  cfg: Stage15ShadowConfig = DEFAULT_STAGE15_SHADOW,
): Stage15ShadowReport {
  let passed = 0, rejected = 0;
  let wouldSaveChainRequests = 0, wouldCostChainWithContracts = 0;
  let wouldCostCases = 0, wouldCostWinners = 0, wouldCostLosers = 0;
  let gradedOutcomes = 0, zeroContractAttempts = 0;
  const rejectionsByReason: Record<string, number> = {};

  for (const a of attempts) {
    const zero = (a.contractsReturned ?? 0) === 0;
    if (zero) zeroContractAttempts += 1;
    // Only genuinely graded, genuinely selected contracts have an outcome.
    const graded = a.selectedOcc && (a.optionOutcome === "WIN" || a.optionOutcome === "LOSS");
    if (graded) gradedOutcomes += 1;

    const r = evaluateStage15Shadow(a.evidence, cfg);
    if (r.verdict === "PASS") { passed += 1; continue; }

    rejected += 1;
    for (const reason of r.reasons) {
      const key = reason.replace(/_-?[\d.]+/g, "_N");
      rejectionsByReason[key] = (rejectionsByReason[key] ?? 0) + 1;
    }
    if (zero) wouldSaveChainRequests += 1; else wouldCostChainWithContracts += 1;
    if (a.becameCase) wouldCostCases += 1;
    if (graded) {
      if (a.optionOutcome === "WIN") wouldCostWinners += 1;
      else wouldCostLosers += 1;
    }
  }

  const n = attempts.length;
  return {
    version: STAGE15_SHADOW_VERSION,
    attempts: n,
    passed,
    rejected,
    wouldSaveChainRequests,
    wouldCostChainWithContracts,
    wouldCostCases,
    wouldCostWinners,
    wouldCostLosers,
    gradedOutcomes,
    zeroContractRecallPct: zeroContractAttempts > 0
      ? +((wouldSaveChainRequests / zeroContractAttempts) * 100).toFixed(2) : 0,
    rejectRatePct: n > 0 ? +((rejected / n) * 100).toFixed(2) : 0,
    rejectionsByReason,
  };
}
