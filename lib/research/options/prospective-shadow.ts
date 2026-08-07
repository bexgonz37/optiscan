/**
 * The prospective shadow arm: baseline and `LHC_SELECT_V1` decided on the SAME opportunity,
 * recorded side by side, before either outcome is known.
 *
 * WHY THIS EXISTS
 *
 * Everything known about V1 was measured on the 58 rows it was derived from. A rule read off
 * a cohort and then scored against that cohort is a description of the cohort. The only test
 * that can actually fail is the one where the decision is written down first and the outcome
 * arrives later — so this module runs at the delivery-decision choke point, records what each
 * arm decided and every input it decided on, and then never touches the row again.
 *
 * WHAT MAKES THIS HONEST
 *
 * 1. `EXPERIMENT_ONLY` and `BASELINE_ONLY` are both tracked. A filter is only interesting if
 *    it can be shown to have been WRONG, which needs the trades it rejected followed to their
 *    close. Recording only the admits would reproduce the trailing-stop error — a policy that
 *    never appears to cost anything because its costs were never measured.
 * 2. Features are built from delivery-time inputs only. `assertNoLeakage` runs on the way in,
 *    so a lifetime accumulator cannot reach the rule even by refactor accident.
 * 3. The confirmation-cost fields are captured HERE, at the moment they are true. The historical
 *    cohort has `first_detected_at_ms == entered_at_ms` for all 58 rows, so confirmation cost is
 *    not answerable retrospectively and must never be backfilled.
 *
 * AUTHORITY BOUNDARY: nothing in this module can change what is delivered. It reads the
 * baseline decision that was ALREADY made and writes a row. `productionBehaviorChanged` is
 * false by construction — there is no return value the caller acts on.
 *
 * PURE. The DB writer is `shadow-arm-store.ts`.
 */

import { evaluate, EXPERIMENT_ID, EXPERIMENT_MODE, type SelectionDecision } from "./selection-experiment.ts";
import {
  assertNoLeakage, easternSessionDate, easternMinuteOfDay,
  type PreEntryFeatures,
} from "./pre-entry-features.ts";
import { freezeAttribution, type PolicyAttribution } from "./policy-attribution.ts";
import { LHC_SELECT_V1 } from "./experiment-registry.ts";

/** The one strategy this experiment is scoped to. Anything else is not evaluated. */
export const SHADOW_STRATEGY = "lower_high_continuation";

/**
 * Which arms admitted this opportunity.
 * BOTH_ADMIT      baseline delivered it and V1 agrees — one canonical contract, two labels
 * BASELINE_ONLY   baseline delivered it, V1 rejected — the rejection is on trial
 * EXPERIMENT_ONLY V1 would have taken it, baseline did not — a recovered opportunity
 * BOTH_REJECT     neither wanted it — recorded so the denominator is real
 */
export type ShadowArm = "BOTH_ADMIT" | "BASELINE_ONLY" | "EXPERIMENT_ONLY" | "BOTH_REJECT";

export function classifyArm(baselineAdmitted: boolean, experimentAdmitted: boolean): ShadowArm {
  if (baselineAdmitted && experimentAdmitted) return "BOTH_ADMIT";
  if (baselineAdmitted) return "BASELINE_ONLY";
  if (experimentAdmitted) return "EXPERIMENT_ONLY";
  return "BOTH_REJECT";
}

/**
 * Every timing field the historical cohort could not answer, captured at the moment it is
 * true. `null` means "not observed", NEVER zero — the degenerate history is exactly what
 * happens when an unobserved value is written as 0.
 */
export interface ConfirmationCapture {
  firstEligibleAtMs: number | null;
  candidateCreatedAtMs: number | null;
  confirmationStartedAtMs: number | null;
  confirmationCompletedAtMs: number | null;
  contractSelectedAtMs: number | null;
  ownerNotifiedAtMs: number | null;
  paperEnteredAtMs: number | null;

  firstEligibleAsk: number | null;
  frozenEntryAsk: number | null;
  underlyingAtFirstEligibility: number | null;
  underlyingAtEntry: number | null;

  /** (frozenEntryAsk - firstEligibleAsk) / firstEligibleAsk — what waiting cost in premium. */
  premiumExpansionPct: number | null;
  /** Signed underlying move between first eligibility and entry, in the thesis direction. */
  underlyingMoveBeforeEntryPct: number | null;
  /**
   * Fraction of the move to the nearest opposing level still unclaimed at entry. Low values
   * mean the setup was mostly over by the time it was confirmed.
   */
  rewardRemainingAtEntry: number | null;

