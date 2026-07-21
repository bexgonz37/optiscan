/**
 * lib/research/forward/twospeed.ts — the two-speed alert pipeline (Analog Engine, Phase F). PURE.
 *
 *   market event → fast deterministic trigger → minimum hard safety/liquidity gates → EARLY_WATCH
 *   then, IN PARALLEL (off the critical path): technical confirmation, options-chain analysis,
 *   catalyst/news, analog lookup, scoring + remaining gates → CONFIRMED | CANCELED | TOO_LATE | EXPIRED.
 *
 * The EARLY_WATCH decision (evaluateEarlyWatch) accepts ONLY fast, deterministic inputs — its type
 * cannot even reference analog/language-model/news results, so heavy work is structurally excluded from the
 * critical path. Bearish/short/put ideas can EARLY_WATCH but are never production-eligible while
 * BEARISH_ACTIONABLE is off (bearish-gate.ts remains the final authority; puts stay RESEARCH_ONLY).
 */
import { gateBearishAction } from "../../bearish-gate.ts";
import type { AlertState, Vehicle } from "./schema.ts";

// ── EARLY WATCH (fast path) ──────────────────────────────────────────────────
export interface EarlyWatchInput {
  symbol: string;
  direction: string;                 // bullish | bearish
  side: Vehicle;                     // call | put | stock
  underlyingPrice: number;
  observedAtMs: number;
  // fast, deterministic signal + liquidity — NOTHING that requires a network round-trip
  relVolume: number;                 // current volume / baseline
  movePct: number;                   // fast price velocity signal
  spreadPct: number | null;          // option spread if applicable
  openInterest: number | null;
  contractVolume: number | null;
  twoSidedQuote: boolean;
  gates: { minRelVolume: number; minAbsMovePct: number; maxSpreadPct: number; minOpenInterest: number; minContractVolume: number };
  env?: NodeJS.ProcessEnv;
}

export interface EarlyWatchResult {
  emit: boolean;
  state: AlertState | null;          // "EARLY_WATCH" when emitted
  productionEligible: boolean;       // false for research-only (bearish/put with the gate off)
  researchOnly: boolean;
  gatesPassed: string[];
  gatesFailed: string[];
  reason: string;
}

/** Deterministic trigger + minimum hard safety/liquidity gates. No analog/language-model/news. */
export function evaluateEarlyWatch(input: EarlyWatchInput): EarlyWatchResult {
  const env = input.env ?? process.env;
  const passed: string[] = [];
  const failed: string[] = [];
  const g = input.gates;

  // fast deterministic trigger
  if (input.relVolume >= g.minRelVolume) passed.push("rel_volume"); else failed.push("rel_volume");
  if (Math.abs(input.movePct) >= g.minAbsMovePct) passed.push("move"); else failed.push("move");

  // minimum hard safety/liquidity gates (only the cheap, local ones belong on the fast path)
  if (input.side !== "stock") {
    if (input.twoSidedQuote) passed.push("two_sided_quote"); else failed.push("two_sided_quote");
    if (input.spreadPct != null && input.spreadPct <= g.maxSpreadPct) passed.push("spread"); else failed.push("spread");
    if ((input.openInterest ?? 0) >= g.minOpenInterest) passed.push("open_interest"); else failed.push("open_interest");
    if ((input.contractVolume ?? 0) >= g.minContractVolume) passed.push("contract_volume"); else failed.push("contract_volume");
  }

  const emit = failed.length === 0;
  // bearish-gate.ts is the FINAL authority: a bearish/put idea can watch but is never actionable
  // while BEARISH_ACTIONABLE is off (verified option puts still route through the normal gate).
  const gate = gateBearishAction({ direction: input.direction, side: input.side, optionSide: input.side }, emit ? "ACTIONABLE" : "WAIT", env);
  const researchOnly = gate.gated || input.side === "put";
  return {
    emit,
    state: emit ? "EARLY_WATCH" : null,
    productionEligible: emit && !researchOnly,
    researchOnly,
    gatesPassed: passed,
    gatesFailed: failed,
    reason: emit ? (researchOnly ? (gate.reason ?? "research-only (put/bearish)") : "early watch emitted") : `hard gate failed: ${failed.join(",")}`,
  };
}

// ── CONFIRMATION (parallel enrichment resolves the alert) ─────────────────────
export interface ConfirmationInput {
  ageMs: number;                     // time since the market event
  ttlMs: number;                     // alert lifetime before it EXPIRES unconfirmed
  freshnessState: "FRESH" | "TOO_LATE"; // from checkEntryFreshness (entry still valid?)
  technicalConfirmed: boolean;       // technical confirmation (parallel)
  optionsOk: boolean;                // options-chain re-analysis passed the remaining hard gates
  remainingGatesFailed: string[];    // event-risk / freshness of chain / OI drift etc.
  analogContradicts?: boolean;       // optional: analog lookup strongly disagrees (never blocks EARLY_WATCH)
}

export interface ConfirmationResult { state: Extract<AlertState, "CONFIRMED" | "CANCELED" | "TOO_LATE" | "EXPIRED">; reason: string }

/** Resolve an EARLY_WATCH into its terminal alert state. Freshness/TOO_LATE takes precedence over
 *  a stale confirmation; an alert that ages out unconfirmed EXPIRES rather than firing late. */
export function resolveConfirmation(input: ConfirmationInput): ConfirmationResult {
  if (input.freshnessState === "TOO_LATE") return { state: "TOO_LATE", reason: "entry no longer valid — underlying left the entry zone / exceeded chase threshold" };
  if (input.ageMs > input.ttlMs) return { state: "EXPIRED", reason: `unconfirmed within ${input.ttlMs}ms TTL` };
  if (!input.technicalConfirmed) return { state: "CANCELED", reason: "technical confirmation failed" };
  if (!input.optionsOk || input.remainingGatesFailed.length > 0) return { state: "CANCELED", reason: `remaining gate failed: ${input.remainingGatesFailed.join(",") || "options"}` };
  if (input.analogContradicts) return { state: "CANCELED", reason: "analog evidence contradicts the setup" };
  return { state: "CONFIRMED", reason: "technical + options confirmed while still fresh" };
}
