/**
 * Monte Carlo scenario analysis — RESEARCH_ONLY. Never presented as certainty.
 */
export type MonteCarloStatus = "RESEARCH_ONLY" | "INSUFFICIENT_DATA";

export interface MonteCarloInput {
  sampleReturns: number[];
  simulations: number;
  seed?: number;
  horizonBars?: number;
  driftAssumption?: number;
  volatilityMethod?: string;
}

export interface MonteCarloResult {
  status: MonteCarloStatus;
  simulations: number;
  seed: number;
  assumptions: string[];
  warnings: string[];
  distribution: {
    mean: number | null;
    median: number | null;
    p05: number | null;
    p95: number | null;
    stdDev: number | null;
  };
  convergenceOk: boolean;
}

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[idx];
}

export function runMonteCarloResearch(input: MonteCarloInput): MonteCarloResult {
  const assumptions = [
    "RESEARCH_ONLY — simulated probability, not observed historical frequency",
    "Empirical resampling from provided return sample — normal distribution NOT assumed",
    `Volatility method: ${input.volatilityMethod ?? "empirical_sample"}`,
    `Drift assumption: ${input.driftAssumption ?? 0}`,
  ];
  const warnings: string[] = [];

  if (input.sampleReturns.length < 30) {
    return {
      status: "INSUFFICIENT_DATA",
      simulations: 0,
      seed: input.seed ?? 0,
      assumptions,
      warnings: [`Sample size ${input.sampleReturns.length} below minimum 30`],
      distribution: { mean: null, median: null, p05: null, p95: null, stdDev: null },
      convergenceOk: false,
    };
  }

  const sims = Math.min(Math.max(input.simulations, 100), 10_000);
  const seed = input.seed ?? 42;
  const rng = mulberry32(seed);
  const horizon = input.horizonBars ?? 1;
  const outcomes: number[] = [];

  for (let i = 0; i < sims; i++) {
    let path = 0;
    for (let h = 0; h < horizon; h++) {
      const idx = Math.floor(rng() * input.sampleReturns.length);
      path += input.sampleReturns[idx] + (input.driftAssumption ?? 0);
    }
    outcomes.push(path);
  }

  outcomes.sort((a, b) => a - b);
  const mean = outcomes.reduce((a, b) => a + b, 0) / outcomes.length;
  const variance = outcomes.reduce((a, b) => a + (b - mean) ** 2, 0) / outcomes.length;

  return {
    status: "RESEARCH_ONLY",
    simulations: sims,
    seed,
    assumptions,
    warnings,
    distribution: {
      mean: +mean.toFixed(6),
      median: +percentile(outcomes, 0.5).toFixed(6),
      p05: +percentile(outcomes, 0.05).toFixed(6),
      p95: +percentile(outcomes, 0.95).toFixed(6),
      stdDev: +Math.sqrt(variance).toFixed(6),
    },
    convergenceOk: sims >= 1000,
  };
}
