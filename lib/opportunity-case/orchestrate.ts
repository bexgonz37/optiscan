/**
 * Enterprise orchestration — builds full Opportunity Case from options LIVE evaluation.
 */
import { adaptOptionsLiveToCase } from "./adapters/options-live.ts";
import { attachExplanationToCase } from "./explanation.ts";
import { attachRegimeToCase, regimeFromMarketContext } from "./regime.ts";
import { loadOpportunityCaseOnDb, persistOpportunityCaseOnDb } from "./store.ts";
import type { OpportunityCase } from "./schema.ts";
import { evaluationFromOptionsSelection } from "../strategy/catalog-adapter.ts";
import { runStrategyConductor } from "../strategy/conductor.ts";
import { buildProbabilityEstimate } from "./probability.ts";

export interface BuildCaseInput {
  input: import("../research/options/discovery.ts").OptionsCandidateInput;
  evalResult: import("../research/options/loop.ts").OptionsEvalResult;
  chainLength: number;
  deliveryDecision?: import("../research/options/delivery-decision.ts").DeliveryDecision | null;
  alertId?: string | null;
  marketContext?: Record<string, unknown> | null;
  forwardEvidence?: { n: number; winRate: number } | null;
  livingOpportunityCaseId?: string | null;
}

export function buildOpportunityCaseFromOptionsLive(args: BuildCaseInput): OpportunityCase {
  let c = adaptOptionsLiveToCase({
    input: args.input,
    evalResult: args.evalResult,
    chainLength: args.chainLength,
    deliveryDecision: args.deliveryDecision,
    alertId: args.alertId,
    livingOpportunityCaseId: args.livingOpportunityCaseId,
  });
  const regime = regimeFromMarketContext(args.marketContext ?? null, args.input.nowMs);
  c = attachRegimeToCase(c, regime);

  const evaluations = evaluationFromOptionsSelection(args.evalResult.selection, args.input.nowMs);
  c.strategyEvaluations = evaluations;

  const ensemble = runStrategyConductor({
    symbol: args.input.symbol,
    nowMs: args.input.nowMs,
    evaluations,
    hardGates: c.hardGateResults,
    regimeLabel: regime.label,
  });
  c.ensembleDecision = ensemble;

  if (args.forwardEvidence && args.forwardEvidence.n >= 5) {
    c.probabilities.push(buildProbabilityEstimate({
      outcomeDefinition: "Target 1 before stop (forward mirror)",
      classification: "empirical",
      observedRate: args.forwardEvidence.winRate,
      sampleSize: args.forwardEvidence.n,
      cohortDefinition: args.evalResult.selection.selected?.key ?? "unknown",
    }));
  }

  c = attachExplanationToCase(c);
  return c;
}

export function persistCaseFromOptionsLive(db: Parameters<typeof persistOpportunityCaseOnDb>[0], args: BuildCaseInput): OpportunityCase {
  const observation = buildOpportunityCaseFromOptionsLive(args);
  let persisted = observation;

  if (args.livingOpportunityCaseId) {
    const existing = loadOpportunityCaseOnDb(db, args.livingOpportunityCaseId);
    if (existing) {
      // A repeat scan enriches the living case but cannot redefine the delivered trade.
      // Opening identity, frozen prices, Discord proof, lifecycle, and summary stay immutable.
      persisted = {
        ...existing,
        underlyingQuote: observation.underlyingQuote,
        chainMetadata: observation.chainMetadata,
        rejectedContracts: observation.rejectedContracts,
        marketRegime: observation.marketRegime,
        strategyEvaluations: observation.strategyEvaluations,
        ensembleDecision: observation.ensembleDecision,
        hardGateResults: observation.hardGateResults,
        probabilities: observation.probabilities,
        rank: observation.rank ?? existing.rank,
        rankExplanation: observation.rankExplanation ?? existing.rankExplanation,
        explanationPayload: observation.explanationPayload ?? existing.explanationPayload,
        dataLineage: [...new Set([...existing.dataLineage, ...observation.dataLineage])],
        configVersions: { ...existing.configVersions, ...observation.configVersions },
        selectedContract: existing.selectedContract ?? observation.selectedContract,
        updatedAtMs: observation.updatedAtMs,
        opportunityId: existing.opportunityId,
        opportunityFingerprint: existing.opportunityFingerprint,
        thesisFingerprint: existing.thesisFingerprint,
        sessionDate: existing.sessionDate,
        detectedAtMs: existing.detectedAtMs,
        createdAtMs: existing.createdAtMs,
        frozenTrade: existing.frozenTrade,
        acceptanceDecision: existing.acceptanceDecision,
        deliveryDecision: existing.deliveryDecision,
        deliveryReason: existing.deliveryReason,
        alertId: existing.alertId,
        discordDeliveryStatus: existing.discordDeliveryStatus,
        lifecycleStatus: existing.lifecycleStatus,
        summary: existing.summary,
        originalThesis: existing.originalThesis,
        discord: existing.discord,
        contractCandidates: existing.contractCandidates,
        contractUpdates: existing.contractUpdates,
      };
    }
  }

  persistOpportunityCaseOnDb(db, persisted);
  return persisted;
}
