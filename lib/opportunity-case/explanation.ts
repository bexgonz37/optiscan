/**
 * Deterministic explanation engine — renders frozen Ensemble Decision without model invention.
 */
import type { OpportunityCase, EnsembleDecision } from "./schema.ts";

export interface StructuredExplanation {
  schemaVersion: 1;
  opportunityId: string;
  sections: {
    setup: string;
    relevance: string;
    supportingStrategies: string[];
    conflictingStrategies: string[];
    insufficientDataStrategies: string[];
    topEvidence: string[];
    correlatedDiscounted: string[];
    independentConfirmation: string[];
    regimeEffect: string | null;
    contractSelection: string | null;
    probabilityDisclosure: string | null;
    risks: string[];
    invalidation: string | null;
    deliveryDecision: string;
    confidenceFactors: { raise: string[]; lower: string[] };
    missingData: string[];
  };
  disclaimer: string;
}

const DISCLAIMER =
  "Informational and educational purposes only. Not financial advice. Past frequency is not a guarantee of future results.";

export function buildDeterministicExplanation(c: OpportunityCase): StructuredExplanation {
  const ev = c.ensembleDecision;
  const supporting = (ev?.evaluations ?? c.strategyEvaluations).filter((e) => e.signal === "SUPPORTIVE").map((e) => e.strategyId);
  const conflicting = (ev?.evaluations ?? c.strategyEvaluations).filter((e) => e.signal === "CONFLICTING" || e.signal === "VETO").map((e) => e.strategyId);
  const insufficient = (ev?.evaluations ?? c.strategyEvaluations).filter((e) => e.signal === "INSUFFICIENT_DATA").map((e) => e.strategyId);

  const topEvidence = (ev?.evaluations ?? c.strategyEvaluations)
    .flatMap((e) => e.evidence)
    .slice(0, 5)
    .map((e) => e.explanation);

  const correlatedDiscounted = Object.entries(ev?.correlationGroups ?? {})
    .filter(([, members]) => members.length > 1)
    .map(([group, members]) => `${group}: ${members.join(", ")} (correlation discount applied)`);

  const independentConfirmation = ev && ev.independentConfirmationCount > 0
    ? [`${ev.independentConfirmationCount} independent cross-domain confirmation(s)`]
    : [];

  const prob = c.probabilities.find((p) => !p.withheld);
  const probabilityDisclosure = prob
    ? `${prob.outcomeDefinition}: ${prob.classification} estimate${prob.value != null ? ` ${(prob.value * 100).toFixed(1)}%` : ""} (n=${prob.sampleSize})`
    : c.probabilities.length === 0
      ? "No publishable probability — insufficient evidence"
      : "Probabilities withheld below sample minimum";

  const contractSelection = c.selectedContract
    ? `${c.selectedContract.side.toUpperCase()} ${c.selectedContract.strike} ${c.selectedContract.expiration} — ${c.selectedContract.selectionReason}`
    : null;

  const raise: string[] = [];
  const lower: string[] = [];
  if (ev && ev.independentConfirmationCount >= 2) raise.push("Multiple independent strategy domains agree");
  if (c.underlyingQuote.freshnessState === "stale") lower.push("Stale underlying quote");
  if (conflicting.length > 0) lower.push(`${conflicting.length} conflicting strategy signal(s)`);

  return {
    schemaVersion: 1,
    opportunityId: c.opportunityId,
    sections: {
      setup: c.setupFamily ? `${c.setupFamily} on ${c.underlyingSymbol}` : `Setup detected on ${c.underlyingSymbol}`,
      relevance: c.direction !== "neutral" ? `${c.direction} bias in ${c.marketSession} session` : "Neutral directional context",
      supportingStrategies: supporting,
      conflictingStrategies: conflicting,
      insufficientDataStrategies: insufficient,
      topEvidence,
      correlatedDiscounted,
      independentConfirmation,
      regimeEffect: c.marketRegime.label ? `Regime: ${c.marketRegime.label}` : null,
      contractSelection,
      probabilityDisclosure,
      risks: c.hardGateResults.filter((g) => !g.passed).map((g) => g.explanation),
      invalidation: c.invalidation,
      deliveryDecision: `${c.deliveryDecision}${c.deliveryReason ? `: ${c.deliveryReason}` : ""}`,
      confidenceFactors: { raise, lower },
      missingData: [
        ...(c.underlyingQuote.freshnessState === "missing" ? ["underlying_quote"] : []),
        ...(c.chainMetadata.freshnessState === "missing" ? ["options_chain"] : []),
        ...insufficient,
      ],
    },
    disclaimer: DISCLAIMER,
  };
}

export function formatExplanationPlainText(ex: StructuredExplanation): string {
  const s = ex.sections;
  const lines = [
    `Setup: ${s.setup}`,
    `Relevance: ${s.relevance}`,
    s.supportingStrategies.length ? `Supporting: ${s.supportingStrategies.join(", ")}` : "Supporting: none",
    s.conflictingStrategies.length ? `Conflicting: ${s.conflictingStrategies.join(", ")}` : null,
    s.contractSelection ? `Contract: ${s.contractSelection}` : null,
    s.probabilityDisclosure ? `Probability: ${s.probabilityDisclosure}` : null,
    `Delivery: ${s.deliveryDecision}`,
    ex.disclaimer,
  ].filter(Boolean);
  return lines.join("\n");
}

export function attachExplanationToCase(c: OpportunityCase): OpportunityCase {
  const explanation = buildDeterministicExplanation(c);
  return {
    ...c,
    explanationPayload: explanation as unknown as Record<string, unknown>,
    updatedAtMs: Date.now(),
  };
}
