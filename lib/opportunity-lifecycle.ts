/**
 * Opportunity lifecycle — PURE logic (no DB, no `@/` alias) so the node test
 * runner can exercise every transition directly. Persistence lives in
 * lib/opportunity-store.ts, which calls into here.
 *
 * Design source: docs/ALERT-RANKING-PLAN.md §1 "Opportunity memory".
 * Core guarantees:
 *   - one record evolves per (ticker, setup_type, trading_day) — a repeated
 *     scan is an UPDATE, never a new opportunity
 *   - hysteresis: cards do not jump on one minor score change; a demotion needs
 *     several consecutive weak reads AND a score below the exit band
 *   - safety states (INVALIDATED / DATA_STALE) apply immediately
 *   - ordering is stable (keyed on monotonic highest_score, not the twitchy
 *     current score)
 */

export type LifecycleStatus =
  | "WATCHING"
  | "BUILDING"
  | "NEAR_TRIGGER"
  | "ENTRY_CONFIRMED"
  | "WAIT_FOR_PULLBACK"
  | "EXTENDED"
  | "INVALIDATED"
  | "DATA_STALE"
  | "NO_VALID_CONTRACT"
  | "RESEARCH_ONLY";

export const LIFECYCLE_STATUSES: LifecycleStatus[] = [
  "WATCHING",
  "BUILDING",
  "NEAR_TRIGGER",
  "ENTRY_CONFIRMED",
  "WAIT_FOR_PULLBACK",
  "EXTENDED",
  "INVALIDATED",
  "DATA_STALE",
  "NO_VALID_CONTRACT",
  "RESEARCH_ONLY",
];

/** Command Center sections. */
export type LifecycleBucket =
  | "DEVELOPING"
  | "NEAR_TRIGGER"
  | "ACTIONABLE"
  | "EXTENDED_OR_INVALID"
  | "RESEARCH";

export type OppFlags = {
  /** required data is stale/blocking — cannot be actionable */
  dataStale?: boolean;
  /** no tradable option contract passes liquidity/spread gates */
  noValidContract?: boolean;
  /** research-only setup (e.g. swing preview, disabled strategy) */
  researchOnly?: boolean;
  /** entry confirmation is valid right now (all gates satisfied) */
  confirmed?: boolean;
  /** price has run past the acceptable entry zone */
  extended?: boolean;
  /** invalidation level was broken — the thesis is dead for the day */
  invalidated?: boolean;
  /** close to confirmation but not yet triggered */
  nearTrigger?: boolean;
  /** confirmed but wants a pullback into the entry zone before entry */
  pullback?: boolean;
};

export type OppSignal = {
  ticker: string;
  setupType: string;
  score: number; // 0..100
  triggerLevel?: number | null;
  entryZone?: string | null;
  invalidationLevel?: number | null;
  expirationTime?: string | null;
  flags?: OppFlags;
};

export type OpportunityRecord = {
  opportunity_id: string;
  ticker: string;
  setup_type: string;
  first_detected_at: string;
  last_updated_at: string;
  highest_score: number;
  current_score: number;
  previous_status: LifecycleStatus | null;
  current_status: LifecycleStatus;
  trigger_level: number | null;
  entry_zone: string | null;
  invalidation_level: number | null;
  expiration_time: string | null;
  // internal hysteresis bookkeeping (persisted, not shown raw in UI)
  demote_streak: number;
  status_since: string;
};

export type LifecycleConfig = {
  /** score at/above which a plain (flagless) signal is NEAR_TRIGGER */
  nearScore: number;
  /** score at/above which a plain signal is BUILDING */
  buildScore: number;
  /** a ladder demotion is only accepted once current_score drops below this */
  exitScore: number;
  /** consecutive demotion-requesting evals required before demoting */
  demoteEvals: number;
};

export function defaultLifecycleConfig(env: Record<string, string | undefined> = {}): LifecycleConfig {
  const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    nearScore: num(env.OPP_NEAR_SCORE, 75),
    buildScore: num(env.OPP_BUILD_SCORE, 55),
    exitScore: num(env.OPP_EXIT_SCORE, 60),
    demoteEvals: Math.max(1, num(env.OPP_DEMOTE_EVALS, 3)),
  };
}

