/**
 * agents/registry.ts — the deterministic catalog of strategy agents (Phase 5).
 * PURE data. Each horizon×direction is a distinct, versioned agent that reuses a
 * centralized selector profile. Puts are separate agents that are ALWAYS
 * research-only (the horizon evaluator + bearish gate enforce it).
 */
import { strategyVersionFor } from "../setup-fingerprint.ts";
import type { HorizonAgentConfig } from "./horizon-agent.ts";
import type { AgentHorizon } from "./types.ts";

interface HorizonSpec { horizon: AgentHorizon; profile: string; dteRange: [number, number] }

const HORIZONS: HorizonSpec[] = [
  { horizon: "0DTE", profile: "zero_dte_momentum", dteRange: [0, 1] },
  { horizon: "1-5", profile: "short_dated_call", dteRange: [1, 5] },
  { horizon: "6-10", profile: "weekly_call", dteRange: [6, 10] },
  { horizon: "11-35", profile: "multiweek_call", dteRange: [11, 35] },
  { horizon: "36-90", profile: "leaps_research_call", dteRange: [36, 90] },
];

function makeAgents(): HorizonAgentConfig[] {
  const out: HorizonAgentConfig[] = [];
  for (const h of HORIZONS) {
    const sv = strategyVersionFor(h.profile);
    out.push({
      agentId: `call_${h.horizon}`,
      agentVersion: 1,
      strategy: h.profile,
      strategyVersion: sv,
      direction: "bullish",
      horizon: h.horizon,
      dteRange: h.dteRange,
      selectorProfile: h.profile,
    });
    out.push({
      agentId: `put_research_${h.horizon}`,
      agentVersion: 1,
      strategy: h.profile,
      strategyVersion: sv,
      direction: "bearish", // ALWAYS research-only
      horizon: h.horizon,
      dteRange: h.dteRange,
      selectorProfile: h.profile,
    });
  }
  return out;
}

/** All options horizon agents (5 bullish call + 5 put research). */
export const HORIZON_AGENTS: HorizonAgentConfig[] = makeAgents();

/** The long-only momentum stock agent (handled via the paper-stock path, not a contract profile). */
export const STOCK_AGENT = {
  agentId: "momentum_stock_long",
  agentVersion: 1,
  strategy: "momentum_stock",
  strategyVersion: strategyVersionFor("momentum_stock"),
  direction: "bullish" as const,
  horizon: "STOCK" as const,
};

export function agentById(id: string): HorizonAgentConfig | undefined {
  return HORIZON_AGENTS.find((a) => a.agentId === id);
}
