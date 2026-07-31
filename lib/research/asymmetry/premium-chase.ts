/**
 * High-Asymmetry Radar — premium-chase analysis. PURE, diagnostic-only.
 *
 * Question answered: by the time we detected this candidate, how much of the
 * premium had ALREADY expanded? Measured from the EARLIEST valid executable
 * quote for the exact same OCC contract in the same session, to the ask at the
 * candidate timestamp.
 *
 * "Earliest valid" means earliest by quote event time among quotes that survive
 * `validateExecutableQuote`. A stale, undated, future, after-hours,
 * wrong-session, or wrong-OCC observation cannot become the baseline, so the
 * chase figure can never be inflated by a quote we could not have traded.
 *
 * This module produces a bucket and nothing else. Phase 1 does not block, gate,
 * rank, or alter any live alert on the strength of it.
 */
import { round, validateExecutableQuote, type AsymmetryQuoteObservation, type QuoteRejection } from "./evidence.ts";

export type PremiumChaseBucket =
  | "UNDER_10"
  | "PCT_10_15"
  | "PCT_15_20"
  | "PCT_20_25"
  | "OVER_25"
  | "UNKNOWN";

export const PREMIUM_CHASE_BUCKETS: PremiumChaseBucket[] = [
  "UNDER_10", "PCT_10_15", "PCT_15_20", "PCT_20_25", "OVER_25", "UNKNOWN",
];

export interface PremiumChaseAnalysis {
  bucket: PremiumChaseBucket;
  chasePct: number | null;
  earliestQuoteAtMs: number | null;
  earliestAsk: number | null;
  earliestQuoteSource: string | null;
  candidateAsk: number | null;
  /** Every observation refused, with the reason. Nothing is silently dropped. */
  rejected: Array<{ atMs: number; source: string; reason: QuoteRejection }>;
  /** Non-null when the analysis could not be performed at all. */
  limitation: string | null;
}

/** Fixed reporting buckets. Diagnostics, not thresholds — nothing acts on them. */
export function premiumChaseBucket(chasePct: number | null): PremiumChaseBucket {
  if (chasePct == null || !Number.isFinite(chasePct)) return "UNKNOWN";
  if (chasePct < 10) return "UNDER_10";
  if (chasePct < 15) return "PCT_10_15";
  if (chasePct < 20) return "PCT_15_20";
  if (chasePct < 25) return "PCT_20_25";
  return "OVER_25";
}

export function analyzePremiumChase(input: {
  occSymbol: string | null;
  candidateAtMs: number;
  candidateAsk: number | null;
  /** Observations at or before the candidate timestamp, any order. */
  priorQuotes: AsymmetryQuoteObservation[];
  maxQuoteAgeMs?: number;
  env?: NodeJS.ProcessEnv;
}): PremiumChaseAnalysis {
  const maxQuoteAgeMs = input.maxQuoteAgeMs ?? 60_000;
  const rejected: PremiumChaseAnalysis["rejected"] = [];
  const empty = (limitation: string): PremiumChaseAnalysis => ({
    bucket: "UNKNOWN", chasePct: null, earliestQuoteAtMs: null, earliestAsk: null,
    earliestQuoteSource: null, candidateAsk: input.candidateAsk ?? null, rejected, limitation,
  });

  if (!input.occSymbol) return empty("No verified exact OCC contract; premium chase cannot be measured.");
  if (!Number.isFinite(input.candidateAtMs)) return empty("Candidate timestamp is unusable.");
  if (input.candidateAsk == null || !Number.isFinite(input.candidateAsk) || input.candidateAsk <= 0) {
    return empty("No executable ask at the candidate timestamp.");
  }

  const accepted = [...input.priorQuotes]
    .filter((observation) => observation.atMs <= input.candidateAtMs)
    .sort((a, b) => a.atMs - b.atMs)
    .map((observation) => ({
      observation,
      quote: validateExecutableQuote({
        occSymbol: observation.occSymbol,
        expectedOccSymbol: input.occSymbol,
        atMs: observation.atMs,
        bid: observation.bid,
        ask: observation.ask,
        quoteTimestampMs: observation.quoteTimestampMs,
        referenceAtMs: input.candidateAtMs,
        maxQuoteAgeMs,
        env: input.env,
      }),
    }));

  for (const row of accepted) {
    if (!row.quote.valid && row.quote.reason) {
      rejected.push({ atMs: row.observation.atMs, source: row.observation.source, reason: row.quote.reason });
    }
  }

  const earliest = accepted.find((row) => row.quote.valid && row.quote.ask != null && row.quote.ask > 0);
  if (!earliest) return empty("No earlier valid executable exact-OCC quote exists in this session.");

  const earliestAsk = earliest.quote.ask as number;
  const chasePct = round(((input.candidateAsk - earliestAsk) / earliestAsk) * 100, 4);
  return {
    bucket: premiumChaseBucket(chasePct),
    chasePct,
    earliestQuoteAtMs: earliest.observation.atMs,
    earliestAsk,
    earliestQuoteSource: earliest.observation.source,
    candidateAsk: input.candidateAsk,
    rejected,
    limitation: null,
  };
}

/** Counts per bucket for the diagnostics endpoint. Every bucket is always present. */
export function premiumChaseDistribution(analyses: PremiumChaseAnalysis[]): Record<PremiumChaseBucket, number> {
  const counts = Object.fromEntries(PREMIUM_CHASE_BUCKETS.map((b) => [b, 0])) as Record<PremiumChaseBucket, number>;
  for (const analysis of analyses) counts[analysis.bucket] += 1;
  return counts;
}
