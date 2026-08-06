/**
 * Evidence learning: turn verified outcomes into NAMED, repeated findings and bounded
 * experiment proposals.
 *
 * WHY THIS SHAPE
 *
 * The system already stored plenty of outcomes. What it could not do was say "this keeps
 * happening" — so the same defect (0DTE never fetched, a strategy that could never be
 * selected, a good entry refused on a clock rule) survived multiple sessions because each
 * instance looked like a one-off. This module only reports a pattern when it recurs across
 * INDEPENDENT sessions, which is what makes it actionable rather than anecdotal.
 *
 * AUTHORITY BOUNDARY — enforced by the types, not by convention.
 *
 * Everything here produces `ExperimentProposal`, which is inert data. It carries no
 * threshold mutation, no promotion, no send authority and no deploy hook. Applying a
 * proposal requires a human to implement it. AI may summarise, detect, propose and
 * explain; it may not choose the live trade, change a threshold silently, promote a
 * strategy, send an alert, deploy, or rewrite a historical outcome.
 */
import type { OutcomeRow, SegmentReport } from "./strategy-performance.ts";

export type PatternId =
  | "ZERO_DTE_WINNERS_NEVER_FETCHED"
  | "STRATEGY_UNSELECTABLE_BY_DOMINATION"
  | "WORSE_CONTRACT_OUTRANKED_BETTER"
  | "CONFIRMATION_AFTER_REWARD_GONE"
  | "ADMITTED_WITH_LOW_REWARD_REMAINING"
  | "REPEATED_DIRECTIONAL_CONFLICT"
  | "NEGATIVE_FORWARD_EXPECTANCY"
  | "GATES_TOO_STRICT_EARLY_ENTRY"
  | "LOOSENED_GATES_UNACCEPTABLE_DRAWDOWN";

export type LearningPopulation =
  | "VERIFIED_ALERTED_WINNER"
  | "VERIFIED_ALERTED_LOSER"
  | "VERIFIED_MISSED_WINNER"
  | "FALSE_POSITIVE_ALERT"
  | "FALSE_NEGATIVE_MISS"
  | "CORRECT_REJECTION"
  | "INCORRECT_REJECTION";

export interface LearningObservation {
  population: LearningPopulation;
  sessionDate: string | null;
  symbol: string | null;
  strategy: string | null;
  optionSymbol: string | null;
  returnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  detail: string;
}

export interface LearningPattern {
  patternId: PatternId;
  title: string;
  /** Number of independent SESSIONS the pattern appears in. Repetition is the bar. */
  sessionsObserved: number;
  occurrences: number;
  /** Sessions listed so a reader can go and check them. */
  sessions: string[];
  evidence: string[];
  /** Named so nobody has to guess what would count as disproof. */
  wouldBeDisprovenBy: string;
}

/**
 * A bounded, inert experiment proposal.
 *
 * Note there is no `apply()` and no threshold field that any runtime reads. This is a
 * description of an experiment for a human to run, not a lever.
 */
export interface ExperimentProposal {
  proposalId: string;
  patternId: PatternId;
  hypothesis: string;
  /** Exactly what to change, in words. Deliberately not machine-applied. */
  proposedChange: string;
  /** The lane it may run in. Never subscriber-facing. */
  lane: "SHADOW" | "PAPER_VALIDATION" | "RESEARCH_ONLY";
  successCriteria: string;
  failureCriteria: string;
  minimumSample: number;
  risks: string[];
  requiresHumanApproval: true;
}

const MIN_SESSIONS_FOR_PATTERN = 2;

function sessionsOf(items: { sessionDate: string | null }[]): string[] {
  return [...new Set(items.map((i) => i.sessionDate).filter((s): s is string => Boolean(s)))].sort();
}