  confirmationDelayMs: number | null;
  queueDelayMs: number | null;
  deliveryDelayMs: number | null;

  /** Per-field provenance, so a report can say which numbers it is entitled to use. */
  fieldQuality: Record<string, TimingQuality>;
}

/**
 * Why a timing value is (or is not) trustworthy.
 * OBSERVED    written from a real event timestamp
 * DERIVED     computed from two OBSERVED values
 * UNAVAILABLE the producing path did not supply it — recorded as null, never 0
 */
export type TimingQuality = "OBSERVED" | "DERIVED" | "UNAVAILABLE";

/** Narrow view of the live delivery submission. Deliberately no outcome fields. */
export interface ShadowSubmissionInput {
  symbol: string;
  strategy: string;
  side: "call" | "put";
  direction: "bullish" | "bearish";
  optionSymbol: string;
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  underlyingPrice: number | null;

  /** The baseline's own decision, already made. Read, never influenced. */
  baselineOutcome: string;
  baselineAdmitted: boolean;
  baselineReason: string;
  baselineQuality: number | null;

  opportunityCaseId: string | null;
  alertId: string | null;
  sessionState: string | null;

  nowMs: number;
  decisionMs: number | null;
  firstDetectedAtMs: number | null;
  firstReadyAtMs: number | null;
  underlyingAtFirstDetection: number | null;
  optionAtFirstDetection: number | null;
  /** Parsed evidence snapshot — the same shape the historical loader reads. */
  featureSnapshot: Record<string, unknown> | null;
}

export interface ShadowRecord {
  experimentId: string;
  experimentVersion: number;
  mode: typeof EXPERIMENT_MODE;
  /** Constant. This module has no path that changes a delivery. */
  productionBehaviorChanged: false;

  sessionDate: string;
  recordedAtMs: number;
  symbol: string;
  strategy: string;
  side: string;
  direction: string;
  optionSymbol: string;
  opportunityCaseId: string | null;
  alertId: string | null;

  baselineAdmitted: boolean;
  baselineOutcome: string;
  baselineReason: string;
  baselineQuality: number | null;

  experimentAdmitted: boolean;
  experimentBlockedBy: string[];
  experimentUnavailable: string[];
  experimentScore: number;
  experimentComponents: SelectionDecision["components"];
  /** One deterministic sentence a human can check without rerunning the rule. */
  experimentReason: string;

