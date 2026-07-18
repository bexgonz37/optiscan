/**
 * lib/research/types.ts — the normalized SetupCandidate contract, setup-tier
 * taxonomy, structured gate results, and lane vocabulary for the multi-lane
 * research architecture (Phase 0 design contract; wired in later phases).
 *
 * PURE types + deterministic constants only. No I/O, no imports of server code.
 * Reuses the existing agent vocabulary (`../agents/types.ts`) so the
 * AgentResult → SetupCandidate adapter (Phase 1) is a real, DRY mapping rather
 * than a parallel universe.
 *
 * Nothing in this file changes runtime behavior. It is imported by the Phase-1
 * capture layer only when SETUP_CANDIDATE_CAPTURE_ENABLED=1.
 */
import type {
  AgentActionability,
  AgentDirection,
  AgentHorizon,
  CandidateStatus,
} from "../agents/types.ts";

// ── Setup tiers ──────────────────────────────────────────────────────────────
export type SetupTier =
  | "PRODUCTION_QUALITY"
  | "EXPERIMENTAL_VALID"
  | "NEAR_MISS_VALID"
  | "REJECTED_INVALID";

export const SETUP_TIERS: readonly SetupTier[] = Object.freeze([
  "PRODUCTION_QUALITY",
  "EXPERIMENTAL_VALID",
  "NEAR_MISS_VALID",
  "REJECTED_INVALID",
]);

/** A tradeable tier is anything a lane may (per its own policy) paper-fill. */
export function isTradeableTier(tier: SetupTier): boolean {
  return tier === "PRODUCTION_QUALITY" || tier === "EXPERIMENTAL_VALID" || tier === "NEAR_MISS_VALID";
}

// ── Lanes ────────────────────────────────────────────────────────────────────
export type Lane =
  | "PRODUCTION_DISCORD"
  | "PRIMARY_PAPER"
  | "CHALLENGE_PAPER"
  | "RESEARCH"
  | "HISTORICAL_QUANT";

export const LANES: readonly Lane[] = Object.freeze([
  "PRODUCTION_DISCORD",
  "PRIMARY_PAPER",
  "CHALLENGE_PAPER",
  "RESEARCH",
  "HISTORICAL_QUANT",
]);

export type AssetClass = "stock" | "option";

// ── Structured gate results (section-7 spec) ─────────────────────────────────
/** One named deterministic gate's verdict. `score` is optional 0..1 quality. */
export interface GateResult {
  passed: boolean;
  score?: number | null;
  reason?: string | null;
}

/** Map of gate name → result. Canonical keys are documented but open-ended. */
export type GateResults = Record<string, GateResult>;

/** Canonical gate names (open set; agents/classifier may add more). */
export const CANONICAL_GATES = Object.freeze([
  "contractIdentity",
  "freshness",
  "liquidity",
  "spread",
  "trend",
  "session",
  "bearish",
  "risk",
  "confidence",
] as const);

// ── Greeks (only when genuinely provided by the provider) ────────────────────
export interface GreeksSnapshot {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  /** True only when the provider actually supplied these values this cycle. */
  available: boolean;
}

// ── Outcome (filled in by grading; null until terminal) ──────────────────────
export interface SetupOutcome {
  status: "OPEN" | "WIN" | "LOSS" | "SCRATCH" | "NOT_FILLED" | null;
  mfePct: number | null;
  maePct: number | null;
  returnPct: number | null;
  win: boolean | null;
  exitReason: string | null;
}

// ── The normalized setup candidate ───────────────────────────────────────────
export interface SetupCandidate {
  /** Stable per-candidate identity (deterministic; see setupIdOf). */
  setupId: string;

  // Attribution
  strategyAgent: string;
  strategyFamily: string;
  strategyVersion: number;
  agentVersion: number;

  // Instrument
  ticker: string;
  direction: AgentDirection;
  assetClass: AssetClass;
  optionSymbol: string | null;
  expiration: string | null;
  strike: number | null;
  side: "call" | "put" | null;
  horizon: AgentHorizon;
  session: MarketSessionName;

  // Classification
  setupTier: SetupTier;
  confidence: number | null;
  candidateStatus: CandidateStatus;
  actionability: AgentActionability;

  // Deterministic evaluation
  gateResults: GateResults;
  rejectionReasons: string[];
  freshnessState: string;

  // Market microstructure (only what is genuinely available)
  liquidity: number | null;
  spreadPct: number | null;
  volume: number | null;
  openInterest: number | null;
  greeks: GreeksSnapshot | null;

  // Theses + context
  entryThesis: string | null;
  invalidationThesis: string | null;
  featureSnapshot: Record<string, unknown> | null;
  marketRegimeContext: Record<string, unknown> | null;

  // Provenance + routing
  originatingTsMs: number;
  consumerLanes: Lane[];
  experimentId: string | null;
  modelVersion: number | null;

  // Outcome (grading)
  outcome: SetupOutcome | null;
}

export type MarketSessionName = "premarket" | "regular" | "afterhours" | "closed";

/**
 * Deterministic setup identity — stable across cycles for the same setup so
 * dedup/idempotency behave. Trading-day is supplied by the caller (ET day) to
 * keep this pure.
 */
export function setupIdOf(
  c: Pick<SetupCandidate, "strategyAgent" | "ticker" | "direction" | "horizon" | "optionSymbol">,
  tradingDay: string,
): string {
  const contract = c.optionSymbol ?? `${c.direction}:${c.horizon}`;
  return `${c.strategyAgent}|${c.ticker.toUpperCase()}|${contract}|${tradingDay}`;
}

// ── Lane routing record (persisted in Phase 2) ───────────────────────────────
export interface LaneRoute {
  setupId: string;
  lane: Lane;
  routed: boolean;
  reasonCode: string;
  reason: string;
  atMs: number;
}
