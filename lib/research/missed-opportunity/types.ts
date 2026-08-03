/**
 * Missed Opportunity Agent — vocabulary.
 *
 * WHY THIS EXISTS. On 2026-08-03 the owner learned from Twitter that SPY and NVDA
 * calls reportedly ran ~+2,000% while OptiScan called neither. The owner should not
 * be the system's miss detector. This subsystem answers, deterministically and per
 * session: did a genuinely executable extreme move exist, did OptiScan see it, and
 * if it saw it, why did nothing go out.
 *
 * IT IS NOT A TRADER. It never sends a subscriber alert, never opens or closes a
 * paper position, never mutates a scanner rule, and never promotes a strategy. It
 * produces evidence and research proposals. A live case it believes is still
 * actionable is handed to the NORMAL deterministic scanner, which decides on its
 * own terms — the agent's opinion is not an override.
 *
 * THE GRADING RULE THAT MAKES THIS HONEST. An advertised percentage is a claim
 * about a print; an executable return is a claim about a fill. They are graded
 * separately and never merged. `ask` entry to later `bid` is the only convention
 * that can produce VERIFIED_EXECUTABLE — every other basis is diagnostic and is
 * labelled as such, because buying at the bid and selling at the ask is not a
 * trade anyone made.
 */

/** How a quoted return was computed. Only ASK_TO_BID can support an official claim. */
export type ReturnBasis =
  | "ASK_TO_BID"
  | "ASK_TO_ASK"
  | "MIDPOINT"
  | "LAST_TRADE"
  | "DAILY_HIGH";

/**
 * Verdict on an advertised gain. The default is INSUFFICIENT_EVIDENCE — a case
 * earns a stronger verdict, it never starts with one.
 */
export type ClaimVerdict =
  | "VERIFIED_EXECUTABLE"
  | "PARTIALLY_EXECUTABLE"
  | "LAST_TRADE_ONLY"
  | "MIDPOINT_ONLY"
  | "ASK_SIDE_ONLY"
  | "BAD_PRINT"
  | "ILLIQUID_HINDSIGHT_ONLY"
  | "UNVERIFIED_EXTERNAL_CLAIM"
  | "INSUFFICIENT_EVIDENCE";

/** One primary cause per case. Secondary causes are recorded separately. */
export type MissedRootCause =
  | "NOT_A_VERIFIED_EXTREME_WINNER"
  | "EXTERNAL_ALERT_NOT_IDENTIFIED"
  | "OUTSIDE_DISCOVERY_UNIVERSE"
  | "UNDERLYING_SETUP_MISSED"
  | "WRONG_DIRECTION"
  | "WRONG_STRATEGY_CLASSIFICATION"
  | "ENTRY_TOO_LATE"
  | "CONFIRMATION_TOO_LATE"
  | "PREMIUM_CHASE_SUPPRESSION"
  | "FAILED_CONFIRMATION_GATE"
  | "WRONG_EXPIRATION"
  | "WRONG_STRIKE"
  | "WRONG_DTE"
  | "POOR_CONTRACT_RANKING"
  | "LIQUIDITY_REJECTION_CORRECT"
  | "SPREAD_REJECTION_CORRECT"
  | "EXTENSION_REJECTION_CORRECT"
  | "DATA_MISSING"
  | "PROVIDER_BUDGET_BLOCKED"
  | "SCHEDULER_DELAY"
  | "QUOTE_PATH_FAILURE"
  | "OPPOSITE_DIRECTION_CONFLICT"
  | "DUPLICATE_OR_COOLDOWN_SUPPRESSION"
  | "RESEARCH_ONLY_CAPTURED"
  | "HIGH_ASYMMETRY_CAPTURED_NOT_PROMOTED"
  | "ALERTED_BUT_WRONG_CONTRACT"
  | "ALERTED_TOO_LATE"
  | "HINDSIGHT_ONLY"
  | "OTHER_PROVEN_REASON"
  | "INSUFFICIENT_EVIDENCE";

/**
 * What, if anything, could still be done about the case. Only
 * LIVE_RECOVERABLE_OPPORTUNITY may be routed back through the normal scanner,
 * and even then the scanner decides.
 */
