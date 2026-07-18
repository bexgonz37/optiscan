/**
 * lib/research/lane-policy.ts — PURE per-lane routing policy (Phase 2).
 *
 * Decides, for a normalized SetupCandidate, which EXECUTABLE / RESEARCH lanes may
 * consume it. Deterministic only — never consults probability/model/AI.
 *
 * IMPORTANT boundaries (owner clarification):
 *   • Production Discord is NOT decided here and is NOT controlled by the router.
 *     The existing `lib/callouts/eligibility.ts` remains the sole authority for
 *     Discord sends. This module intentionally covers only PRIMARY_PAPER,
 *     CHALLENGE_PAPER, and RESEARCH.
 *   • REJECTED_INVALID never routes to ANY paper-fill lane (recorded elsewhere for
 *     counterfactual analysis, but never traded).
 *   • RESEARCH may simulate NEAR_MISS_VALID only when a defensible real quote
 *     exists — enforced by requiring the contractIdentity + freshness gates to pass.
 */
import type { Lane, SetupCandidate } from "./types.ts";

export interface LaneDecision {
  lane: Lane;
  routed: boolean;
  reasonCode: string;
  reason: string;
}

/** The lanes this policy module decides. Discord + Historical are out of scope here. */
export const EXECUTABLE_LANES: readonly Lane[] = Object.freeze(["PRIMARY_PAPER", "CHALLENGE_PAPER", "RESEARCH"]);

function gatePassed(c: SetupCandidate, name: string): boolean {
  return c.gateResults?.[name]?.passed === true;
}

/** Does the candidate carry a defensible, fillable quote right now? */
function hasDefensibleQuote(c: SetupCandidate): boolean {
  return gatePassed(c, "contractIdentity") && gatePassed(c, "freshness");
}

function decide(lane: Lane, routed: boolean, reasonCode: string, reason: string): LaneDecision {
  return { lane, routed, reasonCode, reason };
}

/** Primary = conservative benchmark: PRODUCTION_QUALITY only. */
export function primaryDecision(c: SetupCandidate): LaneDecision {
  if (c.setupTier === "REJECTED_INVALID") return decide("PRIMARY_PAPER", false, "REJECTED_INVALID", "rejected-invalid never trades");
  if (c.setupTier === "PRODUCTION_QUALITY") return decide("PRIMARY_PAPER", true, "OK", "production-quality → Primary");
  return decide("PRIMARY_PAPER", false, "NOT_PRODUCTION_QUALITY", `tier ${c.setupTier} is below Primary's production-quality bar`);
}

/** Challenge = aggressive: PRODUCTION_QUALITY + selected EXPERIMENTAL_VALID. */
export function challengeDecision(c: SetupCandidate): LaneDecision {
  if (c.setupTier === "REJECTED_INVALID") return decide("CHALLENGE_PAPER", false, "REJECTED_INVALID", "rejected-invalid never trades");
  if (c.setupTier === "PRODUCTION_QUALITY" || c.setupTier === "EXPERIMENTAL_VALID") {
    if (!hasDefensibleQuote(c)) return decide("CHALLENGE_PAPER", false, "NO_DEFENSIBLE_QUOTE", "no fresh two-sided quote to fill");
    return decide("CHALLENGE_PAPER", true, "OK", `${c.setupTier} → Challenge`);
  }
  return decide("CHALLENGE_PAPER", false, "TIER_NOT_ELIGIBLE", `tier ${c.setupTier} not eligible for Challenge`);
}

/** Research = high-volume evidence: PRODUCTION_QUALITY + EXPERIMENTAL_VALID + NEAR_MISS_VALID,
 *  but only when a defensible real quote exists (never a fabricated fill). */
export function researchDecision(c: SetupCandidate): LaneDecision {
  if (c.setupTier === "REJECTED_INVALID") return decide("RESEARCH", false, "REJECTED_INVALID", "rejected-invalid recorded but never filled");
  const eligibleTier = c.setupTier === "PRODUCTION_QUALITY" || c.setupTier === "EXPERIMENTAL_VALID" || c.setupTier === "NEAR_MISS_VALID";
  if (!eligibleTier) return decide("RESEARCH", false, "TIER_NOT_ELIGIBLE", `tier ${c.setupTier} not eligible for Research`);
  if (!hasDefensibleQuote(c)) return decide("RESEARCH", false, "NO_DEFENSIBLE_QUOTE", "no defensible real quote — recorded, not simulated");
  return decide("RESEARCH", true, "OK", `${c.setupTier} → Research`);
}

/** All executable-lane decisions for a candidate (Primary, Challenge, Research). */
export function evaluateExecutableLanes(c: SetupCandidate): LaneDecision[] {
  return [primaryDecision(c), challengeDecision(c), researchDecision(c)];
}
