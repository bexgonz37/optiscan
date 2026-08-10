/**
 * edge-shadow.ts — HISTORICAL_EDGE_SHADOW_V1. Advisory scoring from historical evidence.
 *
 * SHADOW ONLY. It ranks nothing that ships. It exists to be COMPARED against the live
 * baseline going forward, so that a hypothesis formed on history can be validated — or
 * killed — by evidence it did not see.
 *
 * ── The rule that shapes the whole design ────────────────────────────────────
 *
 *     MISSING EVIDENCE MUST NEVER BECOME A FAVOURABLE ZERO.
 *
 * The easy implementation gives an absent component the neutral value and sums. Under
 * that scheme a candidate with NO historical comparables scores the same as one with
 * twenty mediocre ones, and — worse — better than one with twenty bad ones. Absence
 * would systematically outrank measured disadvantage, and the model would learn to
 * prefer the unknown.
 *
 * So components are scored ONLY where evidence exists, the score is the mean of the
 * components that were actually available, and the number of missing components is
 * carried alongside as `evidenceQuality`. A score of 0.7 from two components and one
 * from nine are different claims and never collapse into one number.
 *
 * When the cohort itself is INSUFFICIENT_EVIDENCE the result is
 * `INSUFFICIENT_HISTORICAL_EVIDENCE` with a null score. Not a low score — a null. A low
 * score is a finding about the setup; a null is a finding about us.
 *
 * ── What it rewards ──────────────────────────────────────────────────────────
 *
 * Pre-move edge, not direction accuracy. A setup found before the move with room left
 * outranks one found after the move with a better historical hit rate, because the
 * second is unbuyable by the time we see it.
 */
import type { CohortV2Result } from "./cohort-v2.ts";
import type { PreMoveReplayResult } from "./pre-move-replay.ts";

export const EDGE_SHADOW_VERSION = "HISTORICAL_EDGE_SHADOW_V1" as const;

export type EdgeShadowState =
  | "SCORED"
  | "INSUFFICIENT_HISTORICAL_EVIDENCE"
  | "NO_COMPARABLE_COHORT";

export interface EdgeComponent {
  name: string;
  /** 0..1, higher is better. Null when the evidence for this component is absent. */
  value: number | null;
  weight: number;
  basis: string;
}

