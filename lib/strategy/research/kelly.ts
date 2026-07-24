/**
 * Kelly criterion — RESEARCH_ONLY. Never sizes or executes live trades.
 */
export type KellyStatus = "RESEARCH_ONLY" | "INSUFFICIENT_EVIDENCE";

export interface KellyInput {
  winProbability: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  estimationError: number | null;
  sampleSize: number;
  minSampleSize?: number;
}

export interface KellyResult {
  status: KellyStatus;
  fullKelly: number | null;
  fractionalKelly: number | null;
  fractionalPct: number;
  edge: number | null;
  reliable: boolean;
  warnings: string[];
  assumptions: string[];
}

const DEFAULT_MIN_SAMPLE = 30;
const DEFAULT_FRACTION = 0.25;
const MAX_KELLY = 0.5;

export function computeKellyResearch(input: KellyInput): KellyResult {
  const minN = input.minSampleSize ?? DEFAULT_MIN_SAMPLE;
  const warnings: string[] = [];
  const assumptions = [
    "Model-based research output — not personalized financial advice",
    "Does not determine subscriber trade size or execute orders",
    `Fractional Kelly at ${DEFAULT_FRACTION * 100}% of full Kelly by default`,
  ];

  if (input.sampleSize < minN) {
    return {
      status: "INSUFFICIENT_EVIDENCE",
      fullKelly: null,
      fractionalKelly: null,
      fractionalPct: DEFAULT_FRACTION,
      edge: null,
      reliable: false,
      warnings: [`Sample size ${input.sampleSize} below minimum ${minN}`],
      assumptions,
    };
  }
  if (input.winProbability == null || input.avgWinR == null || input.avgLossR == null) {
    return {
      status: "INSUFFICIENT_EVIDENCE",
      fullKelly: null,
      fractionalKelly: null,
      fractionalPct: DEFAULT_FRACTION,
      edge: null,
      reliable: false,
      warnings: ["Missing probability or payoff estimates"],
      assumptions,
    };
  }

  const p = input.winProbability;
  const q = 1 - p;
  const b = input.avgLossR !== 0 ? input.avgWinR / Math.abs(input.avgLossR) : 0;
  const edge = p * input.avgWinR + q * input.avgLossR;
  const fullKelly = b > 0 ? (p * b - q) / b : null;
  let reliable = fullKelly != null && fullKelly > 0;

  if (input.estimationError != null && input.estimationError > 0.15) {
    warnings.push("High estimation error makes Kelly unreliable");
    reliable = false;
  }
  if (fullKelly == null || fullKelly <= 0) {
    warnings.push("Non-positive edge — Kelly withheld");
    return { status: "INSUFFICIENT_EVIDENCE", fullKelly, fractionalKelly: null, fractionalPct: DEFAULT_FRACTION, edge, reliable: false, warnings, assumptions };
  }

  const capped = Math.min(fullKelly, MAX_KELLY);
  const fractionalKelly = +(capped * DEFAULT_FRACTION).toFixed(4);
  if (fullKelly > MAX_KELLY) warnings.push(`Full Kelly capped at ${MAX_KELLY * 100}%`);

  return {
    status: "RESEARCH_ONLY",
    fullKelly: +fullKelly.toFixed(4),
    fractionalKelly,
    fractionalPct: DEFAULT_FRACTION,
    edge: +edge.toFixed(4),
    reliable,
    warnings,
    assumptions,
  };
}
