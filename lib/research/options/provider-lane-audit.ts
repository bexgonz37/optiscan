/**
 * provider-lane-audit.ts — Phase D. WHO IS ACTUALLY SPENDING THE MINUTE, AND WHO COULD WAIT.
 *
 * Gate B7 already partitions the minute cap between consumers, and it works: at
 * a 280/min cap `options_discovery` holds a guaranteed ~28. So the MRNA failure
 * — bullish CALL, score 1.0, research_only 0, killed by
 * PROVIDER_QUOTA_EXCEEDED — was NOT a lane being starved by other lanes. It was
 * a high-value request arriving at a lane whose own 28 had already been spent on
 * lower-value work, in arrival order, because inside a lane there was no order
 * at all.
 *
 * That distinction decides what Phase D may and may not do:
 *
 *   · the CROSS-LANE problem is already solved, so this module raises no cap,
 *     moves no reserve, and changes no cadence. It reports.
 *   · the INTRA-LANE problem is real, and it belongs to `chain-admission.ts`,
 *     which orders the lane's own spend. This module supplies the number that
 *     admission has capacity for.
 *
 * ── WHY THIS IS AN AUDIT AND NOT A SCHEDULER ────────────────────────────────
 *
 * The tempting move is to make `options_paper_mark` and `asymmetry_mark` yield
 * to discovery when the minute is hot. Both hold reserves precisely because they
 * were starved before — `asymmetry_mark` finished 2026-08-03 on a 0.28%
 * admission rate — and both produce the MFE/MAE evidence every later claim about
 * the product is graded on. A mark deferred is not a mark delayed: the horizon
 * it was owed passes, and the observation is gone for good.
 *
 * So the yield classification below is DESCRIPTIVE. It says which lanes could in
 * principle wait and what it would cost; it does not make them wait. Turning a
 * description into a scheduler is a separate, owner-authorized change, and it
 * needs forward evidence that discovery is genuinely short of capacity — which
 * is exactly what `highPriorityDeferred` in the admission result measures.
 *
 * PURE. No clock, no I/O, no env mutation. It reads a snapshot it is handed.
 */
import {
  PROVIDER_CONSUMERS, providerCategoryFor,
  type ProviderConsumer, type ProviderCategory,
} from "../../provider-context.ts";
import { minuteReserveFor, sharedMinutePool } from "../../provider-budget.ts";

/**
 * How a lane relates to the live opportunity it is competing with.
 *
 * `EVIDENCE` is deliberately its own class rather than a flavour of deferrable.
 * Evidence lanes look deferrable — they are periodic, they are not the product,
 * nobody is waiting on them — and they are the one thing that must never be
 * dropped, because a missing mark cannot be backfilled from a market that has
 * already moved.
 */
export type LaneClass =
  /** The live product path. Never yields. */
  | "LIVE_CRITICAL"
  /** Produces point-in-time observations that cannot be recovered later. */
  | "EVIDENCE"
  /** Useful, but the same answer is available a minute later. */
  | "DEFERRABLE"
  /** Operator/diagnostic traffic. Yields first. */
  | "DIAGNOSTIC";

const LANE_CLASS: Readonly<Record<ProviderConsumer, LaneClass>> = Object.freeze({
  scanner: "LIVE_CRITICAL",
  alert_capture: "LIVE_CRITICAL",
  options_discovery: "LIVE_CRITICAL",
  options_paper_mark: "EVIDENCE",
  asymmetry_mark: "EVIDENCE",
  options_shadow_mark: "EVIDENCE",
  asymmetry_discovery: "DEFERRABLE",
  zero_dte_context: "DEFERRABLE",
  swing_scan: "DEFERRABLE",
  watchlist: "DEFERRABLE",
  premarket: "DEFERRABLE",
  historical_research: "DEFERRABLE",
  enrichment: "DEFERRABLE",
  seed_worker: "DEFERRABLE",
  diagnostics: "DIAGNOSTIC",
  dashboard_api: "DIAGNOSTIC",
  unattributed: "DIAGNOSTIC",
});

export function laneClassOf(consumer: ProviderConsumer): LaneClass {
  return LANE_CLASS[consumer] ?? "DIAGNOSTIC";
}

/**
 * Whether a lane could yield without losing an observation.
 *
 * EVIDENCE lanes answer false. That is the finding, not an oversight: the two
 * biggest measured consumers after discovery are both mark lanes, so the honest
 * conclusion of this audit is that the largest deferrable pool is smaller than
 * it looks.
 */
export function couldYield(consumer: ProviderConsumer): boolean {
  const c = laneClassOf(consumer);
  return c === "DEFERRABLE" || c === "DIAGNOSTIC";
}

export interface LaneAuditRow {
  consumer: ProviderConsumer;
  category: ProviderCategory;
  laneClass: LaneClass;
  /** Guaranteed requests per minute. Nothing another lane does can take these. */
  reservedPerMinute: number;
  /** Requests observed this minute, where the caller supplied counters. */
  observedThisMinute: number | null;
  couldYield: boolean;
  /** What deferring this lane would cost, in words. Empty when it may yield freely. */
  yieldCost: string;
}

