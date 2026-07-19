/**
 * lib/research/strategy-agents.ts — the concrete strategy agents + the default
 * registry (Phase 4).
 *
 * TRUTHFUL by construction:
 *   • ACTIVE producers are ADAPTERS over the EXISTING horizon agents — they emit the
 *     canonical AgentResults (already computed once per ticker in the shared context)
 *     mapped through the Phase-1 adapter. No re-fetch, no duplicated logic, and the
 *     setup_id/attribution matches the underlying agent id exactly.
 *   • Context/review agents (regime, liquidity/IV, risk, data-quality) formalize
 *     existing services; they emit NO candidates (role !== producer).
 *   • Every agent whose data is not truthfully available ships INACTIVE_MISSING_DATA
 *     with the EXACT missing provider/feature list and emits nothing — no fabrication.
 *
 * Puts remain research-only: the underlying put_research horizon agent sets
 * actionability=RESEARCH_ONLY (bearish-gate), so tiering yields EXPERIMENTAL_VALID and
 * the lane router keeps puts out of Primary and Production Discord. This file never
 * relaxes that.
 */
import { agentResultToSetupCandidate } from "./adapter.ts";
import { StrategyRegistry } from "./strategy-registry.ts";
import type { AgentDirection, AgentHorizon, AgentRole, AgentStatus, StrategyAgent, StrategyEvaluationContext } from "./strategy-agent.ts";
import type { AssetClass, SetupCandidate } from "./types.ts";

interface AgentDef {
  id: string;
  name: string;
  version?: number;
  strategyFamily: string;
  assetClass: AssetClass | "mixed";
  role: AgentRole;
  supportedDirections?: AgentDirection[];
  supportedHorizons?: AgentHorizon[];
  requiredFeatures?: string[];
  requiredProviderData?: string[];
  /** Non-empty ⇒ INACTIVE_MISSING_DATA; lists the EXACT missing requirements. */
  missing?: string[];
  /** Env key that forces INACTIVE_DISABLED when set to "1". */
  disabledBy?: string;
  /** Producer emit fn (only called when ACTIVE + role==="producer"). */
  emit?: (ctx: StrategyEvaluationContext) => SetupCandidate[];
}

function mkAgent(def: AgentDef): StrategyAgent {
  const missing = def.missing ?? [];
  const status = (env: NodeJS.ProcessEnv = process.env): AgentStatus => {
    if (def.disabledBy && env[def.disabledBy] === "1") return "INACTIVE_DISABLED";
    if (missing.length > 0) return "INACTIVE_MISSING_DATA";
    return "ACTIVE";
  };
  return {
    id: def.id,
    name: def.name,
    version: def.version ?? 1,
    strategyFamily: def.strategyFamily,
    assetClass: def.assetClass,
    role: def.role,
    supportedDirections: def.supportedDirections ?? ["bullish"],
    supportedHorizons: def.supportedHorizons ?? [],
    requiredFeatures: def.requiredFeatures ?? [],
    requiredProviderData: def.requiredProviderData ?? [],
    status,
    inactiveReason(env: NodeJS.ProcessEnv = process.env) {
      const s = status(env);
      if (s === "ACTIVE") return null;
      if (s === "INACTIVE_DISABLED") return `disabled via ${def.disabledBy}=1`;
      return `missing required data: ${missing.join(", ")}`;
    },
    missingRequirements() {
      return [...missing];
    },
    evaluate(ctx: StrategyEvaluationContext): SetupCandidate[] {
      // Hard guard: inactive agents and non-producers NEVER emit — no fabrication.
      if (status() !== "ACTIVE" || def.role !== "producer" || !def.emit) return [];
      return def.emit(ctx);
    },
    diagnostics(env: NodeJS.ProcessEnv = process.env) {
      return {
        id: def.id, name: def.name, version: def.version ?? 1, strategyFamily: def.strategyFamily,
        assetClass: def.assetClass, role: def.role, status: status(env),
        supportedDirections: def.supportedDirections ?? ["bullish"],
        supportedHorizons: def.supportedHorizons ?? [],
        requiredFeatures: def.requiredFeatures ?? [], requiredProviderData: def.requiredProviderData ?? [],
        inactiveReason: this.inactiveReason(env), missingRequirements: [...missing], lastError: null,
      };
    },
  };
}

// ── ACTIVE options producers: adapters over the existing horizon agents ──────
interface HzSpec { hz: AgentHorizon; fam: string; label: string }
const HZ: HzSpec[] = [
  { hz: "0DTE", fam: "0dte", label: "0DTE" },
  { hz: "1-5", fam: "short_dated", label: "Short-Dated" },
  { hz: "6-10", fam: "short_dated", label: "Weekly" },
  { hz: "11-35", fam: "swing", label: "Swing" },
  { hz: "36-90", fam: "swing_leaps", label: "Swing/LEAPS" },
];

/** Emit the canonical results for exactly this agent's underlying horizon agent id. */
function emitForAgentId(id: string) {
  return (ctx: StrategyEvaluationContext): SetupCandidate[] =>
    ctx.agentResults
      .filter((r) => r.agentId === id)
      .map((r) => agentResultToSetupCandidate(r, { tradingDay: ctx.tradingDay, session: ctx.session, price: ctx.underlyingPrice }));
}

