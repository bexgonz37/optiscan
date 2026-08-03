/**
 * classify.ts — deterministic root-cause assignment.
 *
 * FULLY DETERMINISTIC — no model of any kind is consulted here. Every
 * classification is a pure function of persisted evidence, so the same session
 * always yields the same causes and a disagreement is a bug rather than a matter
 * of opinion. The advisory layer may later explain a case; it may not decide one.
 *
 * THE ORDER MATTERS AND IS DELIBERATE. Verification comes before diagnosis: a
 * case that is not a verified executable winner cannot be a "miss" at all, and
 * classifying it as one would let an unverified Twitter percentage drive
 * engineering. Only after a real executable move is established does the pipeline
 * get asked why it did not act.
 *
 * "CORRECT REJECTION" IS A FIRST-CLASS OUTCOME. A system that passed on a wide
 * spread or an already-extended move did its job. Counting those as defects would
 * manufacture pressure to loosen exactly the gates that protect the subscriber.
 */
import {
  CORRECT_REJECTION_CAUSES,
  SYSTEM_DEFECT_CAUSES,
  type ClaimVerdict,
  type EvidenceQuality,
  type FailureFamily,
  type MissedRootCause,
  type Recoverability,
} from "./types.ts";
import type { SymbolReconstruction } from "./reconstruct.ts";

/**
 * Verbatim pipeline reasons mapped to causes. Patterns are matched against the
 * terminal reason exactly as the pipeline wrote it — paraphrasing a reason into a
 * tidier bucket is how a real defect becomes invisible.
 *
 * Every pattern here was observed in production output, not invented.
 */
const REASON_PATTERNS: { re: RegExp; cause: MissedRootCause; family: FailureFamily }[] = [
  // Contract selection — the setup was fine, the contract search failed.
  { re: /no eligible contract in the preferred delta\/dte band/i, cause: "WRONG_DTE", family: "CONTRACT_SELECTION_FAILURE" },
  { re: /no eligible contract/i, cause: "POOR_CONTRACT_RANKING", family: "CONTRACT_SELECTION_FAILURE" },
  { re: /contract gate:[^|]*spread_too_wide/i, cause: "SPREAD_REJECTION_CORRECT", family: "CORRECT_REJECTION" },
  { re: /contract gate:[^|]*insufficient_oi/i, cause: "LIQUIDITY_REJECTION_CORRECT", family: "CORRECT_REJECTION" },
  { re: /contract gate:[^|]*insufficient_volume/i, cause: "LIQUIDITY_REJECTION_CORRECT", family: "CORRECT_REJECTION" },
  { re: /contract (mismatch|incomplete)/i, cause: "POOR_CONTRACT_RANKING", family: "CONTRACT_SELECTION_FAILURE" },

  // Timing / extension — the move was already gone.
  { re: /late_phase_fraction_move/i, cause: "EXTENSION_REJECTION_CORRECT", family: "CORRECT_REJECTION" },
  { re: /premium[_ ]chase/i, cause: "PREMIUM_CHASE_SUPPRESSION", family: "CORRECT_REJECTION" },
  { re: /too[_ ]late|TOO_LATE/i, cause: "ENTRY_TOO_LATE", family: "UNDERLYING_SETUP_FAILURE" },

  // Direction / strategy.
  { re: /below vwap on call|call while materially below vwap/i, cause: "WRONG_DIRECTION", family: "UNDERLYING_SETUP_FAILURE" },
  { re: /direction \w+ is not bullish|not bullish/i, cause: "WRONG_DIRECTION", family: "UNDERLYING_SETUP_FAILURE" },
  { re: /unsupported_bearish_strategy|missing_bearish_structure/i, cause: "WRONG_STRATEGY_CLASSIFICATION", family: "UNDERLYING_SETUP_FAILURE" },
  { re: /below_subscriber_threshold/i, cause: "FAILED_CONFIRMATION_GATE", family: "UNDERLYING_SETUP_FAILURE" },

  // System defects — these are the ones that must never be filed as strategy.
  { re: /stale_quote|DATA_STALE|quote age/i, cause: "DATA_MISSING", family: "NO_FAILURE_ESTABLISHED" },
  { re: /quota|minute_partition|budget/i, cause: "PROVIDER_BUDGET_BLOCKED", family: "NO_FAILURE_ESTABLISHED" },
  { re: /scheduler|skipped|cooldown skip/i, cause: "SCHEDULER_DELAY", family: "NO_FAILURE_ESTABLISHED" },
  { re: /quote path|no quote|quote unavailable/i, cause: "QUOTE_PATH_FAILURE", family: "NO_FAILURE_ESTABLISHED" },

  // Suppression.
  { re: /dedup|duplicate|reopen/i, cause: "DUPLICATE_OR_COOLDOWN_SUPPRESSION", family: "NO_FAILURE_ESTABLISHED" },
  { re: /conflict|opposite direction/i, cause: "OPPOSITE_DIRECTION_CONFLICT", family: "NO_FAILURE_ESTABLISHED" },
];