export interface DetectInput {
  outcomes: OutcomeRow[];
  segments: SegmentReport[];
  /** Verified winners that were never alerted, with why. */
  missedWinners?: { sessionDate: string | null; symbol: string | null; optionSymbol: string | null; dte: number | null; whyMissed: string }[];
  /** Recorded directional-conflict refusals. */
  directionConflicts?: { sessionDate: string | null; symbol: string | null; detail: string }[];
  /** Strategies proven unselectable by catalog domination. */
  unselectableStrategies?: { strategy: string; dominatedBy: string[] }[];
  /** Decisions rejected on candidate age that still had reward left. */
  lateRejections?: { sessionDate: string | null; symbol: string | null; rewardRemainingPct: number | null; premiumExpansionPct: number | null }[];
}

export function detectPatterns(input: DetectInput): LearningPattern[] {
  const out: LearningPattern[] = [];

  const missed0dte = (input.missedWinners ?? []).filter(
    (m) => (m.dte != null && m.dte <= 0) || /0dte|never fetched|not fetched/i.test(m.whyMissed),
  );
  if (missed0dte.length) {
    const sessions = sessionsOf(missed0dte);
    out.push({
      patternId: "ZERO_DTE_WINNERS_NEVER_FETCHED",
      title: "Verified winners were invisible because a same-day partition was never requested",
      sessionsObserved: sessions.length,
      occurrences: missed0dte.length,
      sessions,
      evidence: missed0dte.slice(0, 10).map((m) => `${m.sessionDate ?? "?"} ${m.optionSymbol ?? m.symbol ?? "?"}: ${m.whyMissed}`),
      wouldBeDisprovenBy: "a session where 0DTE-permitting strategies are selected for index symbols and no same-day winner is missed for lack of a chain request",
    });
  }

  if (input.unselectableStrategies?.length) {
    out.push({
      patternId: "STRATEGY_UNSELECTABLE_BY_DOMINATION",
      title: "Strategies that no market state can select, because an earlier catalog entry dominates their signal set",
      sessionsObserved: MIN_SESSIONS_FOR_PATTERN,
      occurrences: input.unselectableStrategies.length,
      sessions: [],
      evidence: input.unselectableStrategies.map((s) => `${s.strategy} dominated by ${s.dominatedBy.join(", ")}`),
      wouldBeDisprovenBy: "the strategy appearing as the SELECTED strategy in a real decision",
    });
  }

  const conflicts = input.directionConflicts ?? [];
  if (conflicts.length) {
    const sessions = sessionsOf(conflicts);
    out.push({
      patternId: "REPEATED_DIRECTIONAL_CONFLICT",
      title: "The same symbol produced opposing actionable directions",
      sessionsObserved: sessions.length,
      occurrences: conflicts.length,
      sessions,
      evidence: conflicts.slice(0, 10).map((c) => `${c.sessionDate ?? "?"} ${c.symbol ?? "?"}: ${c.detail}`),
      wouldBeDisprovenBy: "a full session with zero opposite-direction refusals and zero contradictory deliveries",
    });
  }

  const negative = input.segments.filter((s) => s.classification === "NEGATIVE_EXPECTANCY");
  if (negative.length) {
    out.push({
      patternId: "NEGATIVE_FORWARD_EXPECTANCY",
      title: "Strategy versions with materially negative verified expectancy",
      sessionsObserved: MIN_SESSIONS_FOR_PATTERN,
      occurrences: negative.length,
      sessions: [],
      evidence: negative.map((s) => `${s.key.strategy}@${s.key.strategyVersion}: expectancy ${s.metrics.expectancyPct}%, PF ${s.metrics.profitFactor}, n=${s.metrics.pricedSampleSize}`),
      wouldBeDisprovenBy: "a forward sample where the same version returns positive expectancy with profit factor above 1",
    });
  }

  const lateWithReward = (input.lateRejections ?? []).filter((r) => (r.rewardRemainingPct ?? 0) >= 10);
  if (lateWithReward.length) {
    const sessions = sessionsOf(lateWithReward);
    out.push({
      patternId: "GATES_TOO_STRICT_EARLY_ENTRY",
      title: "Candidates rejected on age that still had material reward remaining",
      sessionsObserved: sessions.length,
      occurrences: lateWithReward.length,
      sessions,
      evidence: lateWithReward.slice(0, 10).map((r) => `${r.sessionDate ?? "?"} ${r.symbol ?? "?"}: reward left ${r.rewardRemainingPct}%, premium expanded ${r.premiumExpansionPct ?? "n/a"}%`),
      wouldBeDisprovenBy: "a replay showing those rejections would have underperformed the alerts that were sent",
    });
  }

  const lowReward = input.outcomes.filter((o) => o.premiumExpansionPct != null && o.premiumExpansionPct > 50 && (o.returnPct ?? 0) < 0);
  if (lowReward.length >= 3) {
    const sessions = sessionsOf(lowReward);
    out.push({
      patternId: "ADMITTED_WITH_LOW_REWARD_REMAINING",
      title: "Losers admitted after the premium had already expanded substantially",
      sessionsObserved: sessions.length,
      occurrences: lowReward.length,
      sessions,
      evidence: lowReward.slice(0, 10).map((o) => `${o.sessionDate ?? "?"} ${o.symbol ?? "?"}: expanded ${o.premiumExpansionPct}% before alert, returned ${o.returnPct}%`),
      wouldBeDisprovenBy: "expanded-premium entries matching or beating fresh entries over a forward sample",
    });
  }

  // Only surface what actually recurs, except for structural findings (domination,
  // negative expectancy) which are proven by construction rather than by repetition.
  const structural: PatternId[] = ["STRATEGY_UNSELECTABLE_BY_DOMINATION", "NEGATIVE_FORWARD_EXPECTANCY"];
  return out.filter((p) => structural.includes(p.patternId) || p.sessionsObserved >= MIN_SESSIONS_FOR_PATTERN);
}

