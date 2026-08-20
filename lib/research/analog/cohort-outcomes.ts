/**
 * cohort-outcomes.ts — ANALOG_OUTCOME_V1. What a retrieved cohort is allowed to say.
 *
 * ── The claim is gated by the class, not by the caller ───────────────────────
 *
 * The whole point of the evidence taxonomy is that permission lives with the evidence.
 * `underlyingOutcomeDistribution` works on any class that observed an underlying path.
 * `optionOutcomeDistribution` THROWS on a class whose option leg was never quoted —
 * HISTORICAL_UNDERLYING_ONLY, MODELED_OPTION, SHADOW_OBSERVATION. It does not return a
 * degraded number, it does not return null with a warning; it refuses, because a caller
 * that has already decided to render "68%" will render whatever it is handed.
 *
 * This matters concretely and immediately: the analog corpus in production is 11,679
 * labels, 100% REAL_UNDERLYING, zero option outcomes. Every option probability this
 * engine could be asked for today is one it must refuse.
 *
 * ── Abstention floors are inherited, not invented ────────────────────────────
 *
 *     >= 20 observations AND >= 5 INDEPENDENT TRADING SESSIONS
 *
 * These are not new numbers. They are `MIN_TRADES_FOR_PROBABILITY` /
 * `MIN_SESSIONS_FOR_PROBABILITY` from `options/cohort-probability.ts` and the identical
 * `V2_MIN_EVENTS` / `V2_MIN_SESSIONS` from `historical/cohort-v2.ts`, which are the floors
 * every other evidence surface in OptiScan already clears. Choosing a third standard here
 * would mean the same sample was sufficient on one page and insufficient on another.
 *
 * The session floor is the one that does the work. Twenty observations from one frantic
 * Tuesday is one observation of one afternoon, and `countIndependentSessions` refuses to
 * count a weekend or a holiday toward it.
 *
 * ── Censored stays censored ──────────────────────────────────────────────────
 *
 * An analog whose outcome is null is counted in `censoredCount` and excluded from every
 * rate. It is never zero, never "no move", never dropped silently. A rate whose
 * denominator quietly shed its unresolved cases is the oldest way to make a strategy look
 * decisive.
 *
 * ── Concentration is reported next to the number ─────────────────────────────
 *
 * The production corpus is three tickers. A cohort drawn from it can clear both floors and
 * still be one company's 2024. `concentration` travels with the estimate so the reader
 * never has to go looking for the reason a number is fragile.
 */
import { countIndependentSessions, TRADING_SESSION_CALENDAR_VERSION } from "../historical/trading-sessions.ts";
import {
  evidenceClassSpec,
  optionReturnProbabilityAllowed,
  underlyingReturnClaimAllowed,
  type AnalogEvidenceClass,
} from "./evidence-class.ts";
import { ANALOG_FEATURE_VECTOR_VERSION } from "./feature-vector.ts";
import { ANALOG_RETRIEVAL_VERSION, type RetrievalResult } from "./retrieval.ts";

export const ANALOG_OUTCOME_VERSION = "ANALOG_OUTCOME_V1";

/** Inherited from options/cohort-probability.ts and historical/cohort-v2.ts. */
export const ANALOG_MIN_OBSERVATIONS = 20;
export const ANALOG_MIN_INDEPENDENT_SESSIONS = 5;

export type EvidenceVerdict = "SUPPORTED" | "INSUFFICIENT_EVIDENCE";

export interface EvidenceQuality {
  verdict: EvidenceVerdict;
  reason: string;
  /** Everything the fence admitted. */
  eligibleSample: number;
  /** Analogs actually retrieved after caps. */
  retrievedSample: number;
  /** Retrieved analogs carrying a resolved outcome — the denominator of every rate. */
  labeledSample: number;
  /** Retrieved analogs whose outcome is unresolved. Never enters a rate. */
  censoredCount: number;
  independentSessions: number;
  sessionCalendarVersion: string;
  rejectedSessionDates: Array<{ date: string; reason: string; holiday: string | null }>;
  minObservations: number;
  minIndependentSessions: number;
  evidenceClass: AnalogEvidenceClass;
  exactOptionEvidence: boolean;
  temporality: "FORWARD" | "HISTORICAL";
  concentration: {
    distinctSymbols: number;
    distinctTradingDays: number;
    topSymbolShare: number;
    symbolScope: RetrievalResult["composition"]["symbolScope"];
    sameSymbol: number;
    crossSymbol: number;
  };
  meanFeatureCoverage: number;
  versions: {
    outcome: string;
    retrieval: string;
    featureVector: string;
    evidenceClassTaxonomy: string;
  };
}

