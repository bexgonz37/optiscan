/**
 * Outcome-defined probability estimates with sample floors.
 * Never fabricates percentages — returns withheld when insufficient.
 */
import type { ProbabilityEstimate } from "./schema.ts";

export interface ProbabilityInput {
  outcomeDefinition: string;
  classification: ProbabilityEstimate["classification"];
  observedRate: number | null;
  sampleSize: number;
  minSampleSize?: number;
  effectiveSampleSize?: number | null;
  confidenceInterval?: [number, number] | null;
  cohortDefinition?: string;
  limitations?: string[];
}

const DEFAULT_MIN = 20;

export function buildProbabilityEstimate(input: ProbabilityInput): ProbabilityEstimate {
  const minN = input.minSampleSize ?? DEFAULT_MIN;
  const limitations = input.limitations ?? [];

  if (input.sampleSize < minN) {
    return {
      outcomeDefinition: input.outcomeDefinition,
      classification: input.classification,
      value: null,
      sampleSize: input.sampleSize,
      effectiveSampleSize: input.effectiveSampleSize ?? null,
      confidenceInterval: null,
      withheld: true,
      withholdReason: `Sample size ${input.sampleSize} below minimum ${minN}`,
      limitations: [...limitations, "INSUFFICIENT_EVIDENCE"],
    };
  }
  if (input.observedRate == null) {
    return {
      outcomeDefinition: input.outcomeDefinition,
      classification: input.classification,
      value: null,
      sampleSize: input.sampleSize,
      effectiveSampleSize: input.effectiveSampleSize ?? null,
      confidenceInterval: null,
      withheld: true,
      withholdReason: "No observed rate available",
      limitations: [...limitations, "INSUFFICIENT_EVIDENCE"],
    };
  }

  return {
    outcomeDefinition: input.outcomeDefinition,
    classification: input.classification,
    value: +input.observedRate.toFixed(4),
    sampleSize: input.sampleSize,
    effectiveSampleSize: input.effectiveSampleSize ?? input.sampleSize,
    confidenceInterval: input.confidenceInterval ?? null,
    withheld: false,
    withholdReason: null,
    limitations,
  };
}

export function probabilitiesCannotOverrideGate(): true {
  return true;
}
