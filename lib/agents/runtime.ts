/**
 * agents/runtime.ts — the impure agent runtime + Opportunity Orchestrator entry
 * (Phase 5). Gathers verified inputs (fresh chain via the metered provider,
 * freshness, market context, evidence, model state, risk verdict), runs every
 * relevant horizon agent through the PURE evaluator, and hands the results to the
 * PURE supervisor. It REUSES existing services and duplicates none of them.
 *
 * Next-server module (uses `@/` aliases); it is exercised via the API route and
 * source-spec tests rather than the node test runner.
 */
import { fetchOptionChain } from "@/lib/polygon-provider";
import { marketSession, type MarketSession } from "@/lib/trading-session";
import { selectContract, PROFILES, type ChainContract } from "@/lib/contract-selector";
import { HORIZON_AGENTS } from "@/lib/agents/registry";
import { evaluateHorizonAgent, type HorizonAgentInputs } from "@/lib/agents/horizon-agent";
import { superviseResults, nextPriorState, type SupervisorOutput, type PriorState } from "@/lib/agents/supervisor";
import { chainDteCoverage, relevantOptionAgents } from "@/lib/agents/relevance";
import {
  marketDataAgent, marketContextAgent, performanceAgentByStrategy, modelAgent, riskAgent, qualityControlAgent,
} from "@/lib/agents/services";
import type { FeatureInput } from "@/lib/model-features";
import type { AgentResult } from "@/lib/agents/types";

const FRESHNESS_KINDS = ["stock_quote", "options_chain", "options_quote", "greeks"];

function underlyingFrom(contracts: any[]): number | null {
  const c = contracts.find((x) => typeof x?.underlyingPrice === "number");
  return c?.underlyingPrice ?? null;
}
function chainAsOf(contracts: any[]): number | null {
  return contracts.reduce<number | null>((max, c) => (typeof c?.providerTimestamp === "number" && (max == null || c.providerTimestamp > max) ? c.providerTimestamp : max), null);
}

function featureInputFor(strategy: string, side: "call" | "put", session: MarketSession, sel: any, ctx: any): FeatureInput {
  return {
    strategy,
    direction: side === "put" ? "PUT" : "CALL",
    session,
    instrument: "option",
    dteAtEntry: sel.ok ? sel.contract.dte ?? null : null,
    entryDelta: sel.ok ? sel.marketData.delta ?? null : null,
    entrySpreadPct: sel.ok ? sel.marketData.spreadPct ?? null : null,
    entryIv: sel.ok ? sel.marketData.iv ?? null : null,
    selectionScore: sel.ok ? sel.score ?? null : null,
    ctxRiskState: (ctx?.riskState as string) ?? null,
    ctxStructure: (ctx?.structure as string) ?? null,
    ctxVolatility: (ctx?.volatility as string) ?? null,
  };
}

export interface RunAgentsResult {
  ticker: string;
  session: MarketSession;
  supervised: SupervisorOutput;
  marketContext: Record<string, unknown> | null;
  qualityControl: Record<string, unknown>;
  chainAvailable: boolean;
  /** Horizon×direction agent ids actually evaluated (chain-supported only). */
  agentsRun: string[];
  /** Prior-state map for the NEXT cycle's lifecycle hysteresis. */
  nextPrior: Map<string, PriorState>;
}

export interface RunAgentsOptions {
  /** Prior supervisor state (per ticker) so lifecycle hysteresis survives cycles. */
  previous?: Map<string, PriorState>;
}

/**
 * Run the relevant horizon agents for ONE ticker and return the supervised
 * canonical set. A single 0–90 DTE chain fetch (metered via `polyFetch`) serves
 * every horizon; horizons the chain does not actually cover are skipped rather
 * than widened to unsupported contracts. Reuses the freshness / context /
 * statistics / model / risk / selector services — it duplicates none of them.
 */
export async function runAgentsForTicker(ticker: string, nowMs: number = Date.now(), opts: RunAgentsOptions = {}): Promise<RunAgentsResult> {
  const session = marketSession(nowMs);
  const freshness = marketDataAgent(ticker, FRESHNESS_KINDS);
  const context = marketContextAgent();

  let contracts: ChainContract[] = [];
  let chainAvailable = false;
  try {
    const chain: any = await fetchOptionChain(ticker, { dteMin: 0, dteMax: 90, maxPages: 3 });
    chainAvailable = Boolean(chain?.available);
    contracts = (chain?.contracts ?? []) as ChainContract[];
  } catch {
    chainAvailable = false;
  }
  const spot = underlyingFrom(contracts);
  const asOf = chainAsOf(contracts);

  // Only evaluate horizons the fetched chain genuinely covers (no silent widening
  // to unsupported expirations). With no chain, no option horizon agent runs.
  const coverage = chainDteCoverage(contracts);
  const activeAgents = relevantOptionAgents(HORIZON_AGENTS, coverage);

  const results: AgentResult[] = [];
  for (const cfg of activeAgents) {
    const side: "call" | "put" = cfg.direction === "bearish" ? "put" : "call";
    const selection = selectContract(
      { underlying: ticker, spot, side, contracts, session, chainAvailable, chainAsOfMs: asOf, nowMs },
      cfg.selectorProfile,
    );
    const evidence = performanceAgentByStrategy(cfg.strategy);
    const model = modelAgent(featureInputFor(cfg.strategy, side, session, selection, context) as unknown as Record<string, unknown>);

    // Risk verdict: computed (and enforced) only for a bullish, actionable candidate.
    let riskVerdict = { allowed: true, failures: [] as string[], vetoed: false };
    if (cfg.direction === "bullish" && selection.ok && selection.actionable) {
      riskVerdict = riskAgent({
        ticker,
        optionType: "call",
        dte: selection.contract.dte ?? null,
        entryLimit: selection.marketData.mid ?? 0,
        contracts: 1,
        stopLossPct: null,
      });
    }

    const input: HorizonAgentInputs = {
      ticker, session, nowMs, selection, freshness,
      marketContext: context, evidence, model, riskVerdict,
      lifecycleStatus: null,
      triggerConditions: [],
      invalidationConditions: [],
    };
    results.push(evaluateHorizonAgent(cfg, input));
  }

  const supervised = superviseResults({ results, nowMs, previous: opts.previous });
  const nextPrior = nextPriorState(supervised.canonical, opts.previous, nowMs);
  return {
    ticker: ticker.toUpperCase(),
    session,
    supervised,
    marketContext: context,
    qualityControl: qualityControlAgent(),
    chainAvailable,
    agentsRun: activeAgents.map((a) => a.agentId),
    nextPrior,
  };
}
