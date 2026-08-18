/**
 * The `OWNER_SELECTION_STRENGTH_GATE_V1` scoreboard: the frozen rule, applied to real owner
 * callouts, with the in-sample window and the prospective window kept strictly apart.
 *
 * WHY THE SPLIT IS THE WHOLE POINT
 *
 * The rule was read off sessions 2026-08-10..2026-08-18. Scoring it against those same
 * sessions describes them; it cannot fail. The only measurement that can fail is the one made
 * on outcomes that closed AFTER the rule was frozen, which is why `prospective` is computed
 * from `prospectiveStartDate` forward and why its verdict — not the in-sample one — is what
 * `status` is derived from. In-sample numbers are still reported, because hiding the
 * flattering number is its own kind of dishonesty, but they are labelled and they gate nothing.
 *
 * EVIDENCE FLOOR: 20 closed prospective outcomes across 5 independent sessions, matching the
 * probability gate's existing floors rather than inventing a friendlier pair. Sessions are
 * counted with `countIndependentSessions`, which validates each date — a weekend or a corrupt
 * epoch produces a well-formed YYYY-MM-DD that would otherwise clear the floor unchallenged.
 *
 * NO PROMOTION. `deriveStatus` can return READY_FOR_HUMAN_REVIEW and nothing beyond it. There
 * is no SUBSCRIBER_APPROVED in the vocabulary and no code path here writes live configuration.
 *
 * READ-ONLY. This module issues no INSERT/UPDATE/DELETE and no provider call.
 */

import { tradingDay } from "../../trading-session.ts";
import {
  buildOwnerLearningReportOnDb,
  type OwnerLearningDb,
  type OwnerLearningRow,
} from "./owner-learning.ts";
import { countIndependentSessions } from "../historical/trading-sessions.ts";
import {
  simulate,
  EXPERIMENT_ID,
  EXPERIMENT_VERSION,
  EXPERIMENT_MODE,
  SELECTION_STRENGTH_FLOOR,
  type StrengthOutcomeRow,
  type StrengthSimulation,
} from "./owner-selection-strength-experiment.ts";
import {
  OWNER_SELECTION_STRENGTH_GATE_V1,
  checkOwnerSelectionStrengthFrozen,
  type ExperimentStatus,
  type FrozenCheck,
} from "./experiment-registry.ts";

/** Closed prospective outcomes required before any verdict beyond INSUFFICIENT_EVIDENCE. */
export const MIN_CLOSED_PROSPECTIVE_OUTCOMES = 20;
/** Independent, validated trading sessions required alongside them. */
export const MIN_INDEPENDENT_SESSIONS = 5;

/** Statuses this scoreboard may report. Deliberately excludes any form of approval. */
export type ScoreboardVerdict =
  | "INSUFFICIENT_EVIDENCE"
  | "PROMISING"
  | "WEAKENING"
  | "FAILED"
  | "READY_FOR_HUMAN_REVIEW";

/** Map an owner learning row onto the experiment's input. No value is derived or defaulted. */
export function toOutcomeRow(r: OwnerLearningRow): StrengthOutcomeRow {
  return {
    opportunityCaseId: r.opportunityCaseId,
    sessionDate: r.sessionDate,
    symbol: r.symbol,
    // The frozen contract is authoritative. A mirror on a different strike is a different
    // trade, and `occExact` is what keeps its return out of every arm.
    optionSymbol: r.frozenOptionSymbol ?? r.optionSymbol,
    side: r.side,
    strategyKey: r.strategyKey,
    selectionStrength: r.selection.selectionStrength,
    realizedReturnPct: r.realizedReturnPct,
    occExact: r.occExact,
  };
}

export interface WindowResult {
  label: "IN_SAMPLE" | "PROSPECTIVE";
  /** ET session bounds, inclusive. Null end means "through the latest closed session". */
  fromSessionDate: string | null;
  toSessionDate: string | null;
  closedOutcomes: number;
  independentSessions: number;
  /** What `countIndependentSessions` refused, so a rejected date is visible not silent. */
  rejectedSessionDates: string[];
  simulation: StrengthSimulation;
}

export interface EvidenceGate {
  met: boolean;
  closedOutcomes: number;
  requiredClosedOutcomes: number;
  independentSessions: number;
  requiredIndependentSessions: number;
  shortfall: string | null;
}

