/**
 * outcomes.ts — PURE outcome tracking for published Watchlist setups.
 *
 * Answers, per published setup: did it trigger, did it fail, did it never
 * trigger, was it invalidated, did it become a VERIFIED subscriber SEND, and did
 * it produce favourable movement.
 *
 * THE HARD BOUNDARY: a Watchlist outcome is research. It becomes a subscriber
 * performance result ONLY when there is a verified canonical SEND with exact-OCC
 * evidence. `promotableToSubscriberResult` is the single place that decides
 * that, and it fails closed on every missing piece.
 */
import type { WatchlistRow } from "./professional-plan.ts";

export type WatchlistOutcomeStatus =
  | "TRIGGERED"
  | "FAILED"
  | "NEVER_TRIGGERED"
  | "INVALIDATED";

/** Evidence that the canonical path actually delivered this setup. */
export interface CanonicalSendEvidence {
  /** Hard Discord proof — a real message id. */
  discordMessageId: string | null;
  /** Exact OCC contract symbol as delivered. */
  optionSymbol: string | null;
  /** Frozen entry recorded at SEND. */
  frozenEntry: number | null;
  /** Matching delivered-paper mirror row id. */
  paperMirrorId: string | null;
  sentAtMs: number | null;
}

/** Underlying movement observed after the trigger, from completed marks only. */
export interface PostTriggerMovement {
  /** Best favourable underlying excursion in percent, signed for the side. */
  favorableExcursionPct: number | null;
  /** Worst adverse underlying excursion in percent, signed for the side. */
  adverseExcursionPct: number | null;
  observedThroughMs: number | null;
}

export interface WatchlistOutcomeInput {
  row: Pick<WatchlistRow, "symbol" | "family" | "setupType" | "callAbove" | "putBelow" | "state">;
  tradingDay: string;
  /** Which side fired, if any. */
  triggeredSide: "CALL" | "PUT" | null;
  triggeredAtMs: number | null;
  /** True when the setup was invalidated before it could trigger. */
  invalidated: boolean;
  invalidationReason?: string | null;
  send?: CanonicalSendEvidence | null;
  movement?: PostTriggerMovement | null;
  /** True once the session in which the row could trigger has completed. */
  sessionComplete: boolean;
}

export interface WatchlistOutcome {
  symbol: string;
  family: string;
  setupType: string;
  tradingDay: string;
  status: WatchlistOutcomeStatus;
  triggeredSide: "CALL" | "PUT" | null;
  triggeredAtMs: number | null;
  /** Did the level trade AND move favourably afterwards? */
  favorableMovement: boolean | null;
  favorableExcursionPct: number | null;
  /** Verified subscriber SEND, exact-OCC backed. */
  becameVerifiedSend: boolean;
  /** Why a SEND was not counted as verified. Empty when it was. */
  sendVerificationGaps: string[];
  /** Always false for a research outcome that lacks a verified SEND. */
  countsAsSubscriberResult: boolean;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};

/**
 * The ONLY gate that promotes a Watchlist outcome to a subscriber performance
 * result. Fails closed: every missing piece is reported and the answer is false.
 */
export function promotableToSubscriberResult(
  send: CanonicalSendEvidence | null | undefined,
): { promotable: boolean; gaps: string[] } {
  const gaps: string[] = [];
  if (!send) return { promotable: false, gaps: ["No canonical SEND evidence"] };
  if (!str(send.discordMessageId)) gaps.push("No Discord message id");
  if (!str(send.optionSymbol)) gaps.push("No exact option contract");
  if (!isNum(send.frozenEntry) || send.frozenEntry <= 0) gaps.push("No frozen entry");
  if (!str(send.paperMirrorId)) gaps.push("No delivered-paper mirror");
  if (!isNum(send.sentAtMs) || send.sentAtMs <= 0) gaps.push("No SEND timestamp");
  return { promotable: gaps.length === 0, gaps };
}

export function buildWatchlistOutcome(input: WatchlistOutcomeInput): WatchlistOutcome {
  const { row } = input;
  const verification = promotableToSubscriberResult(input.send);

  let status: WatchlistOutcomeStatus;
  if (input.invalidated) status = "INVALIDATED";
  else if (input.triggeredSide && isNum(input.triggeredAtMs)) status = "TRIGGERED";
  else if (input.sessionComplete) status = "NEVER_TRIGGERED";
  else status = "NEVER_TRIGGERED";

  let favorableMovement: boolean | null = null;
  const fav = isNum(input.movement?.favorableExcursionPct) ? input.movement!.favorableExcursionPct! : null;
  const adv = isNum(input.movement?.adverseExcursionPct) ? input.movement!.adverseExcursionPct! : null;
  if (status === "TRIGGERED") {
    if (fav == null || adv == null) favorableMovement = null;
    else {
      favorableMovement = fav > Math.abs(adv);
      // A triggered setup whose adverse excursion dominated is a FAILED setup,
      // not merely an unfavourable one.
      if (!favorableMovement) status = "FAILED";
    }
  }

  return {
    symbol: row.symbol,
    family: row.family,
    setupType: row.setupType,
    tradingDay: input.tradingDay,
    status,
    triggeredSide: input.triggeredSide ?? null,
    triggeredAtMs: isNum(input.triggeredAtMs) ? input.triggeredAtMs : null,
    favorableMovement,
    favorableExcursionPct: fav,
    becameVerifiedSend: verification.promotable,
    sendVerificationGaps: verification.gaps,
    countsAsSubscriberResult: verification.promotable,
  };
}