/** One bounded proposal per detected pattern. Inert by construction. */
export function proposeExperiments(patterns: LearningPattern[]): ExperimentProposal[] {
  const mk = (
    patternId: PatternId,
    hypothesis: string,
    proposedChange: string,
    successCriteria: string,
    failureCriteria: string,
    minimumSample: number,
    risks: string[],
    lane: ExperimentProposal["lane"] = "SHADOW",
  ): ExperimentProposal => ({
    proposalId: `exp_${patternId.toLowerCase()}`,
    patternId, hypothesis, proposedChange, lane,
    successCriteria, failureCriteria, minimumSample, risks,
    requiresHumanApproval: true,
  });

  const byId: Partial<Record<PatternId, ExperimentProposal>> = {
    ZERO_DTE_WINNERS_NEVER_FETCHED: mk(
      "ZERO_DTE_WINNERS_NEVER_FETCHED",
      "Index symbols with a 0DTE-permitting selected strategy will recover same-day winners that were previously invisible.",
      "Keep index-scoped strategies selectable and route their candidates to shadow/paper only; measure recovered winners against provider cost.",
      "Recovers at least one verified executable winner per session across 3 independent sessions with no increase in provider-budget refusals.",
      "Provider quota refusals rise above the current 11% baseline, or recovered candidates show negative expectancy.",
      30,
      ["per-minute provider cap is the binding constraint (280/min); widening partitions could starve Core"],
      "PAPER_VALIDATION",
    ),
    STRATEGY_UNSELECTABLE_BY_DOMINATION: mk(
      "STRATEGY_UNSELECTABLE_BY_DOMINATION",
      "Making dominated strategies selectable surfaces setups the winner-take-all selector was hiding.",
      "Keep the explicit tie-break (ratio, matched count, symbol scope, catalog order) and give trend_continuation distinct signals or retire it.",
      "Previously unselectable strategies appear as the selected strategy and their paper outcomes are not worse than the incumbent's.",
      "They are selected but produce worse expectancy than the strategy they displaced.",
      30,
      ["a newly reachable strategy displaces a better incumbent on ties"],
    ),
    NEGATIVE_FORWARD_EXPECTANCY: mk(
      "NEGATIVE_FORWARD_EXPECTANCY",
      "Quarantining materially negative versions from subscriber-style openings raises population expectancy without losing the winners.",
      "Route NEGATIVE_EXPECTANCY and DEGRADED versions to DEMOTED; keep capturing their outcomes in research.",
      "Population expectancy improves across 3 independent sessions while verified winners recovered does not fall.",
      "Expectancy does not improve, or quarantine removes more winners than losers.",
      30,
      ["small per-version samples can misclassify a good strategy after a bad run"],
      "PAPER_VALIDATION",
    ),
    REPEATED_DIRECTIONAL_CONFLICT: mk(
      "REPEATED_DIRECTIONAL_CONFLICT",
      "One authoritative direction per symbol removes contradictory alerts without materially reducing good alerts.",
      "Keep symbol-scoped directional authority enforcing; measure refusals and what they would have returned.",
      "Zero contradictory deliveries, and refused opposite-direction candidates do not show better outcomes than the direction that held the symbol.",
      "Refused candidates consistently outperform the held direction, implying the first mover is the wrong tie-break.",
      20,
      ["first-mover ownership may favour an early weak signal over a later strong one"],
    ),
    GATES_TOO_STRICT_EARLY_ENTRY: mk(
      "GATES_TOO_STRICT_EARLY_ENTRY",
      "Candidates refused on age but with reward remaining are profitable enough to admit under a narrow reprieve.",
      "Shadow the existing late-entry reprieve; compare reprieved vs unreprieved outcomes.",
      "Reprieved entries beat sent alerts on expectancy AND drawdown over 30+ decisions.",
      "Reprieved entries show worse MAE than the alerts already sent (the prior replay showed -29% vs -15.8%).",
      30,
      ["prior replay already showed worse drawdown; this is the main risk"],
    ),
    ADMITTED_WITH_LOW_REWARD_REMAINING: mk(
      "ADMITTED_WITH_LOW_REWARD_REMAINING",
      "Rejecting entries whose premium already expanded materially removes more losers than winners.",
      "Shadow a stricter premium-expansion ceiling; count winners lost against losers avoided.",
      "Losers avoided exceed winners lost by 2:1 over 30+ decisions.",
      "The ceiling removes as many winners as losers.",
      30,
      ["expansion is sometimes the confirmation itself, not a chase"],
    ),
    WORSE_CONTRACT_OUTRANKED_BETTER: mk(
      "WORSE_CONTRACT_OUTRANKED_BETTER",
      "The deterministic ranking objective selects contracts with better realised risk-adjusted outcomes than the incumbent selector.",
      "Run the ranking objective in shadow alongside production selection and compare the chosen contracts.",
      "Shadow-selected contracts beat production-selected on median MFE and immediate-failure rate across 3 sessions.",
      "Shadow selection is not better, or is better only on the single SPY +203% outlier.",
      30,
      ["optimising to one spectacular contract is exactly the failure mode to avoid"],
    ),
    CONFIRMATION_AFTER_REWARD_GONE: mk(
      "CONFIRMATION_AFTER_REWARD_GONE",
      "Confirmation signals arrive after the tradeable reward has already been taken.",
      "Measure time from first eligibility to confirmation against reward remaining at each point.",
      "A confirmation threshold exists that keeps precision while preserving reward remaining.",
      "No threshold preserves both.",
      30,
      ["loosening confirmation raises false positives"],
    ),
    LOOSENED_GATES_UNACCEPTABLE_DRAWDOWN: mk(
      "LOOSENED_GATES_UNACCEPTABLE_DRAWDOWN",
      "Loosened gates increase drawdown more than they increase reward.",
      "Compare drawdown distributions before and after any gate loosening.",
      "Drawdown stays within the current MAE distribution.",
      "MAE worsens materially versus the -15.8% median baseline.",
      30,
      ["this is a guard experiment; its success criterion is that nothing got worse"],
    ),
  };

  return patterns.map((p) => byId[p.patternId]).filter((x): x is ExperimentProposal => Boolean(x));
}
