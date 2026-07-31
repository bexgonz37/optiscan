/**
 * timing-classification.ts — the POST-HOC verdict on when an alert fired
 * relative to the move it described. PURE, deterministic, total.
 *
 * DISTINCT FROM THE GATE. notification-gate.ts answers "may this speak NOW",
 * using only evidence available at that instant. This module answers "was that
 * the right moment", using the full reconstructed timeline INCLUDING what
 * happened afterwards. The gate must never import this — it would be lookahead.
 *
 * EXACTLY ONE VERDICT. The classifier is total: every input maps to exactly one
 * label, precedence is fixed, and the same input always yields the same label.
 * Precedence runs worst-defect-first, so an alert that is simultaneously stale
 * and chased reports the more fundamental problem.
 *
 * INSUFFICIENT_TIMING_EVIDENCE IS A REAL ANSWER. When the timeline cannot
 * support a verdict, that is the verdict. It is never silently downgraded to
 * ON_TIME, and it is never counted as a success or a failure.
 */

export type TimingVerdict =
  /** Fired before the move had any confirmation; the setup had not proven itself. */
  | "EARLY"
  /** Fired while the move was still in front of the reader. */
  | "ON_TIME"
  /** The evidence was valid but confirmation arrived only after most of the move. */
  | "LATE_CONFIRMATION"
  /** Momentum had already turned down at the moment of the alert. */
  | "MOMENTUM_ROLLOVER"
  /** Premium had already expanded materially before the alert went out. */
  | "PREMIUM_CHASE"
  /** The quote the message was built on was too old to describe the present. */
  | "STALE_EVIDENCE"
  /** The trigger level was reclaimed then lost; the breakout did not hold. */
  | "FAILED_BREAKOUT"
  /** The timeline cannot support any verdict. Not a pass and not a failure. */
  | "INSUFFICIENT_TIMING_EVIDENCE";

export const TIMING_VERDICTS: readonly TimingVerdict[] = Object.freeze([
  "EARLY", "ON_TIME", "LATE_CONFIRMATION", "MOMENTUM_ROLLOVER",
  "PREMIUM_CHASE", "STALE_EVIDENCE", "FAILED_BREAKOUT", "INSUFFICIENT_TIMING_EVIDENCE",
]);

export const TIMING_CLASSIFIER_VERSION = "ASYM_TIMING_V1" as const;

/**
 * Thresholds. PROVISIONAL AND VERSIONED, exactly like the gate's 120s/50%.
 * None of these was fitted to outcomes — there is no graded cohort yet. They
 * are declared here, in one place, so that when a cohort does exist they can be
 * re-run at other values over the same inputs.
 */
export interface TimingThresholds {
  /** Quote age at alert past which the message described the past. */
  staleQuoteMs: number;
  /** Premium expansion at alert, from first capture, that reads as a chase. */
  chasePctThreshold: number;
  /** Give-back from peak premium, as a fraction of peak gain, that reads as rollover. */
  rolloverGiveBackFraction: number;
  /**
   * Fraction of the eventual peak premium already realized at the alert. Above
   * this, the reader received the idea after most of the move was priced in.
   */
  lateCaptureFraction: number;
  /** Pullback from the underlying's local high, in percent, that reads as rolled over. */
  pullbackFromHighPct: number;
  /** Minimum usable quote observations before any verdict beyond INSUFFICIENT. */
  minObservations: number;
}

export const DEFAULT_TIMING_THRESHOLDS: Readonly<TimingThresholds> = Object.freeze({
  staleQuoteMs: 120_000,
  chasePctThreshold: 20,
  rolloverGiveBackFraction: 0.5,
  lateCaptureFraction: 0.7,
  pullbackFromHighPct: 0.4,
  minObservations: 3,
});

/**
 * The reconstructed facts a verdict is built from. Every field is measured or
 * null. Nothing is inferred inside this module, and a null is never treated as
 * a zero.
 */
export interface TimingEvidence {
  /** Quote age at the moment the alert was decided, ms. */
  quoteAgeAtAlertMs: number | null;
  /** Premium expansion from first capture to the alert, percent. */
  premiumChasePctAtAlert: number | null;
  /** Ask at first capture. The conservative early entry. */
  entryAskAtCapture: number | null;
  /** Ask at the alert. What the reader would have paid. */
  askAtAlert: number | null;
  /** Highest ask observed BEFORE the alert. */
  peakAskBeforeAlert: number | null;
  /** Highest ask observed over the whole reconstructed session for this OCC. */
  peakAskSession: number | null;
  /** Short-window underlying momentum at the alert. Negative = rolling over. */
  shortWindowMomentumPct: number | null;
  /** Underlying's local high before the alert. */
  localHighBeforeAlert: number | null;
  /** Underlying price at the alert. */
  underlyingAtAlert: number | null;
  /** True when price was above session VWAP at the alert. Null = unmeasured. */
  aboveVwapAtAlert: boolean | null;
  /** True when the published trigger traded, then was lost again afterwards. */
  triggerReclaimedThenLost: boolean | null;
  /** True when the state at alert was still unconfirmed (EARLY/CONFIRMING). */
  unconfirmedAtAlert: boolean | null;
  /** Count of usable quote observations behind this reconstruction. */
  observations: number;
}

