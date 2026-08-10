/**
 * PRE_MOVE_DISCOVERY_V1 — did OptiScan find the opportunity BEFORE the profitable move?
 *
 * This is a grading and diagnostic system. It is NOT a trading gate: nothing here
 * admits, rejects, ranks or sizes anything, and no threshold in this file is consulted
 * by the live path. It exists to answer one commercial question honestly, because the
 * metric that claimed to answer it could not (see `session-range-position.ts`).
 *
 * ── Direction awareness is the whole point ─────────────────────────────────────
 *
 * "Favourable" is defined by the contract, not by the chart:
 *
 *     CALL — the underlying moving UP is favourable.
 *     PUT  — the underlying moving DOWN is favourable.
 *
 * The retired metric measured position in the session range and called a low reading
 * "early". For a PUT that is the moment the downside move has ALREADY happened — the
 * latest possible entry, labelled the earliest. Every measurement below is signed by
 * direction so that "consumed" always means "favourable move already spent", whichever
 * way the trade points.
 *
 * ── No hindsight in the classification ─────────────────────────────────────────
 *
 * `classifyDiscovery` may read ONLY what was observable at the moment it classifies:
 * prices at detection, at eligibility, at alert, and the structural state then. It
 * never reads what happened afterwards. Outcomes appear exclusively in `gradeDiscovery`,
 * which asks a different question — "was the classification useful?" — and is always
 * computed after the fact. Mixing the two would produce a metric that looks
 * extraordinarily accurate in backtest and is unusable live, which is the standard way
 * this measurement goes wrong.
 *
 * ── Missing stays missing ──────────────────────────────────────────────────────
 *
 * Historical rows have no prospective capture and none is invented for them. Every
 * field is nullable and every null means "not observed", never 0. A discovery whose
 * inputs are absent classifies as UNGRADABLE, which is a real answer.
 */

export const PRE_MOVE_DISCOVERY_VERSION = "PRE_MOVE_DISCOVERY_V1";

export type OptionSide = "CALL" | "PUT";

/**
 * Where in the move's lifecycle the opportunity was found.
 *
 * Ordered from earliest to latest. The names describe the MOVE, not the clock — a
 * discovery at 15:45 can be PRE_TRIGGER and one at 09:31 can be TOO_LATE.
 */
export type DiscoveryStage =
  /** The favourable move has not begun. Trigger not yet taken out, premium not expanded. */
  | "PRE_TRIGGER"
  /** The move has just begun: the trigger is taken and little of the move is spent. */
  | "EARLY_CONFIRMATION"
  /** The move is underway and premium is expanding, with meaningful room left. */
  | "EARLY_EXPANSION"
  /** Most of the observable move is behind us; what remains is the tail. */
  | "MATURE_MOVE"
  /** The move is effectively complete — buying here is buying what already happened. */
  | "TOO_LATE"
  /** Inputs absent. Not a stage — an admission. */
  | "UNGRADABLE";

/** Observable, decision-time inputs. Everything here is knowable when it is read. */
export interface DiscoveryObservation {
  side: OptionSide;

  /** Underlying when the symbol first became a candidate this session. */
  underlyingAtFirstDetection: number | null;
  /** Underlying when the setup first became eligible (confirmation complete). */
  underlyingAtEligible: number | null;
  /** Underlying at the moment the alert was (or would be) sent. */
  underlyingAtAlert: number | null;

  /** Option ask at first detection, at eligibility, and the frozen entry actually paid. */
  optionAtFirstDetection: number | null;
  optionAtEligible: number | null;
  optionAtAlert: number | null;

  /** The level whose break defines this setup's trigger, and whether it is taken. */
  triggerLevel?: number | null;
  triggerTaken?: boolean | null;

  /**
   * Session extremes so far — used ONLY to size the move already consumed. Session-to-
   * date and known at decision time; this is not the retired range-position ratio,
   * which used them to make a direction-blind "earliness" claim.
   */
  sessionHigh?: number | null;
  sessionLow?: number | null;
  /** Where the session opened, i.e. the base the day's move is measured from. */
  sessionOpen?: number | null;

