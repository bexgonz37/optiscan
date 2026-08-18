/**
 * PRE_MOVE_DISCOVERY_V2 — did OptiScan find a genuine eventual winner early enough
 * that meaningful upside was still available?
 *
 * MEASUREMENT ONLY. Nothing here admits, rejects, ranks, sizes, times or annotates a
 * callout. No threshold in this file is read by the scanner, the strategy selector,
 * the contract chooser, a target, a stop, an exit or a delivery decision. V1 is not
 * rewritten, not reclassified and not deleted: its rows keep their V1 stage forever.
 *
 * ── Why a V2 exists at all ────────────────────────────────────────────────────
 *
 * V1 grades 100% of every lane PRE_TRIGGER. Measured in production 2026-08-18:
 * OWNER 70/70, RESEARCH 122/125, SHADOW 4943/5000. `medianRewardRemainingFraction`
 * is 1.0 and `medianPremiumConsumedBeforeAlertPct` is 0. A metric that returns its
 * most flattering value for essentially every row has not discriminated anything.
 *
 * There are two independent causes and V2 addresses both.
 *
 * 1. THE BASELINE WAS OUR OWN TICK. V1 measures the favourable move consumed between
 *    FIRST DETECTION and ALERT. The median owner gap between those two instants is
 *    1,619 ms. Nothing measurable happens to a stock in 1.6 seconds, so the answer is
 *    always "0% consumed, 100% of the reward remaining" — a statement about scanner
 *    latency wearing the clothes of a statement about earliness. `sessionOpen` is not
 *    captured anywhere, so V1's fallback base is the detection price, and the metric
 *    compares the alert price against itself.
 *
 *    V2 measures against the SESSION, which is the only denominator that can answer
 *    the commercial question: of the favourable range the day had printed by the time
 *    we spoke, how much was already behind us?
 *
 * 2. TRIGGER STATE SHORT-CIRCUITED THE MAGNITUDE. V1 checks `triggerTaken === false`
 *    FIRST and returns PRE_TRIGGER without ever consulting how much of the move was
 *    spent. On an 87%-put population `lodBreak` is usually false, so almost every row
 *    took that exit. The inversion this produces is severe: a put alerted a penny off
 *    the session low, with the entire day's downside already travelled and nothing
 *    left to capture, is reported as "the favourable move has not begun".
 *
 *    In V2 structure and magnitude are two AXES. Magnitude dominates at the late end —
 *    a setup with 90% of the day's move spent is late whatever its trigger says —
 *    and structure decides at the early end, which is the only place it is informative.
 *
 * ── The no-hindsight rule, and where it is enforced ───────────────────────────
 *
 * `classifyDiscoveryV2` may read ONLY the alert-instant snapshot. That is stricter
 * than it sounds, because the V1 row's `session_high`/`session_low` are maintained as
 * a running MAX/MIN for the whole life of the row and therefore KEEP WIDENING AFTER
 * THE ALERT. Classifying against them would let the rest of the day enlarge the
 * denominator of a decision made at 10:04, and every alert would drift earlier the
 * longer its session ran. V2 therefore refuses to read them and requires its own
 * write-once alert-instant capture (`sessionHighAtAlert` / `sessionLowAtAlert`).
 *
 * A row without that capture is UNGRADABLE. That is the whole of the prospective
 * rule: every row written before the V2 capture site went live is UNGRADABLE forever,
 * no value is back-filled, and no post-alert observation is ever admitted as though it
 * had been available at the time.
 *
 * Outcomes live exclusively in `measureDiscoveryOutcomeV2`, which asks a different
 * question ("was the stage useful?") and is always computed after the fact.
 *
 * ── Missing stays missing ─────────────────────────────────────────────────────
 *
 * Every field is nullable and every null means "not observed", never 0. In particular
 * `premiumExpansionConsumedPct` is NULL when detection and alert are the same
 * observation. V1 reported 0% there, which reads as "the alert cost the owner nothing
 * in premium" — a finding — when it means "the two prices are the same tick".
 *
 * PURE: no I/O, no database, no provider call, no clock.
 */
