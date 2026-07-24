/**
 * Canonical Quant Strategy evaluation contract (Enterprise Phase 3).
 * PURE types — strategies emit structured evidence; they never deliver alerts.
 */
export const STRATEGY_EVALUATION_SCHEMA_VERSION = 1;

export type SignalClassification =
  | "SUPPORTIVE"
  | "CONFLICTING"
  | "NEUTRAL"
  | "INSUFFICIENT_DATA"
  | "VETO";

export type StrategyLifecycleStatus =
  | "ACTIVE"
  | "SHADOW"
  | "RESEARCH_ONLY"
  | "INACTIVE"
  | "BLOCKED"
  | "DEGRADED"
  | "RETIRED";

export type EvidenceCategory =
  | "price_momentum"
  | "volatility"
  | "options_structure"
  | "liquidity"
  | "flow"
  | "regime"
  | "catalyst"
  | "statistical"
  | "risk"
  | "gate";

export interface EvidenceItem {
  evidenceId: string;
  category: EvidenceCategory;
  source: string;
  observedValue: number | string | boolean | null;
  unit: string | null;
  benchmark: string | null;
  timestampMs: number | null;
  freshnessMs: number | null;
  lineage: string[];
  classification: SignalClassification;
  correlationGroup: string | null;
  reasonCode: string;
  explanation: string;
}

export interface StrategyEvaluation {
  schemaVersion: typeof STRATEGY_EVALUATION_SCHEMA_VERSION;
  strategyId: string;
  strategyVersion: string;
  strategyFamily: string;
  lifecycleStatus: StrategyLifecycleStatus;
  applicable: boolean;
  evaluatedDirection: "bullish" | "bearish" | "neutral" | null;
  evaluatedHorizon: string | null;
  signal: SignalClassification;
  rawMetrics: Record<string, number | string | boolean | null>;
  strength: number; // 0–100 normalized
  evidence: EvidenceItem[];
  contradictingEvidence: EvidenceItem[];
  missingDataRequirements: string[];
  regimeCompatible: boolean | null;
  historicalCohortKey: string | null;
  latencyMs: number;
  dataFreshnessMs: number | null;
  limitations: string[];
  reasonCodes: string[];
  error: string | null;
}

export function emptyEvaluation(strategyId: string, reason: string): StrategyEvaluation {
  return {
    schemaVersion: STRATEGY_EVALUATION_SCHEMA_VERSION,
    strategyId,
    strategyVersion: "0",
    strategyFamily: "unknown",
    lifecycleStatus: "INACTIVE",
    applicable: false,
    evaluatedDirection: null,
    evaluatedHorizon: null,
    signal: "INSUFFICIENT_DATA",
    rawMetrics: {},
    strength: 0,
    evidence: [],
    contradictingEvidence: [],
    missingDataRequirements: [reason],
    regimeCompatible: null,
    historicalCohortKey: null,
    latencyMs: 0,
    dataFreshnessMs: null,
    limitations: [reason],
    reasonCodes: ["insufficient_data"],
    error: null,
  };
}

export function blockedEvaluation(
  strategyId: string,
  family: string,
  dependency: string,
): StrategyEvaluation {
  return {
    schemaVersion: STRATEGY_EVALUATION_SCHEMA_VERSION,
    strategyId,
    strategyVersion: "0",
    strategyFamily: family,
    lifecycleStatus: "BLOCKED",
    applicable: false,
    evaluatedDirection: null,
    evaluatedHorizon: null,
    signal: "INSUFFICIENT_DATA",
    rawMetrics: { blockedDependency: dependency },
    strength: 0,
    evidence: [],
    contradictingEvidence: [],
    missingDataRequirements: [dependency],
    regimeCompatible: null,
    historicalCohortKey: null,
    latencyMs: 0,
    dataFreshnessMs: null,
    limitations: [`BLOCKED: requires ${dependency}`],
    reasonCodes: ["blocked_dependency"],
    error: null,
  };
}