export interface WatchlistOutcomeSummary {
  sample: number;
  triggered: number;
  failed: number;
  neverTriggered: number;
  invalidated: number;
  verifiedSends: number;
  favorableMovements: number;
  /** Share of published setups whose level actually traded. */
  triggerRatePct: number | null;
  /** Share of triggered setups that became a verified subscriber SEND. */
  conversionRatePct: number | null;
  /** Share of triggered setups that produced favourable movement. */
  outcomeRatePct: number | null;
  /** Per-setup-family breakdown. */
  byFamily: Array<{
    family: string;
    setupType: string;
    sample: number;
    triggered: number;
    favorable: number;
    triggerRatePct: number | null;
    outcomeRatePct: number | null;
  }>;
  /** CALL-trigger vs PUT-trigger performance. */
  bySide: Array<{
    side: "CALL" | "PUT";
    triggered: number;
    favorable: number;
    outcomeRatePct: number | null;
  }>;
  /**
   * Watchlist outcomes are research. This stays false unless every counted row
   * carries a verified canonical SEND with exact-OCC evidence.
   */
  isSubscriberPerformance: boolean;
  subscriberPerformanceNote: string;
}

function ratePct(num: number, den: number): number | null {
  if (den <= 0) return null;
  return Math.round((num / den) * 1000) / 10;
}

export function summarizeWatchlistOutcomes(outcomes: WatchlistOutcome[]): WatchlistOutcomeSummary {
  const sample = outcomes.length;
  const triggered = outcomes.filter((o) => o.status === "TRIGGERED" || o.status === "FAILED").length;
  const failed = outcomes.filter((o) => o.status === "FAILED").length;
  const neverTriggered = outcomes.filter((o) => o.status === "NEVER_TRIGGERED").length;
  const invalidated = outcomes.filter((o) => o.status === "INVALIDATED").length;
  const verifiedSends = outcomes.filter((o) => o.becameVerifiedSend).length;
  const favorableMovements = outcomes.filter((o) => o.favorableMovement === true).length;

  const familyKeys = [...new Set(outcomes.map((o) => o.family))].sort();
  const byFamily = familyKeys.map((family) => {
    const rows = outcomes.filter((o) => o.family === family);
    const t = rows.filter((o) => o.status === "TRIGGERED" || o.status === "FAILED").length;
    const f = rows.filter((o) => o.favorableMovement === true).length;
    return {
      family,
      setupType: rows[0]?.setupType ?? family,
      sample: rows.length,
      triggered: t,
      favorable: f,
      triggerRatePct: ratePct(t, rows.length),
      outcomeRatePct: ratePct(f, t),
    };
  });

  const bySide = (["CALL", "PUT"] as const).map((side) => {
    const rows = outcomes.filter((o) => o.triggeredSide === side);
    const t = rows.filter((o) => o.status === "TRIGGERED" || o.status === "FAILED").length;
    const f = rows.filter((o) => o.favorableMovement === true).length;
    return { side, triggered: t, favorable: f, outcomeRatePct: ratePct(f, t) };
  });

  // Every counted row must be a verified SEND before this may be called
  // subscriber performance. Zero rows is not a pass.
  const isSubscriberPerformance = sample > 0 && outcomes.every((o) => o.countsAsSubscriberResult);

  return {
    sample,
    triggered,
    failed,
    neverTriggered,
    invalidated,
    verifiedSends,
    favorableMovements,
    triggerRatePct: ratePct(triggered, sample),
    conversionRatePct: ratePct(verifiedSends, triggered),
    outcomeRatePct: ratePct(favorableMovements, triggered),
    byFamily,
    bySide,
    isSubscriberPerformance,
    subscriberPerformanceNote: isSubscriberPerformance
      ? "Every counted row carries a verified canonical SEND with exact-OCC evidence."
      : "Watchlist research outcomes. These are NOT subscriber performance results — a verified canonical SEND with exact-OCC evidence is required for that.",
  };
}
