/**
 * High-Asymmetry Radar — shadow-only research states. PURE.
 *
 * These states are EVIDENCE-COVERAGE classifications, not predictions and not
 * subscriber readiness. A state says what we could prove about a candidate at
 * its own timestamp; it says nothing about what the contract will do next.
 *
 * Two things are deliberately absent from this module and must stay absent in
 * Phase 1:
 *
 *  - No tuned numeric score. Nothing here was fitted to examples. The only
 *    numbers referenced are the premium-chase reporting buckets, which are
 *    themselves diagnostics.
 *  - No authority. `RESEARCH_STATE_CAN_SEND` maps EVERY state to false and
 *    `canResearchStateSend()` returns false unconditionally. There is no
 *    argument, flag, or state that flips it.
 */
import type { AsymmetryEvidence } from "./evidence.ts";
import type { PremiumChaseAnalysis } from "./premium-chase.ts";

export type AsymmetryResearchState =
  | "EARLY_ASYMMETRY"
  | "CONFIRMING"
  | "HIGH_ASYMMETRY"
  | "TRIGGERED"
  | "PREMIUM_CHASE"
  | "LIQUIDITY_FAILURE"
  | "INVALIDATED"
  | "INSUFFICIENT_EVIDENCE";

export const ASYMMETRY_RESEARCH_STATES: AsymmetryResearchState[] = [
  "EARLY_ASYMMETRY", "CONFIRMING", "HIGH_ASYMMETRY", "TRIGGERED",
  "PREMIUM_CHASE", "LIQUIDITY_FAILURE", "INVALIDATED", "INSUFFICIENT_EVIDENCE",
];

/**
 * The authority table. Frozen, exhaustive, and uniformly false.
 * A research state can never authorize a subscriber SEND.
 */
export const RESEARCH_STATE_CAN_SEND: Readonly<Record<AsymmetryResearchState, false>> = Object.freeze(
  Object.fromEntries(ASYMMETRY_RESEARCH_STATES.map((state) => [state, false])) as Record<AsymmetryResearchState, false>,
);

/** Always false. Present so the boundary is executable, not just documented. */
export function canResearchStateSend(_state: AsymmetryResearchState): false {
  return false;
}

/** Structural facts the caller observed. Never inferred inside this module. */
export interface ResearchStateSignals {
  /** A named, sourced structural confirmation at or before the candidate time. */
  confirmationSource?: string | null;
  confirmationAtMs?: number | null;
  /** The published trigger level was crossed, with a named source. */
  triggerConfirmedAtMs?: number | null;
  triggerSource?: string | null;
  /** The setup's own invalidation level was lost, with a named source. */
  invalidatedAtMs?: number | null;
  invalidationSource?: string | null;
}

export interface ResearchStateResult {
  state: AsymmetryResearchState;
  /** The single fact that decided the state. */
  reason: string;
  /** Coverage of the canonical evidence model, 0..1, for audit only. */
  evidenceCoverage: number;
  missingFields: string[];
  canSend: false;
  notSubscriberReady: true;
}

/**
 * Fields whose presence defines FULL evidence coverage. A candidate missing any
 * of them can still be researched — it simply cannot reach HIGH_ASYMMETRY,
 * because we would be calling something high-asymmetry that we cannot describe.
 */
export const COVERAGE_FIELDS = [
  "relativeStockVolume",
  "volumeAcceleration",
  "volumeOpenInterestRatio",
  "optionVolume",
  "openInterest",
  "spreadPct",
  "distanceToLevelPct",
  "roomToNextLevelPct",
  "underlyingMovePctBeforeDetection",
  "dte",
  "underlyingPrice",
] as const;

export function evidenceCoverage(evidence: AsymmetryEvidence): { coverage: number; missingFields: string[] } {
  const missingFields = COVERAGE_FIELDS.filter((field) => evidence[field] == null);
  return {
    coverage: Math.round(((COVERAGE_FIELDS.length - missingFields.length) / COVERAGE_FIELDS.length) * 10000) / 10000,
    missingFields: [...missingFields],
  };
}

const named = (value: string | null | undefined): boolean => String(value ?? "").trim().length > 0;

/**
 * Derives the shadow research state. Precedence is fixed and evaluated in
 * order, so the same inputs always produce the same state.
 */
export function deriveResearchState(
  evidence: AsymmetryEvidence,
  chase: PremiumChaseAnalysis,
  signals: ResearchStateSignals = {},
): ResearchStateResult {
  const { coverage, missingFields } = evidenceCoverage(evidence);
  const result = (state: AsymmetryResearchState, reason: string): ResearchStateResult => ({
    state, reason, evidenceCoverage: coverage, missingFields, canSend: false, notSubscriberReady: true,
  });

  // 1. Can we describe the candidate at all?
  if (!evidence.evidenceComplete) {
    return result("INSUFFICIENT_EVIDENCE", evidence.quoteRejection
      ? `Executable quote refused: ${evidence.quoteRejection}.`
      : "Identity, session, direction, setup family, or executable quote could not be verified.");
  }

  // 2. Was it tradeable? An untradeable contract is not an opportunity.
  if (evidence.liquidityState === "ILLIQUID" || evidence.liquidityState === "UNKNOWN") {
    return result("LIQUIDITY_FAILURE", `Liquidity state ${evidence.liquidityState} with spread quality ${evidence.spreadQuality}.`);
  }

  // 3. Did the setup already fail? A sourced invalidation outranks everything below.
  if (signals.invalidatedAtMs != null && Number.isFinite(signals.invalidatedAtMs) && named(signals.invalidationSource)) {
    return result("INVALIDATED", `Invalidation observed at ${signals.invalidatedAtMs} per ${signals.invalidationSource}.`);
  }

  // 4. Had the premium already run before we saw it?
  if (chase.bucket === "OVER_25") {
    return result("PREMIUM_CHASE", `Premium had already expanded ${chase.chasePct}% from the earliest valid executable quote.`);
  }

  // 5. Had the published trigger level already been crossed?
  if (signals.triggerConfirmedAtMs != null && Number.isFinite(signals.triggerConfirmedAtMs)
    && signals.triggerConfirmedAtMs <= evidence.detectionAtMs && named(signals.triggerSource)) {
    return result("TRIGGERED", `Trigger crossed at ${signals.triggerConfirmedAtMs} per ${signals.triggerSource}.`);
  }

  // 6. Confirmed structure, described completely, before the premium ran.
  const confirmed = signals.confirmationAtMs != null && Number.isFinite(signals.confirmationAtMs)
    && signals.confirmationAtMs <= evidence.detectionAtMs && named(signals.confirmationSource);
  if (confirmed && missingFields.length === 0 && chase.bucket === "UNDER_10") {
    return result("HIGH_ASYMMETRY", "Full evidence coverage, sourced confirmation, and premium chase under 10%.");
  }
  if (confirmed) {
    return result("CONFIRMING", missingFields.length
      ? `Sourced confirmation, but ${missingFields.length} evidence field(s) are missing.`
      : `Sourced confirmation with premium chase bucket ${chase.bucket}.`);
  }

  // 7. Detected, describable, but nothing has confirmed yet.
  return result("EARLY_ASYMMETRY", "Detected before any sourced structural confirmation.");
}

/** Counts per state. Every state is always present, including the zero ones. */
export function researchStateCounts(results: ResearchStateResult[]): Record<AsymmetryResearchState, number> {
  const counts = Object.fromEntries(ASYMMETRY_RESEARCH_STATES.map((s) => [s, 0])) as Record<AsymmetryResearchState, number>;
  for (const result of results) counts[result.state] += 1;
  return counts;
}
