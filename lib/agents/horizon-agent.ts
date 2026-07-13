/**
 * agents/horizon-agent.ts — deterministic evaluation for one options horizon
 * agent (Phase 5). PURE: it consumes already-gathered, verified inputs (a
 * selectContract result, freshness, market context, evidence, model state, risk
 * verdict) and produces a normalized AgentResult. The runtime does the I/O.
 *
 * Bearish trading: gated by lib/bearish-gate.ts (BEARISH_ACTIONABLE). When OFF a
 * bearish idea is research-only; when ON it runs the SAME risk/selection lifecycle
 * as bullish (identical quality standards — no separate, weaker path). A hard gate
 * (stale data, no valid contract, risk veto) always outranks a favorable selection
 * or a model probability, in either direction.
 */
import type { SelectionResult } from "../contract-selector.ts";
import type { MarketSession } from "../trading-session.ts";
import { gateBearishAction } from "../bearish-gate.ts";
import type {
  AgentResult, AgentDirection, AgentHorizon, AgentActionability, CandidateStatus,
  AgentContractRef, AgentEvidence, AgentModelState, AgentRiskVerdict,
} from "./types.ts";

export interface HorizonAgentConfig {
  agentId: string;
  agentVersion: number;
  strategy: string;          // selector profile name (= strategy label)
  strategyVersion: number;
  direction: AgentDirection;
  horizon: AgentHorizon;
  dteRange: [number, number];
  selectorProfile: string;
}

export interface HorizonAgentInputs {
  ticker: string;
  session: MarketSession;
  nowMs: number;
  selection: SelectionResult;
  freshness: { ok: boolean; reason: string | null };
  marketContext?: Record<string, unknown> | null;
  evidence?: AgentEvidence | null;
  model?: AgentModelState | null;
  riskVerdict?: AgentRiskVerdict | null;
  lifecycleStatus?: string | null;
  triggerConditions?: string[];
  invalidationConditions?: string[];
}

function contractRef(sel: SelectionResult, side: "call" | "put"): AgentContractRef | null {
  if (!sel.ok) return null;
  return {
    optionSymbol: sel.contract.optionSymbol ?? null,
    strike: sel.contract.strike ?? null,
    expiration: sel.contract.expiration ?? null,
    dte: sel.contract.dte ?? null,
    side,
    bid: sel.contract.bid ?? null,
    ask: sel.contract.ask ?? null,
    mid: sel.marketData.mid,
    spreadPct: sel.marketData.spreadPct,
    delta: sel.marketData.delta,
    iv: sel.marketData.iv,
    volume: sel.marketData.volume,
    openInterest: sel.marketData.openInterest,
    breakevenPct: sel.marketData.breakevenPct,
  };
}

/** Evaluate one horizon agent into a normalized AgentResult. */
export function evaluateHorizonAgent(config: HorizonAgentConfig, input: HorizonAgentInputs): AgentResult {
  const side: "call" | "put" = config.direction === "bearish" ? "put" : "call";
  const isBearish = config.direction === "bearish";
  const sel = input.selection;

  // The bearish gate is consulted for EVERY bearish idea (final authority).
  const bearish = gateBearishAction({ direction: config.direction, side }, "TRADE");

  const reasons: string[] = [];
  const improvementConditions: string[] = [];
  const passedGates: string[] = [];
  const failedGates: string[] = [];

  let candidateStatus: CandidateStatus;
  let actionability: AgentActionability;
  let researchOnly: boolean;

  if (!input.freshness.ok) {
    candidateStatus = "DATA_STALE";
    actionability = "BLOCKED";
    researchOnly = isBearish;
    reasons.push(`Data stale/unavailable: ${input.freshness.reason ?? "freshness gate failed"}.`);
    improvementConditions.push("A fresh two-sided quote and chain restores evaluation.");
  } else if (!sel.ok) {
    candidateStatus = "NO_VALID_CONTRACT";
    actionability = isBearish ? "RESEARCH_ONLY" : "BLOCKED";
    researchOnly = true;
    reasons.push(sel.reason);
    for (const g of Object.keys(sel.blockedByGate ?? {})) failedGates.push(g);
    improvementConditions.push("A contract in this horizon must pass spread/liquidity/delta/DTE gates.");
  } else {
    // A contract was selected. Derive the "passed" gates for transparency.
    for (const g of ["mid", "spread", "delta", "dte", "freshness"]) passedGates.push(g);

    if (bearish.gated) {
      // Bearish actionability is OFF (BEARISH_ACTIONABLE≠1) → research-only. When
      // enabled, a bearish idea falls through to the SAME risk/selection lifecycle
      // as bullish below (§3: identical quality standards, no separate path).
      candidateStatus = "RESEARCH_ONLY";
      actionability = "RESEARCH_ONLY";
      researchOnly = true;
      reasons.push(bearish.reason ?? "Bearish idea is research-only until bearish trading is enabled.");
    } else if (input.riskVerdict && !input.riskVerdict.allowed) {
      // Risk veto outranks a favorable selection.
      candidateStatus = "WATCH";
      actionability = "BLOCKED";
      researchOnly = false;
      reasons.push(`Risk veto: ${input.riskVerdict.failures.join("; ")}`);
    } else if (sel.actionable) {
      candidateStatus = "ACTIONABLE_NOW";
      actionability = "ACTIONABLE";
      researchOnly = false;
      reasons.push(...(sel.reasons ?? []).slice(0, 3));
    } else {
      candidateStatus = "RESEARCH_ONLY";
      actionability = "RESEARCH_ONLY";
      researchOnly = true;
      reasons.push(...(sel.notes ?? []).slice(0, 2));
      improvementConditions.push("Actionable once every tradability gate and the session policy pass.");
    }
  }

  // Model probability ONLY when a validated/experimental model legitimately
  // permits it AND the idea is bullish (no bullish model as bearish evidence).
  const model = input.model ?? null;
  const modelActive = model != null && model.status.startsWith("ACTIVE");
  const probability = modelActive && !isBearish ? model!.probability : null;

  const evidence = input.evidence ?? null;

  return {
    agentId: config.agentId,
    agentVersion: config.agentVersion,
    strategy: config.strategy,
    strategyVersion: config.strategyVersion,
    ticker: input.ticker.toUpperCase(),
    direction: config.direction,
    horizon: config.horizon,
    dteRange: config.dteRange,
    candidateStatus,
    lifecycleStatus: input.lifecycleStatus ?? null,
    score: sel.ok ? sel.score : null,
    verifiedInputs: {
      spot: sel.ok ? sel.marketData.spot : null,
      session: input.session,
      chainAsOfMs: sel.ok ? sel.marketData.chainAsOfMs : null,
    },
    requiredConditions: input.triggerConditions ?? [],
    selectorProfile: config.selectorProfile,
    selectedContract: contractRef(sel, side),
    passedGates,
    failedGates,
    evidenceStatus: evidence?.evidenceStatus ?? "NOT_TRACKED",
    statisticsSnapshot: evidence,
    modelStatus: model?.status ?? "INACTIVE_NO_TRAINABLE_DATA",
    probability,
    actionability,
    researchOnly,
    reasons,
    improvementConditions,
    invalidationConditions: input.invalidationConditions ?? [],
    freshness: input.freshness,
    marketContext: input.marketContext ?? null,
    riskVerdict: input.riskVerdict ?? { allowed: true, failures: [], vetoed: false },
    timestamp: input.nowMs,
  };
}
