/**
 * lib/research/lane-portfolio.ts — PURE mapping from an executable lane to the
 * paper portfolio it fills into, plus its cooldown scope (Phase 3).
 *
 * The actual sizing configs live with the portfolios they belong to
 * (paper-challenge.ts: challengeSizingEnv / researchSizingEnv; paper-position-sizer
 * profiles for Primary). This module only declares the wiring so the independent
 * consumers know WHICH portfolio + cooldown scope to use per lane.
 */
import type { Lane } from "./types.ts";

export const PRIMARY_PORTFOLIO = "PRIMARY";
export const CHALLENGE_PORTFOLIO = "CHALLENGE";
export const RESEARCH_PORTFOLIO = "RESEARCH";

/** Cooldown scope: Primary keeps the stricter account-wide cooldown; the independent
 *  lanes isolate per symbol so one loss never freezes unrelated tickers. */
export type CooldownScope = "account" | "ticker";

export interface LanePortfolioSpec {
  lane: Lane;
  portfolio: string;
  cooldownScope: CooldownScope;
}

const SPECS: Record<string, LanePortfolioSpec> = {
  PRIMARY_PAPER: { lane: "PRIMARY_PAPER", portfolio: PRIMARY_PORTFOLIO, cooldownScope: "account" },
  CHALLENGE_PAPER: { lane: "CHALLENGE_PAPER", portfolio: CHALLENGE_PORTFOLIO, cooldownScope: "ticker" },
  RESEARCH: { lane: "RESEARCH", portfolio: RESEARCH_PORTFOLIO, cooldownScope: "ticker" },
};

export function lanePortfolioSpec(lane: Lane): LanePortfolioSpec | null {
  return SPECS[lane] ?? null;
}

export function portfolioForLane(lane: Lane): string | null {
  return SPECS[lane]?.portfolio ?? null;
}
