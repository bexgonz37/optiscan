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

export const NOTIFICATION_GATE_VERSION = "ASYM_NOTIFY_V2" as const;

/** States that may ever produce an opening notification. */
export const NOTIFY_ELIGIBLE_STATES: readonly AsymmetryResearchState[] = Object.freeze([
  "HIGH_ASYMMETRY", "TRIGGERED",
]);
/** Silent unless the strength gate passes. */
export const NOTIFY_GATED_STATES: readonly AsymmetryResearchState[] = Object.freeze(["CONFIRMING"]);

export interface NotificationStrengthConfig {
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
  /**
   * Give-back from the best premium seen since capture, as a fraction of the
   * peak gain. Past this, the move being described has already rolled over.
   */
  maxRolloverGiveBackFraction: number;
  maxCaptureToNotifyMs: number;
}

export const DEFAULT_NOTIFICATION_STRENGTH: Readonly<NotificationStrengthConfig> = Object.freeze({
  maxSpreadPct: 15,
  maxPremiumChasePct: 20,
  minOpenInterest: 250,
  minContractVolume: 25,
  maxMissingEvidenceForConfirming: 2,
  maxQuoteAgeAtNotifyMs: 120_000,
  maxRolloverGiveBackFraction: 0.5,
  maxCaptureToNotifyMs: 15 * 60_000,
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
    maxRolloverGiveBackFraction: n(env.ASYM_NOTIFY_MAX_GIVEBACK,
      DEFAULT_NOTIFICATION_STRENGTH.maxRolloverGiveBackFraction, 0.1, 1),
    maxCaptureToNotifyMs: n(env.ASYM_NOTIFY_MAX_CAPTURE_TO_NOTIFY_MS,
      DEFAULT_NOTIFICATION_STRENGTH.maxCaptureToNotifyMs, 30_000, 2 * 60 * 60_000),
  };
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
  const actionFor = (
    reason: string,
    timing: TimingClassification,
    state: AsymmetryResearchState,
  ): HighAsymmetryNotificationAction => {
    if (timing === "ENTRY_TOO_LATE" || timing === "STALE_EVIDENCE" || timing === "MOMENTUM_ROLLOVER") {
      return "HIGH_ASYMMETRY_TOO_LATE";
    }
    if (timing === "PREMIUM_CHASE" || /PREMIUM_CHASE/.test(reason)) return "HIGH_ASYMMETRY_PAPER_ONLY";
    if (state === "EARLY_ASYMMETRY" || state === "CONFIRMING" || /INSUFFICIENT_NOTIFICATION_EVIDENCE|EVIDENCE_INCOMPLETE/.test(reason)) {
      return "HIGH_ASYMMETRY_OWNER_WATCH";
    }
    if (state === "INVALIDATED") return "HIGH_ASYMMETRY_ARCHIVE";
    return "REJECTED";
  };
  const no = (
    reason: string,
    timing: TimingClassification = "ON_TIME",
    action?: HighAsymmetryNotificationAction,
  ): NotificationDecision => ({
    notify: false,
    timing,
    action: action ?? actionFor(reason, timing, e.state),
    reason,
    version: NOTIFICATION_GATE_VERSION,
    silentCapture: true,
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

  // 3. Hard quality blockers. These can never be bypassed, in any state.
  const spread = num(e.spreadPct);
  if (spread != null && spread > cfg.maxSpreadPct) return no(`UNUSABLE_SPREAD_${spread.toFixed(1)}`);
  const chase = num(e.premiumChasePct);
  if (chase != null && chase >= cfg.maxPremiumChasePct) {
    return no(`PREMIUM_CHASE_${chase.toFixed(1)}`, "PREMIUM_CHASE");
  }
  const oi = num(e.openInterest);
  if (oi != null && oi < cfg.minOpenInterest) return no(`WEAK_OPEN_INTEREST_${oi}`);
  const vol = num(e.contractVolume);
  if (vol != null && vol < cfg.minContractVolume) return no(`WEAK_CONTRACT_VOLUME_${vol}`);

  // 4. CONFIRMING must additionally be well described. HIGH_ASYMMETRY and
  //    TRIGGERED already cleared a higher bar in the state machine itself.
  if (gated && e.missingEvidence.length > cfg.maxMissingEvidenceForConfirming) {
    return no(`CONFIRMING_EVIDENCE_INCOMPLETE_${e.missingEvidence.length}`);
  }

  // 5. CURRENT VALIDITY. A promoted state is a record of the past; sending is a
  //    claim about the present. Neither check can be bypassed by TRIGGERED.
  const now = num(e.nowMs);
  const quoteAt = num(e.quoteAtMs);
  if (now != null && quoteAt != null) {
    const age = now - quoteAt;
    if (age > cfg.maxQuoteAgeAtNotifyMs) {
      return no(`LATE_OR_ROLLOVER_SUPPRESSION_STALE_${Math.round(age / 1000)}S`, "STALE_EVIDENCE");
    }
  }
  const firstDetected = num(e.firstDetectedAtMs);
  if (now != null && firstDetected != null) {
    const age = now - firstDetected;
    if (age > cfg.maxCaptureToNotifyMs) {
      return no(`ENTRY_TOO_LATE_${Math.round(age / 60_000)}M`, "ENTRY_TOO_LATE", "HIGH_ASYMMETRY_TOO_LATE");
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

  return {
    notify: true,
    timing: "ON_TIME",
    action: "HIGH_ASYMMETRY_ALERT",
    reason: "NOTIFY",
    version: NOTIFICATION_GATE_VERSION,
    silentCapture: false,
  };
}

/** The headline health number: how much of what we capture we actually say. */
export function alertToCaptureRatio(captured: number, notified: number): number | null {
  if (!Number.isFinite(captured) || captured <= 0) return null; // unknown, never 0
  return Math.round((notified / captured) * 1000) / 10;
}
