/**
 * trigger-lifecycle.ts — PURE. What happens when a Watchlist level actually trades.
 *
 * A TRIGGER IS NOT TRADE READY. A Watchlist row firing means one thing only: the
 * price level we published has traded. Before anything can reach a subscriber it
 * must still be revalidated against the live market and then pass through the
 * EXISTING canonical options SEND path with every one of its gates intact.
 *
 * This module therefore never sends, never selects a contract, and never touches
 * scanner, authority, delivery, or paper state. It decides one thing: whether a
 * triggered row has satisfied the revalidation checklist and may be OFFERED to
 * the canonical path. The canonical path remains free to reject it, and its
 * rejection is final.
 */
import type { WatchlistRow } from "./professional-plan.ts";

export type TriggerSide = "CALL" | "PUT";

export interface TriggerObservation {
  symbol: string;
  side: TriggerSide;
  /** Underlying print that crossed the published level. */
  price: number;
  observedAtMs: number;
  /** True only when the observation came from the live regular session. */
  inRegularSession: boolean;
}

export type RevalidationCheck =
  | "TRIGGER_LEVEL_CROSSED"
  | "IN_REGULAR_SESSION"
  | "EXACT_CONTRACT_REVALIDATED"
  | "FRESH_BID_ASK"
  | "SPREAD_ACCEPTABLE"
  | "LIQUIDITY_ACCEPTABLE"
  | "MARKET_CONTEXT_AVAILABLE";

export const REVALIDATION_CHECKS: RevalidationCheck[] = [
  "TRIGGER_LEVEL_CROSSED",
  "IN_REGULAR_SESSION",
  "EXACT_CONTRACT_REVALIDATED",
  "FRESH_BID_ASK",
  "SPREAD_ACCEPTABLE",
  "LIQUIDITY_ACCEPTABLE",
  "MARKET_CONTEXT_AVAILABLE",
];

/** Live evidence gathered AFTER the trigger, at revalidation time. */
export interface RevalidationEvidence {
  /** Exact OCC symbol chosen against the live chain. Never chosen overnight. */
  optionSymbol: string | null;
  bid: number | null;
  ask: number | null;
  /** Age of the quote at revalidation time, in ms. */
  quoteAgeMs: number | null;
  openInterest: number | null;
  contractVolume: number | null;
  /** Broad-market context available and directional. */
  marketContextAvailable: boolean;
  revalidatedAtMs: number;
}

export interface TriggerLifecycleResult {
  symbol: string;
  side: TriggerSide;
  /** The row triggered — this alone is never permission to send. */
  triggered: boolean;
  /** Every check that passed. */
  passed: RevalidationCheck[];
  /** Every check that failed, with a plain reason. */
  failed: Array<{ check: RevalidationCheck; reason: string }>;
  /**
   * True only when EVERY check passed. Even then this is an OFFER to the
   * canonical live alert path, never an approval to deliver.
   */
  eligibleForCanonicalPath: boolean;
  /** Always true. The canonical path owns the send decision, not this module. */
  requiresCanonicalDelivery: true;
  tradeReady: false;
  optionSymbol: string | null;
}

const MAX_QUOTE_AGE_MS = 60_000;
const MAX_SPREAD_PCT = 15;
const MIN_OPEN_INTEREST = 250;
const MIN_CONTRACT_VOLUME = 25;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Did the observation actually cross the published level?
 * CALL rows require a print at or above the CALL level; PUT rows at or below the
 * PUT level. A row with no trigger on that side can never fire on that side.
 */
export function crossedPublishedLevel(row: WatchlistRow, observation: TriggerObservation): boolean {
  if (row.symbol !== observation.symbol) return false;
  if (!isNum(observation.price) || observation.price <= 0) return false;
  if (observation.side === "CALL") {
    return !!row.callAbove && observation.price >= row.callAbove.price;
  }
  return !!row.putBelow && observation.price <= row.putBelow.price;
}

