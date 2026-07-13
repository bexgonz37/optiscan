/**
 * agents/types.ts — the ONE normalized, deterministic agent-result contract
 * (Phase 5). PURE: no I/O. Every strategy/service agent emits an `AgentResult`
 * with this exact shape so the Supervisor can dedup, rank, and route uniformly.
 *
 * Agents REUSE the existing services (contract-selector, data-freshness,
 * statistics, market-context, model-registry, bearish-gate, risk). They never
 * duplicate that logic — this file only defines the shared vocabulary.
 */

export type AgentDirection = "bullish" | "bearish";
export type AgentHorizon = "0DTE" | "1-5" | "6-10" | "11-35" | "36-90" | "STOCK";

/** Candidate status (superset used by callouts in Phase 6). */
export type CandidateStatus =
  | "ACTIONABLE_NOW"
  | "NEAR_TRIGGER"
  | "DEVELOPING"
  | "WATCH"
  | "WAIT_FOR_PULLBACK"
  | "EXTENDED"
  | "NO_VALID_CONTRACT"
  | "DATA_STALE"
  | "INVALIDATED"
  | "RESEARCH_ONLY"
  | "MODEL_EXPERIMENTAL"
  | "MODEL_INACTIVE"
  | "INSUFFICIENT_EVIDENCE";

/** The single authoritative actionability verdict a downstream consumer may act on. */
export type AgentActionability = "ACTIONABLE" | "RESEARCH_ONLY" | "WATCH" | "BLOCKED";

export interface AgentContractRef {
  optionSymbol: string | null;
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  side: "call" | "put" | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadPct: number | null;
  delta: number | null;
  iv: number | null;
  volume: number | null;
  openInterest: number | null;
  breakevenPct: number | null;
}

export interface AgentEvidence {
  evidenceStatus: string;
  evidenceSummary: string;
  gradedSampleSize: number;
}

export interface AgentModelState {
  status: string;               // ACTIVE_VALIDATED | ACTIVE_EXPERIMENTAL_RESEARCH_ONLY | INACTIVE_...
  modelVersion: number | null;
  probability: number | null;   // only present when the model state legitimately permits it
  calibration: string | null;
}

export interface AgentRiskVerdict {
  allowed: boolean;
  failures: string[];
  vetoed: boolean;
}

export interface AgentResult {
  agentId: string;
  agentVersion: number;
  strategy: string;
  strategyVersion: number;
  ticker: string;
  direction: AgentDirection;
  horizon: AgentHorizon;
  dteRange: [number, number] | null;
  candidateStatus: CandidateStatus;
  lifecycleStatus: string | null;
  score: number | null;
  verifiedInputs: Record<string, unknown>;
  requiredConditions: string[];
  selectorProfile: string | null;
  selectedContract: AgentContractRef | null;
  passedGates: string[];
  failedGates: string[];
  evidenceStatus: string;
  statisticsSnapshot: AgentEvidence | null;
  modelStatus: string;
  probability: number | null;
  actionability: AgentActionability;
  researchOnly: boolean;
  reasons: string[];
  improvementConditions: string[];
  invalidationConditions: string[];
  freshness: { ok: boolean; reason: string | null };
  marketContext: Record<string, unknown> | null;
  riskVerdict: AgentRiskVerdict;
  timestamp: number;
}

/** A stable identity used for dedup: one canonical result per ticker+direction+horizon. */
export function resultKey(r: Pick<AgentResult, "ticker" | "direction" | "horizon">): string {
  return `${r.ticker.toUpperCase()}|${r.direction}|${r.horizon}`;
}

/** Deterministic ordering priority for candidate statuses (higher = more advanced). */
export const STATUS_RANK: Record<CandidateStatus, number> = {
  ACTIONABLE_NOW: 100,
  NEAR_TRIGGER: 80,
  WAIT_FOR_PULLBACK: 70,
  DEVELOPING: 60,
  EXTENDED: 50,
  RESEARCH_ONLY: 40,
  WATCH: 30,
  INSUFFICIENT_EVIDENCE: 25,
  MODEL_EXPERIMENTAL: 24,
  MODEL_INACTIVE: 23,
  NO_VALID_CONTRACT: 20,
  DATA_STALE: 10,
  INVALIDATED: 0,
};
