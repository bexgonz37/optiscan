/**
 * The LHC findings — what the lower_high_continuation investigation established, written down
 * so Evidence Learning consumes it instead of rediscovering it every session.
 *
 * WHY THIS EXISTS
 *
 * The findings existed only in a markdown packet and in the shape of one diagnostic endpoint.
 * Nothing in the running system knew that `contractUpdateCount` is a hindsight trap, that the
 * lane's baseline expectancy is -27.83%, or that `LHC_SELECT_V1`'s profit factor collapses
 * without one trade. So each nightly review started from zero and the AI was free to summarize
 * the experiment as "it works".
 *
 * THE DESIGN CONSTRAINT
 *
 * `limitations` is a required, non-empty array on every finding, and `mustNotBeSummarizedAs`
 * carries the specific wrong summary that this finding invites. A finding is not just a claim —
 * it is a claim plus the reason it is not bigger than it is. The AI prompt is built from both
 * fields, so the honest framing travels with the number rather than being appended by whoever
 * remembers.
 *
 * PURE. The DB writer takes these as input.
 */

import { LHC_SELECT_V1 } from "./experiment-registry.ts";
import { COHORT_ID, COHORT_STRATEGY } from "./lower-high-cohort.ts";
import { POLICY_VERSIONS, UNKNOWN_LEGACY_VERSION } from "./policy-attribution.ts";
import { HINDSIGHT_DENYLIST } from "./pre-entry-features.ts";

export type EvidenceStrength = "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT";

export interface LearningFinding {
  findingId: string;
  strategy: string;
  /** The version the evidence was produced under. Historical rows are honestly unknown. */
  strategyVersion: string;
  population: string;
  evidenceCohortId: string;
  sessions: readonly string[];
  sampleSize: number;
  title: string;
  statement: string;
  baselineMetric: Readonly<Record<string, number | string | null>> | null;
  experimentalMetric: Readonly<Record<string, number | string | null>> | null;
  evidenceStrength: EvidenceStrength;
  /** Non-empty by contract. A finding without limitations is a slogan. */
  limitations: readonly string[];
  affectedOpportunityIds: readonly string[];
  recommendedExperiment: string | null;
  experimentId: string | null;
  experimentStatus: string | null;
  /** The specific wrong summary this finding invites. Carried into every AI prompt. */
  mustNotBeSummarizedAs: string | null;
}

const SESSIONS = Object.freeze([
  "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06",
]);

const H = LHC_SELECT_V1.historicalResult;

/**
 * The six findings the investigation produced.
 *
 * Note the ordering: the negative baseline comes first and the experiment's tail dependence
 * comes immediately after its improvement. A reader taking these in order cannot reach the
 * flattering number before the qualification.
 */