  arm: ShadowArm;
  features: PreEntryFeatures;
  confirmation: ConfirmationCapture;
  attribution: PolicyAttribution;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Build the pre-entry feature vector from a LIVE submission.
 *
 * Mirrors `extractPreEntryFeatures` field for field so a prospective row and a historical
 * cohort row are directly comparable — if these two drift, the prospective sample stops being
 * a test of the same rule. What it does NOT mirror is the degenerate pair: `confirmationDelayMs`
 * and `premiumExpansionPct` are genuinely measurable here and are carried in
 * `ConfirmationCapture`, where their provenance travels with them.
 */
export function liveFeaturesFromSubmission(s: ShadowSubmissionInput): PreEntryFeatures {
  const ev = obj(s.featureSnapshot);
  const u = obj(ev.underlying);
  const ch = obj(ev.chain);

  const px = num(s.underlyingPrice) ?? num(u.price);
  const strike = num(s.strike);
  const moneynessPct = px && px > 0 && strike != null ? ((strike - px) / px) * 100 : null;
  const entryFill = num(s.ask) != null && num(s.bid) != null
    ? (num(s.bid)! + num(s.ask)!) / 2
    : num(s.ask);

  return {
    dte: num(s.dte), strike, entryFill,
    spreadPct: num(s.spreadPct), contractVolume: num(s.volume),
    openInterest: num(s.openInterest), iv: num(s.iv),
    absDelta: num(s.delta) == null ? null : Math.abs(num(s.delta)!),
    moneynessPct,
    underlyingAtEntry: px,
    dollarVolume: num(u.dollarVolume), vwapDistPct: num(u.vwapDistPct),
    aboveVwap: typeof u.aboveVwap === "boolean" ? u.aboveVwap : null,
    velPct: num(u.velPct), accelPct: num(u.accelPct), volumeAccel: num(u.volumeAccel),
    compressionScore: num(u.compressionScore), expansionScore: num(u.expansionScore),
    atrPct: num(u.atrPct), hodProxPct: num(u.hodProxPct), lodProxPct: num(u.lodProxPct),
    nearestSupportDistPct: num(u.nearestSupportDistPct),
    nearestResistanceDistPct: num(u.nearestResistanceDistPct),
    gapPct: num(u.gapPct),
    gapBehavior: typeof u.gapBehavior === "string" ? u.gapBehavior : null,
    callPutVolRatio: num(ch.callPutVolRatio), ivLevel: num(ch.ivLevel),
    medianSpreadPct: num(ch.medianSpreadPct), zeroBidRate: num(ch.zeroBidRate),
    ntmConcentration: num(ch.ntmConcentration),
    chainDirection: typeof ch.direction === "string" ? ch.direction : null,
    etMinute: easternMinuteOfDay(s.decisionMs ?? s.nowMs),
    // Assigned by the caller, which sees the session. Never guessed here.
    sessionAlertOrdinal: null,
    concurrentOpen: null,
    earlinessPhase: typeof ev.earlinessPhase === "string" ? ev.earlinessPhase : null,
    // Carried in ConfirmationCapture with provenance. Kept null here so the feature vector
    // stays comparable to the historical cohort, where both are degenerate.
    confirmationDelayMs: null,
    premiumExpansionPct: null,
  };
}

/**
 * Capture the confirmation-cost fields.
 *
 * Every field is null when its source is absent. The single most important property of this
 * function is that it never substitutes 0 for "not observed" — that substitution is what made
 * the historical cohort unable to answer the question at all.
 */
export function captureConfirmation(s: ShadowSubmissionInput): ConfirmationCapture {
  const q: Record<string, TimingQuality> = {};
  const mark = <T>(k: string, v: T | null, basis: TimingQuality): T | null => {
    q[k] = v == null ? "UNAVAILABLE" : basis;
    return v;
  };

  const firstEligibleAtMs = mark("firstEligibleAtMs", num(s.firstReadyAtMs) ?? num(s.firstDetectedAtMs), "OBSERVED");
  const candidateCreatedAtMs = mark("candidateCreatedAtMs", num(s.firstDetectedAtMs), "OBSERVED");
  const confirmationStartedAtMs = mark("confirmationStartedAtMs", num(s.firstReadyAtMs), "OBSERVED");
  const confirmationCompletedAtMs = mark("confirmationCompletedAtMs", num(s.decisionMs), "OBSERVED");
  const contractSelectedAtMs = mark("contractSelectedAtMs", num(s.decisionMs), "OBSERVED");
  const ownerNotifiedAtMs = mark("ownerNotifiedAtMs", s.baselineAdmitted ? num(s.nowMs) : null, "OBSERVED");
  // The mirror is reserved downstream of this call; the store links it when it exists.
  const paperEnteredAtMs = mark("paperEnteredAtMs", null, "UNAVAILABLE");

  const firstEligibleAsk = mark("firstEligibleAsk", num(s.optionAtFirstDetection), "OBSERVED");
  const frozenEntryAsk = mark("frozenEntryAsk", num(s.ask), "OBSERVED");
  const underlyingAtFirstEligibility = mark("underlyingAtFirstEligibility", num(s.underlyingAtFirstDetection), "OBSERVED");
  const underlyingAtEntry = mark("underlyingAtEntry", num(s.underlyingPrice), "OBSERVED");

  const premiumExpansionPct = mark(
    "premiumExpansionPct",
    firstEligibleAsk != null && firstEligibleAsk > 0 && frozenEntryAsk != null
      ? ((frozenEntryAsk - firstEligibleAsk) / firstEligibleAsk) * 100
      : null,
    "DERIVED",
  );

  // Signed IN THE THESIS DIRECTION: a bearish setup that fell before entry has consumed
  // reward, so both directions report "move already spent" as a positive number.
  const rawMovePct =
    underlyingAtFirstEligibility != null && underlyingAtFirstEligibility > 0 && underlyingAtEntry != null
      ? ((underlyingAtEntry - underlyingAtFirstEligibility) / underlyingAtFirstEligibility) * 100
      : null;
  const underlyingMoveBeforeEntryPct = mark(
    "underlyingMoveBeforeEntryPct",
    rawMovePct == null ? null : s.direction === "bearish" ? -rawMovePct : rawMovePct,
    "DERIVED",
  );

  // How much of the distance to the opposing level is left. The level distances are measured
  // at delivery, so this is the reward still available to the trade being opened.
  const ev = obj(s.featureSnapshot);
  const u = obj(ev.underlying);
  const targetDist = s.direction === "bearish"
    ? num(u.nearestSupportDistPct)
    : num(u.nearestResistanceDistPct);
  const rewardRemainingAtEntry = mark(
    "rewardRemainingAtEntry",
    targetDist == null ? null : Math.abs(targetDist),
    "DERIVED",
  );

  const confirmationDelayMs = mark(
    "confirmationDelayMs",
    confirmationCompletedAtMs != null && firstEligibleAtMs != null
      ? confirmationCompletedAtMs - firstEligibleAtMs
      : null,
    "DERIVED",
  );
  const queueDelayMs = mark(
    "queueDelayMs",
    confirmationStartedAtMs != null && candidateCreatedAtMs != null
      ? confirmationStartedAtMs - candidateCreatedAtMs
      : null,
    "DERIVED",
  );
  const deliveryDelayMs = mark(
    "deliveryDelayMs",
    ownerNotifiedAtMs != null && confirmationCompletedAtMs != null
      ? ownerNotifiedAtMs - confirmationCompletedAtMs
      : null,
    "DERIVED",
  );

  return {
    firstEligibleAtMs, candidateCreatedAtMs, confirmationStartedAtMs, confirmationCompletedAtMs,
    contractSelectedAtMs, ownerNotifiedAtMs, paperEnteredAtMs,
    firstEligibleAsk, frozenEntryAsk, underlyingAtFirstEligibility, underlyingAtEntry,
    premiumExpansionPct, underlyingMoveBeforeEntryPct, rewardRemainingAtEntry,
    confirmationDelayMs, queueDelayMs, deliveryDelayMs,
    fieldQuality: q,
  };
}

/** One sentence naming exactly why V1 landed where it did. */
export function experimentReason(d: SelectionDecision): string {
  if (d.admitted) return `admitted: all ${d.components.length ? "gates" : "gates"} passed (score ${d.score})`;
  const missing = d.unavailable.length ? ` (unmeasurable: ${d.unavailable.join(", ")})` : "";
  return `rejected by ${d.blockedBy.join(", ")}${missing}`;
}

/**
 * Decide both arms and assemble the record. Throws only if a hindsight field reaches the
 * rule — a condition that must fail loudly rather than be recorded as a decision.
 */
export function buildShadowRecord(
  s: ShadowSubmissionInput,
  ctx: { deploymentSha: string | null; population: string },
): ShadowRecord {
  const features = liveFeaturesFromSubmission(s);
  assertNoLeakage(features as unknown as Record<string, unknown>, "prospective-shadow.buildShadowRecord");
  const decision = evaluate(features);

  return {
    experimentId: EXPERIMENT_ID,
    experimentVersion: LHC_SELECT_V1.experimentVersion,
    mode: EXPERIMENT_MODE,
    productionBehaviorChanged: false,

    sessionDate: easternSessionDate(s.decisionMs ?? s.nowMs),
    recordedAtMs: s.nowMs,
    symbol: s.symbol,
    strategy: s.strategy,
    side: s.side,
    direction: s.direction,
    optionSymbol: s.optionSymbol,
    opportunityCaseId: s.opportunityCaseId,
    alertId: s.alertId,

    baselineAdmitted: s.baselineAdmitted,
    baselineOutcome: s.baselineOutcome,
    baselineReason: s.baselineReason,
    baselineQuality: s.baselineQuality,

    experimentAdmitted: decision.admitted,
    experimentBlockedBy: decision.blockedBy,
    experimentUnavailable: decision.unavailable,
    experimentScore: decision.score,
    experimentComponents: decision.components,
    experimentReason: experimentReason(decision),

    arm: classifyArm(s.baselineAdmitted, decision.admitted),
    features,
    confirmation: captureConfirmation(s),
    attribution: freezeAttribution({
      strategyId: s.strategy,
      population: ctx.population,
      experimentId: EXPERIMENT_ID,
      cohortId: LHC_SELECT_V1.sourceCohortId,
      deploymentSha: ctx.deploymentSha,
    }),
  };
}

/**
 * Does this submission belong in the shadow arm at all?
 *
 * Scoped to the one strategy V1 was derived for. Widening this without re-deriving the rule
 * would silently test it on a population it was never about.
 */
export function isShadowEligible(strategy: string): boolean {
  return strategy === SHADOW_STRATEGY;
}
