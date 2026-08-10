/**
 * pre-move-replay.ts — PRE_MOVE_DISCOVERY_REPLAY_V1.
 *
 * The same question live capture asks — "where in the move did we find this?" — answered
 * for a historical moment from reconstructed evidence.
 *
 * ── Why this is a SEPARATE identity ──────────────────────────────────────────
 *
 *     REPLAY_DERIVED  is never  OBSERVED_LIVE.
 *
 * A live row is a measurement: the scanner really did see that price at that moment. A
 * replay row is an inference from what we later stored, and its coverage depends on what
 * a backfill happened to fetch. Written into one table with one shape they become
 * indistinguishable, and then every forward statistic is quietly contaminated by
 * reconstructions of the past. So the origin is part of the row and part of the key,
 * the version is stamped, and coverage is reported rather than assumed.
 *
 * ── The classifier is REUSED, not reimplemented ──────────────────────────────
 *
 * `classifyDiscovery` from the live module does the staging. A second implementation
 * would drift from the first, and the whole point of comparing replay against live is
 * that the same rule was applied to both. What differs is only where the INPUTS come
 * from: live reads the scanner's in-flight evidence, replay reads the durable store
 * under a time fence.
 *
 * ── No hindsight ─────────────────────────────────────────────────────────────
 *
 * Every input is fetched through `replay.ts`, which fences in SQL. Nothing dated after
 * the classification instant can reach the stage — including the day's final HOD/LOD,
 * the eventual outcome, and any later quote. Outcome-aware grading is a separate
 * function and says so in its name.
 */
import {
  classifyDiscovery,
  computeRewardRemaining,
  type DiscoveryStage,
  type OptionSide,
} from "../options/pre-move-discovery.ts";
import {
  replayContractStateOnDb,
  replayUnderlyingStateOnDb,
  sessionDateOf,
  type ReplayEvidenceStrength,
} from "./replay.ts";
import { deriveHistoricalMarketContext } from "./market-context.ts";
import type { StoreDb } from "./store.ts";

export const PRE_MOVE_REPLAY_VERSION = "PRE_MOVE_DISCOVERY_REPLAY_V1" as const;
export const REPLAY_ORIGIN = "REPLAY_DERIVED" as const;

export interface PreMoveReplayResult {
  version: typeof PRE_MOVE_REPLAY_VERSION;
  origin: typeof REPLAY_ORIGIN;

  occ: string;
  symbol: string;
  side: OptionSide;
  sessionDate: string | null;
  /** The instant the setup is classified AT. Nothing later is visible. */
  detectedAtMs: number;
  /** The instant an alert would have fired. Defaults to detection when absent. */
  decisionAtMs: number;

  stage: DiscoveryStage;
  underlyingMoveConsumedPct: number | null;
  premiumExpansionConsumedPct: number | null;
  moveConsumedFraction: number | null;
  rewardRemainingFraction: number | null;
  rewardRemainingBand: string;

  /** Contract economics at the decision instant, from stored NBBO. */
  entryAsk: number | null;
  spreadPct: number | null;
  dte: number | null;
  moneynessPct: number | null;

  /** Market regime at the decision instant, itself replay-derived. */
  regime: string;
  marketAlignment: string;

  underlyingBarsUsed: number;
  missingFields: string[];
  evidenceQuality: ReplayEvidenceStrength;
  reason: string;
}

/**
 * Classify one historical opportunity.
 *
 * `detectedAtMs` is when the setup first became visible; `decisionAtMs` is when it would
 * have been acted on. Keeping them apart is what makes "how much did we consume while
 * confirming" answerable at all — collapsing them scores every setup as instantly
 * actionable, which is the flattering answer.
 */