export const LHC_FINDINGS: readonly LearningFinding[] = Object.freeze([
  {
    findingId: "LHC_NEGATIVE_BASELINE_EXPECTANCY",
    strategy: COHORT_STRATEGY,
    strategyVersion: UNKNOWN_LEGACY_VERSION,
    population: "DELIVERED_ALERT_PAPER",
    evidenceCohortId: COHORT_ID,
    sessions: SESSIONS,
    sampleSize: 54,
    title: "The delivered lower_high_continuation lane loses money",
    statement:
      "Across all 54 closed mirrors of owner Discord openings for lower_high_continuation, mean return is " +
      "-27.83%, median -41.67%, win rate 14.8% and profit factor 0.311. Every member is a put. This is the " +
      "denominator for every claim about this lane — not a recent slice of it.",
    baselineMetric: Object.freeze({
      n: 54, winners: 8, losses: 46, winRate: 0.148,
      meanReturnPct: -27.83, medianReturnPct: -41.67, profitFactor: 0.311,
    }),
    experimentalMetric: null,
    evidenceStrength: "STRONG",
    limitations: Object.freeze([
      "Spans at least four deploys during which the published stop, DTE derivation and duplicate-exclusion all changed; the rows are not one system.",
      "Strategy/policy versions are UNKNOWN_LEGACY_VERSION for every row, so per-version attribution is impossible retrospectively.",
      "42 of 58 members have >= 20 same-contract marks; the other 16 support realized return but no path claim.",
    ]),
    affectedOpportunityIds: Object.freeze([]),
    recommendedExperiment: "Nothing may be delivered to subscribers from this lane until a prospective arm shows positive expectancy.",
    experimentId: null,
    experimentStatus: null,
    mustNotBeSummarizedAs:
      "The lane is improving. It is negative across its full delivered history; a single profitable session is not a trend.",
  },
  {
    findingId: "LHC_HINDSIGHT_FEATURES_REJECTED",
    strategy: COHORT_STRATEGY,
    strategyVersion: UNKNOWN_LEGACY_VERSION,
    population: "DELIVERED_ALERT_PAPER",
    evidenceCohortId: COHORT_ID,
    sessions: SESSIONS,
    sampleSize: 58,
    title: "The two strongest apparent predictors were hindsight and are permanently denylisted",
    statement:
      "Ranked naively, contractUpdateCount (AUC 0.892) and contractCandidateCount (AUC 0.875) separated winners " +
      "from losers better than any genuine feature. Both are lifetime accumulators: 0 of 222 contract candidates " +
      "and 0 of 163 contract updates were observed at or before entry. They measure how long a position survived, " +
      "not how it was chosen. A rule built on them would backtest beautifully and do nothing live.",
    baselineMetric: Object.freeze({
      contractUpdateCountAuc: 0.892, contractCandidateCountAuc: 0.875,
      candidatesObservedBeforeEntry: 0, updatesObservedBeforeEntry: 0,
    }),
    experimentalMetric: null,
    evidenceStrength: "STRONG",
    limitations: Object.freeze([
      "This is a statement about two specific columns, not proof that the remaining features are leak-free.",
      "The denylist is enforced by assertNoLeakage at the rule boundary; a feature added without going through that boundary is unguarded.",
    ]),
    affectedOpportunityIds: Object.freeze([]),
    recommendedExperiment: "Any new selection feature must declare a pre-entry basis and pass assertNoLeakage before use.",
    experimentId: null,
    experimentStatus: null,
    mustNotBeSummarizedAs:
      "Contract update activity predicts winners. It predicts survival, which is the outcome, not a cause.",
  },
  {
    findingId: "LHC_WINNER_LOSER_PRE_ENTRY_SEPARATION",
    strategy: COHORT_STRATEGY,
    strategyVersion: UNKNOWN_LEGACY_VERSION,
    population: "DELIVERED_ALERT_PAPER",
    evidenceCohortId: COHORT_ID,
    sessions: SESSIONS,
    sampleSize: 54,
    title: "The lane bought more implied move than the setup could outrun",
    statement:
      "Contract selection pins delta near 0.45, so at fixed delta the strike distance measures the implied move " +
      "already priced in: a delta-0.45 put sits 0.24% from spot on low-vol AAPL and 1.85% away on ACHR. Winners " +
      "and losers separate on contractVolume (AUC 0.815), moneynessPct (0.750), vwapDistPct (0.745), dollarVolume " +
      "(0.701), spreadPct (0.283), iv (0.315) and dte (0.245) — all repeated across a date-separated split. This " +
      "is a contract-quality and expression defect, not primarily a thesis defect.",
    baselineMetric: Object.freeze({
      contractVolumeAuc: 0.815, moneynessPctAuc: 0.750, vwapDistPctAuc: 0.745,
      dollarVolumeAuc: 0.701, spreadPctAuc: 0.283, ivAuc: 0.315, dteAuc: 0.245,
      winnerMedianMoneynessPct: -0.24, loserMedianMoneynessPct: -0.48,
    }),
    experimentalMetric: null,
    evidenceStrength: "MODERATE",
    limitations: Object.freeze([
      "8 winners against 46 losers — every winner-side median rests on a very small sample.",
      "callPutVolRatio, ivLevel, concurrentOpen and nearestResistanceDistPct separated overall and REVERSED in validation; they are not discriminators.",
      "Session crowding looked strong in development (AUC 0.23) and inverted in validation (0.86). It is excluded.",
      "These are correlated views of one mechanism, not seven independent findings.",
    ]),
    affectedOpportunityIds: Object.freeze([]),
    recommendedExperiment: "LHC_SELECT_V1 — gate on strike distance, expiry, underlying liquidity and contract IV.",
    experimentId: LHC_SELECT_V1.experimentId,
    experimentStatus: "PROSPECTIVE_SHADOW",
    mustNotBeSummarizedAs:
      "Closer strikes always win. The mechanism is implied move relative to what the setup can deliver; strike " +
      "distance is the visible proxy for it at fixed delta.",
  },
  {
    findingId: "LHC_SELECT_V1_HISTORICAL_IMPROVEMENT",
    strategy: COHORT_STRATEGY,
    strategyVersion: POLICY_VERSIONS.strategyVersion,
    population: "DELIVERED_ALERT_PAPER",
    evidenceCohortId: COHORT_ID,
    sessions: SESSIONS,
    sampleSize: 54,
    title: "LHC_SELECT_V1 improves the historical cohort and rejects none of its winners",
    statement:
      `On the cohort it was derived from, V1 admits 20 of 54 closed trades: 8 winners and 12 losses, PF ` +
      `${H.experimentProfitFactor} against a baseline ${H.baselineProfitFactor}. It rejects 0 of 8 winners and ` +
      `avoids 34 of 46 losses. The improvement repeats in the date-separated split (development ` +
      `${H.developmentBaselineProfitFactor} -> ${H.developmentExperimentProfitFactor}; untouched validation ` +
      `${H.validationBaselineProfitFactor} -> ${H.validationExperimentProfitFactor}) and no individual session is made worse.`,
    baselineMetric: Object.freeze({
      n: 54, winners: 8, losses: 46, profitFactor: H.baselineProfitFactor, meanReturnPct: H.baselineMeanReturnPct,
    }),
    experimentalMetric: Object.freeze({
      n: 20, winners: 8, losses: 12, profitFactor: H.experimentProfitFactor,
      meanReturnPct: H.experimentMeanReturnPct, winnersRejected: 0, lossesAvoided: 34,
    }),
    evidenceStrength: "WEAK",
    limitations: Object.freeze([
      "Measured on the cohort the rule was READ FROM. Improvement here is close to guaranteed and proves nothing.",
      "The untouched validation block is 9 closed trades; PF 1.051 there is barely above break-even.",
      "Zero winners rejected is measured on 8 winners — not evidence that no winner can be rejected.",
      "No prospective outcome had closed at the time this finding was written.",
    ]),
    affectedOpportunityIds: Object.freeze([]),
    recommendedExperiment: "Prospective shadow arm — record V1 and baseline decisions live, before outcomes exist.",
    experimentId: LHC_SELECT_V1.experimentId,
    experimentStatus: "PROSPECTIVE_SHADOW",
    mustNotBeSummarizedAs:
      "LHC_SELECT_V1 works, or is validated, or is ready for subscribers. It is PROMISING and UNVALIDATED.",
  },
  {
    findingId: "LHC_SELECT_V1_TAIL_DEPENDENCE",
    strategy: COHORT_STRATEGY,
    strategyVersion: POLICY_VERSIONS.strategyVersion,
    population: "DELIVERED_ALERT_PAPER",
    evidenceCohortId: COHORT_ID,
    sessions: SESSIONS,
    sampleSize: 20,
    title: "LHC_SELECT_V1 is not a profitable system without one convex trade",
    statement:
      `Strip the single +${H.topWinnerReturnPct}% AAPL run and V1's profit factor falls from ` +
      `${H.experimentProfitFactor} to ${H.exTopWinnerProfitFactor}. Cap returns at +60% and it reads ` +
      `${H.cappedAt60ProfitFactor}. Both are below break-even. The improvement over baseline is large and repeated ` +
      "in all three framings (baseline 0.311 / 0.153 / 0.181), so the rule is doing something real — and the lane " +
      "it improves is still carried by a tail it cannot be shown to reproduce.",
    baselineMetric: Object.freeze({
      profitFactor: H.baselineProfitFactor, exTopWinnerProfitFactor: 0.153, cappedAt60ProfitFactor: 0.181,
    }),
    experimentalMetric: Object.freeze({
      profitFactor: H.experimentProfitFactor,
      exTopWinnerProfitFactor: H.exTopWinnerProfitFactor,
      cappedAt60ProfitFactor: H.cappedAt60ProfitFactor,
      topWinnerReturnPct: H.topWinnerReturnPct,
    }),
    evidenceStrength: "STRONG",
    limitations: Object.freeze([
      "Removing the best trade from a 20-trade sample is a severe test; passing it would be unusual. The point is that it FAILS it.",
      "Convexity may be genuinely reproducible in this lane — the winners took 8 to 1431 minutes to reach +25%, and long holds are load-bearing. This finding does not prove the tail is luck.",
    ]),
    affectedOpportunityIds: Object.freeze([]),
    recommendedExperiment: "Require acceptable ex-top-winner and capped-return performance before any subscriber consideration.",
    experimentId: LHC_SELECT_V1.experimentId,
    experimentStatus: "PROSPECTIVE_SHADOW",
    mustNotBeSummarizedAs:
      "The +343.93% winner proves the strategy. One trade is not evidence of a repeatable edge, and readiness may " +
      "never be argued from it.",
  },
  {
    findingId: "LHC_SELECTION_NOT_EXIT_POLICY",
    strategy: COHORT_STRATEGY,
    strategyVersion: UNKNOWN_LEGACY_VERSION,
    population: "DELIVERED_ALERT_PAPER",
    evidenceCohortId: COHORT_ID,
    sessions: SESSIONS,
    sampleSize: 32,
    title: "Exit policy alone cannot fix this lane, and neither can selection alone",
    statement:
      "Of 32 trustworthy losses, 14 never cleared +5% — no post-entry policy could have rescued them. The best " +
      "evidenced exit change (break-even after +15%) leaves the lane at PF 0.905, still short of break-even, and " +
      "every trailing and time stop tested DESTROYS the convex winners (trail-10% takes the +343.93% run to -7.14%). " +
      "V1 rejects 71% of never-worked and 78% of worked-then-lost trades, so it is a general contract-quality " +
      "filter rather than a thesis filter. Four worked-then-lost trades survive it and are the remaining exit job.",
    baselineMetric: Object.freeze({
      trustworthyLosses: 32, neverClearedPlus5: 14, workedFirst: 18,
      bestExitPolicyProfitFactor: 0.905, trail10ProfitFactor: 0.549,
    }),
    experimentalMetric: Object.freeze({
      neverWorkedRejectedRate: 0.71, workedThenLostRejectedRate: 0.78,
    }),
    evidenceStrength: "MODERATE",
    limitations: Object.freeze([
      "The exit-policy simulator was structurally unable to clip a winner until it was corrected; figures predating that fix are void.",
      "32 trustworthy losses out of 46 — the remaining 14 have no path evidence and are excluded, not assumed similar.",
      "Loss taxonomy assigns INSUFFICIENT_EVIDENCE to 14 rows rather than guessing a cause.",
    ]),
    affectedOpportunityIds: Object.freeze([]),
    recommendedExperiment: "Selection and exit must be measured as separate arms; neither is sufficient alone.",
    experimentId: LHC_SELECT_V1.experimentId,
    experimentStatus: "PROSPECTIVE_SHADOW",
    mustNotBeSummarizedAs:
      "The losses are an exit problem, or the losses are a selection problem. The evidence says both, and that " +
      "fixing one leaves the lane unprofitable.",
  },
]);

/** Structural guard: a finding without limitations is not a finding. */
export function assertFindingsWellFormed(findings: readonly LearningFinding[] = LHC_FINDINGS): void {
  for (const f of findings) {
    if (!f.limitations.length) throw new Error(`finding ${f.findingId} has no limitations`);
    if (!f.statement.trim()) throw new Error(`finding ${f.findingId} has no statement`);
    if (!f.sessions.length) throw new Error(`finding ${f.findingId} names no sessions`);
    if (f.sampleSize <= 0) throw new Error(`finding ${f.findingId} has a non-positive sample`);
  }
}

/**
 * The denylist, restated as a finding consumers can read without importing the feature module.
 * Exported so a diagnostic can show WHICH fields are banned rather than that some are.
 */
export const DENYLISTED_SELECTION_FEATURES = HINDSIGHT_DENYLIST;