/** First matching pattern wins; patterns are ordered most-specific first. */
export function causeFromReason(
  reason: string | null | undefined,
): { cause: MissedRootCause; family: FailureFamily } | null {
  const r = String(reason ?? "").trim();
  if (!r) return null;
  for (const p of REASON_PATTERNS) if (p.re.test(r)) return { cause: p.cause, family: p.family };
  return null;
}

/** All causes implied by a reason string, in pattern order. Used for secondaries. */
export function allCausesFromReason(reason: string | null | undefined): MissedRootCause[] {
  const r = String(reason ?? "").trim();
  if (!r) return [];
  const out: MissedRootCause[] = [];
  for (const p of REASON_PATTERNS) if (p.re.test(r) && !out.includes(p.cause)) out.push(p.cause);
  return out;
}

export interface ClassifyInput {
  reconstruction: SymbolReconstruction;
  /** Executable ask→bid return, or null when it could not be verified. */
  executableReturnPct: number | null;
  verdict: ClaimVerdict;
  /** The research threshold this case was raised against, e.g. 200 for +200%. */
  thresholdPct: number;
  /** True when quote evidence was available at all. */
  hadQuoteEvidence: boolean;
  /** True when the lane was materially refused by the provider budget in-window. */
  budgetPlausibleCause: boolean;
  /** Direction the verified winner required, e.g. "CALL". */
  winnerDirection: "CALL" | "PUT" | null;
}

export interface Classification {
  rootCause: MissedRootCause;
  secondaryCauses: MissedRootCause[];
  failureFamily: FailureFamily;
  recoverability: Recoverability;
  evidenceQuality: EvidenceQuality;
}

function evidenceQualityFor(input: ClassifyInput): EvidenceQuality {
  const { reconstruction: rc, hadQuoteEvidence } = input;
  if (!hadQuoteEvidence && !rc.hasAnyEvidence) return "NONE";
  if (hadQuoteEvidence && rc.hasAnyEvidence && rc.observations.length > 0) return "STRONG";
  if (hadQuoteEvidence || rc.hasAnyEvidence) return "PARTIAL";
  return "WEAK";
}

/**
 * Assign one primary cause.
 *
 * Reads top to bottom; the first branch that holds decides. Verification gates
 * everything below it, so an unverified claim can never reach a diagnosis of the
 * pipeline.
 */