export interface ProviderLaneAudit {
  minuteCap: number;
  totalReserved: number;
  sharedPool: number;
  lanes: LaneAuditRow[];
  /** Requests per minute held by lanes that could yield without losing evidence. */
  yieldableReserved: number;
  /** Requests per minute held by lanes that must not yield. */
  protectedReserved: number;
  /** What the live options lane is guaranteed right now. */
  optionsDiscoveryReserved: number;
  /** Plain statement of what this audit concluded, for a report. */
  conclusion: string;
}

const YIELD_COST: Readonly<Partial<Record<LaneClass, string>>> = Object.freeze({
  LIVE_CRITICAL: "this IS the live product path — deferring it defers the opportunity itself",
  EVIDENCE: "the horizon passes while it waits; a missed mark cannot be backfilled from a market that moved",
});

/**
 * Classify every lane against the partition it actually holds.
 *
 * `observed` is optional. Where it is absent the row reports null rather than
 * zero, because "no counter was supplied" and "this lane spent nothing" are
 * different claims and the second one would quietly justify taking its reserve.
 */
export function auditProviderLanes(
  minuteCap: number,
  observed: ReadonlyMap<ProviderConsumer, number> | null = null,
  env: NodeJS.ProcessEnv = process.env,
): ProviderLaneAudit {
  const cap = Number.isFinite(minuteCap) && minuteCap > 0 ? Math.floor(minuteCap) : 0;

  const lanes: LaneAuditRow[] = PROVIDER_CONSUMERS.map((consumer) => {
    const laneClass = laneClassOf(consumer);
    const reservedPerMinute = cap > 0 ? minuteReserveFor(consumer, env, cap) : 0;
    return {
      consumer,
      category: providerCategoryFor(consumer),
      laneClass,
      reservedPerMinute,
      observedThisMinute: observed?.get(consumer) ?? null,
      couldYield: couldYield(consumer),
      yieldCost: YIELD_COST[laneClass] ?? "",
    };
  });

  let yieldableReserved = 0, protectedReserved = 0;
  for (const l of lanes) {
    if (l.couldYield) yieldableReserved += l.reservedPerMinute;
    else protectedReserved += l.reservedPerMinute;
  }

  const optionsDiscoveryReserved = cap > 0 ? minuteReserveFor("options_discovery", env, cap) : 0;

  return {
    minuteCap: cap,
    totalReserved: yieldableReserved + protectedReserved,
    sharedPool: cap > 0 ? sharedMinutePool(cap, env) : 0,
    lanes,
    yieldableReserved,
    protectedReserved,
    optionsDiscoveryReserved,
    conclusion: yieldableReserved === 0
      ? `every reserved request belongs to a live or evidence lane; the ${optionsDiscoveryReserved}/min `
        + "options lane cannot be enlarged by deferral, only spent in a better order"
      : `${yieldableReserved}/min sits in lanes that could yield, against ${protectedReserved}/min that must not; `
        + `the options lane holds ${optionsDiscoveryReserved}/min guaranteed`,
  };
}

/* ---------------------------------------------------------------------------
 * THE INTRA-LANE RESERVE
 * -------------------------------------------------------------------------*/

/**
 * Share of the options lane's chain capacity that only ACTIONABLE work may use.
 *
 * The Tier-0 pattern, one level down. Tier 0 gets a reserved bucket so broad
 * work cannot starve SPY/QQQ/IWM; this gives subscriber-reachable candidates a
 * reserved slice so research-only work cannot starve them. Same mechanism, same
 * justification, applied to the axis that actually failed.
 *
 * Deliberately a MINORITY share. A majority reserve would invert the problem —
 * research-only work would starve on a quiet day when nothing is actionable,
 * and the exploration that keeps the tail measurable would stop.
 */
export const DEFAULT_ACTIONABLE_CHAIN_RESERVE_FRACTION = 0.4;

export interface ChainCapacitySplit {
  /** Total chain requests the cycle may spend. */
  total: number;
  /** Of those, the count only non-research-only tickets may occupy. */
  actionableReserved: number;
  /** The remainder, open to any ticket including research-only ones. */
  shared: number;
  explain: string;
}

/**
 * Split a chain budget into an actionable reserve plus a shared pool.
 *
 * RAISES NOTHING. `actionableReserved + shared === total` always, so this only
 * decides who may occupy the capacity that already exists. A reserve is never
 * larger than the total, and a total of zero splits into zero and zero rather
 * than manufacturing a floor.
 */
export function splitChainCapacity(
  total: number,
  fraction: number = DEFAULT_ACTIONABLE_CHAIN_RESERVE_FRACTION,
): ChainCapacitySplit {
  const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const actionableReserved = Math.min(t, Math.floor(t * f));
  return {
    total: t,
    actionableReserved,
    shared: t - actionableReserved,
    explain: t === 0
      ? "no chain capacity this cycle"
      : `${t} chain requests — ${actionableReserved} reserved for actionable candidates, ${t - actionableReserved} shared`,
  };
}

export function actionableReserveFraction(env: NodeJS.ProcessEnv = process.env): number {
  const x = Number(env.OPTIONS_ACTIONABLE_CHAIN_RESERVE_FRACTION);
  return Number.isFinite(x) && x >= 0 && x <= 1 ? x : DEFAULT_ACTIONABLE_CHAIN_RESERVE_FRACTION;
}