/** A milestone probability. `probability` is null whenever the cohort abstains. */
export interface MilestoneEstimate {
  thresholdPct: number;
  withinMs: number | null;
  reached: number;
  of: number;
  probability: number | null;
  verdict: EvidenceVerdict;
}

export interface OutcomeDistribution {
  kind: "UNDERLYING" | "OPTION";
  evidenceClass: AnalogEvidenceClass;
  quality: EvidenceQuality;
  /** All null when the cohort abstains. */
  median: number | null;
  mean: number | null;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
  winRate: number | null;
  milestones: MilestoneEstimate[];
  researchAuthority: "RESEARCH_ONLY";
  calibration: "NOT_CALIBRATED_FOR_LIVE_AUTHORITY";
}

/** Thrown when a class without exact option evidence is asked for an option return. */
export class OptionClaimNotPermittedError extends Error {
  readonly evidenceClass: AnalogEvidenceClass;
  constructor(cls: AnalogEvidenceClass) {
    super(
      `evidence class ${cls} cannot produce an option-return probability: ${evidenceClassSpec(cls).description} ` +
        "Converting an underlying or modeled move into an option return manufactures a fill that was never quoted.",
    );
    this.name = "OptionClaimNotPermittedError";
    this.evidenceClass = cls;
  }
}

export interface OutcomeInput {
  /** Retrieval output — supplies the cohort, its composition and its versions. */
  retrieval: RetrievalResult;
  evidenceClass: AnalogEvidenceClass;
  /** Milestones to estimate, in percent. */
  milestones?: number[];
  minObservations?: number;
  minIndependentSessions?: number;
}

function assessQuality(input: OutcomeInput): EvidenceQuality {
  const { retrieval } = input;
  const minObs = input.minObservations ?? ANALOG_MIN_OBSERVATIONS;
  const minSes = input.minIndependentSessions ?? ANALOG_MIN_INDEPENDENT_SESSIONS;
  const spec = evidenceClassSpec(input.evidenceClass);

  const labeled = retrieval.analogs.filter((a) => a.outcome !== null);
  const sessionCount = countIndependentSessions(labeled.map((a) => a.tradingDay));

  const reasons: string[] = [];
  if (labeled.length < minObs) reasons.push(`${labeled.length} resolved analogs < ${minObs}`);
  if (sessionCount.independentSessions < minSes) {
    reasons.push(`${sessionCount.independentSessions} independent sessions < ${minSes}`);
  }
  const verdict: EvidenceVerdict = reasons.length === 0 ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE";

  return {
    verdict,
    reason: verdict === "SUPPORTED"
      ? `${labeled.length} resolved analogs over ${sessionCount.independentSessions} independent sessions`
      : reasons.join("; "),
    eligibleSample: retrieval.eligibleCount,
    retrievedSample: retrieval.retrievedCount,
    labeledSample: labeled.length,
    censoredCount: retrieval.retrievedCount - labeled.length,
    independentSessions: sessionCount.independentSessions,
    sessionCalendarVersion: TRADING_SESSION_CALENDAR_VERSION,
    rejectedSessionDates: sessionCount.rejected.map((r) => ({ date: r.date, reason: r.reason, holiday: r.holiday })),
    minObservations: minObs,
    minIndependentSessions: minSes,
    evidenceClass: input.evidenceClass,
    exactOptionEvidence: spec.exactOptionEvidence,
    temporality: spec.temporality,
    concentration: {
      distinctSymbols: retrieval.composition.distinctSymbols,
      distinctTradingDays: retrieval.composition.distinctTradingDays,
      topSymbolShare: retrieval.composition.topSymbolShare,
      symbolScope: retrieval.composition.symbolScope,
      sameSymbol: retrieval.composition.sameSymbol,
      crossSymbol: retrieval.composition.crossSymbol,
    },
    meanFeatureCoverage: retrieval.meanCoverage,
    versions: {
      outcome: ANALOG_OUTCOME_VERSION,
      retrieval: ANALOG_RETRIEVAL_VERSION,
      featureVector: ANALOG_FEATURE_VECTOR_VERSION,
      evidenceClassTaxonomy: "ANALOG_EVIDENCE_CLASS_V1",
    },
  };
}