import { createHash } from "node:crypto";

export const PRE_MOVE_DISCOVERY_V2_VERSION = "PRE_MOVE_DISCOVERY_V2";

export type OptionSideV2 = "CALL" | "PUT";

/**
 * Where in the move's lifecycle the opportunity was found.
 *
 * The names describe the MOVE, not the clock: a discovery at 15:45 can be
 * PRE_TRIGGER_WATCH and one at 09:31 can be TOO_LATE.
 */
export type DiscoveryStageV2 =
  /** Structure has not broken and little of the day's favourable range is spent. */
  | "PRE_TRIGGER_WATCH"
  /** The trigger is taken and the move has barely started. */
  | "EARLY_CONFIRMATION"
  /** The move is underway with the majority of the day's range still ahead. */
  | "EARLY_EXPANSION"
  /** Most of the day's observable favourable range is already behind us. */
  | "MATURE_MOVE"
  /** The day's favourable range is effectively spent; this is buying what happened. */
  | "TOO_LATE"
  /** Inputs absent. Not a stage — an admission. */
  | "UNGRADABLE";

export const DISCOVERY_STAGES_V2: readonly DiscoveryStageV2[] = Object.freeze([
  "PRE_TRIGGER_WATCH", "EARLY_CONFIRMATION", "EARLY_EXPANSION",
  "MATURE_MOVE", "TOO_LATE", "UNGRADABLE",
]);

/** Whether the level defining this setup had been taken out when we spoke. */
export type TriggerStateV2 = "NOT_TAKEN" | "TAKEN" | "UNKNOWN";

/**
 * The five named instants of a discovery. Every one is optional and a null is never
 * rendered as "immediately"; a timeline that cannot be reconstructed says so.
 */
export interface DiscoveryTimelineV2 {
  /** First tick on which the symbol became a candidate for this setup. */
  firstSetupObservedAtMs: number | null;
  /** First tick on which SOME confirmation existed but the setup was not yet READY. */
  firstPartialConfirmationAtMs: number | null;
  /** First tick on which confirmation was complete — the candidate became READY. */
  firstFullConfirmationAtMs: number | null;
  /** The instant the owner's Discord opening was actually sent. */
  ownerCalloutAtMs: number | null;
  /** First tick after the callout on which the contract's premium had visibly expanded. */
  firstExpansionAtMs: number | null;
}

/**
 * Everything observable at the moment of the callout, snapshotted THEN.
 *
 * `sessionHighAtAlert` / `sessionLowAtAlert` are the load-bearing pair. They must be
 * the values as of the alert, not a running extent — see the module header.
 */
export interface DiscoveryObservationV2 {
  side: OptionSideV2;

  underlyingAtAlert: number | null;
  sessionHighAtAlert: number | null;
  sessionLowAtAlert: number | null;
  /** Where the session opened, when the capture site had it. Optional. */
  sessionOpen?: number | null;
  vwapAtAlert?: number | null;

  /** The level whose break defines this setup's trigger, and whether it was taken. */
  triggerLevelAtAlert?: number | null;
  triggerTakenAtAlert?: boolean | null;

  /** Option ask at the callout, and at first detection when they are distinguishable. */
  optionAtAlert?: number | null;
  optionAtFirstDetection?: number | null;
  underlyingAtFirstDetection?: number | null;

  timeline?: Partial<DiscoveryTimelineV2>;
}

export interface DiscoveryClassificationV2 {
  version: typeof PRE_MOVE_DISCOVERY_V2_VERSION;
  stage: DiscoveryStageV2;
  side: OptionSideV2;
  triggerState: TriggerStateV2;

  /**
   * Share of the day's favourable range already travelled our way at the callout, 0..1.
   *
   * CALL: (price − sessionLow) / (sessionHigh − sessionLow).
   * PUT:  (sessionHigh − price) / (sessionHigh − sessionLow).
   *
   * Signed by direction, which is the difference between this and the range-position
   * ratio V1's header retired: for a PUT a LOW reading is early, because the downside
   * has not happened yet. Null when the session printed no range to measure against —
   * "there was nothing to be early for" is not "we were late".
   */
  sessionMoveConsumedFraction: number | null;
  /** 1 − consumed. How much of what the day offered was still ahead of us. */
  rewardRemainingFraction: number | null;

