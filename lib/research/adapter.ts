/**
 * lib/research/adapter.ts — PURE mapping from the existing agent verdict
 * (`AgentResult`) to the normalized `SetupCandidate` (Phase 1). Reuses the
 * deterministic tier classifier. No I/O; the trading day + session are supplied
 * by the caller so this stays pure and unit-testable.
 *
 * Greeks: only `delta`/`iv` exist on `AgentContractRef` at this layer, so
 * gamma/theta/vega are left null and `available` reflects what the provider truly
 * gave us. Nothing is fabricated.
 */
import type { AgentResult } from "../agents/types.ts";
import { classifySetupTier } from "./tiering.ts";
import {
  setupIdOf,
  type GreeksSnapshot,
  type Lane,
  type MarketSessionName,
  type SetupCandidate,
} from "./types.ts";

export interface AdapterContext {
  tradingDay: string;
  session: MarketSessionName;
  /** Underlying/stock price for stock candidates (options price is on the contract). */
  price?: number | null;
  featureSnapshot?: Record<string, unknown> | null;
  maxResearchSpreadPct?: number;
}

function greeksOf(r: AgentResult): GreeksSnapshot | null {
  const k = r.selectedContract;
  if (!k) return null;
  const available = k.delta != null || k.iv != null;
  return { delta: k.delta ?? null, gamma: null, theta: null, vega: null, iv: k.iv ?? null, available };
}

export function agentResultToSetupCandidate(r: AgentResult, ctx: AdapterContext): SetupCandidate {
  const assetClass = r.horizon === "STOCK" ? "stock" : "option";
  const k = r.selectedContract;

  const { tier, gateResults, rejectionReasons } = classifySetupTier({
    assetClass,
    candidateStatus: r.candidateStatus,
    actionability: r.actionability,
    freshnessOk: r.freshness.ok,
    freshnessReason: r.freshness.reason,
    riskAllowed: r.riskVerdict.allowed,
    riskVetoed: r.riskVerdict.vetoed,
    riskFailures: r.riskVerdict.failures,
    contract: k,
    price: ctx.price ?? null,
    maxResearchSpreadPct: ctx.maxResearchSpreadPct,
  });

  const setupId = setupIdOf(
    { strategyAgent: r.agentId, ticker: r.ticker, direction: r.direction, horizon: r.horizon, optionSymbol: k?.optionSymbol ?? null },
    ctx.tradingDay,
  );

  // Consumer lanes are ASSIGNED by the Phase-2 lane router; at capture time the
  // list is empty (the router persists routing decisions separately).
  const consumerLanes: Lane[] = [];

  return {
    setupId,
    strategyAgent: r.agentId,
    strategyFamily: r.strategy,
    strategyVersion: r.strategyVersion,
    agentVersion: r.agentVersion,
    ticker: r.ticker.toUpperCase(),
    direction: r.direction,
    assetClass,
    optionSymbol: k?.optionSymbol ?? null,
    expiration: k?.expiration ?? null,
    strike: k?.strike ?? null,
    side: k?.side ?? null,
    horizon: r.horizon,
    session: ctx.session,
    setupTier: tier,
    confidence: r.score ?? null,
    candidateStatus: r.candidateStatus,
    actionability: r.actionability,
    gateResults,
    rejectionReasons,
    freshnessState: r.freshness.ok ? "fresh" : (r.freshness.reason ?? "stale"),
    liquidity: k?.openInterest ?? null,
    spreadPct: k?.spreadPct ?? null,
    volume: k?.volume ?? null,
    openInterest: k?.openInterest ?? null,
    greeks: greeksOf(r),
    entryThesis: r.reasons[0] ?? null,
    invalidationThesis: r.invalidationConditions[0] ?? null,
    featureSnapshot: ctx.featureSnapshot ?? (r.verifiedInputs ?? null),
    marketRegimeContext: r.marketContext ?? null,
    originatingTsMs: r.timestamp,
    consumerLanes,
    experimentId: null,
    modelVersion: null,
    outcome: null,
  };
}
