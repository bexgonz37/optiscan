/**
 * professional-plan.ts — PURE builder for the professional daily options plan.
 *
 * Turns a candidate universe plus deterministic setup evidence into a concise,
 * publishable Watchlist. Two products, one builder:
 *   OVERNIGHT_PLAN    — completed prior-session and daily evidence only.
 *   PREMARKET_UPDATE  — the overnight plan re-stated against premarket evidence,
 *                       with explicit changes, invalidations, and additions.
 *
 * Publication is a gate, not a formatting step. A row publishes only with a
 * setup family, at least one real deterministic trigger price, a source level, a
 * reason, and a freshness stamp. There is no generic fallback row, no
 * structure_watch filler, no confidence score, and no "VERIFY AT OPEN"-only
 * trigger. When nothing qualifies, the plan is empty and says why.
 */
import {
  applyPremarketLevels,
  type DetectedSetup,
  type SessionLevels,
  type SetupFamily,
} from "./setup-families.ts";
import type { UniverseCandidate } from "./universe.ts";

export type WatchlistPhase = "OVERNIGHT_PLAN" | "PREMARKET_UPDATE";

/** Lifecycle state of one Watchlist row. */
export type WatchlistState =
  | "OVERNIGHT_PLAN"
  | "PREMARKET_UPDATE"
  | "TRIGGERED_TODAY"
  | "INVALIDATED"
  | "NEEDS_MORE_DATA";

export const WATCHLIST_STATES: WatchlistState[] = [
  "OVERNIGHT_PLAN", "PREMARKET_UPDATE", "TRIGGERED_TODAY", "INVALIDATED", "NEEDS_MORE_DATA",
];

export interface PublishedTrigger {
  price: number;
  sourceLevelName: string;
}

export interface WatchlistRow {
  symbol: string;
  family: SetupFamily;
  setupType: string;
  /** CALLS ABOVE this price. Null when the setup supports no upside trigger. */
  callAbove: PublishedTrigger | null;
  /** PUTS BELOW this price. Null when the setup supports no downside trigger. */
  putBelow: PublishedTrigger | null;
  reason: string;
  sourceLevels: Array<{ name: string; value: number; origin: string }>;
  freshness: string;
  evidenceAsOfMs: number;
  catalyst: string | null;
  state: WatchlistState;
  /** Populated only after options open; never selected overnight. */
  exactContract: string | null;
  /** True when this row's levels or state moved since the overnight plan. */
  changedSinceOvernight: boolean;
  changes: string[];
  rank: number;
  structureScore: number;
}

export interface WithheldRow {
  symbol: string;
  state: "NEEDS_MORE_DATA";
  missing: string[];
}

export interface WatchlistPlan {
  tradingDay: string;
  phase: WatchlistPhase;
  builtAtMs: number;
  planVersion: string;
  /**
   * Overnight plan identity a premarket update refreshes. Null on the overnight
   * plan itself, and null when a premarket update found no overnight plan to
   * refresh — a premarket update is never silently presented as a continuation
   * of a plan that does not exist.
   */
  derivedFromPlanVersion: string | null;
  rows: WatchlistRow[];
  needsMoreData: WithheldRow[];
  invalidated: Array<{ symbol: string; family: SetupFamily; setupType: string; reason: string }>;
  newlyQualified: string[];
  marketAlignment: string | null;
  diagnostics: {
    universeConsidered: number;
    setupsDetected: number;
    publishedCount: number;
    maxRows: number;
    blockers: string[];
    /** Symbols whose premarket evidence was rejected, with the reason. */
    premarketEvidenceExcluded: Array<{ symbol: string; reason: string }>;
  };
}

export interface BuildWatchlistPlanInput {
  tradingDay: string;
  phase: WatchlistPhase;
  nowMs: number;
  universe: UniverseCandidate[];
  /** Detected setups keyed by symbol. Only symbols in the universe are used. */
  setupsBySymbol: Record<string, DetectedSetup[]>;
  /** Premarket evidence keyed by symbol. Ignored for the overnight plan. */
  sessionBySymbol?: Record<string, SessionLevels> | null;
  /** The published overnight plan, when building a premarket update. */
  previousPlan?: WatchlistPlan | null;
  /** Plain-English broad-market alignment, e.g. "SPY bearish, QQQ bearish". */
  marketAlignment?: string | null;
  maxRows?: number;
}

