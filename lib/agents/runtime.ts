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
import { superviseResults, type SupervisorOutput } from "@/lib/agents/supervisor";
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
}

/** Run all horizon agents for one ticker and return the supervised canonical set. */
export async function runAgentsForTicker(ticker: string, nowMs: number = Date.now()): Promise<RunAgentsResult> {
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

  const results: AgentResult[] = [];
  for (const cfg of HORIZON_AGENTS) {
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

  const supervised = superviseResults({ results, nowMs });
  return { ticker: ticker.toUpperCase(), session, supervised, marketContext: context, qualityControl: qualityControlAgent(), chainAvailable };
}
