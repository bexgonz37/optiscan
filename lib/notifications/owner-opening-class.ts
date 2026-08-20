/**
 * owner-opening-class.ts — the ONE place that answers "is this owner Discord opening an
 * ACTIONABLE callout, or a WATCH/research observation?"
 *
 * ── The defect this module exists to end ─────────────────────────────────────
 *
 * `sendOwnerPrivateOpening` tagged EVERY owner opening `researchObservation: true`, so a
 * single flag — `OWNER_WATCH_DISCORD_SUPPRESSED=1` — silenced two populations that are not
 * the same thing:
 *
 *   - the READINESS-GATED opening, which had already cleared the session guard, the
 *     research floor, the late-phase bar, the SUBSCRIBER quality bar, correlation,
 *     ranking and entry quality. The only thing refusing it is that its strategy version
 *     is not SUBSCRIBER_APPROVED — a statement about SUBSCRIBERS, not about the setup.
 *     That is a real trade notification.
 *   - the BEARISH owner review, which fires UPSTREAM of the research floor, the late-phase
 *     bar and the quality bar. A BEARISH_READY candidate may be none of those things. That
 *     is a research observation.
 *
 * Production at ca9b98c: every owner opening from 2026-08-19T15:31Z onward is SUPPRESSED —
 * 10 on 2026-08-20 alone, 0 SENT. The suppression was correct for the second population and
 * wrong for the first, and nothing in the code could tell them apart.
 *
 * ── What ACTIONABLE means here ───────────────────────────────────────────────
 *
 * An owner opening is ACTIONABLE when the candidate met the SAME OBJECTIVE BARS a
 * subscriber callout must meet, and the only remaining refusal is an authorization
 * statement about subscribers. Every bar below is read from values the delivery decision
 * already computed. Nothing here computes a threshold, a target, a stop, a score or a
 * ranking, and nothing here can cause a send that the existing hard delivery gates
 * (`OWNER_RESEARCH_DISCORD_ENABLED`, `OWNER_RESEARCH_INTRADAY_ENABLED`,
 * `BEARISH_OWNER_ALERTS_ENABLED`, webhook configuration, session guard) would refuse.
 *
 * Fails closed: an unknown path, a missing quality, or any unmet bar is WATCH.
 */

export const OWNER_OPENING_CLASS_VERSION = "OWNER_OPENING_CLASS_V1" as const;

/**
 * The late-phase bar, as a named constant.
 *
 * This is the value `decideDeliveryBatch` has always used inline. It is exported here so
 * the classifier and the delivery decision cannot drift to two different numbers — the
 * classifier's whole claim is that it checks the SAME bars, which is only true while the
 * bars are literally the same value. NOT a new threshold and NOT a tunable.
 */
export const LATE_PHASE_FRACTION_MOVE = 0.75;

/** Which owner path produced the opening. Determines which bars must be checked here. */
export type OwnerOpeningPath =
  /**
   * `maybeSendReadinessGatedOwnerOpening`. Structurally DOWNSTREAM of every bar below:
   * the candidate cannot reach it without having passed them. They are re-asserted anyway
   * so the record states what was true rather than what the call site implies.
   */
  | "readiness_gate"
  /**
   * `maybeSendBearishOwnerReview`. Structurally UPSTREAM of the research floor, the
   * late-phase bar, the quality bar, correlation and ranking, so every one of them must
   * be evaluated explicitly here or a below-floor candidate would be called actionable.
   */
  | "bearish_authority";

export type OwnerOpeningClass = "ACTIONABLE" | "WATCH";

export interface OwnerOpeningGate {
  name: string;
  passed: boolean;
  detail: string;
}

export interface OwnerOpeningClassification {
  version: typeof OWNER_OPENING_CLASS_VERSION;
  path: OwnerOpeningPath;
  openingClass: OwnerOpeningClass;
  /** True exactly when `openingClass === "WATCH"` — the value the suppression flag reads. */
  researchObservation: boolean;
  reason: string;
  /** Every bar checked and its verdict. Reported so a WATCH verdict is arguable. */
  gates: OwnerOpeningGate[];
  /**
   * Whether the PORTFOLIO-level checks — correlation withholding, per-flush ranking, and
   * the entry-quality gate — had already run when this opening was classified.
   *
   * True on the readiness-gated path, which sits downstream of all three. FALSE on the
   * bearish path, which fires before them, so an ACTIONABLE bearish opening is a statement
   * about the CANDIDATE, not about the portfolio: the owner may receive two openings in one
   * correlated cluster where a subscriber would have received one. That is the pre-existing
   * shape of the bearish owner review and this session does not move its call site —
   * moving it would change which candidates get an owner review at all. Stated here so
   * nothing downstream has to infer it.
   */
  portfolioGatesEvaluated: boolean;
}

