/**
 * Enterprise orchestration — builds full Opportunity Case from options LIVE evaluation.
 */
import { adaptOptionsLiveToCase } from "./adapters/options-live.ts";
import { attachExplanationToCase } from "./explanation.ts";
import { attachRegimeToCase, regimeFromMarketContext } from "./regime.ts";
import { persistOpportunityCaseOnDb } from "./store.ts";
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
}

export function buildOpportunityCaseFromOptionsLive(args: BuildCaseInput): OpportunityCase {
  let c = adaptOptionsLiveToCase(args);
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
  const c = buildOpportunityCaseFromOptionsLive(args);
  persistOpportunityCaseOnDb(db, c);
  return c;
}
