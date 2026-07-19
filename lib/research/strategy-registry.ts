/**
 * lib/research/strategy-registry.ts — the versioned strategy-agent registry +
 * flag-gated evaluation (Phase 4).
 *
 * Guarantees:
 *   • Duplicate agent ids are rejected at registration.
 *   • Deterministic ordering (sorted by id) for reproducible runs.
 *   • An INACTIVE agent is NEVER evaluated and can never emit candidates.
 *   • Evaluation is a HARD no-op unless STRATEGY_AGENTS_V2_ENABLED=1.
 *   • One agent's exception never stops the others (failure isolation) — the error
 *     is captured in diagnostics; there are no silent failures.
 *   • The registry never sends Discord, never creates a trade, never routes — it only
 *     collects normalized SetupCandidates for the EXISTING lane router/tiering to use.
 */
import { researchFlags } from "./flags.ts";
import { diagnosticsOf, type AgentDiagnostics, type StrategyAgent, type StrategyEvaluationContext } from "./strategy-agent.ts";
import type { SetupCandidate } from "./types.ts";

export class StrategyRegistry {
  private agents = new Map<string, StrategyAgent>();

  register(agent: StrategyAgent): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`duplicate strategy-agent id: ${agent.id}`);
    }
    this.agents.set(agent.id, agent);
  }

  registerAll(agents: StrategyAgent[]): void {
    for (const a of agents) this.register(a);
  }

  get(id: string): StrategyAgent | undefined {
    return this.agents.get(id);
  }

  /** All agents, deterministically ordered by id. */
  list(): StrategyAgent[] {
    return [...this.agents.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  activeProducers(env: NodeJS.ProcessEnv = process.env): StrategyAgent[] {
    return this.list().filter((a) => a.role === "producer" && a.status(env) === "ACTIVE");
  }

  capabilityReport(env: NodeJS.ProcessEnv = process.env): AgentDiagnostics[] {
    return this.list().map((a) => diagnosticsOf(a, env));
  }
}

export interface AgentRunResult {
  agentId: string;
  status: string;
  emitted: number;
  error: string | null;
}

export interface StrategyEvaluationResult {
  ran: boolean;
  skippedReason: string | null;
  candidates: SetupCandidate[];
  perAgent: AgentRunResult[];
}

/**
 * Evaluate ACTIVE producer agents against a shared context. HARD no-op unless the
 * framework flag is on. Inactive agents are skipped (never evaluated). Every agent
 * runs in its own try/catch so one failure cannot stop the rest.
 */
export function evaluateAgents(
  registry: StrategyRegistry,
  ctx: StrategyEvaluationContext,
  env: NodeJS.ProcessEnv = process.env,
): StrategyEvaluationResult {
  if (!researchFlags(env).strategyAgentsV2) {
    return { ran: false, skippedReason: "STRATEGY_AGENTS_V2_ENABLED!=1", candidates: [], perAgent: [] };
  }
  const candidates: SetupCandidate[] = [];
  const perAgent: AgentRunResult[] = [];
  for (const agent of registry.activeProducers(env)) {
    try {
      // Defense-in-depth: even though we filtered to ACTIVE producers, re-assert it —
      // an agent whose evaluate ignored its own status can never leak here.
      const emitted = agent.status(env) === "ACTIVE" && agent.role === "producer" ? agent.evaluate(ctx) : [];
      candidates.push(...emitted);
      perAgent.push({ agentId: agent.id, status: "ACTIVE", emitted: emitted.length, error: null });
    } catch (err: any) {
      // Failure isolation: capture and continue. No silent failure.
      perAgent.push({ agentId: agent.id, status: "ERROR", emitted: 0, error: String(err?.message ?? err).slice(0, 200) });
    }
  }
  return { ran: true, skippedReason: null, candidates, perAgent };
}