  /** Signed favourable underlying movement from the session's base to the callout. */
  underlyingMoveConsumedPct: number | null;
  /**
   * Premium expansion between first detection and the callout.
   *
   * NULL — not 0 — when those are the same observation. V1 reported 0% on all 70 owner
   * rows because detection and alert are 1.6 s apart, and a reader takes 0% to mean
   * "we paid nothing for the delay" rather than "we did not measure it".
   */
  premiumExpansionConsumedPct: number | null;

  /** Signed % the underlying still had to travel to take the trigger. Negative = past it. */
  distanceToTriggerPct: number | null;
  /** Signed % the callout price sat beyond VWAP in the trade's direction — the chase. */
  extensionFromVwapPct: number | null;

  /** Milliseconds between each pair of adjacent timeline instants that both exist. */
  timeline: DiscoveryTimelineV2;
  setupToCalloutMs: number | null;
  fullConfirmationToCalloutMs: number | null;

  /** Every input that was absent. UNGRADABLE always lists why. */
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
 * Stage thresholds, in fractions of the day's favourable range already spent.
 *
 * Named constants because an unnamed 0.6 in a branch is a threshold nobody can find
 * later, and because the definition hash probes these boundaries: moving one changes
 * the hash and fails the freeze check rather than silently redefining the measurement.
 *
 * DIAGNOSTIC ONLY. No live path reads any of them.
 */
export const DISCOVERY_V2_THRESHOLDS = Object.freeze({
  /** At or above this share consumed, the day's favourable range is effectively spent. */
  tooLateConsumed: 0.85,
  /** At or above this, most of the observable move is behind us. */
  matureConsumed: 0.6,
  /** At or above this, the move is underway even if the trigger never printed. */
  expansionConsumed: 0.25,
  /** A taken trigger with at least this much spent is already expanding, not confirming. */
  expansionAfterTriggerConsumed: 0.1,
  /** Premium expansion that counts as "we arrived after the contract already moved". */
  substantialPremiumExpansionPct: 15,
  /**
   * Two observations closer together than this are ONE observation.
   *
   * The owner median detection-to-alert gap is 1,619 ms. Differencing two prices that
   * close reports scanner latency as premium expansion; below this the answer is null.
   */
  sameObservationMs: 15_000,
});

/**
 * Signed favourable movement from `from` to `to`, as a percentage of `from`.
 *
 * A CALL profits when the underlying rises and a PUT when it falls, so both return
 * POSITIVE when the move went the trade's way.
 */
export function favorableMovePctV2(
  side: OptionSideV2,
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
 * Share of the session's printed range already travelled in the trade's favour.
 *
 * Clamped to 0..1: a price outside the range it is measured against is a data error,
 * not a 130% move. Null when the session printed no range — a symbol that has not
 * moved offers no denominator, and inventing one would make "nothing happened" read
 * as "we were perfectly early".
 */
export function sessionMoveConsumedFractionV2(
  side: OptionSideV2,
  atAlert: number | null,
  sessionHigh: number | null,
  sessionLow: number | null,
): number | null {
  const p = num(atAlert);
  const hi = num(sessionHigh);
  const lo = num(sessionLow);
  if (p == null || hi == null || lo == null) return null;
  const range = hi - lo;
  if (!(range > 0)) return null;
  const consumed = side === "PUT" ? hi - p : p - lo;
  return round(Math.max(0, Math.min(1, consumed / range)));
}

function triggerState(v: boolean | null | undefined): TriggerStateV2 {
  if (v === true) return "TAKEN";
  if (v === false) return "NOT_TAKEN";
  return "UNKNOWN";
}

/**
 * Classify one discovery from ALERT-INSTANT evidence only.
 *
 * Reads no outcome, no forward price, no mark, and nothing dated after the callout.
 */
export function classifyDiscoveryV2(obs: DiscoveryObservationV2): DiscoveryClassificationV2 {
  const missing: string[] = [];
  const need = <T>(name: string, v: T | null): T | null => {
    if (v == null) missing.push(name);
    return v;
  };

  const side = obs.side;
  const atAlert = need("underlyingAtAlert", num(obs.underlyingAtAlert));
  const hi = need("sessionHighAtAlert", num(obs.sessionHighAtAlert));
  const lo = need("sessionLowAtAlert", num(obs.sessionLowAtAlert));
  const tState = triggerState(obs.triggerTakenAtAlert);
  if (tState === "UNKNOWN") missing.push("triggerTakenAtAlert");

  const consumed = sessionMoveConsumedFractionV2(side, atAlert, hi, lo);

  // The base the day's move is measured from: the session open where the capture site
  // had it, otherwise the first price we saw. Never a later price — that would let the
  // move being measured shrink its own baseline.
  const base = num(obs.sessionOpen) ?? num(obs.underlyingAtFirstDetection);
  const underlyingMoveConsumedPct = favorableMovePctV2(side, base, atAlert);

  const t = DISCOVERY_V2_THRESHOLDS;
  const timeline: DiscoveryTimelineV2 = {
    firstSetupObservedAtMs: num(obs.timeline?.firstSetupObservedAtMs),
    firstPartialConfirmationAtMs: num(obs.timeline?.firstPartialConfirmationAtMs),
    firstFullConfirmationAtMs: num(obs.timeline?.firstFullConfirmationAtMs),
    ownerCalloutAtMs: num(obs.timeline?.ownerCalloutAtMs),
    firstExpansionAtMs: num(obs.timeline?.firstExpansionAtMs),
  };

  // Premium expansion is only measurable across two DISTINCT observations. Detection and
  // alert on the same tick differ by scanner latency, not by market movement.
  const optDetected = num(obs.optionAtFirstDetection);
  const optAlert = num(obs.optionAtAlert);
  const detectedAt = timeline.firstSetupObservedAtMs;
  const calloutAt = timeline.ownerCalloutAtMs;
  const distinctObservations =
    detectedAt != null && calloutAt != null && calloutAt - detectedAt >= t.sameObservationMs;
  const premiumExpansionConsumedPct =
    distinctObservations && optDetected != null && optAlert != null && optDetected > 0
      ? round(((optAlert - optDetected) / optDetected) * 100)
      : null;
  if (premiumExpansionConsumedPct == null) missing.push("premiumExpansionConsumedPct");

  const trigger = num(obs.triggerLevelAtAlert);
  const distanceToTriggerPct = favorableMovePctV2(side, atAlert, trigger);
  const vwap = num(obs.vwapAtAlert);
  const extensionFromVwapPct = favorableMovePctV2(side, vwap, atAlert);

  const result: DiscoveryClassificationV2 = {
    version: PRE_MOVE_DISCOVERY_V2_VERSION,
    stage: "UNGRADABLE",
    side,
    triggerState: tState,
    sessionMoveConsumedFraction: consumed,
    rewardRemainingFraction: consumed == null ? null : round(Math.max(0, 1 - consumed)),
    underlyingMoveConsumedPct,
    premiumExpansionConsumedPct,
    distanceToTriggerPct,
    extensionFromVwapPct,
    timeline,
    setupToCalloutMs:
      timeline.firstSetupObservedAtMs != null && calloutAt != null
        ? calloutAt - timeline.firstSetupObservedAtMs : null,
    fullConfirmationToCalloutMs:
      timeline.firstFullConfirmationAtMs != null && calloutAt != null
        ? calloutAt - timeline.firstFullConfirmationAtMs : null,
    missingInputs: missing,
    reason: "",
  };

  if (consumed == null) {
    // No alert-instant session extent means no denominator, and V2 refuses the running
    // one on purpose. Every row captured before the V2 site went live lands here and
    // stays here: nothing is back-filled and no later observation is admitted.
    result.reason = atAlert == null || hi == null || lo == null
      ? `no alert-instant session extent: missing ${missing.join(", ") || "session snapshot"}`
      : "the session printed no range at the callout, so there was no favourable extent to measure against";
    return result;
  }

  const pct = Math.round(consumed * 100);

  // MAGNITUDE FIRST at the late end. This is the exact inversion V1 produced: a setup
  // whose trigger has not printed can still have the entire day's favourable range
  // behind it, and calling that "the move has not begun" is the flattering answer.
  if (consumed >= t.tooLateConsumed) {
    result.stage = "TOO_LATE";
    result.reason = `${pct}% of the session's favourable range was already spent at the callout`;
    return result;
  }
  if (consumed >= t.matureConsumed) {
    result.stage = "MATURE_MOVE";
    result.reason = `${pct}% of the session's favourable range was already behind us at the callout`;
    return result;
  }
  if (consumed >= t.expansionConsumed) {
    result.stage = "EARLY_EXPANSION";
    result.reason = `${pct}% of the range spent — the move is underway with the majority still ahead`;
    return result;
  }

  // STRUCTURE decides at the early end, and only here, because this is the only band in
  // which "has the level broken yet" changes what the callout is.
  if (tState === "TAKEN") {
    if (consumed >= t.expansionAfterTriggerConsumed) {
      result.stage = "EARLY_EXPANSION";
      result.reason = `the trigger is taken and ${pct}% of the range is spent — expanding, not just confirming`;
      return result;
    }
    result.stage = "EARLY_CONFIRMATION";
    result.reason = `the trigger is taken and only ${pct}% of the session's favourable range is spent`;
    return result;
  }
  if (tState === "NOT_TAKEN") {
    result.stage = "PRE_TRIGGER_WATCH";
    result.reason = `the trigger has not been taken and only ${pct}% of the range is spent`;
    return result;
  }

  // Low consumption with unobservable structure. PRE_TRIGGER_WATCH and
  // EARLY_CONFIRMATION are different claims about the setup and nothing here can tell
  // them apart, so neither is asserted. Forcing one would recreate V1's defect in the
  // opposite direction.
  result.reason =
    `only ${pct}% of the range is spent, but the trigger state was not observed, so `
    + "pre-trigger and confirmed cannot be distinguished";
  return result;
}

// ── outcomes: hindsight is allowed HERE and only here ────────────────────────

export const DISCOVERY_V2_MILESTONES = Object.freeze([10, 25] as const);

/** One mark on the FROZEN contract. The caller guarantees contract identity. */
export interface ContractMarkV2 {
  atMs: number | null;
  returnPct: number | null;
  premium?: number | null;
}

export interface DiscoveryOutcomeV2 {
  version: typeof PRE_MOVE_DISCOVERY_V2_VERSION;
  stage: DiscoveryStageV2;

  /** ms from the callout to the first touch of each milestone. Null = never reached. */
  msToPlus10: number | null;
  msToPlus25: number | null;
  msToTarget1: number | null;
  msToTarget2: number | null;

  /** Highest post-callout return on the frozen contract, when excursion is verified. */
  postCalloutMfePct: number | null;
  /** True when the contract never traded above the callout price. */
  neverConfirmed: boolean | null;
  /** True when the stage said the move was already mostly or wholly spent. */
  alreadyMature: boolean;
  /** True when the premium had visibly expanded before we spoke. Null = unmeasured. */
  arrivedAfterSubstantialExpansion: boolean | null;
  /** Realized outcome, carried so stage and result can be crossed without a second join. */
  realizedReturnPct: number | null;
  eventualWinner: boolean | null;

  note: string;
}

/**
 * Measure what happened AFTER the callout.
 *
 * Marks dated before the callout are used only to say what was consumed before it; they
 * can never count toward a milestone the callout takes credit for.
 */
export function measureDiscoveryOutcomeV2(input: {
  classification: DiscoveryClassificationV2;
  calloutAtMs: number | null;
  marks: ReadonlyArray<ContractMarkV2>;
  entryPremium?: number | null;
  target1Premium?: number | null;
  target2Premium?: number | null;
  realizedReturnPct?: number | null;
  /** A post-callout MFE is reported only when the excursion evidence is VERIFIED. */
  excursionVerified?: boolean;
}): DiscoveryOutcomeV2 {
  const c = input.classification;
  const calloutAtMs = num(input.calloutAtMs) ?? c.timeline.ownerCalloutAtMs;

  const usable = input.marks
    .map((m) => ({ atMs: num(m.atMs), returnPct: num(m.returnPct), premium: num(m.premium ?? null) }))
    .filter((m): m is { atMs: number; returnPct: number; premium: number | null } =>
      m.atMs != null && m.returnPct != null)
    .sort((a, b) => a.atMs - b.atMs);

  const after = calloutAtMs == null ? [] : usable.filter((m) => m.atMs >= calloutAtMs);

  const msTo = (predicate: (m: { returnPct: number; premium: number | null }) => boolean): number | null => {
    if (calloutAtMs == null) return null;
    const hit = after.find(predicate);
    return hit ? hit.atMs - calloutAtMs : null;
  };

  const entry = num(input.entryPremium);
  const t1 = num(input.target1Premium);
  const t2 = num(input.target2Premium);
  // Targets are premium levels, so they are reached on the PREMIUM, not on a return
  // recomputed from a possibly different entry. When a mark carries no premium the
  // target time is null — unknown — rather than derived from the wrong series.
  const premiumAtOrAbove = (level: number | null) =>
    level == null
      ? () => false
      : (m: { premium: number | null }) => m.premium != null && m.premium >= level;

  const postCalloutMfePct = input.excursionVerified && after.length
    ? round(Math.max(...after.map((m) => m.returnPct)))
    : null;

  const realizedReturnPct = num(input.realizedReturnPct);

  return {
    version: PRE_MOVE_DISCOVERY_V2_VERSION,
    stage: c.stage,
    msToPlus10: msTo((m) => m.returnPct >= 10),
    msToPlus25: msTo((m) => m.returnPct >= 25),
    msToTarget1: msTo(premiumAtOrAbove(t1)),
    msToTarget2: msTo(premiumAtOrAbove(t2)),
    postCalloutMfePct,
    neverConfirmed: postCalloutMfePct == null ? null : postCalloutMfePct <= 0,
    alreadyMature: c.stage === "MATURE_MOVE" || c.stage === "TOO_LATE",
    arrivedAfterSubstantialExpansion: c.premiumExpansionConsumedPct == null
      ? null
      : c.premiumExpansionConsumedPct >= DISCOVERY_V2_THRESHOLDS.substantialPremiumExpansionPct,
    realizedReturnPct,
    eventualWinner: realizedReturnPct == null ? null : realizedReturnPct > 0,
    note: calloutAtMs == null
      ? "No callout instant: every time-to-milestone is unavailable, not zero."
      : "Times are measured FROM the callout on the frozen contract's own marks. A milestone "
        + "reached before the callout is never counted as lead time. Entry premium is "
        + (entry == null ? "unavailable" : "the frozen entry") + ".",
  };
}

// ── the frozen definition ────────────────────────────────────────────────────

/**
 * Content hash of the V2 stage rule, probed by BEHAVIOUR rather than by source text.
 *
 * Every boundary in `DISCOVERY_V2_THRESHOLDS` is swept from both sides and in every
 * trigger state, so moving a threshold — or reordering the branches, which is what
 * actually went wrong in V1 — changes the hash even though the constants still read
 * the same. A silent redefinition mid-sample is the failure this prevents.
 */
export function discoveryV2DefinitionHash(): string {
  const h = createHash("sha256");
  h.update(`${PRE_MOVE_DISCOVERY_V2_VERSION}:`);
  const consumedProbes = [
    0, 0.05, 0.0999, 0.1, 0.1001, 0.2499, 0.25, 0.2501, 0.5,
    0.5999, 0.6, 0.6001, 0.8499, 0.85, 0.8501, 0.999, 1,
  ];
  for (const side of ["CALL", "PUT"] as const) {
    for (const taken of [true, false, null]) {
      for (const p of consumedProbes) {
        // Drive the classifier through a synthetic session whose range places the alert
        // price at exactly `p` of the way through it, in the trade's favour.
        const lo = 100;
        const hi = 200;
        const price = side === "PUT" ? hi - p * (hi - lo) : lo + p * (hi - lo);
        const c = classifyDiscoveryV2({
          side,
          underlyingAtAlert: price,
          sessionHighAtAlert: hi,
          sessionLowAtAlert: lo,
          triggerTakenAtAlert: taken,
        });
        h.update(`${side}|${String(taken)}|${p}=>${c.stage};`);
      }
    }
  }
  // Degenerate shapes must keep answering UNGRADABLE, and that is part of the definition.
  for (const obs of [
    { side: "PUT" as const, underlyingAtAlert: null, sessionHighAtAlert: 10, sessionLowAtAlert: 1 },
    { side: "PUT" as const, underlyingAtAlert: 5, sessionHighAtAlert: null, sessionLowAtAlert: 1 },
    { side: "CALL" as const, underlyingAtAlert: 5, sessionHighAtAlert: 5, sessionLowAtAlert: 5 },
  ]) {
    h.update(`degenerate=>${classifyDiscoveryV2(obs).stage};`);
  }
  return h.digest("hex").slice(0, 32);
}

/**
 * The hash recorded when PRE_MOVE_DISCOVERY_V2 was frozen.
 *
 * If this and `discoveryV2DefinitionHash()` disagree, THE MEASUREMENT CHANGED and every
 * stage collected under the old rule describes a different thing from every stage
 * collected under the new one. Do not update this constant to make a check pass —
 * register PRE_MOVE_DISCOVERY_V3 and leave V2's sample intact, exactly as V1 was left
 * intact here.
 */
export const PRE_MOVE_DISCOVERY_V2_DEFINITION_HASH = "e6eb1148e3bbd29fc4b71c657afbcafc";

export interface DiscoveryV2FrozenCheck {
  frozen: boolean;
  expected: string;
  actual: string;
  message: string;
}

export function checkDiscoveryV2Frozen(): DiscoveryV2FrozenCheck {
  const actual = discoveryV2DefinitionHash();
  const frozen = actual === PRE_MOVE_DISCOVERY_V2_DEFINITION_HASH;
  return {
    frozen,
    expected: PRE_MOVE_DISCOVERY_V2_DEFINITION_HASH,
    actual,
    message: frozen
      ? "PRE_MOVE_DISCOVERY_V2 stage definitions are unchanged since freeze."
      : "PRE_MOVE_DISCOVERY_V2 STAGE DEFINITIONS CHANGED. Stages collected before and after "
        + "this change are not comparable. Do not update the recorded hash — register V3.",
  };
}

/** The written definition, carried alongside the numbers wherever they are reported. */
export const PRE_MOVE_DISCOVERY_V2_DEFINITION = Object.freeze({
  version: PRE_MOVE_DISCOVERY_V2_VERSION,
  measures: "How much of the session's favourable range was already spent when the callout went out.",
  authority: "MEASUREMENT_ONLY",
  affectsDelivery: false as const,
  prospectiveOnly: true as const,
  denominator: "the session high-to-low range as of the CALLOUT INSTANT, snapshotted write-once",
  stages: Object.freeze({
    PRE_TRIGGER_WATCH: "trigger not taken and under 25% of the day's favourable range spent",
    EARLY_CONFIRMATION: "trigger taken and under 10% spent",
    EARLY_EXPANSION: "25%-60% spent, or trigger taken with 10%-25% spent",
    MATURE_MOVE: "60%-85% spent",
    TOO_LATE: "85% or more spent",
    UNGRADABLE: "no alert-instant session extent, or low consumption with unobserved trigger state",
  }),
  supersedes: "PRE_MOVE_DISCOVERY_V1",
  supersedesReason:
    "V1 measured the move consumed between first detection and alert, a median 1,619 ms "
    + "window, and short-circuited to PRE_TRIGGER on trigger state before consulting "
    + "magnitude at all. It graded 100% of every lane PRE_TRIGGER in production.",
  v1RowsUnchanged: true as const,
});