export interface TimingClassificationResult {
  verdict: TimingVerdict;
  /** The single fact that decided it, in plain language. */
  rationale: string;
  /** Machine-readable reason code, stable across releases. */
  code: string;
  version: string;
  thresholds: TimingThresholds;
  /** Derived measures, exposed so the verdict can be audited not just trusted. */
  measures: {
    giveBackFractionAtAlert: number | null;
    capturedFractionOfPeak: number | null;
    pullbackFromLocalHighPct: number | null;
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Fraction of the session's eventual peak gain that was already realized at the
 * alert. 1.0 means the reader arrived exactly at the top.
 */
export function capturedFractionOfPeak(
  entryAsk: number | null, askAtAlert: number | null, peakAskSession: number | null,
): number | null {
  const e = num(entryAsk), a = num(askAtAlert), p = num(peakAskSession);
  if (e == null || a == null || p == null) return null;
  if (!(e > 0) || !(p > e)) return null;
  return Math.round(((a - e) / (p - e)) * 10_000) / 10_000;
}

/** Give-back from the pre-alert peak, as a fraction of the peak gain. */
export function giveBackAtAlert(
  entryAsk: number | null, peakAskBeforeAlert: number | null, askAtAlert: number | null,
): number | null {
  const e = num(entryAsk), p = num(peakAskBeforeAlert), a = num(askAtAlert);
  if (e == null || p == null || a == null) return null;
  if (!(e > 0) || !(p > e)) return null;
  return Math.round(((p - a) / (p - e)) * 10_000) / 10_000;
}

/** Underlying pullback from its pre-alert local high, in percent. */
export function pullbackFromLocalHighPct(
  localHigh: number | null, underlyingAtAlert: number | null,
): number | null {
  const h = num(localHigh), u = num(underlyingAtAlert);
  if (h == null || u == null || !(h > 0)) return null;
  return Math.round(((h - u) / h) * 10_000) / 100;
}

/**
 * Classify. Precedence, worst defect first:
 *
 *   1. INSUFFICIENT_TIMING_EVIDENCE — nothing can be said.
 *   2. STALE_EVIDENCE     — the message described a quote that no longer held.
 *   3. FAILED_BREAKOUT    — the trigger was reclaimed and then lost.
 *   4. MOMENTUM_ROLLOVER  — the move had already turned at the alert.
 *   5. PREMIUM_CHASE      — the premium had already run.
 *   6. LATE_CONFIRMATION  — valid, but most of the move was already priced.
 *   7. EARLY              — fired before the setup proved anything.
 *   8. ON_TIME            — nothing above applied.
 *
 * Stale ranks above rollover because a stale quote makes every other measure at
 * that instant unreliable: we cannot honestly call a move "rolled over" using
 * numbers we know were out of date.
 */
export function classifyTiming(
  e: TimingEvidence,
  thresholds: TimingThresholds = DEFAULT_TIMING_THRESHOLDS,
): TimingClassificationResult {
  const measures = {
    giveBackFractionAtAlert: giveBackAtAlert(e.entryAskAtCapture, e.peakAskBeforeAlert, e.askAtAlert),
    capturedFractionOfPeak: capturedFractionOfPeak(e.entryAskAtCapture, e.askAtAlert, e.peakAskSession),
    pullbackFromLocalHighPct: pullbackFromLocalHighPct(e.localHighBeforeAlert, e.underlyingAtAlert),
  };
  const done = (verdict: TimingVerdict, code: string, rationale: string): TimingClassificationResult =>
    ({ verdict, code, rationale, version: TIMING_CLASSIFIER_VERSION, thresholds, measures });

  // 1. Can anything be said at all?
  const age = num(e.quoteAgeAtAlertMs);
  const ask = num(e.askAtAlert);
  if (ask == null) {
    // Reported separately from a thin sample: "we never resolved the ask at the
    // alert" and "we barely have data" are different failures with different
    // fixes, and collapsing them hides which one actually occurred.
    return done("INSUFFICIENT_TIMING_EVIDENCE", "NO_ASK_AT_ALERT",
      `No executable ask could be resolved at the alert instant (${e.observations} observation(s) in the window); without it, nothing about the entry can be judged.`);
  }
  if (e.observations < thresholds.minObservations) {
    return done("INSUFFICIENT_TIMING_EVIDENCE", "TOO_FEW_OBSERVATIONS",
      `Only ${e.observations} usable observation(s), below the ${thresholds.minObservations} required; the timeline cannot support a timing verdict.`);
  }

  // 2. Stale evidence outranks everything measured at the same instant.
  if (age != null && age > thresholds.staleQuoteMs) {
    return done("STALE_EVIDENCE", "QUOTE_AGE_EXCEEDED",
      `Quote was ${Math.round(age / 1000)}s old at the alert, past the ${Math.round(thresholds.staleQuoteMs / 1000)}s window; the message described a price that no longer held.`);
  }

  // 3. A breakout that was reclaimed and then lost is a structural failure.
  if (e.triggerReclaimedThenLost === true) {
    return done("FAILED_BREAKOUT", "TRIGGER_RECLAIMED_THEN_LOST",
      "The published trigger traded and was then lost again; the breakout did not hold.");
  }

  // 4. Rollover — either the premium gave back most of its gain, or the
  //    underlying had turned down off its local high, or momentum was negative.
  const giveBack = measures.giveBackFractionAtAlert;
  if (giveBack != null && giveBack > thresholds.rolloverGiveBackFraction) {
    return done("MOMENTUM_ROLLOVER", "PREMIUM_GAVE_BACK",
      `Premium had given back ${Math.round(giveBack * 100)}% of its peak gain before the alert, past the ${Math.round(thresholds.rolloverGiveBackFraction * 100)}% threshold.`);
  }
  const momentum = num(e.shortWindowMomentumPct);
  const pullback = measures.pullbackFromLocalHighPct;
  if (momentum != null && momentum < 0 && pullback != null && pullback > thresholds.pullbackFromHighPct) {
    return done("MOMENTUM_ROLLOVER", "MOMENTUM_NEGATIVE_OFF_HIGH",
      `Short-window momentum was ${momentum.toFixed(2)}% and price was ${pullback.toFixed(2)}% off the local high at the alert.`);
  }

  // 5. Premium chase — the entry the message showed was already expensive.
  const chase = num(e.premiumChasePctAtAlert);
  if (chase != null && chase >= thresholds.chasePctThreshold) {
    return done("PREMIUM_CHASE", "PREMIUM_ALREADY_EXPANDED",
      `Premium had expanded +${chase.toFixed(1)}% from first capture before the alert, at or past the ${thresholds.chasePctThreshold}% threshold.`);
  }

  // 6. Late confirmation — valid evidence, but most of the move was gone.
  const captured = measures.capturedFractionOfPeak;
  if (captured != null && captured > thresholds.lateCaptureFraction) {
    return done("LATE_CONFIRMATION", "MOST_OF_MOVE_ALREADY_PRICED",
      `${Math.round(captured * 100)}% of the session's eventual premium gain was already realized at the alert, past the ${Math.round(thresholds.lateCaptureFraction * 100)}% threshold.`);
  }

  // 7. Early — fired while still unconfirmed and before price cleared structure.
  if (e.unconfirmedAtAlert === true && e.aboveVwapAtAlert === false) {
    return done("EARLY", "UNCONFIRMED_BELOW_VWAP",
      "The alert fired in an unconfirmed state with price below VWAP; the setup had not proven itself yet.");
  }

  return done("ON_TIME", "NO_TIMING_DEFECT",
    "No staleness, rollover, chase, or late-confirmation defect was measurable at the alert.");
}

/**
 * Map a post-hoc verdict onto whether ASYM_NOTIFY_V2 would have suppressed it.
 * Reported separately from the verdict itself so a disagreement is visible:
 * a gate that suppresses ON_TIME alerts is over-tight, and a gate that passes
 * MOMENTUM_ROLLOVER alerts is under-tight. Both are findings.
 */
export function gateWouldSuppress(verdict: TimingVerdict): boolean | null {
  switch (verdict) {
    case "STALE_EVIDENCE": return true;
    case "MOMENTUM_ROLLOVER": return true;
    case "PREMIUM_CHASE": return true;
    case "ON_TIME": return false;
    case "EARLY": return false;
    // The gate has no lookahead, so it cannot see either of these. Reporting
    // "unknown" is honest; reporting false would imply the gate approved them.
    case "LATE_CONFIRMATION": return null;
    case "FAILED_BREAKOUT": return null;
    case "INSUFFICIENT_TIMING_EVIDENCE": return null;
  }
}
