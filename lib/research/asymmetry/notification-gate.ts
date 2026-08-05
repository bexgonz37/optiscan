/**
 * notification-gate.ts — the decision to SPEAK, kept separate from the decision
 * to CAPTURE. PURE, versioned, deterministic. No AI.
 *
 * Production on 2026-07-31 sent 39 owner-private messages from 62 captures. A
 * ~63% alert-to-capture ratio is not research surfacing, it is noise, and the
 * signal that matters gets lost in it.
 *
 * THE FIX IS NOT TO CAPTURE LESS. Backend capture, forward marks, paper
 * eligibility and Quant must all keep seeing everything — the research value is
 * in the full population. What changes is only how much of it reaches Discord.
 *
 * DEFAULTS BY STATE:
 *   EARLY_ASYMMETRY  — silent always. It is by definition unconfirmed.
 *   CONFIRMING       — silent unless the strength gate passes.
 *   HIGH_ASYMMETRY   — eligible.
 *   TRIGGERED        — eligible.
 *   everything else  — never an opening notification.
 *
 * A MINIMUM PRESENTATION PAYLOAD is also required for the eligible states: a
 * message with no executable quote and no underlying price is not worth
 * interrupting someone for, and sending it teaches them to ignore the channel.
 * Failing that check suppresses the MESSAGE ONLY — the case is still captured,
 * still marked, still paper-eligible, still counted by Quant.
 *
 * Liquidity and premium-chase blockers can never be bypassed here: this gate
 * only ever makes notification STRICTER than the state machine already did.
 */
import type { AsymmetryResearchState } from "./states.ts";
import { splitMissingEvidence } from "./evidence-requirements.ts";
import { OPTIONS_STRATEGIES, getStrategy, tenorBand, type OptionSide, type Session, type TenorBand } from "../options/strategy-catalog.ts";

export const NOTIFICATION_GATE_VERSION = "ASYM_NOTIFY_V3" as const;

/** States that may ever produce an opening notification. */
export const NOTIFY_ELIGIBLE_STATES: readonly AsymmetryResearchState[] = Object.freeze([
  "HIGH_ASYMMETRY", "TRIGGERED",
]);
/** Silent unless the strength gate passes. */
export const NOTIFY_GATED_STATES: readonly AsymmetryResearchState[] = Object.freeze(["CONFIRMING"]);

export interface NotificationStrengthConfig {
  strategyKey: string | null;
  freshnessSource: "LEGACY_GLOBAL" | "STRATEGY_CATALOG" | "UNKNOWN_STRATEGY";
  strategySide: OptionSide | null;
  strategySessions: readonly Session[];
  /** Spread above this is never worth surfacing, whatever else is true. */
  maxSpreadPct: number;
  /** Premium expansion at or above this means the early entry is gone. */
  maxPremiumChasePct: number;
  minOpenInterest: number;
  minContractVolume: number;
  /** CONFIRMING must be at least this complete to earn a message. */
  maxMissingEvidenceForConfirming: number;
  /**
   * Maximum age of the quote AT THE MOMENT OF SENDING. A state promoted from
   * evidence minutes ago must not speak on that evidence now — the state is a
   * record of the past, and a message is a claim about the present.
   */
  maxQuoteAgeAtNotifyMs: number;
  maxUnderlyingQuoteAgeAtNotifyMs: number;
  /**
   * Give-back from the best premium seen since capture, as a fraction of the
   * peak gain. Past this, the move being described has already rolled over.
   */
  maxRolloverGiveBackFraction: number;
  maxCaptureToNotifyMs: number;
  maxUnderlyingMoveBeforeEntryPct: number | null;
  minRewardRemainingPct: number | null;
  minDistanceFromInvalidationPct: number | null;
  preferredDteBands: readonly TenorBand[];
  preferredDelta: readonly [number, number] | null;
  requireStrategyEvidence: boolean;
  minImmediateScore: number;
}