export interface StrengthScoreboard {
  experimentId: typeof EXPERIMENT_ID;
  experimentVersion: typeof EXPERIMENT_VERSION;
  mode: typeof EXPERIMENT_MODE;
  floor: number;
  definitionFrozen: FrozenCheck;
  /** The frozen record: hypothesis, caveats, disproof rule, hash, SHAs. */
  frozen: typeof OWNER_SELECTION_STRENGTH_GATE_V1;

  /** Sessions the rule was read from. Reported, never used to derive `verdict`. */
  inSample: WindowResult;
  /** Outcomes that closed after the rule was frozen. The only window that can fail it. */
  prospective: WindowResult;

  evidence: EvidenceGate;
  verdict: ScoreboardVerdict;
  verdictReason: string;
  /** What `verdict` is NOT. Rendered alongside it so it cannot be read as permission. */
  authority: string;
  limitations: readonly string[];
}

/**
 * Derive the verdict from PROSPECTIVE evidence only.
 *
 * Order matters. The evidence floor is checked FIRST, so a two-trade window that happens to
 * look excellent reports INSUFFICIENT_EVIDENCE rather than PROMISING — a small sample is the
 * single most reliable way for a filter to look like it works.
 *
 * FAILED and WEAKENING are reachable from any sufficient sample, because an experiment that
 * cannot lose is not an experiment. READY_FOR_HUMAN_REVIEW is a request for attention and is
 * never reached automatically from a first passing window.
 */
export function deriveVerdict(prospective: WindowResult, evidence: EvidenceGate): { verdict: ScoreboardVerdict; reason: string } {
  if (!evidence.met) {
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      reason: evidence.shortfall ?? "prospective evidence has not reached the frozen floor",
    };
  }
  const s = prospective.simulation;
  const basePf = s.baseline.profitFactor;
  const shadowPf = s.shadow.profitFactor;
  const shadowExBest = s.shadow.profitFactorExBestWinner;

  if (basePf == null || shadowPf == null) {
    return { verdict: "INSUFFICIENT_EVIDENCE", reason: "an arm has no losing trade, so no profit factor is defined for it" };
  }
  if (shadowPf <= basePf) {
    return {
      verdict: "FAILED",
      reason: `shadow PF ${shadowPf} is no better than the evaluable baseline's ${basePf} on prospective evidence — ` +
        "the stated disproof condition",
    };
  }
  // An advantage that exists only with the best winner included is the LHC_SELECT_V1 lesson,
  // and it is reported as WEAKENING rather than PROMISING however good the headline looks.
  if (shadowExBest != null && shadowExBest <= basePf) {
    return {
      verdict: "WEAKENING",
      reason: `shadow PF ${shadowPf} beats baseline ${basePf}, but removing its single best winner leaves ` +
        `${shadowExBest}, at or below baseline — the result is carried by one trade`,
    };
  }
  if (s.sessionsWorse > s.sessionsBetter) {
    return {
      verdict: "WEAKENING",
      reason: `the rule was worse in ${s.sessionsWorse} prospective sessions and better in ${s.sessionsBetter}`,
    };
  }
  return {
    verdict: "PROMISING",
    reason: `shadow PF ${shadowPf} vs baseline ${basePf} on ${evidence.closedOutcomes} closed prospective outcomes ` +
      `across ${evidence.independentSessions} independent sessions, and it survives removal of its best winner ` +
      `(${shadowExBest}). This is a measurement, not a recommendation.`,
  };
}

function windowFor(
  label: WindowResult["label"],
  rows: readonly OwnerLearningRow[],
  predicate: (sessionDate: string | null) => boolean,
): WindowResult {
  const inWindow = rows.filter((r) => predicate(r.sessionDate));
  const outcomes = inWindow.map(toOutcomeRow);
  const simulation = simulate(outcomes);
  // Independence is counted over the CLOSED, exact-contract, evaluable rows the arms actually
  // use. Counting it over every callout would let an open trade or an OCC mismatch contribute
  // a session the statistics never saw.
  const audit = countIndependentSessions(simulation.sessions);
  const dates = inWindow.map((r) => r.sessionDate).filter((d): d is string => !!d).sort();
  return {
    label,
    fromSessionDate: dates[0] ?? null,
    toSessionDate: dates[dates.length - 1] ?? null,
    closedOutcomes: simulation.coverage.evaluable,
    independentSessions: audit.independentSessions,
    rejectedSessionDates: audit.rejected.map((r) => r.date),
    simulation,
  };
}

export interface ScoreboardOptions {
  nowMs?: number;
  /** Override the freeze date in tests. Production always reads it from the frozen record. */
  prospectiveStartDate?: string;
}