export interface EdgeShadowResult {
  version: typeof EDGE_SHADOW_VERSION;
  state: EdgeShadowState;
  /** 0..1. NULL — never 0 — when evidence is insufficient. */
  score: number | null;
  /** Components that actually had evidence, over the number defined. */
  componentsScored: number;
  componentsDefined: number;
  components: EdgeComponent[];
  cohortId: string | null;
  cohortEvents: number;
  cohortSessions: number;
  evidenceQuality: "COMPLETE" | "PARTIAL" | "INSUFFICIENT";
  advisoryOnly: true;
  reason: string;
  warnings: string[];
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Map a value onto 0..1 by where it sits between two reference points. */
function scale(v: number | null | undefined, lo: number, hi: number): number | null {
  if (v == null || !Number.isFinite(v) || hi === lo) return null;
  return clamp01((v - lo) / (hi - lo));
}

/** Discovery stage as an ordinal preference. The core of "find them before they run". */
function stageScore(stage: string | null | undefined): number | null {
  switch (stage) {
    case "PRE_TRIGGER": return 1;
    case "EARLY_CONFIRMATION": return 0.85;
    case "EARLY_EXPANSION": return 0.6;
    case "MATURE_MOVE": return 0.25;
    case "TOO_LATE": return 0;
    // UNGRADABLE is not a stage, it is an admission. Scoring it would turn "we could not
    // tell" into a mild preference.
    default: return null;
  }
}

export interface EdgeShadowInput {
  /** The comparable cohort. Null when none could be formed. */
  cohort: CohortV2Result | null;
  /** Replay- or live-derived discovery state for the candidate. */
  discovery?: Pick<PreMoveReplayResult, "stage" | "rewardRemainingFraction" | "premiumExpansionConsumedPct" | "marketAlignment" | "spreadPct"> | null;
  /** Contract liquidity at decision time. */
  contract?: { spreadPct?: number | null; openInterest?: number | null; volume?: number | null } | null;
}

/**
 * Score one candidate.
 *
 * The weights are declared, not learned. A fitted weight vector over a handful of
 * historical events would be an overfit dressed as a model, and this is explicitly a
 * hypothesis generator whose job is to be tested forward.
 */
export function scoreHistoricalEdgeShadow(input: EdgeShadowInput): EdgeShadowResult {
  const warnings: string[] = [];
  const cohort = input.cohort;

  if (!cohort) {
    return {
      version: EDGE_SHADOW_VERSION,
      state: "NO_COMPARABLE_COHORT",
      score: null, componentsScored: 0, componentsDefined: 0, components: [],
      cohortId: null, cohortEvents: 0, cohortSessions: 0,
      evidenceQuality: "INSUFFICIENT", advisoryOnly: true,
      reason: "no comparable historical cohort could be formed for this candidate",
      warnings,
    };
  }

  const supported = cohort.floors.verdict === "SUPPORTED";
  const p25 = cohort.milestones.find((m) => m.milestone === 25)?.probability ?? null;
  const p100 = cohort.milestones.find((m) => m.milestone === 100)?.probability ?? null;

  const components: EdgeComponent[] = [
    {
      name: "empiricalExpectancy",
      // −50%..+50% realized expectancy spans the plausible range for this lane.
      value: supported ? scale(cohort.expectedReturnPct, -50, 50) : null,
      weight: 2,
      basis: "cohort mean realized-equivalent return",
    },
    {
      name: "milestoneProbability",
      value: supported ? scale(p25, 0, 0.6) : null,
      weight: 2,
      basis: "cohort P(+25%) after entry",
    },
    {
      name: "tailUpside",
      value: supported ? scale(p100, 0, 0.25) : null,
      weight: 1,
      basis: "cohort P(+100%) — asymmetric upside, weighted below the base rate",
    },
    {
      name: "expectedDownside",
      // Less negative MAE is better, so the scale is inverted.
      value: supported ? scale(cohort.expectedMaePct, -80, 0) : null,
      weight: 1,
      basis: "cohort mean adverse excursion",
    },
    {
      name: "discoveryStage",
      value: stageScore(input.discovery?.stage),
      weight: 3,
      basis: "PRE_TRIGGER and EARLY outrank MATURE and TOO_LATE — the point is finding them before they run",
    },
    {
      name: "rewardRemaining",
      value: input.discovery?.rewardRemainingFraction ?? null,
      weight: 2,
      basis: "share of the session's favourable extent still unspent (advisory, not a forecast)",
    },
    {
      name: "premiumNotYetConsumed",
      // 0% expansion is ideal; +60% before we look is a chase.
      value: input.discovery?.premiumExpansionConsumedPct == null
        ? null
        : clamp01(1 - clamp01(input.discovery.premiumExpansionConsumedPct / 60)),
      weight: 2,
      basis: "premium already paid for before the decision — high means chasing",
    },
    {
      name: "contractQuality",
      value: (() => {
        const s = input.contract?.spreadPct ?? input.discovery?.spreadPct ?? null;
        if (s == null) return null;
        // 1% spread is excellent, 15% is unusable.
        return clamp01(1 - clamp01((s - 1) / 14));
      })(),
      weight: 2,
      basis: "quoted spread at decision time — execution cost is not a detail on a 0DTE contract",
    },
    {
      name: "liquidity",
      value: (() => {
        const oi = input.contract?.openInterest ?? null;
        const vol = input.contract?.volume ?? null;
        if (oi == null && vol == null) return null;
        return clamp01(Math.max(scale(oi, 0, 5000) ?? 0, scale(vol, 0, 2000) ?? 0));
      })(),
      weight: 1,
      basis: "open interest / contract volume",
    },
    {
      name: "marketAlignment",
      value: (() => {
        switch (input.discovery?.marketAlignment) {
          case "ALIGNED": return 1;
          case "MIXED": return 0.5;
          case "COUNTER_TREND": return 0.15;
          // UNKNOWN means we could not see the tape. Scoring it as neutral would reward
          // a blind spot.
          default: return null;
        }
      })(),
      weight: 1,
      basis: "does the broad tape agree with the trade's direction",
    },
    {
      name: "evidenceStrength",
      value: supported ? scale(cohort.floors.events, 20, 200) : null,
      weight: 1,
      basis: "how much history the cohort actually rests on",
    },
  ];

  const scored = components.filter((c) => c.value != null);
  const componentsDefined = components.length;

  if (!supported) {
    return {
      version: EDGE_SHADOW_VERSION,
      state: "INSUFFICIENT_HISTORICAL_EVIDENCE",
      // NULL, not a low score. A low score is a finding about the setup; a null is a
      // finding about us.
      score: null,
      componentsScored: scored.length,
      componentsDefined,
      components,
      cohortId: cohort.cohortId,
      cohortEvents: cohort.floors.events,
      cohortSessions: cohort.floors.independentSessions,
      evidenceQuality: "INSUFFICIENT",
      advisoryOnly: true,
      reason: `cohort did not clear the evidence floors: ${cohort.floors.reason}`,
      warnings: [...cohort.robustness.warnings],
    };
  }

  // Mean over AVAILABLE components only. Treating an absent component as neutral would
  // let a candidate with no evidence outrank one with measured disadvantage.
  const totalWeight = scored.reduce((a, c) => a + c.weight, 0);
  const score = totalWeight > 0
    ? +(scored.reduce((a, c) => a + (c.value as number) * c.weight, 0) / totalWeight).toFixed(4)
    : null;

  const coverage = scored.length / componentsDefined;
  const evidenceQuality = coverage >= 0.85 ? "COMPLETE" : coverage >= 0.5 ? "PARTIAL" : "INSUFFICIENT";
  if (coverage < 0.5) {
    warnings.push(`only ${scored.length}/${componentsDefined} components had evidence; the score rests on very little`);
  }
  warnings.push(...cohort.robustness.warnings);
  if (cohort.robustness.survivesBestExcluded === false) {
    warnings.push("the cohort's edge does not survive removing its single best event");
  }

  return {
    version: EDGE_SHADOW_VERSION,
    state: "SCORED",
    score,
    componentsScored: scored.length,
    componentsDefined,
    components,
    cohortId: cohort.cohortId,
    cohortEvents: cohort.floors.events,
    cohortSessions: cohort.floors.independentSessions,
    evidenceQuality,
    advisoryOnly: true,
    reason:
      `scored from ${scored.length}/${componentsDefined} components over a cohort of `
      + `${cohort.floors.events} events across ${cohort.floors.independentSessions} sessions. `
      + "ADVISORY ONLY — historical replay initializes a hypothesis; only forward evidence validates it.",
    warnings,
  };
}

export interface BaselineVsShadow {
  opportunityCaseId: string;
  symbol: string;
  baselineRank: number | null;
  shadowScore: number | null;
  shadowState: EdgeShadowState;
  agreement: "AGREE" | "SHADOW_PREFERS" | "BASELINE_PREFERS" | "UNCOMPARABLE";
  note: string;
}

/**
 * Pair a live baseline rank with a shadow score for later comparison.
 *
 * `UNCOMPARABLE` is its own outcome and is NOT counted as agreement. A pair where the
 * shadow had no evidence tells us nothing about either model, and folding it into
 * "agree" would make the shadow look increasingly correct as its coverage got worse.
 */
export function compareBaselineToShadow(
  input: { opportunityCaseId: string; symbol: string; baselineRank: number | null; shadow: EdgeShadowResult },
  opts: { baselineRankScale?: number } = {},
): BaselineVsShadow {
  const { baselineRank, shadow } = input;
  if (shadow.state !== "SCORED" || shadow.score == null || baselineRank == null) {
    return {
      opportunityCaseId: input.opportunityCaseId,
      symbol: input.symbol,
      baselineRank,
      shadowScore: shadow.score,
      shadowState: shadow.state,
      agreement: "UNCOMPARABLE",
      note: "no shadow score or no baseline rank; this pair says nothing about either model",
    };
  }
  // Baseline rank is 1-based and lower is better; normalize onto the shadow's 0..1.
  const scaleN = Math.max(2, opts.baselineRankScale ?? 20);
  const baselineScore = clamp01(1 - (baselineRank - 1) / (scaleN - 1));
  const delta = shadow.score - baselineScore;
  const agreement = Math.abs(delta) < 0.1
    ? "AGREE"
    : delta > 0 ? "SHADOW_PREFERS" : "BASELINE_PREFERS";
  return {
    opportunityCaseId: input.opportunityCaseId,
    symbol: input.symbol,
    baselineRank,
    shadowScore: shadow.score,
    shadowState: shadow.state,
    agreement,
    note: `baseline ${baselineScore.toFixed(3)} vs shadow ${shadow.score.toFixed(3)} (delta ${delta.toFixed(3)})`,
  };
}