export type Recoverability =
  | "LIVE_RECOVERABLE_OPPORTUNITY"
  | "HINDSIGHT_RESEARCH_ONLY"
  | "CORRECTLY_REJECTED"
  | "MISSED_DUE_TO_SYSTEM_DEFECT"
  | "MISSED_DUE_TO_STRATEGY_RULE"
  | "WRONG_CONTRACT_SELECTED"
  | "TOO_LATE_TO_NOTIFY"
  | "INSUFFICIENT_EVIDENCE";

/**
 * Which of the three failure families the miss belongs to. This is the
 * distinction the owner actually asked for: a system that never saw the setup
 * needs different work from one that saw it and bought the wrong contract.
 */
export type FailureFamily =
  | "UNDERLYING_SETUP_FAILURE"
  | "CONTRACT_SELECTION_FAILURE"
  | "CORRECT_REJECTION"
  | "NO_FAILURE_ESTABLISHED";

/** Evidence strength. Governs whether a case may support any conclusion at all. */
export type EvidenceQuality = "STRONG" | "PARTIAL" | "WEAK" | "NONE";

/** Every case is research until a separate, fully-validated path says otherwise. */
export type CaseStatus =
  | "RESEARCH_ONLY"
  | "PROPOSAL_DRAFTED"
  | "ROUTED_TO_SCANNER"
  | "CLOSED_NO_ACTION";

/** A quote observation used as evidence. Never fabricated, never interpolated. */
export interface QuoteObservation {
  atMs: number;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  lastTrade: number | null;
  quoteTimestampMs: number | null;
  volume: number | null;
  openInterest: number | null;
}

/** A return measured on one basis, with the timestamps that produced it. */
export interface MeasuredReturn {
  basis: ReturnBasis;
  entryAtMs: number;
  entryPrice: number;
  exitAtMs: number;
  exitPrice: number;
  returnPct: number;
}

/** Time-to-threshold ladder. `null` means the threshold was never reached. */
export interface ThresholdLadder {
  pct25: number | null;
  pct50: number | null;
  pct100: number | null;
  pct200: number | null;
  pct500: number | null;
  pct1000: number | null;
  pct2000: number | null;
}

export const LADDER_THRESHOLDS: readonly (keyof ThresholdLadder)[] = [
  "pct25", "pct50", "pct100", "pct200", "pct500", "pct1000", "pct2000",
] as const;

export const LADDER_PCT: Record<keyof ThresholdLadder, number> = {
  pct25: 25, pct50: 50, pct100: 100, pct200: 200, pct500: 500, pct1000: 1000, pct2000: 2000,
};

export function emptyLadder(): ThresholdLadder {
  return { pct25: null, pct50: null, pct100: null, pct200: null, pct500: null, pct1000: null, pct2000: null };
}

/** What the regular scanner and the High-Asymmetry lane each did with a symbol. */
export interface LaneDecision {
  /** First time this lane recorded ANY observation of the symbol this session. */
  firstSeenAtMs: number | null;
  /** First time it produced a directional candidate. */
  firstCandidateAtMs: number | null;
  direction: string | null;
  setupFamily: string | null;
  /** The contract the lane actually selected, if it got that far. */
  selectedOcc: string | null;
  /** Contracts the lane evaluated and did not select. */
  consideredOccs: string[];
  /** Terminal reason, verbatim from the pipeline. Never paraphrased. */
  terminalReason: string | null;
  state: string | null;
  observationCount: number;
  candidateCount: number;
  readyCount: number;
  rejectedCount: number;
  /**
   * Direction across the WHOLE session, not just the first row. "The scanner was
   * bearish" is a claim about a distribution; reading it off one row would state
   * a conclusion the evidence does not support.
   */
  directionTally: Record<string, number>;
  /** Contracts considered, split by option side. Zero calls is a direction fact. */
  callsConsidered: number;
  putsConsidered: number;
}