function horizonAgents(): StrategyAgent[] {
  const out: StrategyAgent[] = [];
  for (const h of HZ) {
    out.push(mkAgent({
      id: `call_${h.hz}`, name: `${h.label} Calls Agent`, strategyFamily: h.fam, assetClass: "option", role: "producer",
      supportedDirections: ["bullish"], supportedHorizons: [h.hz],
      requiredProviderData: ["options_chain", "options_quote", "greeks"], requiredFeatures: ["momentum", "liquidity", "spread"],
      emit: emitForAgentId(`call_${h.hz}`),
    }));
    out.push(mkAgent({
      // Puts stay research-only downstream (bearish-gate → RESEARCH_ONLY → tiering
      // EXPERIMENTAL_VALID → router keeps them out of Primary/Discord). Never relaxed here.
      id: `put_research_${h.hz}`, name: `${h.label} Puts Research Agent`, strategyFamily: h.fam, assetClass: "option", role: "producer",
      supportedDirections: ["bearish"], supportedHorizons: [h.hz],
      requiredProviderData: ["options_chain", "options_quote", "greeks"], requiredFeatures: ["momentum", "liquidity", "spread"],
      emit: emitForAgentId(`put_research_${h.hz}`),
    }));
  }
  return out;
}

// ── Context / review agents (formalize existing services; emit NO candidates) ──
function contextAndReviewAgents(): StrategyAgent[] {
  return [
    mkAgent({ id: "options_liquidity_contract", name: "Options Liquidity / Contract Selection Agent", strategyFamily: "microstructure", assetClass: "option", role: "context", requiredProviderData: ["options_chain", "options_quote"], requiredFeatures: ["spread", "open_interest", "volume"] }),
    mkAgent({ id: "volatility_iv_context", name: "Volatility / IV Context Agent", strategyFamily: "volatility", assetClass: "option", role: "context", disabledBy: "STRATEGY_AGENT_IV_CONTEXT_DISABLED", requiredProviderData: ["greeks", "implied_volatility"], requiredFeatures: ["iv_level"] }),
    mkAgent({ id: "market_regime", name: "Market Regime Agent", strategyFamily: "regime", assetClass: "mixed", role: "context", requiredFeatures: ["index_trend", "breadth"] }),
    mkAgent({ id: "risk_agent", name: "Risk Agent", strategyFamily: "risk", assetClass: "mixed", role: "review", requiredFeatures: ["proposed_trade_risk"] }),
    mkAgent({ id: "data_quality", name: "Data Quality Agent", strategyFamily: "data_quality", assetClass: "mixed", role: "review", requiredProviderData: ["provider_timestamps"] }),
  ];
}

// ── INACTIVE_MISSING_DATA agents (interface + diagnostics; emit nothing) ──────
function inactiveStockAgents(): StrategyAgent[] {
  const opts = (id: string, name: string, missing: string[]): AgentDef => ({
    id, name, strategyFamily: "stock", assetClass: "stock", role: "producer",
    supportedDirections: ["bullish", "bearish"], supportedHorizons: ["STOCK"], missing,
  });
  return [
    mkAgent(opts("momentum_acceleration", "Momentum Acceleration Agent", ["stock_feature_snapshot_in_context", "stock_tape_in_context"])),
    mkAgent(opts("breakout", "Breakout Agent", ["intraday_high_low_levels", "breakout_confirmation_features"])),
    mkAgent(opts("news_catalyst", "News Catalyst Agent", ["news_event_feed", "catalyst_scoring"])),
    mkAgent(opts("premarket_afterhours", "Premarket / After-Hours Agent", ["session_scoped_stock_features"])),
    mkAgent(opts("reversal", "Reversal Agent", ["reversal_detection_features", "exhaustion_signal"])),
    mkAgent(opts("sector_sympathy", "Sector Sympathy / Rotation Agent", ["sector_membership_map", "sector_relative_strength"])),
  ];
}

function inactiveOptionsAgents(): StrategyAgent[] {
  return [
    mkAgent({ id: "earnings_options_research", name: "Earnings Options Research Agent", strategyFamily: "earnings", assetClass: "option", role: "producer", supportedDirections: ["bullish", "bearish"], supportedHorizons: ["1-5", "6-10"], missing: ["earnings_calendar", "event_window_iv"] }),
  ];
}

function inactiveResearchAgents(): StrategyAgent[] {
  const r = (id: string, name: string, missing: string[]): StrategyAgent =>
    mkAgent({ id, name, strategyFamily: "research", assetClass: "mixed", role: "research", missing });
  return [
    r("trade_review", "Trade Review Agent", ["research_experiment_ledger_phase5", "graded_outcomes"]),
    r("counterfactual_review", "Counterfactual / Rejection Review Agent", ["counterfactual_outcomes_phase5"]),
    r("pattern_discovery", "Pattern Discovery Agent", ["graded_outcome_history_phase5_6"]),
    r("strategy_evaluation", "Strategy Evaluation Agent", ["per_strategy_outcomes_phase5"]),
    r("portfolio_allocation_research", "Portfolio Allocation Research Agent", ["research_experiment_returns_phase5"]),
  ];
}

/** The default, fully-populated set of strategy agents (deterministic). */
export function defaultStrategyAgents(): StrategyAgent[] {
  return [
    ...horizonAgents(),
    ...contextAndReviewAgents(),
    ...inactiveStockAgents(),
    ...inactiveOptionsAgents(),
    ...inactiveResearchAgents(),
  ];
}

/** A registry pre-loaded with the default agents. */
export function defaultRegistry(): StrategyRegistry {
  const reg = new StrategyRegistry();
  reg.registerAll(defaultStrategyAgents());
  return reg;
}
