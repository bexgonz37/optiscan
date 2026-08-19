/**
 * plain-language.ts — one place that turns backend constants into language.
 *
 * THE PROBLEM
 *
 * The private app renders internal identifiers directly. `OWNER_VALIDATION_PAPER`
 * appears as a card subtitle. Raw experiment ids and 32-character definition
 * hashes appear as headings. `RESEARCH_ONLY`, `INSUFFICIENT_EVIDENCE` and
 * `UNKNOWN_LEGACY_VERSION` reach the owner unexplained.
 *
 * None of those strings is wrong. They are precise, and precision is why they
 * exist — but a constant chosen so that two modules agree with each other is not
 * a phrase chosen so a person understands it, and the app had been using the
 * first as though it were the second.
 *
 * WHAT THIS IS NOT
 *
 * Not a replacement for `lib/metric-glossary.ts`. That module owns what a METRIC
 * means and is the single source the InfoTips read; a component may not restate
 * its wording, and a test enforces that. This module owns what a STATE, LANE,
 * VERDICT or EXPERIMENT is called — the vocabulary the glossary does not cover —
 * and it never redefines a metric.
 *
 * Not a way to hide anything. Every label here carries the raw constant with it
 * so the technical value stays available under TECHNICAL DETAILS. The rule is
 * that the owner should not have to know the constant to read the screen, not
 * that the constant should be unavailable.
 *
 * PURE. No I/O, no clock, no env.
 */

export interface PlainLabel {
  /** What the owner reads. */
  label: string;
  /** One sentence on what it means. Empty when the label is self-explanatory. */
  meaning: string;
  /** The backend constant, preserved for the technical-details disclosure. */
  raw: string;
}

const plain = (raw: string, label: string, meaning = ""): PlainLabel => ({ label, meaning, raw });

/**
 * Trade populations. These are the strings most likely to be mistaken for each
 * other, and the distinction is the difference between "a result I can quote to a
 * subscriber" and "a result only I ever saw".
 */
const LANES: Record<string, PlainLabel> = {
  OWNER_VALIDATION_PAPER: plain(
    "OWNER_VALIDATION_PAPER",
    "Owner validation (paper-tracked)",
    "Callouts tracked privately for the owner. Nothing here was delivered to a subscriber, "
    + "so no result in this lane is a subscriber result.",
  ),
  DELIVERED_ALERT_PAPER: plain(
    "DELIVERED_ALERT_PAPER",
    "Delivered alerts (paper-tracked)",
    "Callouts that were actually sent, tracked on paper from the frozen entry.",
  ),
  INDEPENDENT_OPTIONS: plain(
    "INDEPENDENT_OPTIONS",
    "Independent options research",
    "The options research lane, separate from the scanner's own callouts.",
  ),
  SUPERVISOR_OPTIONS: plain(
    "SUPERVISOR_OPTIONS",
    "Supervisor callouts",
    "Callouts the supervisor cycle promoted.",
  ),
};

/** Decision and lifecycle states. */
const STATES: Record<string, PlainLabel> = {
  RESEARCH_ONLY: plain(
    "RESEARCH_ONLY",
    "Research only",
    "Recorded for study. Never sent, never actionable.",
  ),
  NON_ACTIONABLE_RESEARCH: plain(
    "NON_ACTIONABLE_RESEARCH",
    "Research only",
    "Recorded for study. Never sent, never actionable.",
  ),
  DELIVER_INTENT: plain("DELIVER_INTENT", "Cleared the bar to send"),
  NOT_OBSERVED: plain(
    "NOT_OBSERVED",
    "Never seen",
    "OptiScan produced no record of this symbol at all — it was not a rejection, it was absence.",
  ),
  UNKNOWN_LEGACY_VERSION: plain(
    "UNKNOWN_LEGACY_VERSION",
    "Version not recorded",
    "This callout predates strategy-version stamping, so which version produced it cannot be proven.",
  ),
};

/** Evidence verdicts — how much the record can actually support. */
const VERDICTS: Record<string, PlainLabel> = {
  INSUFFICIENT_EVIDENCE: plain(
    "INSUFFICIENT_EVIDENCE",
    "Not enough evidence yet",
    "The sample is too small or too concentrated to conclude anything. Not a negative result.",
  ),
  SUPPORTED: plain("SUPPORTED", "Supported by the sample"),
  NOT_SUPPORTED: plain("NOT_SUPPORTED", "The sample does not support this"),
  COLLECTING_DATA: plain("COLLECTING_DATA", "Still collecting"),
  NONE: plain("NONE", "No evidence"),
  PARTIAL: plain("PARTIAL", "Partial evidence"),
  STRONG: plain("STRONG", "Strong evidence"),
  NO_FEEDBACK_YET: plain(
    "NO_FEEDBACK_YET",
    "Nothing judged yet",
    "You have not approved or rejected any of these, so no preference can be inferred.",
  ),
};