export function replayPreMoveDiscoveryOnDb(
  db: StoreDb,
  input: {
    occ: string;
    symbol: string;
    side: OptionSide;
    detectedAtMs: number;
    decisionAtMs?: number;
    triggerLevel?: number | null;
    maxQuoteStalenessMs?: number;
  },
): PreMoveReplayResult {
  const decisionAtMs = input.decisionAtMs ?? input.detectedAtMs;
  const missing: string[] = [];

  // Underlying at BOTH instants, each fenced independently.
  const atDetection = replayUnderlyingStateOnDb(db, input.symbol, input.detectedAtMs);
  const atDecision = replayUnderlyingStateOnDb(db, input.symbol, decisionAtMs);
  for (const m of atDetection.missing) missing.push(`detection.${m}`);

  const contractAtDetection = replayContractStateOnDb(db, input.occ, input.detectedAtMs, {
    underlyingPrice: atDetection.price,
    maxStalenessMs: input.maxQuoteStalenessMs,
  });
  const contractAtDecision = replayContractStateOnDb(db, input.occ, decisionAtMs, {
    underlyingPrice: atDecision.price,
    maxStalenessMs: input.maxQuoteStalenessMs,
  });
  for (const m of contractAtDecision.missing) missing.push(`decision.${m}`);

  // Trigger state. Absent knowledge is NULL, never false: a false asserts "the move has
  // not begun" and short-circuits the consumed-fraction measurement entirely, which is
  // exactly the degenerate column the live lane already had to fix once.
  const isCall = input.side === "CALL";
  const triggerLevel = input.triggerLevel ?? null;
  const triggerTaken = triggerLevel == null || atDecision.price == null
    ? null
    : (isCall ? atDecision.price >= triggerLevel : atDecision.price <= triggerLevel);

  const classification = classifyDiscovery({
    side: input.side,
    underlyingAtFirstDetection: atDetection.price,
    underlyingAtEligible: atDecision.price,
    underlyingAtAlert: atDecision.price,
    optionAtFirstDetection: contractAtDetection.executableAsk,
    optionAtEligible: contractAtDecision.executableAsk,
    optionAtAlert: contractAtDecision.executableAsk,
    triggerLevel,
    triggerTaken,
    // Session extremes come from the DECISION instant's reconstruction, which is
    // session-to-date through that instant — never the day's final range.
    sessionHigh: atDecision.sessionHigh,
    sessionLow: atDecision.sessionLow,
    sessionOpen: atDecision.sessionOpen,
    compressionPct: atDecision.compressionPct,
    volumeAcceleration: atDecision.volumeAcceleration,
    firstDetectedAtMs: input.detectedAtMs,
    eligibleAtMs: decisionAtMs,
    alertAtMs: decisionAtMs,
  });
  for (const m of classification.missingInputs) missing.push(`classify.${m}`);

  const reward = computeRewardRemaining(classification);
  const ctx = deriveHistoricalMarketContext(db, decisionAtMs);

  // Market alignment: does the tape agree with the trade's direction? UNKNOWN when the
  // regime itself is unknown — an unaligned trade and an unobserved market are different
  // findings and must not share a label.
  const marketAlignment = ctx.broadDirection === "UNKNOWN"
    ? "UNKNOWN"
    : ctx.broadDirection === "MIXED"
      ? "MIXED"
      : (isCall && ctx.broadDirection === "RISK_ON") || (!isCall && ctx.broadDirection === "RISK_OFF")
        ? "ALIGNED"
        : "COUNTER_TREND";

  const evidenceQuality: ReplayEvidenceStrength = classification.stage === "UNGRADABLE"
    ? "INSUFFICIENT"
    : missing.length === 0 && contractAtDecision.executableAsk != null
      ? "COMPLETE"
      : "PARTIAL";

  return {
    version: PRE_MOVE_REPLAY_VERSION,
    origin: REPLAY_ORIGIN,
    occ: String(input.occ).toUpperCase(),
    symbol: String(input.symbol).toUpperCase(),
    side: input.side,
    sessionDate: sessionDateOf(decisionAtMs),
    detectedAtMs: input.detectedAtMs,
    decisionAtMs,
    stage: classification.stage,
    underlyingMoveConsumedPct: classification.underlyingMoveConsumedPct,
    premiumExpansionConsumedPct: classification.premiumExpansionConsumedPct,
    moveConsumedFraction: classification.moveConsumedFraction,
    rewardRemainingFraction: reward.fraction,
    rewardRemainingBand: reward.band,
    entryAsk: contractAtDecision.executableAsk,
    spreadPct: contractAtDecision.spreadPct,
    dte: contractAtDecision.dte,
    moneynessPct: contractAtDecision.moneynessPct,
    regime: ctx.broadDirection,
    marketAlignment,
    underlyingBarsUsed: atDecision.barsUsed,
    missingFields: missing,
    evidenceQuality,
    reason:
      `${classification.reason}. REPLAY_DERIVED from stored evidence at or before the decision `
      + "instant — a reconstruction, never a live observation, and its coverage depends on what "
      + "the backfill fetched.",
  };
}
