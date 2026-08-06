/**
 * outcome-delivery-lane.ts — WHICH delivery lane a content draft belongs to, and
 * WHAT counts as the same closed outcome.
 *
 * ## The defect this exists to fix
 *
 * On 2026-08-05 the private Recaps channel received a steady drip of historical
 * report cards — `WHY_THIS_FAILED · AAPL`, `CLOSED_LOSER · NVDA`, and so on —
 * one every few minutes, all evening. Measured in production at `cb1fc98`:
 *
 *   - 449 undelivered drafts across 148 content events
 *   - the recovery sweep drains ONE event per scan → 148 further messages queued
 *   - 63 canonical outcomes produced 265 delivered drafts
 *
 * Three separate multipliers turn one closed trade into many messages:
 *
 * 1. **Two close events per closure.** `EXIT_HIT` and `OPPORTUNITY_CLOSED` both
 *    map to `CLOSED_LOSER` in `eligibleCategories`, so one closure emits two
 *    content events. Verified on `oc_4pu17q` (IWM): events `ce_1tv6vou` and
 *    `ce_1a16wby`, both CLOSED_LOSER, same case.
 * 2. **A third event for the same closure.** `OPPORTUNITY_REPORT_CARD_READY`
 *    adds `WHY_THIS_FAILED`. Observed as a second Discord message ~6 minutes
 *    after the first, e.g. `oc_kmzobp` (NVDA) at 02:38:30Z then 02:44:48Z.
 * 3. **Three copy variants per event.** Historically each variant was its own
 *    Discord message — `oc_4pu17q` holds nine drafts carrying nine consecutive
 *    message snowflakes.
 *
 * None of these is a distinct event worth an owner interrupt. They are one
 * closure described three ways, times three phrasings.
 *
 * ## What this module decides
 *
 * The LANE answers "may this be delivered individually, right now?" — and it is
 * derived from the age of the underlying event, never from the draft's own row,
 * because a draft written today about a trade that closed five days ago is
 * historical no matter when the row appeared.
 *
 * The FINGERPRINT answers "have we already told the owner about this closure?"
 *
 * Neither ever deletes or rewrites a draft. Everything stays queryable in the
 * app; the lane only governs Discord.
 */

export type ContentDeliveryLane =
  /** Fresh enough to be worth an interrupt. Delivered individually. */
  | "LIVE_CURRENT"
  /** Recent, recoverable, still individually useful — but it yields to live. */
  | "RECENT_RECOVERY"
  /** Old. Rolls up into one bounded digest instead of N messages. */
  | "HISTORICAL_DIGEST"
  /** Too old to summarise. Stays in the app and stays searchable. */
  | "ARCHIVE_ONLY";

export interface LaneWindows {
  liveMs: number;
  recentMs: number;
  archiveAfterMs: number;
}

const DEFAULT_WINDOWS: LaneWindows = {
  liveMs: 15 * 60_000,
  recentMs: 24 * 60 * 60_000,
  archiveAfterMs: 30 * 24 * 60 * 60_000,
};

function positive(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function laneWindows(env: NodeJS.ProcessEnv = process.env): LaneWindows {
  const live = positive(env.CONTENT_LANE_LIVE_MS, DEFAULT_WINDOWS.liveMs);
  const recent = positive(env.CONTENT_LANE_RECENT_MS, DEFAULT_WINDOWS.recentMs);
  const archive = positive(env.CONTENT_LANE_ARCHIVE_AFTER_MS, DEFAULT_WINDOWS.archiveAfterMs);
  // Windows must nest. A misconfiguration that put `recent` inside `live` would
  // silently promote day-old backlog to live, which is the exact failure this
  // module exists to prevent — so the ordering is enforced, not trusted.
  const recentOk = Math.max(recent, live);
  return { liveMs: live, recentMs: recentOk, archiveAfterMs: Math.max(archive, recentOk) };
}

export interface LaneDecision {
  lane: ContentDeliveryLane;
  /** May this draft become its own Discord message? */
  individualDeliveryAllowed: boolean;
  ageMs: number | null;
  reason: string;
}

/**
 * Classify one draft's delivery lane from the age of the event it describes.
 *
 * A missing or future timestamp is NOT treated as live. Freshness that cannot be
 * proven is not freshness: an unprovable age routes to the digest, where the
 * content is still surfaced but cannot claim currency or spend an interrupt.
 */
export function classifyDeliveryLane(input: {
  eventOccurredAtMs: number | null;
  nowMs: number;
  env?: NodeJS.ProcessEnv;
}): LaneDecision {
  const w = laneWindows(input.env ?? process.env);
  const t = input.eventOccurredAtMs;
  if (t == null || !Number.isFinite(t)) {
    return {
      lane: "HISTORICAL_DIGEST",
      individualDeliveryAllowed: false,
      ageMs: null,
      reason: "event has no usable timestamp, so its freshness cannot be proven",
    };
  }
  const ageMs = input.nowMs - Number(t);
  if (ageMs < 0) {
    return {
      lane: "HISTORICAL_DIGEST",
      individualDeliveryAllowed: false,
      ageMs,
      reason: "event timestamp is in the future, so it cannot be treated as current",
    };
  }
  if (ageMs <= w.liveMs) {
    return { lane: "LIVE_CURRENT", individualDeliveryAllowed: true, ageMs, reason: "event is inside the live delivery window" };
  }
  if (ageMs <= w.recentMs) {
    return { lane: "RECENT_RECOVERY", individualDeliveryAllowed: true, ageMs, reason: "event is recent and individually recoverable" };
  }
  if (ageMs <= w.archiveAfterMs) {
    return { lane: "HISTORICAL_DIGEST", individualDeliveryAllowed: false, ageMs, reason: "event is historical and belongs in a bounded digest" };
  }
  return { lane: "ARCHIVE_ONLY", individualDeliveryAllowed: false, ageMs, reason: "event is older than the digest window and stays in the app archive" };
}

/**
 * Categories that all report the SAME closure. Whichever arrives first is the
 * owner's one report card for that outcome; the rest are alternate descriptions
 * of an event already reported.
 *
 * `RETURN_MILESTONE` and `NEW_HIGH` are deliberately NOT here — they describe
 * distinct moments in a position's life, not the closure, and collapsing them
 * would hide genuinely new information.
 */
export const OUTCOME_REPORT_CATEGORIES: ReadonlySet<string> = new Set([
  "CLOSED_WINNER",
  "CLOSED_LOSER",
  "WHY_THIS_WORKED",
  "WHY_THIS_FAILED",
]);

export function isOutcomeReportCategory(category: string): boolean {
  return OUTCOME_REPORT_CATEGORIES.has(String(category));
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * The evidence-aware identity of one closed outcome.
 *
 * Keyed on the canonical case plus the exact contract, so two different
 * contracts on the same underlying stay distinct, and a re-render of the same
 * closure under a new template version does not become a new outcome.
 *
 * `contentVersion` is included so a deliberate content revision CAN be delivered
 * again; it is not defaulted from the draft's template family, because three
 * phrasings of one closure must collapse, not multiply.
 */
export function outcomeFingerprint(input: {
  canonicalOutcomeId: string | null;
  opportunityId?: string | null;
  occ?: string | null;
  lifecycleCloseEventId?: string | null;
  resultType?: string | null;
  contentVersion?: string | null;
}): string {
  const key = [
    input.canonicalOutcomeId ?? "",
    input.opportunityId ?? "",
    input.occ ?? "",
    input.lifecycleCloseEventId ?? "",
    input.resultType ?? "",
    input.contentVersion ?? "v1",
  ].join("|");
  return `oco_${djb2(key)}`;
}