function pct(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return +sorted[i].toFixed(6);
}

function distribute(input: OutcomeInput, kind: "UNDERLYING" | "OPTION"): OutcomeDistribution {
  const quality = assessQuality(input);
  const labeled = input.retrieval.analogs.filter((a) => a.outcome !== null).map((a) => a.outcome as number);
  const milestoneThresholds = input.milestones ?? [10, 25, 50, 100];

  // Abstain: every estimate is null, but the counts remain visible so the reader can see
  // exactly how far short the sample fell.
  if (quality.verdict === "INSUFFICIENT_EVIDENCE") {
    return {
      kind,
      evidenceClass: input.evidenceClass,
      quality,
      median: null, mean: null, p10: null, p25: null, p75: null, p90: null, winRate: null,
      milestones: milestoneThresholds.map((t) => ({
        thresholdPct: t,
        withinMs: null,
        reached: labeled.filter((o) => o >= t).length,
        of: labeled.length,
        probability: null,
        verdict: "INSUFFICIENT_EVIDENCE" as const,
      })),
      researchAuthority: "RESEARCH_ONLY",
      calibration: "NOT_CALIBRATED_FOR_LIVE_AUTHORITY",
    };
  }

  const sorted = [...labeled].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    kind,
    evidenceClass: input.evidenceClass,
    quality,
    median: pct(sorted, 0.5),
    mean: +(sorted.reduce((a, x) => a + x, 0) / n).toFixed(6),
    p10: pct(sorted, 0.1),
    p25: pct(sorted, 0.25),
    p75: pct(sorted, 0.75),
    p90: pct(sorted, 0.9),
    winRate: +(sorted.filter((o) => o > 0).length / n).toFixed(4),
    milestones: milestoneThresholds.map((t) => {
      const reached = sorted.filter((o) => o >= t).length;
      return {
        thresholdPct: t,
        withinMs: null,
        reached,
        of: n,
        probability: +(reached / n).toFixed(4),
        verdict: "SUPPORTED" as const,
      };
    }),
    researchAuthority: "RESEARCH_ONLY",
    calibration: "NOT_CALIBRATED_FOR_LIVE_AUTHORITY",
  };
}

/**
 * Underlying / setup outcome statistics. Permitted for every class that observed an
 * underlying path; refused for SHADOW_OBSERVATION, which is not an outcome population.
 */
export function underlyingOutcomeDistribution(input: OutcomeInput): OutcomeDistribution {
  if (!underlyingReturnClaimAllowed(input.evidenceClass)) {
    throw new Error(
      `evidence class ${input.evidenceClass} does not carry underlying outcome evidence: ${evidenceClassSpec(input.evidenceClass).description}`,
    );
  }
  return distribute(input, "UNDERLYING");
}

/**
 * Option-return statistics. THROWS for any class whose option leg was not observed on a
 * real quote. This is requirement "underlying-only evidence never produces an
 * option-return probability", enforced structurally.
 */
export function optionOutcomeDistribution(input: OutcomeInput): OutcomeDistribution {
  if (!optionReturnProbabilityAllowed(input.evidenceClass)) {
    throw new OptionClaimNotPermittedError(input.evidenceClass);
  }
  return distribute(input, "OPTION");
}

/**
 * The safe entry point for a research surface: returns whichever distributions the class
 * actually supports, and names the ones it refused. Nothing here throws, so a page can
 * render an honest "this cannot be computed" instead of a 500.
 */
export function availableOutcomeDistributions(input: OutcomeInput): {
  underlying: OutcomeDistribution | null;
  option: OutcomeDistribution | null;
  refused: Array<{ kind: "UNDERLYING" | "OPTION"; reason: string }>;
} {
  const refused: Array<{ kind: "UNDERLYING" | "OPTION"; reason: string }> = [];
  let underlying: OutcomeDistribution | null = null;
  let option: OutcomeDistribution | null = null;

  if (underlyingReturnClaimAllowed(input.evidenceClass)) underlying = distribute(input, "UNDERLYING");
  else refused.push({ kind: "UNDERLYING", reason: `${input.evidenceClass} carries no underlying outcome evidence` });

  if (optionReturnProbabilityAllowed(input.evidenceClass)) option = distribute(input, "OPTION");
  else {
    refused.push({
      kind: "OPTION",
      reason: `${input.evidenceClass} has no exact option evidence; an option-return probability cannot be derived from it`,
    });
  }
  return { underlying, option, refused };
}
