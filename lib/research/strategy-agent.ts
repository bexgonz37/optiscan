/**
 * lib/research/strategy-agent.ts — the typed StrategyAgent interface + the shared
 * StrategyEvaluationContext (Phase 4). PURE types + small helpers, no I/O.
 *
 * A StrategyAgent is a HYPOTHESIS PRODUCER (or a context/review/research role). It
 * emits normalized SetupCandidate records ONLY. It may NEVER send Discord, create a
 * trade, alter balances, bypass the lane router / deterministic tiering /
 * bearish-gate, relax freshness, override risk/liquidity/safety gates, mutate
 * production config, or fabricate unavailable data. All trading, routing, tiering,
 * execution, and Discord decisions live OUTSIDE the agents (Phases 1–3).
 *
 * The shared context carries ONE timestamped market-data snapshot per ticker so
 * agents never re-fetch: the existing per-ticker agent run (which fetches the chain
 * once) is mapped into this context and reused by every agent.
 */
import type { AgentDirection, AgentHorizon, AgentResult } from "../agents/types.ts";
import type { AssetClass, MarketSessionName, SetupCandidate } from "./types.ts";

export type AgentStatus = "ACTIVE" | "INACTIVE_MISSING_DATA" | "INACTIVE_DISABLED" | "ERROR";
/** producer = emits candidates; context = supplies features; review = veto/evidence; research = offline analysis. */
export type AgentRole = "producer" | "context" | "review" | "research";

export interface StrategyEvaluationContext {
  ticker: string;
  nowMs: number;
  tradingDay: string;
  session: MarketSessionName;
  /** Shared freshness/data-quality verdict for the underlying+chain this cycle. */
  freshness: { ok: boolean; reason: string | null } | null;
  /** Shared market-regime/context features (from marketContextAgent). */
  marketRegime: Record<string, unknown> | null;
  /** Pre-computed canonical agent verdicts for THIS ticker — the shared data layer.
   *  Producers adapt the subset that matches their horizon/direction; no re-fetch. */
  agentResults: AgentResult[];
  underlyingPrice: number | null;
  /** Extra shared features (VWAP state, RVOL, IV context, …) when truthfully available. */
  features: Record<string, unknown> | null;
  /** Explicit missing-data markers surfaced by the shared layer (never fabricated). */
  missing: string[];
}

export interface AgentDiagnostics {
  id: string;
  name: string;
  version: number;
  strategyFamily: string;
  assetClass: AssetClass | "mixed";
  role: AgentRole;
  status: AgentStatus;
  supportedDirections: AgentDirection[];
  supportedHorizons: AgentHorizon[];
  requiredFeatures: string[];
  requiredProviderData: string[];
  inactiveReason: string | null;
  missingRequirements: string[];
  lastError: string | null;
}

export interface StrategyAgent {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly strategyFamily: string;
  readonly assetClass: AssetClass | "mixed";
  readonly role: AgentRole;
  readonly supportedDirections: AgentDirection[];
  readonly supportedHorizons: AgentHorizon[];
  readonly requiredFeatures: string[];
  readonly requiredProviderData: string[];
  /** Base status (before the framework flag). INACTIVE agents never emit. */
  status(env?: NodeJS.ProcessEnv): AgentStatus;
  /** Human reason when not ACTIVE, else null. */
  inactiveReason(env?: NodeJS.ProcessEnv): string | null;
  /** Exact missing provider/feature requirements (empty when satisfied). */
  missingRequirements(env?: NodeJS.ProcessEnv): string[];
  /** Emit normalized candidates. MUST return [] unless ACTIVE and role==="producer". */
  evaluate(ctx: StrategyEvaluationContext): SetupCandidate[];
  diagnostics(env?: NodeJS.ProcessEnv): AgentDiagnostics;
}

/** Build a standard diagnostics object from an agent (deterministic). */
export function diagnosticsOf(a: StrategyAgent, env: NodeJS.ProcessEnv = process.env, lastError: string | null = null): AgentDiagnostics {
  return {
    id: a.id, name: a.name, version: a.version, strategyFamily: a.strategyFamily,
    assetClass: a.assetClass, role: a.role, status: a.status(env),
    supportedDirections: a.supportedDirections, supportedHorizons: a.supportedHorizons,
    requiredFeatures: a.requiredFeatures, requiredProviderData: a.requiredProviderData,
    inactiveReason: a.inactiveReason(env), missingRequirements: a.missingRequirements(env),
    lastError,
  };
}

export type { AgentDirection, AgentHorizon, AgentResult, AssetClass, SetupCandidate };