export interface OwnerOpeningClassInput {
  path: OwnerOpeningPath;
  /** The delivery quality this candidate scored, 0..1. */
  quality: number | null | undefined;
  /** The subscriber deliver bar in force for this batch (includes the opening bump). */
  deliverBar: number | null | undefined;
  /** The candidate's own research-only flag. */
  researchOnly: boolean;
  /** Share of the expected move already spent. Null when it could not be measured. */
  fractionMove: number | null | undefined;
  /** The research floor in force for this batch. */
  researchFloor?: number | null;
  /** The bearish authority state, on the bearish path only. */
  bearishState?: string | null;
}

const finite = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(Number(v)) ? null : Number(v);

/**
 * Classify one owner opening.
 *
 * The bars are evaluated for BOTH paths and reported for both. Only the verdict differs:
 * the readiness-gated path cannot be reached with a bar unmet, so a failure there is a
 * contradiction worth surfacing rather than a reclassification — it still yields WATCH,
 * because an opening that cannot prove it cleared the bars is not an actionable callout.
 */
export function classifyOwnerOpening(input: OwnerOpeningClassInput): OwnerOpeningClassification {
  const quality = finite(input.quality);
  const deliverBar = finite(input.deliverBar);
  const researchFloor = finite(input.researchFloor);
  const fractionMove = finite(input.fractionMove);

  const gates: OwnerOpeningGate[] = [];

  const notResearchOnly = input.researchOnly !== true;
  gates.push({
    name: "not_research_only",
    passed: notResearchOnly,
    detail: notResearchOnly ? "candidate is not research-only" : "candidate is flagged research_only",
  });

  const qualityKnown = quality != null && deliverBar != null;
  const overDeliverBar = qualityKnown && (quality as number) >= (deliverBar as number);
  gates.push({
    name: "subscriber_quality_bar",
    passed: overDeliverBar,
    detail: qualityKnown
      ? `quality ${quality} ${overDeliverBar ? ">=" : "<"} deliver bar ${deliverBar}`
      : "quality or deliver bar unavailable",
  });

  // Reported for completeness. The deliver bar sits above the research floor in every
  // configuration, so this can only fail when the deliver bar itself is unavailable —
  // in which case the bar above has already refused.
  const overResearchFloor = researchFloor == null
    ? overDeliverBar
    : quality != null && quality >= researchFloor;
  gates.push({
    name: "research_floor",
    passed: overResearchFloor,
    detail: researchFloor == null
      ? "research floor not supplied; subsumed by the deliver bar"
      : `quality ${quality} ${overResearchFloor ? ">=" : "<"} research floor ${researchFloor}`,
  });

  const notLatePhase = fractionMove == null || fractionMove < LATE_PHASE_FRACTION_MOVE;
  gates.push({
    name: "late_phase_fraction_move",
    passed: notLatePhase,
    detail: fractionMove == null
      ? "fraction of expected move not measured"
      : `fraction move ${fractionMove} ${notLatePhase ? "<" : ">="} ${LATE_PHASE_FRACTION_MOVE}`,
  });

  if (input.path === "bearish_authority") {
    const ready = String(input.bearishState ?? "").trim().toUpperCase() === "BEARISH_READY";
    gates.push({
      name: "bearish_authority_state",
      passed: ready,
      detail: ready
        ? "BEARISH_READY — qualified, withheld from subscribers by authorization only"
        : `bearish state ${input.bearishState ?? "UNKNOWN"} is not BEARISH_READY`,
    });
  }

  const portfolioGatesEvaluated = input.path === "readiness_gate";
  const failed = gates.filter((g) => !g.passed);
  if (failed.length === 0) {
    return {
      version: OWNER_OPENING_CLASS_VERSION,
      path: input.path,
      openingClass: "ACTIONABLE",
      researchObservation: false,
      reason: portfolioGatesEvaluated
        ? "cleared every subscriber delivery bar including correlation, ranking and entry quality; "
          + "withheld from subscribers by the readiness gate only"
        : "cleared every subscriber CANDIDATE bar (quality, research floor, late phase); "
          + "portfolio correlation/ranking/entry-quality not yet evaluated at this point in the "
          + "pipeline; withheld from subscribers by bearish authorization only",
      gates,
      portfolioGatesEvaluated,
    };
  }

  return {
    version: OWNER_OPENING_CLASS_VERSION,
    path: input.path,
    openingClass: "WATCH",
    researchObservation: true,
    reason: `research observation: ${failed.map((g) => g.name).join(", ")}`,
    gates,
    portfolioGatesEvaluated,
  };
}