/**
 * Build the scoreboard from the owner lane as it actually stands.
 *
 * The population is `buildOwnerLearningReportOnDb`'s — the same rows the nightly research and
 * the private app read — so no consumer can show a different outcome for the same callout.
 */
export function buildOwnerSelectionStrengthScoreboardOnDb(
  db: OwnerLearningDb,
  opts: ScoreboardOptions = {},
): StrengthScoreboard {
  const start = opts.prospectiveStartDate ?? OWNER_SELECTION_STRENGTH_GATE_V1.prospectiveStartDate;
  const report = buildOwnerLearningReportOnDb(db, {});
  // Only closed rows carry a return. An open trade is not a 0% outcome.
  const closed = report.rows.filter((r) => r.status === "EXITED" && r.realizedReturnPct != null);

  const inSample = windowFor("IN_SAMPLE", closed, (d) => d != null && d < start);
  const prospective = windowFor("PROSPECTIVE", closed, (d) => d != null && d >= start);

  const evidence: EvidenceGate = (() => {
    const n = prospective.closedOutcomes;
    const sessions = prospective.independentSessions;
    const met = n >= MIN_CLOSED_PROSPECTIVE_OUTCOMES && sessions >= MIN_INDEPENDENT_SESSIONS;
    const missing: string[] = [];
    if (n < MIN_CLOSED_PROSPECTIVE_OUTCOMES) missing.push(`${n}/${MIN_CLOSED_PROSPECTIVE_OUTCOMES} closed prospective outcomes`);
    if (sessions < MIN_INDEPENDENT_SESSIONS) missing.push(`${sessions}/${MIN_INDEPENDENT_SESSIONS} independent sessions`);
    return {
      met,
      closedOutcomes: n,
      requiredClosedOutcomes: MIN_CLOSED_PROSPECTIVE_OUTCOMES,
      independentSessions: sessions,
      requiredIndependentSessions: MIN_INDEPENDENT_SESSIONS,
      shortfall: met ? null : `prospective evidence stands at ${missing.join(" and ")}`,
    };
  })();

  const { verdict, reason } = deriveVerdict(prospective, evidence);

  return {
    experimentId: EXPERIMENT_ID,
    experimentVersion: EXPERIMENT_VERSION,
    mode: EXPERIMENT_MODE,
    floor: SELECTION_STRENGTH_FLOOR,
    definitionFrozen: checkOwnerSelectionStrengthFrozen(),
    frozen: OWNER_SELECTION_STRENGTH_GATE_V1,
    inSample,
    prospective,
    evidence,
    verdict,
    verdictReason: reason,
    authority:
      "SHADOW ONLY. This verdict changes nothing: no callout was rejected, rerouted, delayed or " +
      "reordered by it, no threshold, ranking weight, contract selection, target, stop or exit " +
      "reads it, and it is not and can never become subscriber approval. The most it can reach " +
      "is READY_FOR_HUMAN_REVIEW, which is a request.",
    limitations: Object.freeze([
      `In-sample sessions (${inSample.fromSessionDate ?? "—"}..${inSample.toSessionDate ?? "—"}) produced the ` +
      "hypothesis and are reported for context only. The verdict is derived from prospective evidence alone.",
      "Callouts with no frozen strength are UNEVALUABLE: excluded from both arms, reported separately, " +
      "and never counted as rejections. Missing evidence is not a low score.",
      "Both arms are measured on the same evaluable rows, so the comparison is a rule's effect and " +
      "not a difference in population size.",
      ...OWNER_SELECTION_STRENGTH_GATE_V1.robustnessCaveats,
    ]),
  };
}

/** The latest ET session with a closed outcome, for surfaces that need to date the board. */
export function latestSessionOf(board: StrengthScoreboard, nowMs: number = Date.now()): string {
  return board.prospective.toSessionDate ?? board.inSample.toSessionDate ?? tradingDay(nowMs);
}

/**
 * The registry status this scoreboard supports. Never written automatically — the caller
 * decides whether to record it, and `recordStatusOnDb` still enforces legal transitions.
 */
export function supportedRegistryStatus(board: StrengthScoreboard): ExperimentStatus {
  switch (board.verdict) {
    case "FAILED": return "FAILED";
    case "WEAKENING": return "DEMOTED";
    case "PROMISING": return "PROMISING";
    case "READY_FOR_HUMAN_REVIEW": return "READY_FOR_HUMAN_REVIEW";
    default:
      return board.prospective.closedOutcomes > 0 ? "PAPER_VALIDATION" : "PROSPECTIVE_SHADOW";
  }
}