/** Publication bounds. A concise plan is the product; more rows is not better. */
export const MIN_USEFUL_ROWS = 8;
export const MAX_PUBLISHED_ROWS = 12;

/** One row per ticker: the highest-scoring family wins, ties broken by name. */
function bestSetupPerSymbol(setups: DetectedSetup[]): DetectedSetup | null {
  if (!setups.length) return null;
  return setups
    .slice()
    .sort((a, b) => b.structureScore - a.structureScore || a.family.localeCompare(b.family))[0];
}

/**
 * The publication gate. Returns the missing evidence; an empty array means the
 * row may publish. This is the ONLY path to a published row.
 */
export function publishBlockers(setup: DetectedSetup | null, nowMs: number): string[] {
  if (!setup) return ["No deterministic setup detected"];
  const missing: string[] = [];
  const hasCall = !!setup.callTrigger && Number.isFinite(setup.callTrigger.price) && setup.callTrigger.price > 0;
  const hasPut = !!setup.putTrigger && Number.isFinite(setup.putTrigger.price) && setup.putTrigger.price > 0;
  if (!hasCall && !hasPut) missing.push("No deterministic CALL or PUT trigger price");
  if (!setup.sourceLevels.length) missing.push("No source level");
  if (!setup.reason || setup.reason.trim().length < 20) missing.push("No concise reason");
  if (!setup.freshness || !setup.freshness.trim()) missing.push("No freshness stamp");
  if (!Number.isFinite(setup.evidenceAsOfMs) || setup.evidenceAsOfMs <= 0) missing.push("No evidence timestamp");
  else if (setup.evidenceAsOfMs > nowMs) missing.push("Evidence is timestamped in the future");
  return missing;
}

function toRow(setup: DetectedSetup, state: WatchlistState, changes: string[]): WatchlistRow {
  return {
    symbol: setup.symbol,
    family: setup.family,
    setupType: setup.familyLabel,
    callAbove: setup.callTrigger
      ? { price: setup.callTrigger.price, sourceLevelName: setup.callTrigger.sourceLevelName }
      : null,
    putBelow: setup.putTrigger
      ? { price: setup.putTrigger.price, sourceLevelName: setup.putTrigger.sourceLevelName }
      : null,
    reason: setup.reason,
    sourceLevels: setup.sourceLevels,
    freshness: setup.freshness,
    evidenceAsOfMs: setup.evidenceAsOfMs,
    catalyst: setup.catalyst,
    state,
    // Overnight and premarket NEVER select an exact contract. The contract is
    // chosen by the live path after options open, against a fresh chain.
    exactContract: null,
    changedSinceOvernight: changes.length > 0,
    changes,
    rank: 0,
    structureScore: setup.structureScore,
  };
}

