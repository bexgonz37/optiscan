/**
 * lane.ts — the identity and eligibility rules for the High-Asymmetry paper lane. PURE.
 *
 * THIS LANE IS OWNER-PRIVATE SIMULATION ONLY. It is structurally separate from
 * every existing paper population:
 *
 *   options_paper_trades.paper_kind = DELIVERED_ALERT_PAPER   — subscriber alert mirrors
 *                                     RESEARCH_ONLY_PAPER     — scanner shadow research
 *                                     ZERO_DTE_RESEARCH_PAPER — 0DTE ledger
 *                                     BEARISH_RESEARCH_PAPER  — qualified-PUT research
 *   asymmetry_paper_positions                                  — THIS LANE, separate table
 *
 * A different TABLE, not a different column value, is the separator. Nothing in
 * this lane can be selected by a query against options_paper_trades, so no
 * existing readiness number, subscriber statistic, delivered win rate, or
 * report card can absorb it by accident.
 *
 * NO AI. Nothing in this file, or anything it imports, may reach a model. Every
 * decision here is a readable rule over persisted evidence and is reproducible
 * from the stored row alone.
 */
import type { AsymmetryResearchState } from "../states.ts";

/** The structural lane label. Written to every row and asserted by test. */
export const ASYMMETRY_PAPER_LANE = "HIGH_ASYMMETRY_PAPER" as const;

/** Master flag. Unset means the entire paper lane does zero work. */
export const PAPER_ENABLED_ENV = "HIGH_ASYMMETRY_PAPER_ENABLED";

/**
 * The deterministic rule-set version stamped on every position at entry.
 * Cohorts are NEVER mixed across versions without the label — a rule change
 * must produce a new version so old and new results stay separable.
 */
export const PAPER_RULES_VERSION = "HIGH_ASYMMETRY_PAPER_V1" as const;

/** States that may OPEN a position. */
export const PAPER_ENTRY_STATES: readonly AsymmetryResearchState[] = Object.freeze([
  "EARLY_ASYMMETRY", "CONFIRMING", "HIGH_ASYMMETRY",
]);

/**
 * States that may UPDATE an existing position but must never open one.
 * TRIGGERED is deliberately here: by the time a trigger has printed, the early
 * entry this lane exists to measure has already been missed.
 */
export const PAPER_UPDATE_ONLY_STATES: readonly AsymmetryResearchState[] = Object.freeze(["TRIGGERED"]);

/** States that can never produce a position. */
export const PAPER_INELIGIBLE_STATES: readonly AsymmetryResearchState[] = Object.freeze([
  "PREMIUM_CHASE", "LIQUIDITY_FAILURE", "INVALIDATED", "INSUFFICIENT_EVIDENCE",
]);

export function isPaperEntryState(state: AsymmetryResearchState): boolean {
  return PAPER_ENTRY_STATES.includes(state);
}

/**
 * Durable uniqueness key: symbol + direction + exact OCC + session + setup
 * identity. This string is a PRIMARY KEY column, so a duplicate is refused by
 * SQLite itself rather than by a read-then-write check that can race.
 *
 * The setup identity is part of the key because the same contract reached by
 * two genuinely different setups is two different research observations; it is
 * NOT part of it by accident, and a missing setup collapses to the explicit
 * literal "NO_SETUP" rather than to an empty string that would silently merge
 * with a different missing value.
 */
export function paperPositionFingerprint(i: {
  sessionDate: string;
  symbol: string;
  direction: "CALL" | "PUT";
  optionSymbol: string;
  setupFamily: string | null;
}): string {
  const setup = String(i.setupFamily ?? "").trim() || "NO_SETUP";
  return [i.sessionDate, i.symbol.toUpperCase(), i.direction, i.optionSymbol.toUpperCase(), setup].join("|");
}

/** Terminal position states. A closed position is never reopened. */
export const PAPER_TERMINAL_STATES = Object.freeze(["CLOSED", "EXPIRED_SESSION"] as const);
export type PaperPositionState = "OPEN" | "CLOSED" | "EXPIRED_SESSION";

export function isPaperTerminal(state: string): boolean {
  return (PAPER_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * The authority table for this lane, frozen and uniformly false. Present so the
 * boundary is executable rather than merely documented: there is no argument,
 * flag, state, or configuration that makes any of these true.
 */
export const PAPER_LANE_AUTHORITY = Object.freeze({
  canSendSubscriber: false,
  canPlaceRealOrder: false,
  canModifySubscriberPaper: false,
  canChangeThresholds: false,
  aiMayDecide: false,
  simulatedOnly: true,
} as const);
