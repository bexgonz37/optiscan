/**
 * `EXTREME_PREMARKET_DISCOVERY_V1` — a frozen, SHADOW-ONLY hypothesis about
 * COVERAGE, and an honest statement of the half of it that cannot yet be
 * measured.
 *
 * THE HYPOTHESIS
 *
 * Ranked whole-market discovery with no price ceiling surfaces genuine early
 * asymmetric opportunities that the curated + sub-$50 universe structurally
 * cannot see — rather than merely surfacing noisy, already-extended movers.
 *
 * WHY IT IS REGISTERED BEFORE IT CAN BE ANSWERED
 *
 * It was motivated by ONE example. MRNA on 2026-08-19 opened around +84%, ran
 * to +133%, and left no trace in the system, and its 120C went from $8.13 at
 * the first regular-hours mark to $31.95 — an attainable +293%. That is a
 * compelling story and exactly the kind that gets a threshold quietly widened
 * until it fits. Freezing the definition NOW is what stops the rule and its
 * evidence from moving together: `definitionHash()` covers the eligibility
 * behaviour AND the ranking's ordering behaviour, so retuning either changes
 * the hash and fails the guard. The remedy is V2, never an edit to V1.
 *
 * WHAT THIS MAY NEVER DO
 *
 * Promote a symbol into the live scanner, emit a callout, open a position,
 * change a gate, or reach Discord. `productionBehaviorChanged` is false by
 * construction. The discovery layer it describes only writes observation rows.
 *
 * THE HALF THAT CANNOT BE MEASURED YET — stated plainly rather than faked
 *
 * The interesting question is not "did we find a big mover" (we did, trivially)
 * but "was there still substantial reward left in an EXECUTABLE contract when
 * we found it". Answering that requires quoting options on newly discovered
 * symbols: first executable NBBO, strategy eligibility, selection strength, the
 * +10/+25/+50/+100/MFE ladder, and the too-late rate.
 *
 * Every one of those costs provider budget, and provider budget is the binding
 * constraint. On 2026-08-19 the session ran 22,260 quota blocks against 78,322
 * requests, and a lane holding no minute reserve — which any new research lane
 * would be — was served 393 requests against 1,647 refusals. Measuring the
 * executable half by adding a lane there would either starve an existing lane
 * or sample the market only in the minutes it happened to win a slot, which is
 * a biased sample wearing the costume of a measurement.
 *
 * So this experiment declares TWO measurement scopes, and the second is
 * explicitly not started. Recording an unmeasurable field as null forever is
 * honest; recording it as zero, or quietly measuring it on whatever the budget
 * allowed, is not.
 *
 * PURE. No I/O, no clock, no env.
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_MARKET_DISCOVERY,
  marketDiscoveryEligible,
  rankMarketMovers,
  type MarketQuote,
} from "../discovery/market-movers.ts";

export const EXPERIMENT_ID = "EXTREME_PREMARKET_DISCOVERY_V1" as const;
export const EXPERIMENT_VERSION = 1 as const;
/** Shadow means shadow. No code path may consult this to authorize, block or order anything. */
export const EXPERIMENT_MODE = "SHADOW_ONLY" as const;

/**
 * What this experiment is allowed to claim to have measured.
 *
 * COVERAGE is answerable from persisted rows at zero provider cost. EXECUTABLE
 * is not answerable under the current budget and is declared NOT_STARTED, with
 * the prerequisite named.
 */
export type MeasurementScope = "COVERAGE" | "EXECUTABLE";

export interface ScopeDeclaration {
  scope: MeasurementScope;
  started: boolean;
  /** The fields this scope may populate. Anything outside stays null. */
  measures: readonly string[];
  /** Why it is not started, when it is not. */
  blockedBy: string | null;
}

export const MEASUREMENT_SCOPES: readonly ScopeDeclaration[] = Object.freeze([
  Object.freeze({
    scope: "COVERAGE" as const,
    started: true,
    measures: Object.freeze([
      "symbolsDiscoveredBeyondOldUniverse",
      "firstIndependentObservationAtMs",
      "firstObservedSessionPhase",
      "movePctAtFirstObservation",
      "peakAbsMovePct",
      "direction",
      "admittedToOptiScanUniverse",
      "admissionLagMinutes",
    ]),
    blockedBy: null,
  }),
  Object.freeze({
    scope: "EXECUTABLE" as const,
    started: false,
    measures: Object.freeze([
      "firstExecutableNbboAtMs",
      "strategyEligible",
      "selectionStrength",
      "attainablePct10", "attainablePct25", "attainablePct50", "attainablePct100",
      "attainableMfePct",
      "tooLateRate",
      "neverConfirmedRate",
      "liquidityRejectionRate",
    ]),
    blockedBy:
      "Provider budget. Quoting options on newly discovered symbols requires a lane that holds "
      + "no minute reserve; on 2026-08-19 such a lane was served 393 requests against 1,647 "
      + "refusals. A sample drawn only from the minutes a starved lane happened to win is biased, "
      + "and a biased sample is worse than no sample because it looks like evidence. "
      + "PREREQUISITE: provider-budget headroom that does not come from starving an existing lane.",
  }),
]);