  /** Structural context, all decision-time. */
  compressionPct?: number | null;
  volumeAcceleration?: number | null;

  firstDetectedAtMs?: number | null;
  eligibleAtMs?: number | null;
  alertAtMs?: number | null;
}

export interface DiscoveryClassification {
  version: typeof PRE_MOVE_DISCOVERY_VERSION;
  stage: DiscoveryStage;
  side: OptionSide;

  /**
   * Favourable underlying movement, in percent, already spent before the alert.
   * SIGNED BY DIRECTION: positive means the move went our way before we alerted.
   * A PUT whose underlying fell 2% before the alert consumed +2%, not −2%.
   */
  underlyingMoveConsumedPct: number | null;
  /** Premium expansion, in percent, already spent between first detection and alert. */
  premiumExpansionConsumedPct: number | null;
  /**
   * Share of the session's favourable move already spent at alert time, 0..1.
   * The honest denominator: what the day actually offered, measured after the fact for
   * the DAY but entirely from prices already printed when we alerted.
   */
  moveConsumedFraction: number | null;

  /** Milliseconds from first detection to alert. How long we sat on it. */
  detectionToAlertMs: number | null;
  /** Milliseconds from eligibility to alert — the confirmation-to-delivery cost. */
  eligibleToAlertMs: number | null;