export function buildWatchlistPlan(input: BuildWatchlistPlanInput): WatchlistPlan {
  const maxRows = Math.min(MAX_PUBLISHED_ROWS, Math.max(1, input.maxRows ?? MAX_PUBLISHED_ROWS));
  const premarket = input.phase === "PREMARKET_UPDATE";
  const state: WatchlistState = premarket ? "PREMARKET_UPDATE" : "OVERNIGHT_PLAN";
  const universeSymbols = input.universe.map((c) => c.symbol);
  const previousBySymbol = new Map(
    (input.previousPlan?.rows ?? []).map((r) => [r.symbol, r] as const),
  );

  const rows: WatchlistRow[] = [];
  const needsMoreData: WithheldRow[] = [];
  const premarketEvidenceExcluded: Array<{ symbol: string; reason: string }> = [];
  let setupsDetected = 0;

  for (const symbol of universeSymbols) {
    const detected = (input.setupsBySymbol?.[symbol] ?? []).filter((s) => s && s.symbol === symbol);
    setupsDetected += detected.length;
    let best = bestSetupPerSymbol(detected);
    const changes: string[] = [];
    if (best && premarket) {
      const applied = applyPremarketLevels(best, input.sessionBySymbol?.[symbol] ?? null, input.nowMs);
      best = applied.setup;
      changes.push(...applied.changes);
      // An unsourced, undated, future-dated, or stale premarket extreme leaves
      // the daily level standing and is reported, never quietly applied.
      if (applied.excludedReason && applied.excludedReason !== "No premarket evidence") {
        premarketEvidenceExcluded.push({ symbol, reason: applied.excludedReason });
      }
    }
    const missing = publishBlockers(best, input.nowMs);
    if (missing.length) {
      needsMoreData.push({ symbol, state: "NEEDS_MORE_DATA", missing });
      continue;
    }
    const prior = previousBySymbol.get(symbol);
    if (premarket && prior) {
      if (prior.family !== best!.family) changes.push(`Setup changed from ${prior.setupType} to ${best!.familyLabel}`);
      if (!changes.length
        && prior.callAbove?.price !== best!.callTrigger?.price) changes.push("CALL trigger level changed");
      if (!changes.length
        && prior.putBelow?.price !== best!.putTrigger?.price) changes.push("PUT trigger level changed");
    }
    rows.push(toRow(best!, state, changes));
  }

  rows.sort((a, b) => b.structureScore - a.structureScore || a.symbol.localeCompare(b.symbol));
  const published = rows.slice(0, maxRows).map((r, i) => ({ ...r, rank: i + 1 }));
  const publishedSymbols = new Set(published.map((r) => r.symbol));
  for (const dropped of rows.slice(maxRows)) {
    needsMoreData.push({
      symbol: dropped.symbol,
      state: "NEEDS_MORE_DATA",
      missing: [`Ranked below the ${maxRows}-ticker publication limit`],
    });
  }

  // Premarket bookkeeping: what fell out, what is new, versus the overnight plan.
  const invalidated: WatchlistPlan["invalidated"] = [];
  const newlyQualified: string[] = [];
  if (premarket && input.previousPlan) {
    for (const prior of input.previousPlan.rows) {
      if (publishedSymbols.has(prior.symbol)) continue;
      const withheld = needsMoreData.find((w) => w.symbol === prior.symbol);
      invalidated.push({
        symbol: prior.symbol,
        family: prior.family,
        setupType: prior.setupType,
        reason: withheld ? withheld.missing.join("; ") : "Setup no longer carries deterministic evidence",
      });
    }
    for (const row of published) {
      if (!previousBySymbol.has(row.symbol)) newlyQualified.push(row.symbol);
    }
  }

  const blockers: string[] = [];
  if (!input.universe.length) blockers.push("No candidate carried liquid-options evidence.");
  else if (!setupsDetected) blockers.push("No candidate carried a deterministic technical setup.");
  else if (!published.length) blockers.push("Every detected setup failed the publication gate.");
  if (published.length > 0 && published.length < MIN_USEFUL_ROWS) {
    blockers.push(`Only ${published.length} setups qualified; a full plan carries ${MIN_USEFUL_ROWS}-${MAX_PUBLISHED_ROWS}.`);
  }

  return {
    tradingDay: input.tradingDay,
    phase: input.phase,
    builtAtMs: input.nowMs,
    planVersion: `watchlist-pro-${input.phase === "PREMARKET_UPDATE" ? "premarket" : "overnight"}-${input.tradingDay}`,
    derivedFromPlanVersion: premarket ? (input.previousPlan?.planVersion ?? null) : null,
    rows: published,
    needsMoreData: needsMoreData.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    invalidated: invalidated.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    newlyQualified: newlyQualified.sort(),
    marketAlignment: input.marketAlignment ?? null,
    diagnostics: {
      universeConsidered: universeSymbols.length,
      setupsDetected,
      publishedCount: published.length,
      maxRows,
      blockers,
      premarketEvidenceExcluded: premarketEvidenceExcluded.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    },
  };
}

/** Group published rows by setup type, for a mobile-friendly reading order. */
export function groupRowsBySetup(rows: WatchlistRow[]): Array<{ setupType: string; rows: WatchlistRow[] }> {
  const byType = new Map<string, WatchlistRow[]>();
  for (const row of rows) {
    if (!byType.has(row.setupType)) byType.set(row.setupType, []);
    byType.get(row.setupType)!.push(row);
  }
  return [...byType.entries()]
    .map(([setupType, groupRows]) => ({
      setupType,
      rows: groupRows.slice().sort((a, b) => a.rank - b.rank),
    }))
    .sort((a, b) => a.rows[0].rank - b.rows[0].rank);
}
