/**
 * Session range position — the metric that has been called "earliness" and is not.
 *
 * What it computes, exactly:
 *
 *     fraction = (price − sessionLow) / (sessionHigh − sessionLow)
 *
 * That is where the current price sits inside the range the session has printed SO
 * FAR. It is a sound, pre-entry-safe number: `hod`/`lod` are session-to-date and known
 * at decision time, so there is no hindsight in the live path.
 *
 * It is not earliness, for four reasons:
 *
 *   1. DIRECTION-BLIND. For a PUT, a low fraction means the downside move has largely
 *      already happened — the worst possible moment — and it was labelled "early".
 *   2. UNSTABLE. The denominator grows through the day, so the same price re-buckets
 *      as the range widens, and near the open the range is barely formed.
 *   3. NO LIFECYCLE. It cannot tell "has not moved yet" from "round-tripped back to
 *      the low". Both sit at fraction ≈ 0 and both were labelled "early".
 *   4. NO REWARD REMAINING. It says nothing about expected total move size, so it
 *      cannot distinguish a move that is 10% done from one that is 90% done.
 *
 * BEFORE_RUN / EARLY_IN_RUN / LATE / TOO_LATE are statements about a move's lifecycle.
 * This is a range-position ratio and cannot express them. See `pre-move-discovery.ts`
 * for the direction-aware metric that can.
 *
 * The stored values are UNCHANGED. `options_candidates.earliness_phase` keeps its
 * column, its "early"/"during"/"late" buckets and every historical row exactly as
 * written — silently redefining old rows would make the record less trustworthy, not
 * more. What changes is the NAME this is reported under, so no reader mistakes a
 * range-position ratio for a claim about how early OptiScan found something.
 */

/** The three buckets, unchanged. Stored verbatim in `earliness_phase`. */
export type SessionRangePositionPhase = "early" | "during" | "late";

/**
 * Legacy thresholds, preserved exactly. `<= 0.4` is the bottom of today's range,
 * `>= 0.75` is the top. Changing them would redefine the meaning of stored rows.
 */
export const RANGE_POSITION_LOW = 0.4;
export const RANGE_POSITION_HIGH = 0.75;

/** Position of `price` within the session range so far. Null when the range is degenerate. */
export function sessionRangeFraction(
  price: number | null | undefined,
  sessionHigh: number | null | undefined,
  sessionLow: number | null | undefined,
): number | null {
  if (price == null || sessionHigh == null || sessionLow == null) return null;
  if (!Number.isFinite(price) || !Number.isFinite(sessionHigh) || !Number.isFinite(sessionLow)) return null;
  if (!(sessionHigh > sessionLow)) return null;
  return +(((price - sessionLow) / (sessionHigh - sessionLow)).toFixed(3));
}

/** Bucket a range fraction. Identical behaviour to the inline expression it replaces. */
export function classifySessionRangePosition(fraction: number | null): SessionRangePositionPhase | null {
  if (fraction == null || !Number.isFinite(fraction)) return null;
  if (fraction >= RANGE_POSITION_HIGH) return "late";
  if (fraction <= RANGE_POSITION_LOW) return "early";
  return "during";
}

/**
 * How this metric must be described wherever it is reported.
 *
 * Carried with the data rather than left to a prompt or a dashboard label: a caption
 * is edited far more often than a data contract, and a number named "early" will be
 * read as earliness by anyone who does not happen to have the caption in front of
 * them.
 */
export const SESSION_RANGE_POSITION_SEMANTICS = {
  metric: "SESSION_RANGE_POSITION",
  unit: "contract-selection attempts",
  measures:
    "where price sat inside the session's range-so-far at the moment a candidate was evaluated",
  doesNotMeasure:
    "how early OptiScan found the opportunity, how much of the move remains, or whether the move had started",
  directionAware: false,
  warning:
    "Direction-blind. For a PUT a low fraction means the downside move has largely already "
    + "happened, and the legacy bucket name for that is \"early\". Do not use for subscriber "
    + "readiness or for learning about pre-move discovery.",
  supersededBy: "PRE_MOVE_DISCOVERY_V1",
} as const;