export function classifyCase(input: ClassifyInput): Classification {
  const { reconstruction: rc } = input;
  const evidenceQuality = evidenceQualityFor(input);
  const secondary = new Set<MissedRootCause>();

  const done = (
    rootCause: MissedRootCause,
    failureFamily: FailureFamily,
    recoverability: Recoverability,
  ): Classification => ({
    rootCause,
    secondaryCauses: [...secondary].filter((c) => c !== rootCause),
    failureFamily,
    recoverability,
    evidenceQuality,
  });

  // 1. Verification gates everything. No verified executable move, no miss.
  if (!input.hadQuoteEvidence) {
    return done("INSUFFICIENT_EVIDENCE", "NO_FAILURE_ESTABLISHED", "INSUFFICIENT_EVIDENCE");
  }
  if (input.executableReturnPct == null) {
    return done("INSUFFICIENT_EVIDENCE", "NO_FAILURE_ESTABLISHED", "INSUFFICIENT_EVIDENCE");
  }
  if (input.executableReturnPct < input.thresholdPct) {
    return done("NOT_A_VERIFIED_EXTREME_WINNER", "NO_FAILURE_ESTABLISHED", "CORRECTLY_REJECTED");
  }
  if (input.verdict === "MIDPOINT_ONLY" || input.verdict === "LAST_TRADE_ONLY" || input.verdict === "ASK_SIDE_ONLY") {
    return done("NOT_A_VERIFIED_EXTREME_WINNER", "NO_FAILURE_ESTABLISHED", "CORRECTLY_REJECTED");
  }
  if (input.verdict === "BAD_PRINT" || input.verdict === "ILLIQUID_HINDSIGHT_ONLY") {
    return done("HINDSIGHT_ONLY", "CORRECT_REJECTION", "CORRECTLY_REJECTED");
  }

  // 2. A real winner existed. Did OptiScan see the symbol at all?
  const sawRegular = rc.regularScanner.observationCount > 0;
  const sawAsymmetry = rc.highAsymmetry.observationCount > 0;
  if (!sawRegular && !sawAsymmetry) {
    return done("OUTSIDE_DISCOVERY_UNIVERSE", "UNDERLYING_SETUP_FAILURE", "MISSED_DUE_TO_SYSTEM_DEFECT");
  }

  // 3. Provider budget is checked before strategy: a lane that was refused did not
  //    get to have an opinion, and blaming its strategy would be a false diagnosis.
  if (input.budgetPlausibleCause) secondary.add("PROVIDER_BUDGET_BLOCKED");

  // 4. Was an alert actually delivered on this symbol?
  const sent = rc.alerts.filter((a) => a.state === "SENT" || a.sentAtMs != null);
  if (sent.length > 0) {
    const matchedContract = sent.some((a) => a.occSymbol && rc.regularScanner.selectedOcc === a.occSymbol);
    if (!matchedContract) {
      return done("ALERTED_BUT_WRONG_CONTRACT", "CONTRACT_SELECTION_FAILURE", "WRONG_CONTRACT_SELECTED");
    }
    return done("ALERTED_TOO_LATE", "CONTRACT_SELECTION_FAILURE", "TOO_LATE_TO_NOTIFY");
  }

  // 5. High-Asymmetry captured it but the subscriber pipeline never qualified it.
  if (sawAsymmetry && rc.highAsymmetry.readyCount === 0 && !sawRegular) {
    return done("HIGH_ASYMMETRY_CAPTURED_NOT_PROMOTED", "CONTRACT_SELECTION_FAILURE", "MISSED_DUE_TO_STRATEGY_RULE");
  }

  // 6. Direction: the lane saw the symbol but was pointed the wrong way.
  if (input.winnerDirection && rc.regularScanner.direction) {
    const laneDir = rc.regularScanner.direction.toUpperCase();
    const wantsCall = input.winnerDirection === "CALL";
    const laneIsCall = /CALL|BULL/i.test(laneDir);
    const laneIsPut = /PUT|BEAR/i.test(laneDir);
    if ((wantsCall && laneIsPut) || (!wantsCall && laneIsCall)) {
      secondary.add("WRONG_DIRECTION");
    }
  }

  // 7. The terminal reason the funnel actually ended on.
  const fromRegular = causeFromReason(rc.regularScanner.terminalReason);
  for (const c of allCausesFromReason(rc.regularScanner.terminalReason)) secondary.add(c);

  if (fromRegular) {
    const isCorrect = (CORRECT_REJECTION_CAUSES as readonly string[]).includes(fromRegular.cause);
    const isDefect = (SYSTEM_DEFECT_CAUSES as readonly string[]).includes(fromRegular.cause);
    const recoverability: Recoverability = isCorrect
      ? "CORRECTLY_REJECTED"
      : isDefect
        ? "MISSED_DUE_TO_SYSTEM_DEFECT"
        : fromRegular.family === "CONTRACT_SELECTION_FAILURE"
          ? "WRONG_CONTRACT_SELECTED"
          : "MISSED_DUE_TO_STRATEGY_RULE";
    return done(fromRegular.cause, fromRegular.family, recoverability);
  }

  // 8. High-Asymmetry captured it and the regular lane had no terminal reason.
  if (sawAsymmetry && rc.highAsymmetry.readyCount === 0) {
    return done("HIGH_ASYMMETRY_CAPTURED_NOT_PROMOTED", "CONTRACT_SELECTION_FAILURE", "MISSED_DUE_TO_STRATEGY_RULE");
  }

  // 9. Seen, no alert, no recorded reason. Say exactly that.
  if (sawRegular && rc.regularScanner.readyCount === 0) {
    return done("UNDERLYING_SETUP_MISSED", "UNDERLYING_SETUP_FAILURE", "MISSED_DUE_TO_STRATEGY_RULE");
  }

  return done("OTHER_PROVEN_REASON", "NO_FAILURE_ESTABLISHED", "INSUFFICIENT_EVIDENCE");
}