/**
 * Evaluate a triggered row against the revalidation checklist.
 *
 * Failing ANY check leaves `eligibleForCanonicalPath` false. Passing every check
 * still leaves `tradeReady` false — the canonical options SEND path, its
 * bearish-gate authority, its deduplication, its frozen entry/stop/target
 * behaviour, and its paper linkage all still apply, unchanged.
 */
export function evaluateTriggerLifecycle(
  row: WatchlistRow,
  observation: TriggerObservation,
  evidence: RevalidationEvidence | null,
): TriggerLifecycleResult {
  const passed: RevalidationCheck[] = [];
  const failed: TriggerLifecycleResult["failed"] = [];
  const record = (check: RevalidationCheck, ok: boolean, reason: string) => {
    if (ok) passed.push(check);
    else failed.push({ check, reason });
  };

  const triggered = crossedPublishedLevel(row, observation);
  record("TRIGGER_LEVEL_CROSSED", triggered, "Published trigger level has not traded");
  record("IN_REGULAR_SESSION", observation.inRegularSession === true, "Observation is not from the live regular session");

  const optionSymbol = evidence?.optionSymbol && String(evidence.optionSymbol).trim()
    ? String(evidence.optionSymbol).trim().toUpperCase()
    : null;
  record("EXACT_CONTRACT_REVALIDATED", optionSymbol != null, "No exact option contract revalidated against the live chain");

  const bid = isNum(evidence?.bid) ? (evidence!.bid as number) : null;
  const ask = isNum(evidence?.ask) ? (evidence!.ask as number) : null;
  const age = isNum(evidence?.quoteAgeMs) ? (evidence!.quoteAgeMs as number) : null;
  const freshTwoSided = bid != null && ask != null && bid > 0 && ask >= bid
    && age != null && age >= 0 && age <= MAX_QUOTE_AGE_MS;
  record("FRESH_BID_ASK", freshTwoSided, "No fresh two-sided quote within the freshness bound");

  const mid = freshTwoSided ? (bid! + ask!) / 2 : null;
  const spreadPct = mid && mid > 0 ? ((ask! - bid!) / mid) * 100 : null;
  record("SPREAD_ACCEPTABLE", spreadPct != null && spreadPct <= MAX_SPREAD_PCT,
    spreadPct == null ? "Spread not measurable without a fresh two-sided quote" : `Spread ${spreadPct.toFixed(1)}% wider than ${MAX_SPREAD_PCT}%`);

  const oi = isNum(evidence?.openInterest) ? (evidence!.openInterest as number) : null;
  const vol = isNum(evidence?.contractVolume) ? (evidence!.contractVolume as number) : null;
  record("LIQUIDITY_ACCEPTABLE", oi != null && vol != null && oi >= MIN_OPEN_INTEREST && vol >= MIN_CONTRACT_VOLUME,
    "Contract liquidity is below the revalidation floor");

  record("MARKET_CONTEXT_AVAILABLE", evidence?.marketContextAvailable === true, "Broad-market context is unavailable");

  return {
    symbol: row.symbol,
    side: observation.side,
    triggered,
    passed,
    failed,
    eligibleForCanonicalPath: failed.length === 0,
    requiresCanonicalDelivery: true,
    tradeReady: false,
    optionSymbol,
  };
}

/**
 * Structural guarantee, asserted by test: a Watchlist trigger can never itself
 * deliver. The canonical path is the only sender, and it is unchanged by this
 * module. The returned handoff carries no delivery authority of any kind.
 */
export function buildCanonicalHandoff(result: TriggerLifecycleResult): {
  offer: boolean;
  symbol: string;
  side: TriggerSide;
  optionSymbol: string | null;
  note: string;
} {
  return {
    offer: result.eligibleForCanonicalPath,
    symbol: result.symbol,
    side: result.side,
    optionSymbol: result.eligibleForCanonicalPath ? result.optionSymbol : null,
    note: "Offered to the existing canonical options SEND path. All delivery, authority, deduplication, and paper-linkage gates still apply and may reject it.",
  };
}