export const DEFAULT_NOTIFICATION_STRENGTH: Readonly<NotificationStrengthConfig> = Object.freeze({
  strategyKey: null,
  freshnessSource: "LEGACY_GLOBAL",
  strategySide: null,
  strategySessions: Object.freeze(["regular"] as Session[]),
  maxSpreadPct: 15,
  maxPremiumChasePct: 20,
  minOpenInterest: 250,
  minContractVolume: 25,
  maxMissingEvidenceForConfirming: 2,
  maxQuoteAgeAtNotifyMs: 120_000,
  maxUnderlyingQuoteAgeAtNotifyMs: 120_000,
  maxRolloverGiveBackFraction: 0.5,
  maxCaptureToNotifyMs: 15 * 60_000,
  maxUnderlyingMoveBeforeEntryPct: null,
  minRewardRemainingPct: null,
  minDistanceFromInvalidationPct: null,
  preferredDteBands: Object.freeze([]),
  preferredDelta: null,
  requireStrategyEvidence: false,
  minImmediateScore: 80,
});

export function resolveNotificationStrength(env: NodeJS.ProcessEnv = process.env): NotificationStrengthConfig {
  const n = (raw: string | undefined, d: number, lo: number, hi: number): number => {
    const x = Number(raw);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return {
    maxSpreadPct: n(env.ASYM_NOTIFY_MAX_SPREAD_PCT, DEFAULT_NOTIFICATION_STRENGTH.maxSpreadPct, 1, 100),
    maxPremiumChasePct: n(env.ASYM_NOTIFY_MAX_CHASE_PCT, DEFAULT_NOTIFICATION_STRENGTH.maxPremiumChasePct, 1, 200),
    minOpenInterest: n(env.ASYM_NOTIFY_MIN_OI, DEFAULT_NOTIFICATION_STRENGTH.minOpenInterest, 0, 100_000),
    minContractVolume: n(env.ASYM_NOTIFY_MIN_VOL, DEFAULT_NOTIFICATION_STRENGTH.minContractVolume, 0, 100_000),
    maxMissingEvidenceForConfirming: Math.floor(
      n(env.ASYM_NOTIFY_MAX_MISSING, DEFAULT_NOTIFICATION_STRENGTH.maxMissingEvidenceForConfirming, 0, 20)),
    maxQuoteAgeAtNotifyMs: n(env.ASYM_NOTIFY_MAX_QUOTE_AGE_MS,
      DEFAULT_NOTIFICATION_STRENGTH.maxQuoteAgeAtNotifyMs, 5_000, 30 * 60_000),
    maxUnderlyingQuoteAgeAtNotifyMs: n(env.ASYM_NOTIFY_MAX_UNDERLYING_QUOTE_AGE_MS,
      DEFAULT_NOTIFICATION_STRENGTH.maxUnderlyingQuoteAgeAtNotifyMs, 5_000, 30 * 60_000),
    maxRolloverGiveBackFraction: n(env.ASYM_NOTIFY_MAX_GIVEBACK,
      DEFAULT_NOTIFICATION_STRENGTH.maxRolloverGiveBackFraction, 0.1, 1),
    maxCaptureToNotifyMs: n(env.ASYM_NOTIFY_MAX_CAPTURE_TO_NOTIFY_MS,
      DEFAULT_NOTIFICATION_STRENGTH.maxCaptureToNotifyMs, 30_000, 2 * 60 * 60_000),
    strategyKey: null,
    freshnessSource: "LEGACY_GLOBAL",
    strategySide: null,
    strategySessions: ["regular"],
    maxUnderlyingMoveBeforeEntryPct: null,
    minRewardRemainingPct: null,
    minDistanceFromInvalidationPct: null,
    preferredDteBands: [],
    preferredDelta: null,
    requireStrategyEvidence: false,
    minImmediateScore: n(env.ASYM_NOTIFY_MIN_IMMEDIATE_SCORE,
      DEFAULT_NOTIFICATION_STRENGTH.minImmediateScore, 0, 100),
  };
}

/**
 * Resolve the live notification policy from the strategy catalog. Operator
 * overrides may tighten a strategy, but cannot make it older or less liquid
 * than the catalog permits.
 */
export function resolveStrategyNotificationStrength(
  setupFamily: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NotificationStrengthConfig {
  const base = resolveNotificationStrength(env);
  const key = String(setupFamily ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const strategy = key ? getStrategy(key) : null;
  if (!strategy) {
    return {
      ...base,
      freshnessSource: "UNKNOWN_STRATEGY",
      requireStrategyEvidence: true,
      maxCaptureToNotifyMs: Math.min(base.maxCaptureToNotifyMs, 120_000),
      maxQuoteAgeAtNotifyMs: Math.min(base.maxQuoteAgeAtNotifyMs, 120_000),
      maxUnderlyingQuoteAgeAtNotifyMs: Math.min(base.maxUnderlyingQuoteAgeAtNotifyMs, 120_000),
    };
  }
  return {
    ...base,
    strategyKey: strategy.key,
    freshnessSource: "STRATEGY_CATALOG",
    strategySide: strategy.side,
    strategySessions: strategy.sessions,
    maxSpreadPct: Math.min(base.maxSpreadPct, strategy.optionsLiquidity.maxSpreadPct),
    minOpenInterest: Math.max(base.minOpenInterest, strategy.optionsLiquidity.minOpenInterest),
    minContractVolume: Math.max(base.minContractVolume, strategy.optionsLiquidity.minContractVolume),
    maxQuoteAgeAtNotifyMs: Math.min(base.maxQuoteAgeAtNotifyMs, strategy.freshnessMaxMs),
    maxUnderlyingQuoteAgeAtNotifyMs: Math.min(base.maxUnderlyingQuoteAgeAtNotifyMs, strategy.freshnessMaxMs),
    maxCaptureToNotifyMs: Math.min(base.maxCaptureToNotifyMs, strategy.freshnessMaxMs),
    maxUnderlyingMoveBeforeEntryPct: strategy.chaseLimitPct,
    minRewardRemainingPct: Math.max(5, base.maxPremiumChasePct / 2),
    minDistanceFromInvalidationPct: 5,
    preferredDteBands: strategy.preferredDte,
    preferredDelta: strategy.preferredDelta,
    requireStrategyEvidence: true,
  };
}

export function strategyNotificationPolicyMatrix(env: NodeJS.ProcessEnv = process.env) {
  return OPTIONS_STRATEGIES.map((strategy) => {
    const policy = resolveStrategyNotificationStrength(strategy.key, env);
    return {
      strategyKey: strategy.key,
      holdingHorizon: strategy.holdingHorizon,
      preferredDte: strategy.preferredDte,
      maxCandidateAgeMs: policy.maxCaptureToNotifyMs,
      maxOptionQuoteAgeMs: policy.maxQuoteAgeAtNotifyMs,
      maxUnderlyingQuoteAgeMs: policy.maxUnderlyingQuoteAgeAtNotifyMs,
      maxPremiumExpansionPct: policy.maxPremiumChasePct,
      maxUnderlyingMoveBeforeEntryPct: policy.maxUnderlyingMoveBeforeEntryPct,
      minRewardRemainingPct: policy.minRewardRemainingPct,
      minDistanceFromInvalidationPct: policy.minDistanceFromInvalidationPct,
      maxSpreadPct: policy.maxSpreadPct,
      minOpenInterest: policy.minOpenInterest,
      minContractVolume: policy.minContractVolume,
      preferredDelta: policy.preferredDelta,
      sessions: strategy.sessions,
    };
  });
}

export type HighAsymmetryNotificationAction =
  | "HIGH_ASYMMETRY_ALERT"
  | "HIGH_ASYMMETRY_OWNER_WATCH"
  | "HIGH_ASYMMETRY_PAPER_ONLY"
  | "HIGH_ASYMMETRY_TOO_LATE"
  | "HIGH_ASYMMETRY_ARCHIVE"
  | "REJECTED";

/** Everything the gate may look at. Measured values only — nothing inferred. */
export interface NotificationEvidence {
  state: AsymmetryResearchState;
  setupFamily?: string | null;
  direction?: "CALL" | "PUT" | null;
  optionSymbol: string | null;
  bid: number | null;
  ask: number | null;
  quoteAtMs: number | null;
  underlyingPrice: number | null;
  spreadPct: number | null;
  premiumChasePct: number | null;
  openInterest: number | null;
  contractVolume: number | null;
  missingEvidence: string[];
  trigger: string | null;
  invalidation: string | null;
  /** The clock the quote is judged against. Required for staleness at send. */
  nowMs?: number | null;
  /**
   * Best premium observed since capture, from PERSISTED marks. Costs no
   * provider call — it is data the mark runner already wrote.
   */
  peakAskSinceCapture?: number | null;
  entryAskAtCapture?: number | null;
  firstDetectedAtMs?: number | null;
  dte?: number | null;
  delta?: number | null;
  underlyingQuoteAtMs?: number | null;
  currentUnderlyingPrice?: number | null;
  underlyingMoveBeforeDetectionPct?: number | null;
  roomToNextLevelPct?: number | null;
  /** Frozen deterministic option-premium levels from the initial READY callout. */
  targetT1?: number | null;
  targetStop?: number | null;
}

/** Exactly one timing verdict per decision. */
export type TimingClassification =
  | "ON_TIME" | "ENTRY_TOO_LATE" | "STALE_EVIDENCE" | "MOMENTUM_ROLLOVER"
  | "PREMIUM_CHASE" | "INSUFFICIENT_TIMING_EVIDENCE";

export interface NotificationDecision {
  notify: boolean;
  timing: TimingClassification;
  /** Deterministic lifecycle output. Only HIGH_ASYMMETRY_ALERT may send now. */
  action: HighAsymmetryNotificationAction;
  /** Machine-readable suppression reason. Persisted for the ratio report. */
  reason: string;
  version: string;
  /** True when the case is captured and tracked but deliberately silent. */
  silentCapture: boolean;
  qualityScore: number | null;
  deliveryLevel: "IMMEDIATE_OWNER_ALERT" | "OWNER_WATCH" | "PERIODIC_DIGEST" | "PAPER_ONLY" | "ARCHIVE";
  strategyKey: string | null;
  candidateAgeMs: number | null;
  optionQuoteAgeMs: number | null;
  underlyingQuoteAgeMs: number | null;
  underlyingMoveBeforeEntryPct: number | null;
  rewardRemainingPct: number | null;
  distanceToInvalidationPct: number | null;
}

const OCC = /^O:[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Decide whether this state change earns a Discord message.
 *
 * Returning `notify: false` NEVER means "discard" — every caller still
 * persists the transition and keeps the case in the research population. That
 * separation is the whole point of this module.
 */
export function decideNotification(
  e: NotificationEvidence,
  cfg: NotificationStrengthConfig = DEFAULT_NOTIFICATION_STRENGTH,
): NotificationDecision {
  const now = num(e.nowMs);
  const quoteAt = num(e.quoteAtMs);
  const underlyingQuoteAt = num(e.underlyingQuoteAtMs);
  const firstDetected = num(e.firstDetectedAtMs);
  const candidateAgeMs = now != null && firstDetected != null ? now - firstDetected : null;
  const optionQuoteAgeMs = now != null && quoteAt != null ? now - quoteAt : null;
  const underlyingQuoteAgeMs = now != null && underlyingQuoteAt != null ? now - underlyingQuoteAt : null;
  const detectedUnderlying = num(e.underlyingPrice);
  const currentUnderlying = num(e.currentUnderlyingPrice);
  const directionMoveSinceCapture = detectedUnderlying != null && detectedUnderlying > 0 && currentUnderlying != null
    ? ((currentUnderlying - detectedUnderlying) / detectedUnderlying) * 100 * (e.direction === "PUT" ? -1 : 1)
    : null;
  const favorableMoveSinceCapture = directionMoveSinceCapture == null ? null : Math.max(0, directionMoveSinceCapture);
  // The persisted prior move is the session move from the previous close. It
  // is useful context, but it is not chase after first eligibility: counting a
  // premarket gap here would wrongly suppress gap/catalyst strategies. The
  // authoritative callout freshness check also measures observed -> current.
  const underlyingMoveBeforeEntryPct = favorableMoveSinceCapture;
  const targetT1 = num(e.targetT1);
  const targetStop = num(e.targetStop);
  const askNow = num(e.ask);
  const roomAtCapture = num(e.roomToNextLevelPct);
  const rewardRemainingPct = targetT1 != null && targetT1 > 0 && askNow != null && askNow > 0
    ? ((targetT1 - askNow) / askNow) * 100
    : roomAtCapture != null && favorableMoveSinceCapture != null
      ? roomAtCapture - favorableMoveSinceCapture
      : null;
  const distanceToInvalidationPct = targetStop != null && targetStop > 0 && askNow != null && askNow > 0
    ? ((askNow - targetStop) / askNow) * 100
    : null;

  const actionFor = (
    reason: string,
    timing: TimingClassification,
    state: AsymmetryResearchState,
  ): HighAsymmetryNotificationAction => {
    if (timing === "ENTRY_TOO_LATE" || timing === "STALE_EVIDENCE" || timing === "MOMENTUM_ROLLOVER") {
      return "HIGH_ASYMMETRY_TOO_LATE";
    }
    if (timing === "PREMIUM_CHASE" || /PREMIUM_CHASE|UNDERLYING_ALREADY_EXTENDED/.test(reason)) return "HIGH_ASYMMETRY_PAPER_ONLY";
    if (state === "EARLY_ASYMMETRY" || state === "CONFIRMING" || /INSUFFICIENT_|EVIDENCE_INCOMPLETE|STRATEGY_FRESHNESS_UNAVAILABLE/.test(reason)) {
      return "HIGH_ASYMMETRY_OWNER_WATCH";
    }
    if (state === "INVALIDATED") return "HIGH_ASYMMETRY_ARCHIVE";
    return "REJECTED";
  };
  const no = (
    reason: string,
    timing: TimingClassification = "ON_TIME",
    action?: HighAsymmetryNotificationAction,
    qualityScore: number | null = null,
    deliveryLevel?: NotificationDecision["deliveryLevel"],
  ): NotificationDecision => ({
    notify: false,
    timing,
    action: action ?? actionFor(reason, timing, e.state),
    reason,
    version: NOTIFICATION_GATE_VERSION,
    silentCapture: true,
    qualityScore,
    deliveryLevel: deliveryLevel ?? deliveryLevelFor(action ?? actionFor(reason, timing, e.state)),
    strategyKey: cfg.strategyKey,
    candidateAgeMs,
    optionQuoteAgeMs,
    underlyingQuoteAgeMs,
    underlyingMoveBeforeEntryPct,
    rewardRemainingPct,
    distanceToInvalidationPct,
  });

  // 1. State. EARLY is silent by definition; the chased/failed states never open.
  if (e.state === "EARLY_ASYMMETRY") return no("SILENT_EARLY_ASYMMETRY");
  const eligible = NOTIFY_ELIGIBLE_STATES.includes(e.state);
  const gated = NOTIFY_GATED_STATES.includes(e.state);
  if (!eligible && !gated) return no(`STATE_NOT_NOTIFIABLE_${e.state}`);

  // 2. Minimum presentation payload. A message nobody can act on is worse than
  //    silence, because it trains the reader to ignore the channel.
  if (!e.optionSymbol || !OCC.test(e.optionSymbol)) return no("INSUFFICIENT_NOTIFICATION_EVIDENCE_NO_OCC");
  const ask = num(e.ask);
  if (ask == null || ask <= 0) return no("INSUFFICIENT_NOTIFICATION_EVIDENCE_NO_ENTRY_QUOTE");
  if (num(e.quoteAtMs) == null) return no("INSUFFICIENT_NOTIFICATION_EVIDENCE_NO_QUOTE_TIMESTAMP");
  if (num(e.underlyingPrice) == null) return no("INSUFFICIENT_NOTIFICATION_EVIDENCE_NO_UNDERLYING");

  if (cfg.requireStrategyEvidence && cfg.freshnessSource !== "STRATEGY_CATALOG") {
    return no("STRATEGY_FRESHNESS_UNAVAILABLE", "INSUFFICIENT_TIMING_EVIDENCE", "HIGH_ASYMMETRY_OWNER_WATCH");
  }
  if (cfg.strategySide === "call" && e.direction !== "CALL") return no("STRATEGY_SIDE_MISMATCH_CALL");
  if (cfg.strategySide === "put" && e.direction !== "PUT") return no("STRATEGY_SIDE_MISMATCH_PUT");

  // 3. Hard quality blockers. These can never be bypassed, in any state.
  const spread = num(e.spreadPct);
  if (spread != null && spread > cfg.maxSpreadPct) return no(`UNUSABLE_SPREAD_${spread.toFixed(1)}`);
  const chase = num(e.premiumChasePct);
  if (chase != null && chase >= cfg.maxPremiumChasePct) {
    return no(`PREMIUM_CHASE_${chase.toFixed(1)}`, "PREMIUM_CHASE");
  }
  const oi = num(e.openInterest);
  if (cfg.requireStrategyEvidence && oi == null) {
    return no("INSUFFICIENT_CURRENT_CONTRACT_EVIDENCE_OPEN_INTEREST", "INSUFFICIENT_TIMING_EVIDENCE", "HIGH_ASYMMETRY_OWNER_WATCH");
  }
  if (oi != null && oi < cfg.minOpenInterest) return no(`WEAK_OPEN_INTEREST_${oi}`);
  const vol = num(e.contractVolume);
  if (cfg.requireStrategyEvidence && vol == null) {
    return no("INSUFFICIENT_CURRENT_CONTRACT_EVIDENCE_VOLUME", "INSUFFICIENT_TIMING_EVIDENCE", "HIGH_ASYMMETRY_OWNER_WATCH");
  }
  if (vol != null && vol < cfg.minContractVolume) return no(`WEAK_CONTRACT_VOLUME_${vol}`);

  // 4. CONFIRMING must additionally be well described. HIGH_ASYMMETRY and
  //    TRIGGERED already cleared a higher bar in the state machine itself.
  // Count only evidence the capture path actually sought. Six labels fire on every
  // candidate because loop.ts hardcodes their inputs to null, which made this check
  // unsatisfiable and produced CONFIRMING_EVIDENCE_INCOMPLETE_9 as the single
  // largest suppression reason in production. The unsupplied labels are reported in
  // the reason string so the wiring debt is never hidden. Every other check in this
  // gate is unchanged.
  const evidence = splitMissingEvidence(e.missingEvidence);
  if (gated && evidence.blockingCount > cfg.maxMissingEvidenceForConfirming) {
    return no(`CONFIRMING_EVIDENCE_INCOMPLETE_${evidence.blockingCount}`);
  }

  // 5. CURRENT VALIDITY. A promoted state is a record of the past; sending is a
  //    claim about the present. Neither check can be bypassed by TRIGGERED.
  if (candidateAgeMs != null && candidateAgeMs < -5_000) {
    return no("INVALID_FUTURE_CANDIDATE_TIMESTAMP", "INSUFFICIENT_TIMING_EVIDENCE", "HIGH_ASYMMETRY_OWNER_WATCH");
  }
  if (optionQuoteAgeMs != null && optionQuoteAgeMs < -5_000) {
    return no("INVALID_FUTURE_OPTION_QUOTE_TIMESTAMP", "INSUFFICIENT_TIMING_EVIDENCE", "HIGH_ASYMMETRY_OWNER_WATCH");
  }
  if (underlyingQuoteAgeMs != null && underlyingQuoteAgeMs < -5_000) {
    return no("INVALID_FUTURE_UNDERLYING_QUOTE_TIMESTAMP", "INSUFFICIENT_TIMING_EVIDENCE", "HIGH_ASYMMETRY_OWNER_WATCH");
  }
  if (optionQuoteAgeMs != null) {
    if (optionQuoteAgeMs > cfg.maxQuoteAgeAtNotifyMs) {
      return no(`LATE_OR_ROLLOVER_SUPPRESSION_STALE_${Math.round(optionQuoteAgeMs / 1000)}S`, "STALE_EVIDENCE");
    }
  }
  if (candidateAgeMs != null) {
    if (candidateAgeMs > cfg.maxCaptureToNotifyMs) {
      const ageLabel = candidateAgeMs >= 60_000
        ? `${Math.round(candidateAgeMs / 60_000)}M`
        : `${Math.round(candidateAgeMs / 1000)}S`;
      return no(`ENTRY_TOO_LATE_${ageLabel}`, "ENTRY_TOO_LATE", "HIGH_ASYMMETRY_TOO_LATE");
    }
  }

  if (cfg.freshnessSource === "STRATEGY_CATALOG") {
    const dte = num(e.dte);
    if (dte == null) {
      return no("INSUFFICIENT_CURRENT_CONTRACT_EVIDENCE_DTE", "INSUFFICIENT_TIMING_EVIDENCE", "HIGH_ASYMMETRY_OWNER_WATCH");
    }
    const band = tenorBand(Math.max(0, Math.floor(dte)));
    if (!cfg.preferredDteBands.includes(band)) return no(`CONTRACT_DTE_OUTSIDE_STRATEGY_${band.toUpperCase()}`);

    const delta = num(e.delta);
    if (delta == null || cfg.preferredDelta == null) {
      return no("INSUFFICIENT_CURRENT_CONTRACT_EVIDENCE_DELTA", "INSUFFICIENT_TIMING_EVIDENCE", "HIGH_ASYMMETRY_OWNER_WATCH");
    }
    const absDelta = Math.abs(delta);
    if (absDelta < cfg.preferredDelta[0] || absDelta > cfg.preferredDelta[1]) {
      return no(`CONTRACT_DELTA_OUTSIDE_STRATEGY_${absDelta.toFixed(2)}`);
    }

    if (underlyingQuoteAgeMs == null || currentUnderlying == null) {
      return no("INSUFFICIENT_CURRENT_UNDERLYING_EVIDENCE", "INSUFFICIENT_TIMING_EVIDENCE", "HIGH_ASYMMETRY_OWNER_WATCH");
    }
    if (underlyingQuoteAgeMs > cfg.maxUnderlyingQuoteAgeAtNotifyMs) {
      return no(`LATE_OR_ROLLOVER_SUPPRESSION_UNDERLYING_STALE_${Math.round(underlyingQuoteAgeMs / 1000)}S`, "STALE_EVIDENCE");
    }
    if (underlyingMoveBeforeEntryPct == null) {
      return no("INSUFFICIENT_UNDERLYING_MOVE_EVIDENCE", "INSUFFICIENT_TIMING_EVIDENCE", "HIGH_ASYMMETRY_OWNER_WATCH");
    }
    if (cfg.maxUnderlyingMoveBeforeEntryPct != null
      && underlyingMoveBeforeEntryPct > cfg.maxUnderlyingMoveBeforeEntryPct) {
      return no(`UNDERLYING_ALREADY_EXTENDED_${underlyingMoveBeforeEntryPct.toFixed(2)}PCT`, "ON_TIME", "HIGH_ASYMMETRY_PAPER_ONLY");
    }
    if (rewardRemainingPct == null) {
      return no("INSUFFICIENT_REWARD_REMAINING_EVIDENCE", "INSUFFICIENT_TIMING_EVIDENCE", "HIGH_ASYMMETRY_OWNER_WATCH");
    }
    if (cfg.minRewardRemainingPct != null && rewardRemainingPct < cfg.minRewardRemainingPct) {
      return no(`REWARD_EXHAUSTED_${rewardRemainingPct.toFixed(2)}PCT`, "ENTRY_TOO_LATE", "HIGH_ASYMMETRY_TOO_LATE");
    }
    if (distanceToInvalidationPct == null) {
      return no("INSUFFICIENT_INVALIDATION_DISTANCE_EVIDENCE", "INSUFFICIENT_TIMING_EVIDENCE", "HIGH_ASYMMETRY_OWNER_WATCH");
    }
    if (cfg.minDistanceFromInvalidationPct != null
      && distanceToInvalidationPct < cfg.minDistanceFromInvalidationPct) {
      return no(`NEAR_OR_BELOW_INVALIDATION_${distanceToInvalidationPct.toFixed(2)}PCT`, "ENTRY_TOO_LATE", "HIGH_ASYMMETRY_TOO_LATE");
    }
  }

  // Premium rollover, measured from marks already persisted — no provider call.
  // If the contract ran and has given back most of that gain, the move being
  // described is over, whatever the stored state still says.
  const peak = num(e.peakAskSinceCapture);
  const entry = num(e.entryAskAtCapture);
  if (peak != null && entry != null && entry > 0 && peak > entry) {
    const peakGain = peak - entry;
    const givenBack = peak - ask;
    if (givenBack > peakGain * cfg.maxRolloverGiveBackFraction) {
      return no(
        `LATE_OR_ROLLOVER_SUPPRESSION_GAVE_BACK_${Math.round((givenBack / peakGain) * 100)}PCT`,
        "MOMENTUM_ROLLOVER",
      );
    }
  }

  const qualityScore = cfg.freshnessSource === "STRATEGY_CATALOG"
    ? notificationQualityScore(e, cfg, {
      candidateAgeMs, optionQuoteAgeMs, underlyingQuoteAgeMs,
      underlyingMoveBeforeEntryPct, rewardRemainingPct,
    })
    : null;
  if (qualityScore != null && qualityScore < cfg.minImmediateScore) {
    const digest = qualityScore >= 60;
    return no(
      `${digest ? "RANKED_FOR_DIGEST" : "RANKED_OWNER_WATCH"}_${qualityScore}`,
      "ON_TIME",
      "HIGH_ASYMMETRY_OWNER_WATCH",
      qualityScore,
      digest ? "PERIODIC_DIGEST" : "OWNER_WATCH",
    );
  }

  return {
    notify: true,
    timing: "ON_TIME",
    action: "HIGH_ASYMMETRY_ALERT",
    reason: "NOTIFY",
    version: NOTIFICATION_GATE_VERSION,
    silentCapture: false,
    qualityScore,
    deliveryLevel: "IMMEDIATE_OWNER_ALERT",
    strategyKey: cfg.strategyKey,
    candidateAgeMs,
    optionQuoteAgeMs,
    underlyingQuoteAgeMs,
    underlyingMoveBeforeEntryPct,
    rewardRemainingPct,
    distanceToInvalidationPct,
  };
}

function deliveryLevelFor(action: HighAsymmetryNotificationAction): NotificationDecision["deliveryLevel"] {
  if (action === "HIGH_ASYMMETRY_ALERT") return "IMMEDIATE_OWNER_ALERT";
  if (action === "HIGH_ASYMMETRY_OWNER_WATCH") return "OWNER_WATCH";
  if (action === "HIGH_ASYMMETRY_PAPER_ONLY") return "PAPER_ONLY";
  return "ARCHIVE";
}

function notificationQualityScore(
  e: NotificationEvidence,
  cfg: NotificationStrengthConfig,
  metrics: Pick<NotificationDecision,
    "candidateAgeMs" | "optionQuoteAgeMs" | "underlyingQuoteAgeMs"
    | "underlyingMoveBeforeEntryPct" | "rewardRemainingPct">,
): number {
  const ratio = (value: number | null, max: number | null) =>
    value == null || max == null || max <= 0 ? 0 : Math.max(0, Math.min(1, 1 - value / max));
  const floorRatio = (value: number | null, floor: number) =>
    value == null || floor <= 0 ? 0 : Math.max(0, Math.min(1, value / floor));
  const state = e.state === "TRIGGERED" ? 20 : e.state === "HIGH_ASYMMETRY" ? 18 : 12;
  const freshness = ratio(metrics.candidateAgeMs, cfg.maxCaptureToNotifyMs) * 15;
  const optionFreshness = ratio(metrics.optionQuoteAgeMs, cfg.maxQuoteAgeAtNotifyMs) * 10;
  const underlyingFreshness = ratio(metrics.underlyingQuoteAgeMs, cfg.maxUnderlyingQuoteAgeAtNotifyMs) * 10;
  const premium = ratio(num(e.premiumChasePct), cfg.maxPremiumChasePct) * 10;
  const spread = ratio(num(e.spreadPct), cfg.maxSpreadPct) * 8;
  const liquidity = floorRatio(num(e.openInterest), cfg.minOpenInterest) * 4
    + floorRatio(num(e.contractVolume), cfg.minContractVolume) * 4;
  const extension = ratio(metrics.underlyingMoveBeforeEntryPct, cfg.maxUnderlyingMoveBeforeEntryPct) * 8;
  const reward = floorRatio(metrics.rewardRemainingPct, cfg.minRewardRemainingPct ?? 1) * 8;
  // Same like-with-like rule as the CONFIRMING check: score the evidence that was
  // sought. Counting the six permanently-unsupplied labels pinned this term to 0 for
  // every candidate, so it measured the wiring rather than the setup.
  const completeness = Math.max(0, 5 - Math.min(5, splitMissingEvidence(e.missingEvidence).blockingCount));
  return Math.round(Math.max(0, Math.min(100,
    state + freshness + optionFreshness + underlyingFreshness + premium
    + spread + liquidity + extension + reward + completeness,
  )));
}

/** The headline health number: how much of what we capture we actually say. */
export function alertToCaptureRatio(captured: number, notified: number): number | null {
  if (!Number.isFinite(captured) || captured <= 0) return null; // unknown, never 0
  return Math.round((notified / captured) * 1000) / 10;
}