/** Overlay states short-circuit the score ladder (order = priority). */
const OVERLAY_PRIORITY: LifecycleStatus[] = [
  "INVALIDATED",
  "DATA_STALE",
  "NO_VALID_CONTRACT",
  "RESEARCH_ONLY",
  "EXTENDED",
];

/** Ladder rank — higher means closer to an actionable entry. */
const LADDER_RANK: Record<string, number> = {
  WATCHING: 1,
  BUILDING: 2,
  NEAR_TRIGGER: 3,
  WAIT_FOR_PULLBACK: 4,
  ENTRY_CONFIRMED: 5,
};

function isLadder(s: LifecycleStatus): boolean {
  return s in LADDER_RANK;
}

/**
 * Target status from the current signal alone, ignoring history. Overlay flags
 * win over the score ladder; among ladder outcomes, confirmation beats
 * near-trigger beats score bands.
 */
export function computeTargetStatus(signal: OppSignal, cfg: LifecycleConfig): LifecycleStatus {
  const f = signal.flags ?? {};
  if (f.invalidated) return "INVALIDATED";
  if (f.dataStale) return "DATA_STALE";
  if (f.noValidContract) return "NO_VALID_CONTRACT";
  if (f.researchOnly) return "RESEARCH_ONLY";
  if (f.extended) return "EXTENDED";
  if (f.confirmed) return "ENTRY_CONFIRMED";
  if (f.pullback) return "WAIT_FOR_PULLBACK";
  if (f.nearTrigger) return "NEAR_TRIGGER";
  const score = Number(signal.score) || 0;
  if (score >= cfg.nearScore) return "NEAR_TRIGGER";
  if (score >= cfg.buildScore) return "BUILDING";
  return "WATCHING";
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/**
 * Fold a new signal into the prior record (or create one). Applies hysteresis
 * on ladder demotions so a single minor score wobble never reshuffles cards.
 */
export function reconcile(
  prev: OpportunityRecord | null,
  signal: OppSignal,
  nowMs: number,
  cfg: LifecycleConfig = defaultLifecycleConfig(),
): OpportunityRecord {
  const ticker = String(signal.ticker || "").toUpperCase();
  const setupType = String(signal.setupType || "generic");
  const score = Math.max(0, Math.min(100, Number(signal.score) || 0));
  const target = computeTargetStatus(signal, cfg);
  const iso = nowIso(nowMs);

  if (!prev) {
    return {
      opportunity_id: `opp_${ticker}_${setupType}`.replace(/[^A-Za-z0-9_]/g, "_"),
      ticker,
      setup_type: setupType,
      first_detected_at: iso,
      last_updated_at: iso,
      highest_score: score,
      current_score: score,
      previous_status: null,
      current_status: target,
      trigger_level: signal.triggerLevel ?? null,
      entry_zone: signal.entryZone ?? null,
      invalidation_level: signal.invalidationLevel ?? null,
      expiration_time: signal.expirationTime ?? null,
      demote_streak: 0,
      status_since: iso,
    };
  }

  let nextStatus = prev.current_status;
  let demoteStreak = prev.demote_streak;

  // INVALIDATED is terminal for the day — a dead thesis does not silently revive.
  if (prev.current_status === "INVALIDATED") {
    nextStatus = "INVALIDATED";
    demoteStreak = 0;
  } else if (!isLadder(target) || !isLadder(prev.current_status)) {
    // Any move that touches an overlay state (into or out of it) applies
    // immediately — safety/accuracy beat smoothing here.
    nextStatus = target;
    demoteStreak = 0;
  } else {
    // Both prev and target are ladder states: hysteresis on demotions only.
    const targetRank = LADDER_RANK[target];
    const currentRank = LADDER_RANK[prev.current_status];
    if (targetRank >= currentRank) {
      nextStatus = target; // promotion or lateral — accept, clear streak
      demoteStreak = 0;
    } else {
      demoteStreak = prev.demote_streak + 1;
      const belowExit = score < cfg.exitScore;
      if (demoteStreak >= cfg.demoteEvals && belowExit) {
        nextStatus = target;
        demoteStreak = 0;
      } else {
        nextStatus = prev.current_status; // hold — not enough evidence yet
      }
    }
  }

  const changed = nextStatus !== prev.current_status;
  return {
    ...prev,
    ticker,
    setup_type: setupType,
    last_updated_at: iso,
    highest_score: Math.max(prev.highest_score, score),
    current_score: score,
    previous_status: changed ? prev.current_status : prev.previous_status,
    current_status: nextStatus,
    trigger_level: signal.triggerLevel ?? prev.trigger_level,
    entry_zone: signal.entryZone ?? prev.entry_zone,
    invalidation_level: signal.invalidationLevel ?? prev.invalidation_level,
    expiration_time: signal.expirationTime ?? prev.expiration_time,
    demote_streak: demoteStreak,
    status_since: changed ? iso : prev.status_since,
  };
}

export function bucketOf(status: LifecycleStatus): LifecycleBucket {
  switch (status) {
    case "ENTRY_CONFIRMED":
      return "ACTIONABLE";
    case "NEAR_TRIGGER":
    case "WAIT_FOR_PULLBACK":
      return "NEAR_TRIGGER";
    case "WATCHING":
    case "BUILDING":
      return "DEVELOPING";
    case "EXTENDED":
    case "INVALIDATED":
      return "EXTENDED_OR_INVALID";
    case "DATA_STALE":
    case "NO_VALID_CONTRACT":
    case "RESEARCH_ONLY":
      return "RESEARCH";
  }
}

const BUCKET_ORDER: Record<LifecycleBucket, number> = {
  ACTIONABLE: 0,
  NEAR_TRIGGER: 1,
  DEVELOPING: 2,
  EXTENDED_OR_INVALID: 3,
  RESEARCH: 4,
};

/**
 * Stable ordering. Sorts on the MONOTONIC highest_score (not current_score) so
 * a transient dip cannot reorder cards, then on first_detected_at (older wins
 * ties → prior rank is preserved), then ticker for full determinism.
 */
export function stableOrder(records: OpportunityRecord[]): OpportunityRecord[] {
  return [...records].sort((a, b) => {
    const ba = BUCKET_ORDER[bucketOf(a.current_status)];
    const bb = BUCKET_ORDER[bucketOf(b.current_status)];
    if (ba !== bb) return ba - bb;
    if (b.highest_score !== a.highest_score) return b.highest_score - a.highest_score;
    if (a.first_detected_at !== b.first_detected_at) {
      return a.first_detected_at < b.first_detected_at ? -1 : 1;
    }
    return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
  });
}

export function groupByBucket(records: OpportunityRecord[]): Record<LifecycleBucket, OpportunityRecord[]> {
  const out: Record<LifecycleBucket, OpportunityRecord[]> = {
    ACTIONABLE: [],
    NEAR_TRIGGER: [],
    DEVELOPING: [],
    EXTENDED_OR_INVALID: [],
    RESEARCH: [],
  };
  for (const r of stableOrder(records)) out[bucketOf(r.current_status)].push(r);
  return out;
}

/** Human-readable, one-line status label for cards. */
export function statusLabel(status: LifecycleStatus): string {
  const map: Record<LifecycleStatus, string> = {
    WATCHING: "Watching",
    BUILDING: "Building",
    NEAR_TRIGGER: "Near trigger",
    ENTRY_CONFIRMED: "Entry confirmed",
    WAIT_FOR_PULLBACK: "Wait for pullback",
    EXTENDED: "Extended",
    INVALIDATED: "Invalidated",
    DATA_STALE: "Data stale",
    NO_VALID_CONTRACT: "No valid contract",
    RESEARCH_ONLY: "Research only",
  };
  return map[status];
}