export function scopeFor(scope: MeasurementScope): ScopeDeclaration {
  return MEASUREMENT_SCOPES.find((s) => s.scope === scope) as ScopeDeclaration;
}

/** True when a field may legitimately carry a measured value today. */
export function isMeasurable(field: string): boolean {
  return MEASUREMENT_SCOPES.some((s) => s.started && s.measures.includes(field));
}

/**
 * Content hash of the DISCOVERY RULE'S BEHAVIOUR — both halves of it.
 *
 * Probing eligibility alone would let the ranking be retuned silently, and the
 * ranking is what decides whether a mover is reached at all. So the hash covers
 * eligibility verdicts across a price/volume/move sweep AND the resulting ORDER
 * of a fixed synthetic market. Moving the $1 floor, the $10M floor, the 10%
 * move floor, or any weight in the score changes at least one probe.
 */
export function definitionHash(): string {
  const h = createHash("sha256");
  h.update(`${EXPERIMENT_ID}:${EXPERIMENT_VERSION}:${EXPERIMENT_MODE}:`);

  // Half one — eligibility, including the absence of a price ceiling.
  const prices = [0.4, 0.99, 1, 3, 20, 49.99, 50, 50.01, 116, 250, 5000];
  const volumes = [0, 1_000, 500_000, 2_000_000, 50_000_000];
  const moves = [-133.4, -25, -10.01, -10, -9.9, 0, 9.9, 10, 25, 84, 264];
  for (const price of prices) {
    for (const volume of volumes) {
      for (const changePercent of moves) {
        const d = marketDiscoveryEligible({ symbol: "P", price, changePercent, volume });
        h.update(`${price}|${volume}|${changePercent}=>${d.eligible ? "Y" : "N"}:${d.rejections.join(",")};`);
      }
    }
  }

  // Half two — the ORDER. A fixed market, ranked with no prior snapshot, so the
  // result depends only on the scoring weights and the tie-break.
  const market: MarketQuote[] = [
    { symbol: "AAA", price: 147, changePercent: 133.4, volume: 91_865_992, bid: 146.9, ask: 147.1, dayHigh: 149.6, dayLow: 112, prevClose: 62.96 },
    { symbol: "BBB", price: 12.4, changePercent: 124.5, volume: 40_000_000, bid: 12.39, ask: 12.41 },
    { symbol: "CCC", price: 250, changePercent: 11, volume: 80_000_000 },
    { symbol: "DDD", price: 8, changePercent: 95, volume: 2_000_000 },
    { symbol: "EEE", price: 40, changePercent: -52, volume: 5_000_000 },
    { symbol: "FFF", price: 10, changePercent: 30, volume: 5_000_000, bid: 9, ask: 11 },
    { symbol: "GGG", price: 10, changePercent: 30, volume: 5_000_000 },
    { symbol: "HHH", price: 60, changePercent: 0.2, volume: 5_000_000 },
  ];
  for (const r of rankMarketMovers(market, new Map(), 1_787_000_000_000)) {
    h.update(`${r.rank}:${r.symbol}:${r.extreme ? "X" : "-"};`);
  }

  // The floors themselves, so a config default change is caught even if no probe crosses it.
  h.update(JSON.stringify(DEFAULT_MARKET_DISCOVERY));
  return h.digest("hex").slice(0, 32);
}

export interface DiscoveryShadowDecision {
  experimentId: typeof EXPERIMENT_ID;
  experimentVersion: typeof EXPERIMENT_VERSION;
  mode: typeof EXPERIMENT_MODE;
  /** False here forever. Nothing in this module changes what is discovered or delivered. */
  productionBehaviorChanged: false;
  scopesStarted: readonly MeasurementScope[];
  scopesBlocked: readonly MeasurementScope[];
}

export function describeShadowAuthority(): DiscoveryShadowDecision {
  return {
    experimentId: EXPERIMENT_ID,
    experimentVersion: EXPERIMENT_VERSION,
    mode: EXPERIMENT_MODE,
    productionBehaviorChanged: false,
    scopesStarted: Object.freeze(MEASUREMENT_SCOPES.filter((s) => s.started).map((s) => s.scope)),
    scopesBlocked: Object.freeze(MEASUREMENT_SCOPES.filter((s) => !s.started).map((s) => s.scope)),
  };
}
