/**
 * Versioned canonical Opportunity Case — one options opportunity throughout its lifecycle.
 * PURE schema + helpers. Immutable frozen trade values after freeze.
 */
import type { StrategyEvaluation } from "../strategy/evaluation.ts";

export const OPPORTUNITY_CASE_SCHEMA_VERSION = 1;

export type MissingDataState = "present" | "missing" | "stale" | "blocked" | "insufficient";

export type DeliveryState =
  | "pending"
  | "delivered"
  | "rejected"
  | "suppressed"
  | "research_only"
  | "too_late"
  | "duplicate"
  | "discord_failed";

export interface FrozenTradeValues {
  entryMid: number;
  targetT1: number;
  targetT2: number;
  stop: number;
  bid: number;
  ask: number;
  spreadPct: number;
  methodology: string;
  frozenAtMs: number;
  immutable: true;
}

export interface SelectedContract {
  optionSymbol: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
  dte: number;
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  delta: number | null;
  openInterest: number | null;
  volume: number | null;
  selectionReason: string;
}

export interface RejectedContract {
  optionSymbol: string;
  reasonCode: string;
  explanation: string;
}

export interface HardGateResult {
  gateId: string;
  passed: boolean;
  reasonCode: string;
  explanation: string;
  finalAuthority: boolean;
}

export interface ProbabilityEstimate {
  outcomeDefinition: string;
  classification: "empirical" | "model" | "bayesian" | "simulated";
  value: number | null;
  sampleSize: number;
  effectiveSampleSize: number | null;
  confidenceInterval: [number, number] | null;
  withheld: boolean;
  withholdReason: string | null;
  limitations: string[];
}

export interface EnsembleDecision {
  schemaVersion: 1;
  conductorVersion: string;
  evaluations: StrategyEvaluation[];
  correlationGroups: Record<string, string[]>;
  independentConfirmationCount: number;
  hardGateResults: HardGateResult[];
  contributionModel: Record<string, {
    rawStrength: number;
    correlationDiscount: number;
    regimeAdjustment: number;
    freshnessAdjustment: number;
    uncertaintyPenalty: number;
    finalContribution: number;
  }>;
  ensembleStrength: number;
  vetoApplied: boolean;
  decisionReasonCodes: string[];
}

export interface OpportunityCase {
  schemaVersion: typeof OPPORTUNITY_CASE_SCHEMA_VERSION;
  opportunityId: string;
  underlyingSymbol: string;
  direction: "bullish" | "bearish" | "neutral";
  setupFamily: string | null;
  detectedAtMs: number;
  marketSession: string;
  sourcePath: "options_live" | "supervisor_agent" | "stock_radar" | "research";

  underlyingQuote: {
    price: number | null;
    velPct: number | null;
    relVolume: number | null;
    quoteTimestampMs: number | null;
    freshnessState: MissingDataState;
  };

  chainMetadata: {
    fetched: boolean;
    contractCount: number | null;
    fetchTimestampMs: number | null;
    freshnessState: MissingDataState;
  };

  selectedContract: SelectedContract | null;
  rejectedContracts: RejectedContract[];
  frozenTrade: FrozenTradeValues | null;
  invalidation: string | null;
  expectedHorizon: string | null;

  marketRegime: {
    label: string | null;
    reasonCodes: string[];
    timestampMs: number | null;
    uncertainty: number | null;
    configVersion: string;
    freshnessState: MissingDataState;
  };

  strategyEvaluations: StrategyEvaluation[];
  ensembleDecision: EnsembleDecision | null;
  hardGateResults: HardGateResult[];
  probabilities: ProbabilityEstimate[];
  rank: number | null;
  rankExplanation: string | null;

  acceptanceDecision: "accepted" | "rejected" | "pending";
  rejectionReasonCodes: string[];
  deliveryDecision: DeliveryState;
  deliveryReason: string | null;
  alertId: string | null;

  explanationPayload: Record<string, unknown> | null;
  dataLineage: string[];
  configVersions: Record<string, string>;
  discordDeliveryStatus: string | null;

  createdAtMs: number;
  updatedAtMs: number;
}

export function deterministicOpportunityId(parts: string[]): string {
  let h = 5381;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return `oc_${h.toString(36)}`;
}

export function createEmptyCase(symbol: string, nowMs: number, sourcePath: OpportunityCase["sourcePath"]): OpportunityCase {
  return {
    schemaVersion: OPPORTUNITY_CASE_SCHEMA_VERSION,
    opportunityId: deterministicOpportunityId([symbol, String(nowMs), sourcePath]),
    underlyingSymbol: symbol.toUpperCase(),
    direction: "neutral",
    setupFamily: null,
    detectedAtMs: nowMs,
    marketSession: "unknown",
    sourcePath,
    underlyingQuote: { price: null, velPct: null, relVolume: null, quoteTimestampMs: null, freshnessState: "missing" },
    chainMetadata: { fetched: false, contractCount: null, fetchTimestampMs: null, freshnessState: "missing" },
    selectedContract: null,
    rejectedContracts: [],
    frozenTrade: null,
    invalidation: null,
    expectedHorizon: null,
    marketRegime: { label: null, reasonCodes: [], timestampMs: null, uncertainty: null, configVersion: "1", freshnessState: "missing" },
    strategyEvaluations: [],
    ensembleDecision: null,
    hardGateResults: [],
    probabilities: [],
    rank: null,
    rankExplanation: null,
    acceptanceDecision: "pending",
    rejectionReasonCodes: [],
    deliveryDecision: "pending",
    deliveryReason: null,
    alertId: null,
    explanationPayload: null,
    dataLineage: [],
    configVersions: {},
    discordDeliveryStatus: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

export function serializeCase(c: OpportunityCase): string {
  return JSON.stringify(c);
}

export function parseCase(json: string): OpportunityCase | null {
  try {
    const o = JSON.parse(json) as OpportunityCase;
    if (o.schemaVersion !== OPPORTUNITY_CASE_SCHEMA_VERSION) return null;
    return o;
  } catch {
    return null;
  }
}
