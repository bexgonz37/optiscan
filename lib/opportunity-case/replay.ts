/**
 * Point-in-time decision replay from stored Opportunity Case.
 */
import { loadOpportunityCaseOnDb } from "./store.ts";
import { buildDeterministicExplanation, formatExplanationPlainText } from "./explanation.ts";
import type { OpportunityCase } from "./schema.ts";

export interface DecisionReplayResult {
  opportunityId: string;
  replayedAtMs: number;
  caseFound: boolean;
  opportunityCase: OpportunityCase | null;
  explanationText: string | null;
  auditAnswers: {
    whatWasDetected: string | null;
    strategiesApplicable: string[];
    strategiesSupported: string[];
    strategiesConflicted: string[];
    hardGates: string[];
    contractSelected: string | null;
    deliveryDecision: string | null;
    dataAvailableAtDecisionTime: boolean;
  };
}

export function replayDecisionOnDb(db: { prepare: (sql: string) => { get: (...a: any[]) => any } }, opportunityId: string, nowMs = Date.now()): DecisionReplayResult {
  const c = loadOpportunityCaseOnDb(db as any, opportunityId);
  if (!c) {
    return {
      opportunityId,
      replayedAtMs: nowMs,
      caseFound: false,
      opportunityCase: null,
      explanationText: null,
      auditAnswers: {
        whatWasDetected: null,
        strategiesApplicable: [],
        strategiesSupported: [],
        strategiesConflicted: [],
        hardGates: [],
        contractSelected: null,
        deliveryDecision: null,
        dataAvailableAtDecisionTime: false,
      },
    };
  }

  const ex = buildDeterministicExplanation(c);
  const evals = c.ensembleDecision?.evaluations ?? c.strategyEvaluations;

  return {
    opportunityId,
    replayedAtMs: nowMs,
    caseFound: true,
    opportunityCase: c,
    explanationText: formatExplanationPlainText(ex),
    auditAnswers: {
      whatWasDetected: c.setupFamily,
      strategiesApplicable: evals.filter((e) => e.applicable).map((e) => e.strategyId),
      strategiesSupported: evals.filter((e) => e.signal === "SUPPORTIVE").map((e) => e.strategyId),
      strategiesConflicted: evals.filter((e) => e.signal === "CONFLICTING" || e.signal === "VETO").map((e) => e.strategyId),
      hardGates: c.hardGateResults.map((g) => `${g.gateId}:${g.passed ? "pass" : "fail"}`),
      contractSelected: c.selectedContract?.optionSymbol ?? null,
      deliveryDecision: `${c.deliveryDecision}${c.deliveryReason ? ` — ${c.deliveryReason}` : ""}`,
      dataAvailableAtDecisionTime: c.underlyingQuote.freshnessState === "present",
    },
  };
}