export function emptyLaneDecision(): LaneDecision {
  return {
    firstSeenAtMs: null, firstCandidateAtMs: null, direction: null, setupFamily: null,
    selectedOcc: null, consideredOccs: [], terminalReason: null, state: null,
    observationCount: 0, candidateCount: 0, readyCount: 0, rejectedCount: 0,
    directionTally: {}, callsConsidered: 0, putsConsidered: 0,
  };
}

/** Option side from an OCC symbol, or null when it is not parseable. */
export function occSide(occ: string): "C" | "P" | null {
  const m = /^O?:?[A-Z]{1,6}\d{6}([CP])\d{8}$/.exec(String(occ).replace(/^O:/, ""));
  return m ? (m[1] as "C" | "P") : null;
}

/** Provider and scheduler state during the window, to attribute budget-caused misses. */
export interface SystemStateDuringWindow {
  providerMinutesObserved: number;
  providerRequestsInWindow: number;
  providerQuotaBlocksInWindow: number;
  /** Admission rate across the window, 0-100. Low values make budget a live suspect. */
  admissionPct: number | null;
  /** True when the symbol's lane was refused often enough to plausibly cause the miss. */
  budgetPlausibleCause: boolean;
  notes: string[];
}

/**
 * One versioned missed-opportunity case. `caseVersion` is bumped whenever the
 * schema or the classification logic changes, so a stored case always records
 * which rules produced it.
 */
export interface MissedOpportunityCase {
  missedOpportunityId: string;
  caseVersion: number;
  symbol: string;
  sessionDate: string;
  direction: "CALL" | "PUT" | null;
  occSymbol: string | null;
  expiration: string | null;
  strike: number | null;
  dte: number | null;

  externalClaim: {
    claimed: boolean;
    claimedReturnPct: number | null;
    source: string | null;
    alertIdentified: boolean;
    verdict: ClaimVerdict;
  };

  verified: {
    /** The one number that may ever be called executable. */
    executableReturnPct: number | null;
    basis: ReturnBasis | null;
    measured: MeasuredReturn[];
    ladder: ThresholdLadder;
    mfePct: number | null;
    maePct: number | null;
    entrySpreadPct: number | null;
    entryVolume: number | null;
    entryOpenInterest: number | null;
    maxExecutableBid: number | null;
    /** Notional fillable near the claimed entry, where inferable. */
    executableNotionalUsd: number | null;
  };

  timeline: {
    earliestValidSetupAtMs: number | null;
    earliestExecutableContractAtMs: number | null;
    optiscanFirstSeenAtMs: number | null;
    asymmetryFirstSeenAtMs: number | null;
    localHighAtMs: number | null;
  };

  regularScanner: LaneDecision;
  highAsymmetry: LaneDecision;

  betterAlternativeOcc: string | null;
  rootCause: MissedRootCause;
  secondaryCauses: MissedRootCause[];
  failureFamily: FailureFamily;
  recoverability: Recoverability;
  evidenceQuality: EvidenceQuality;
  systemState: SystemStateDuringWindow;

  quantFinding: string | null;
  aiAdvisory: string | null;
  experimentId: string | null;
  feedbackProposalId: string | null;

  status: CaseStatus;
  /** Always false in this subsystem. Recorded so the invariant is auditable. */
  productionChanged: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Bumped when classification logic or the case shape changes. */
export const MISSED_OPPORTUNITY_CASE_VERSION = 1;

/**
 * Causes that mean the system behaved correctly. Used to keep "we were right to
 * pass" out of the defect counts a weekly report would otherwise inflate.
 */
export const CORRECT_REJECTION_CAUSES: readonly MissedRootCause[] = [
  "LIQUIDITY_REJECTION_CORRECT",
  "SPREAD_REJECTION_CORRECT",
  "EXTENSION_REJECTION_CORRECT",
  "NOT_A_VERIFIED_EXTREME_WINNER",
  "HINDSIGHT_ONLY",
] as const;

/** Causes that indicate a defect in the system rather than in the strategy. */
export const SYSTEM_DEFECT_CAUSES: readonly MissedRootCause[] = [
  "DATA_MISSING",
  "PROVIDER_BUDGET_BLOCKED",
  "SCHEDULER_DELAY",
  "QUOTE_PATH_FAILURE",
] as const;
