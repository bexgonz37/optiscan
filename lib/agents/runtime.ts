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
import { assessEntryWindow, entryWindowConfig } from "@/lib/entry-window";
import { latchConfig, updateLatch, crossingSignal, markFired, type LatchState } from "@/lib/breakout-latch";
import { loopState } from "@/lib/scanner-loop";
import type { FeatureInput } from "@/lib/model-features";
import type { AgentResult } from "@/lib/agents/types";

const FRESHNESS_KINDS = ["stock_quote", "options_chain", "options_quote", "greeks"];

/**
 * In-process breakout-crossing latch state, keyed by ticker:side:strategy. Held
 * in memory ON PURPOSE: a process restart starts empty, so a crossing can only be
 * rescued if THIS process observed the prior developing stamp → no post-restart
 * ghost alerts. Railway runs a single replica, so cross-worker sharing is not
 * required; entries self-expire by TTL and are pruned when cleared.
 */
const LATCH_STATE = new Map<string, LatchState>();

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

  // Live momentum snapshot for the FORWARD-LOOKING entry window (anti-late). The
  // scanner tape carries the underlying's current direction/extension/volume; with
  // no snapshot the entry window cannot confirm an entry and never returns
  // ACTIONABLE. Best-effort: a scanner that has not booted yields null (→ WATCH/
  // early), never a false actionable.
  let tapeRow: any = null;
  try {
    const tape: any[] = (loopState() as any)?.tape ?? [];
    tapeRow = tape.find((r) => String(r?.symbol ?? "").toUpperCase() === ticker.toUpperCase()) ?? null;
  } catch { tapeRow = null; }
  const momentum = tapeRow
    ? { shortRate: tapeRow.shortRate ?? null, accel: tapeRow.accel ?? null, aboveVwap: tapeRow.aboveVwap ?? null, vwapDistPct: tapeRow.vwapDistPct ?? null, movePct: tapeRow.movePct ?? null, relVol: tapeRow.relVol ?? null }
    : null;
  const ewCfg = entryWindowConfig();
  const latchCfg = latchConfig();
  const quoteAgeMs = asOf != null ? Math.max(0, nowMs - asOf) : null;
  const maxEntrySpreadPct = Number(process.env.ENTRY_MAX_SPREAD_PCT ?? 8) || 8;

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

    // Forward-looking entry window for THIS side (anti-late authority).
    const ewInput = {
      side,
      regularSession: session === "regular",
      momentum,
      quoteAgeMs,
      spreadPct: selection.ok ? selection.marketData.spreadPct : null,
      maxSpreadPct: maxEntrySpreadPct,
      cfg: ewCfg,
    };
    // Deterministic breakout-crossing latch (breakout-latch.ts): a fast breakout
    // can cross the entry band BETWEEN ~30s supervisor cycles, so a single-instant
    // snapshot sees NEAR_TRIGGER then WAIT_FOR_PULLBACK and never ACTIONABLE. Two
    // consecutive snapshots bracket the crossing: if a prior cycle stamped this
    // candidate as developing and it is now just past the band but still fully
    // confirmed and not extended, rescue it to ACTIONABLE — once. No band widening,
    // no extra provider calls, all downstream gates unchanged.
    const latchKey = `${ticker.toUpperCase()}:${side}:${cfg.strategy}`;
    const base = assessEntryWindow(ewInput);
    const invalidated = ["INVALIDATED", "BLOCKED", "EXTENDED", "MISSED"].includes(base.state);
    let latch = updateLatch(LATCH_STATE.get(latchKey), { developingNow: base.developing, invalidated, nowMs, cfg: latchCfg });
    let entryWindow = base;
    if (base.state === "ACTIONABLE") {
      // Normal actionable fire — mark the episode fired so a later just-past
      // reading cannot re-rescue the same move (dedup across cycles).
      latch = markFired(latch, nowMs);
    } else {
      const signal = crossingSignal(latch, nowMs, latchCfg);
      if (signal.active) {
        const rescued = assessEntryWindow({ ...ewInput, crossing: signal });
        if (rescued.crossingLatched) {
          entryWindow = rescued;
          latch = markFired(latch, nowMs); // fire once per crossing episode
        }
      }
    }
    if (latch.developingSinceMs == null && latch.firedAtMs == null) LATCH_STATE.delete(latchKey);
    else LATCH_STATE.set(latchKey, latch);

    const input: HorizonAgentInputs = {
      ticker, session, nowMs, selection, freshness,
      marketContext: context, evidence, model, riskVerdict,
      lifecycleStatus: null,
      triggerConditions: [],
      invalidationConditions: [],
      entryWindow,
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