  /** Every input that was absent. A stage of UNGRADABLE always lists why. */
  missingInputs: string[];
  reason: string;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round = (v: number | null, places = 4): number | null =>
  v == null ? null : +v.toFixed(places);

/**
 * Signed favourable movement from `from` to `to`, as a percentage of `from`.
 *
 * The sign convention is the core of this module: a CALL profits when the underlying
 * rises, a PUT when it falls, so both return POSITIVE when the move went the trade's
 * way. Negative means the underlying moved against the thesis before we alerted.
 */
export function favorableMovePct(
  side: OptionSide,
  from: number | null,
  to: number | null,
): number | null {
  const a = num(from);
  const b = num(to);
  if (a == null || b == null || !(a > 0)) return null;
  const raw = ((b - a) / a) * 100;
  return round(side === "PUT" ? -raw : raw);
}

/**
 * How much of the session's favourable move was already spent at alert time.
 *
 * For a CALL the day's favourable extent is (sessionHigh − base); for a PUT it is
 * (base − sessionLow). The numerator is what had been consumed by the alert. Returns
 * null rather than 0 when the day offered no favourable move at all — "there was
 * nothing to be early for" is not the same as "we were late".
 */
export function moveConsumedFraction(
  side: OptionSide,
  base: number | null,
  atAlert: number | null,
  sessionHigh: number | null,
  sessionLow: number | null,
): number | null {
  const b = num(base);
  const alert = num(atAlert);
  const hi = num(sessionHigh);
  const lo = num(sessionLow);
  if (b == null || alert == null || hi == null || lo == null) return null;
  const extent = side === "PUT" ? b - lo : hi - b;
  if (!(extent > 0)) return null;
  const consumed = side === "PUT" ? b - alert : alert - b;
  // Clamped: a price outside the session range is a data error, not a >100% move.
  return round(Math.max(0, Math.min(1, consumed / extent)));
}

/** Stage thresholds. Diagnostic only — nothing in the live path reads these. */
export const DISCOVERY_THRESHOLDS = {
  /** Below this share of the day's favourable move consumed, the move has barely begun. */
  earlyConsumedFraction: 0.25,
  /** Above this, the observable move is mostly behind us. */
  matureConsumedFraction: 0.6,
  /** Above this, buying is buying what already happened. */
  tooLateConsumedFraction: 0.85,
  /** Premium expansion that marks a move as visibly underway. */
  expansionUnderwayPct: 15,
} as const;

/**
 * Classify a discovery from decision-time evidence ONLY.
 *
 * Reads no outcome, no forward price, and nothing dated after `alertAtMs`. This is
 * what makes the classification reproducible live; `gradeDiscovery` is where outcomes
 * are allowed in.
 */
export function classifyDiscovery(obs: DiscoveryObservation): DiscoveryClassification {
  const missing: string[] = [];
  const need = (name: string, v: number | null): number | null => {
    if (v == null) missing.push(name);
    return v;
  };

  const side = obs.side;
  const detected = need("underlyingAtFirstDetection", num(obs.underlyingAtFirstDetection));
  const atAlert = need("underlyingAtAlert", num(obs.underlyingAtAlert));
  const optDetected = num(obs.optionAtFirstDetection);
  const optAlert = num(obs.optionAtAlert);

  const underlyingMoveConsumedPct = favorableMovePct(side, detected, atAlert);
  const premiumExpansionConsumedPct = optDetected != null && optAlert != null && optDetected > 0
    ? round(((optAlert - optDetected) / optDetected) * 100)
    : null;

  // The base the day's move is measured from: the session open where known, otherwise
  // the price when we first saw the symbol. Never a later price — that would let the
  // move we are trying to measure shrink its own denominator.
  const base = num(obs.sessionOpen) ?? detected;
  const consumedFraction = moveConsumedFraction(
    side, base, atAlert, num(obs.sessionHigh), num(obs.sessionLow),
  );

  const detectionToAlertMs = obs.firstDetectedAtMs != null && obs.alertAtMs != null
    ? obs.alertAtMs - obs.firstDetectedAtMs
    : null;
  const eligibleToAlertMs = obs.eligibleAtMs != null && obs.alertAtMs != null
    ? obs.alertAtMs - obs.eligibleAtMs
    : null;

  const base_: DiscoveryClassification = {
    version: PRE_MOVE_DISCOVERY_VERSION,
    stage: "UNGRADABLE",
    side,
    underlyingMoveConsumedPct,
    premiumExpansionConsumedPct,
    moveConsumedFraction: consumedFraction,
    detectionToAlertMs,
    eligibleToAlertMs,
    missingInputs: missing,
    reason: "",
  };

  if (underlyingMoveConsumedPct == null) {
    base_.reason = `cannot measure favourable movement: missing ${missing.join(", ")}`;
    return base_;
  }

  const triggerTaken = obs.triggerTaken ?? null;
  const expansion = premiumExpansionConsumedPct;
  const t = DISCOVERY_THRESHOLDS;

  // PRE_TRIGGER is a statement about STRUCTURE, not about size: the level that defines
  // the setup has not been taken out yet. It is checked first because a move that has
  // not started cannot be "25% spent" in any meaningful sense.
  if (triggerTaken === false) {
    base_.stage = "PRE_TRIGGER";
    base_.reason = "the trigger level has not been taken out; the favourable move has not begun";
    return base_;
  }

  if (consumedFraction == null) {
    // No usable denominator. Fall back to what CAN be said: premium expansion is a
    // direct observation of the move being paid for, and needs no session extent.
    if (expansion != null && expansion >= t.expansionUnderwayPct) {
      base_.stage = "MATURE_MOVE";
      base_.reason = `premium already expanded ${expansion}% before the alert; session extent unavailable`;
      return base_;
    }
    base_.reason = "the session offered no measurable favourable extent to size the move against";
    return base_;
  }

  if (consumedFraction >= t.tooLateConsumedFraction) {
    base_.stage = "TOO_LATE";
    base_.reason = `${Math.round(consumedFraction * 100)}% of the session's favourable move was already spent`;
    return base_;
  }
  if (consumedFraction >= t.matureConsumedFraction) {
    base_.stage = "MATURE_MOVE";
    base_.reason = `${Math.round(consumedFraction * 100)}% of the session's favourable move was already spent`;
    return base_;
  }
  if (consumedFraction <= t.earlyConsumedFraction) {
    // Distinguish "confirmed and barely moved" from "confirmed and already paying".
    const underway = expansion != null && expansion >= t.expansionUnderwayPct;
    base_.stage = underway ? "EARLY_EXPANSION" : "EARLY_CONFIRMATION";
    base_.reason = underway
      ? `only ${Math.round(consumedFraction * 100)}% of the move spent, and premium is already expanding (${expansion}%)`
      : `only ${Math.round(consumedFraction * 100)}% of the session's favourable move was spent at alert`;
    return base_;
  }
  base_.stage = "EARLY_EXPANSION";
  base_.reason = `${Math.round(consumedFraction * 100)}% of the session's favourable move was spent; the move is underway with room left`;
  return base_;
}

// ── lead time ────────────────────────────────────────────────────────────────

/**
 * How early were we, in the only unit that matters commercially: time between the
 * alert and the move paying.
 *
 * "Alerted 12 minutes BEFORE +25%" and "the option had already gained 47% before we
 * alerted" are the two answers this has to be able to give, and they are different
 * enough that a single signed number would hide one of them.
 */
export interface AlertLeadTime {
  version: typeof PRE_MOVE_DISCOVERY_VERSION;
  alertAtMs: number | null;
  /** ms from alert to first touch of each milestone. Null = never reached. */
  msToMilestone: Record<string, number | null>;
  /** Post-alert MFE on the frozen contract, when the excursion evidence supports one. */
  postAlertMfePct: number | null;
  /**
   * Premium already gained between first detection and the alert. When this is large
   * the alert was late no matter how good the realized return looked.
   */
  premiumConsumedBeforeAlertPct: number | null;
  /** Milestones the trade reached BEFORE the alert. Any is a red flag. */
  milestonesReachedBeforeAlert: number[];
  note: string;
}

export const DEFAULT_LEAD_TIME_MILESTONES = [10, 25, 50, 100, 200] as const;

/**
 * Compute lead time from a same-contract mark series.
 *
 * `marks` must already be filtered to the frozen contract — this function cannot check
 * identity and will not pretend to. Marks dated before the alert are used only to
 * report what was consumed before it; they never count toward a milestone the alert
 * can claim credit for.
 */
export function computeAlertLeadTime(input: {
  alertAtMs: number | null;
  marks: ReadonlyArray<{ atMs: number | null; returnPct: number | null }>;
  milestones?: readonly number[];
  premiumConsumedBeforeAlertPct?: number | null;
  /** Excursion evidence state; a post-alert MFE is reported only when VERIFIED. */
  excursionVerified?: boolean;
}): AlertLeadTime {
  const milestones = input.milestones ?? DEFAULT_LEAD_TIME_MILESTONES;
  const alertAtMs = input.alertAtMs;
  const msToMilestone: Record<string, number | null> = {};
  for (const m of milestones) msToMilestone[String(m)] = null;

  const usable = input.marks
    .map((m) => ({ atMs: num(m.atMs), returnPct: num(m.returnPct) }))
    .filter((m): m is { atMs: number; returnPct: number } => m.atMs != null && m.returnPct != null)
    .sort((a, b) => a.atMs - b.atMs);

  const before = alertAtMs == null ? [] : usable.filter((m) => m.atMs < alertAtMs);
  const after = alertAtMs == null ? usable : usable.filter((m) => m.atMs >= alertAtMs);

  for (const m of milestones) {
    const hit = after.find((x) => x.returnPct >= m);
    msToMilestone[String(m)] = hit && alertAtMs != null ? hit.atMs - alertAtMs : null;
  }

  const reachedBefore = milestones.filter((m) => before.some((x) => x.returnPct >= m));
  const postAlertMfePct = input.excursionVerified && after.length
    ? round(Math.max(...after.map((x) => x.returnPct)))
    : null;

  return {
    version: PRE_MOVE_DISCOVERY_VERSION,
    alertAtMs,
    msToMilestone,
    postAlertMfePct,
    premiumConsumedBeforeAlertPct: round(num(input.premiumConsumedBeforeAlertPct)),
    milestonesReachedBeforeAlert: [...reachedBefore],
    note: alertAtMs == null
      ? "No alert timestamp: lead time is unavailable, not zero."
      : "Milestone times are measured from the alert. A milestone reached BEFORE the alert is "
        + "reported separately and never counted as lead time.",
  };
}

// ── reward remaining ─────────────────────────────────────────────────────────

/**
 * REWARD_REMAINING — advisory foundation, deliberately not a probability.
 *
 * Distinguishes "right direction, most of the move already gone" from "right
 * direction, large opportunity still ahead". It uses ONLY inputs the system already
 * defends: the session's favourable extent, how much of it is spent, and the premium
 * already paid for. No new model, no empirical P(+25)/P(+50), no historical cohort —
 * those need VERIFIED excursion evidence that does not exist yet.
 *
 * `fraction` is 1 − consumed, so it falls as the move is spent. It is a share of the
 * SESSION's observed extent, not a forecast: it cannot know the move will continue,
 * only how much of what the day has already offered is left. Null when the day
 * offered no measurable favourable extent — "unknown", never "none".
 */
export interface RewardRemaining {
  version: typeof PRE_MOVE_DISCOVERY_VERSION;
  fraction: number | null;
  band: "LARGE_REMAINING" | "MODERATE_REMAINING" | "MOSTLY_SPENT" | "UNAVAILABLE";
  basis: string;
  advisoryOnly: true;
}

export function computeRewardRemaining(c: DiscoveryClassification): RewardRemaining {
  const consumed = c.moveConsumedFraction;
  if (consumed == null) {
    return {
      version: PRE_MOVE_DISCOVERY_VERSION,
      fraction: null,
      band: "UNAVAILABLE",
      basis: "no measurable favourable session extent; remaining reward is unknown, not zero",
      advisoryOnly: true,
    };
  }
  const fraction = round(Math.max(0, 1 - consumed));
  const band = fraction == null
    ? "UNAVAILABLE"
    : fraction >= 0.75
      ? "LARGE_REMAINING"
      : fraction >= 0.4
        ? "MODERATE_REMAINING"
        : "MOSTLY_SPENT";
  return {
    version: PRE_MOVE_DISCOVERY_VERSION,
    fraction,
    band,
    basis:
      "share of the SESSION's observed favourable extent still unspent at alert time. "
      + "Not a probability and not a forecast: it says how much of what the day has already "
      + "offered remained, never that the move will continue.",
    advisoryOnly: true,
  };
}

// ── grading (hindsight allowed HERE and only here) ───────────────────────────

/**
 * Was the classification useful? Answered after the fact.
 *
 * Kept rigorously separate from `classifyDiscovery`. The classification must be
 * reproducible from decision-time evidence alone; this asks whether that decision-time
 * label predicted anything, and it needs the outcome to do so. A single function doing
 * both would let the outcome leak into the label and produce a metric that grades
 * itself perfectly and is worthless live.
 */
export function gradeDiscovery(
  c: DiscoveryClassification,
  outcome: { realizedReturnPct: number | null; postAlertMfePct: number | null },
): {
  version: typeof PRE_MOVE_DISCOVERY_VERSION;
  stage: DiscoveryStage;
  classificationWasUseful: boolean | null;
  reason: string;
} {
  const mfe = num(outcome.postAlertMfePct);
  if (mfe == null) {
    return {
      version: PRE_MOVE_DISCOVERY_VERSION,
      stage: c.stage,
      classificationWasUseful: null,
      reason: "no verified post-alert excursion, so the classification cannot be graded",
    };
  }
  // The claim each stage makes about what should FOLLOW the alert.
  const earlyStages: DiscoveryStage[] = ["PRE_TRIGGER", "EARLY_CONFIRMATION", "EARLY_EXPANSION"];
  const lateStages: DiscoveryStage[] = ["MATURE_MOVE", "TOO_LATE"];
  if (earlyStages.includes(c.stage)) {
    return {
      version: PRE_MOVE_DISCOVERY_VERSION,
      stage: c.stage,
      classificationWasUseful: mfe > 0,
      reason: `an early classification predicts favourable movement after the alert; post-alert MFE was ${mfe}%`,
    };
  }
  if (lateStages.includes(c.stage)) {
    return {
      version: PRE_MOVE_DISCOVERY_VERSION,
      stage: c.stage,
      classificationWasUseful: mfe <= 0,
      reason: `a late classification predicts little left after the alert; post-alert MFE was ${mfe}%`,
    };
  }
  return {
    version: PRE_MOVE_DISCOVERY_VERSION,
    stage: c.stage,
    classificationWasUseful: null,
    reason: "ungradable classifications make no prediction to score",
  };
}