/** Coverage outcomes from the missed-opportunity forensic. */
const COVERAGE: Record<string, PlainLabel> = {
  NOT_ADMITTED_TO_UNIVERSE: plain(
    "NOT_ADMITTED_TO_UNIVERSE",
    "Never observed",
    "The symbol never entered any lane's universe, so there was nothing to reject. "
    + "No return can be claimed for it.",
  ),
  ADMITTED_NOT_QUOTED: plain(
    "ADMITTED_NOT_QUOTED",
    "Observed but never quoted",
    "OptiScan saw the symbol but never recorded an option quote for it.",
  ),
  QUOTED_NO_CONTRACT_SELECTED: plain(
    "QUOTED_NO_CONTRACT_SELECTED",
    "Quoted but rejected",
    "Options were quoted and the contract rules refused every candidate.",
  ),
  OBSERVED_BY_OPTISCAN: plain("OBSERVED_BY_OPTISCAN", "Observed and quoted"),
  EXECUTABLE_EVIDENCE_PRESENT: plain(
    "EXECUTABLE_EVIDENCE_PRESENT",
    "Quoted, with a measurable outcome",
    "A real quote exists, so what was attainable after that quote can be measured.",
  ),
  TOO_LATE: plain(
    "TOO_LATE",
    "Found too late",
    "By the time OptiScan could act, the move it was reacting to had already happened.",
  ),
  CORRECT_REJECTION: plain(
    "CORRECT_REJECTION",
    "Correctly passed on",
    "The rules refused it and refusing it was right.",
  ),
};

/**
 * Frozen experiments, in one sentence each.
 *
 * Written for someone who has not read the module. "What is it testing, and what
 * would it change if it worked" — not the mechanism.
 */
export interface PlainExperiment {
  experimentId: string;
  title: string;
  /** What question this is trying to answer. */
  purpose: string;
  /** What would change if it turned out to be right. Never a promise that it will. */
  ifItWorks: string;
}

const EXPERIMENTS: Record<string, PlainExperiment> = {
  OWNER_SELECTION_STRENGTH_GATE_V1: {
    experimentId: "OWNER_SELECTION_STRENGTH_GATE_V1",
    title: "Does a stricter selection score pick better trades?",
    purpose:
      "Every callout gets a selection-strength score. This asks whether refusing the "
      + "weakest-scoring ones would have improved results — measured on the callouts the "
      + "rule can actually judge, not on all of them.",
    ifItWorks:
      "A minimum selection strength could be added to the live bar. Nothing changes until "
      + "the sample is large enough and you decide to.",
  },
  PRE_MOVE_DISCOVERY_V2: {
    experimentId: "PRE_MOVE_DISCOVERY_V2",
    title: "How much of the move was already gone when the callout went out?",
    purpose:
      "Measures how much of the session's favourable range had already been spent at the "
      + "moment of the callout. V1 measured a 1.6-second window and so graded almost "
      + "everything early, which told you nothing.",
    ifItWorks:
      "Callouts arriving after most of the move is gone could be identified and studied "
      + "separately. It changes no gate today.",
  },
  EXTREME_PREMARKET_DISCOVERY_V1: {
    experimentId: "EXTREME_PREMARKET_DISCOVERY_V1",
    title: "Are huge premarket movers worth finding at all?",
    purpose:
      "Whole-market discovery with no price ceiling now surfaces names the curated list "
      + "could never see. This asks whether those names are genuine early opportunities or "
      + "just noisy moves that already happened.",
    ifItWorks:
      "Extreme movers could earn a place in the scanner's real universe. Today they are "
      + "observed and nothing more.",
  },
  LHC_SELECT_V1: {
    experimentId: "LHC_SELECT_V1",
    title: "Which lower-high setups are worth taking?",
    purpose: "A frozen selection rule for the lower-high continuation family.",
    ifItWorks: "Its gates could inform live selection. They do not today.",
  },
};

const ALL: Record<string, PlainLabel> = { ...LANES, ...STATES, ...VERDICTS, ...COVERAGE };

/**
 * Plain label for a backend constant.
 *
 * An unknown constant is DE-SHOUTED rather than dropped: `SOME_NEW_STATE` becomes
 * "Some new state" and keeps its raw value. Returning the raw constant unchanged
 * would reintroduce exactly the leak this module exists to stop, and returning
 * nothing would hide a state the owner needs to see.
 */
export function plainLabel(raw: string | null | undefined): PlainLabel {
  const key = String(raw ?? "").trim();
  if (!key) return { label: "Unknown", meaning: "", raw: "" };
  const known = ALL[key];
  if (known) return known;
  if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
    const words = key.toLowerCase().replace(/_/g, " ");
    return { label: words.charAt(0).toUpperCase() + words.slice(1), meaning: "", raw: key };
  }
  return { label: key, meaning: "", raw: key };
}

/** Plain description of a frozen experiment, or a de-shouted fallback. */
export function plainExperiment(experimentId: string): PlainExperiment {
  const known = EXPERIMENTS[experimentId];
  if (known) return known;
  return {
    experimentId,
    title: plainLabel(experimentId).label,
    purpose: "No plain-English description has been written for this experiment yet.",
    ifItWorks: "",
  };
}

/**
 * The banner every shadow experiment carries. One sentence, always the same
 * words, so it is recognised rather than read.
 */
export const SHADOW_ONLY_BANNER = "SHADOW ONLY — DOES NOT CHANGE LIVE CALLOUTS";

/** Every constant this module can name, for the coverage test. */
export function knownConstants(): string[] {
  return [...Object.keys(ALL), ...Object.keys(EXPERIMENTS)].sort();
}
