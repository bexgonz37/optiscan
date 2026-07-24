/**
 * Deterministic Strategy Conductor — coordinates strategy evaluations into one Ensemble Decision.
 * Never delivers alerts. Never overrides hard gates. Never uses naive averaging.
 */
import type { StrategyEvaluation, SignalClassification } from "./evaluation.ts";
import { evaluateBlockedStrategy } from "./blocked-providers.ts";
import type { EnsembleDecision, HardGateResult } from "../opportunity-case/schema.ts";

export const CONDUCTOR_VERSION = "1.0.0";

export interface ConductorInput {
  symbol: string;
  nowMs: number;
  evaluations: StrategyEvaluation[];
  hardGates?: HardGateResult[];
  regimeLabel?: string | null;
}

const CORRELATION_GROUPS: Record<string, string[]> = {
  price_extension: ["momentum", "breakout", "trend_strength", "vwap_reclaim", "z_score"],
  options_liquidity: ["spread_quality", "open_interest", "volume_oi_anomaly"],
  volatility_cluster: ["realized_vol", "implied_vol", "iv_rank", "iv_rv_spread"],
};

function signalWeight(signal: SignalClassification): number {
  switch (signal) {
    case "SUPPORTIVE": return 1;
    case "CONFLICTING": return -1;
    case "VETO": return -2;
    case "NEUTRAL": return 0;
    case "INSUFFICIENT_DATA": return 0;
    default: return 0;
  }
}

function findCorrelationGroup(strategyId: string): string | null {
  for (const [group, members] of Object.entries(CORRELATION_GROUPS)) {
    if (members.some((m) => strategyId.includes(m))) return group;
  }
  return null;
}

export function runStrategyConductor(input: ConductorInput): EnsembleDecision {
  const hardGates = input.hardGates ?? [];
  const vetoGate = hardGates.find((g) => g.finalAuthority && !g.passed);
  const activeEvals = input.evaluations.filter((e) => e.lifecycleStatus === "ACTIVE" || e.lifecycleStatus === "SHADOW");

  // Include blocked strategy stubs
  const blockedIds = ["order_book_imbalance", "dealer_gamma_exposure"];
  const blockedEvals = blockedIds.map((id) => evaluateBlockedStrategy(id)).filter((e): e is StrategyEvaluation => e != null);
  const allEvals = [...activeEvals, ...blockedEvals];

  const correlationGroups: Record<string, string[]> = {};
  const contributionModel: EnsembleDecision["contributionModel"] = {};
  const groupsSeen = new Set<string>();
  let independentConfirmation = 0;
  let totalContribution = 0;
  let vetoApplied = false;

  for (const ev of allEvals) {
    if (ev.signal === "VETO") vetoApplied = true;
    const group = findCorrelationGroup(ev.strategyId);
    let correlationDiscount = 0;
    if (group) {
      if (!correlationGroups[group]) correlationGroups[group] = [];
      correlationGroups[group].push(ev.strategyId);
      if (groupsSeen.has(group)) correlationDiscount = 0.35;
      else groupsSeen.add(group);
    } else if (ev.signal === "SUPPORTIVE") {
      independentConfirmation += 1;
    }

    const regimeAdjustment = input.regimeLabel && ev.regimeCompatible === false ? -0.15 : 0;
    const freshnessAdjustment = ev.dataFreshnessMs != null && ev.dataFreshnessMs > 120_000 ? -0.2 : 0;
    const uncertaintyPenalty = ev.missingDataRequirements.length > 0 ? 0.25 : 0;
    const rawStrength = ev.strength / 100;
    const signalMul = signalWeight(ev.signal);
    let finalContribution = rawStrength * signalMul * (1 - correlationDiscount) + regimeAdjustment + freshnessAdjustment - uncertaintyPenalty;
    if (ev.signal === "INSUFFICIENT_DATA") finalContribution = 0;

    contributionModel[ev.strategyId] = {
      rawStrength: +rawStrength.toFixed(4),
      correlationDiscount: +correlationDiscount.toFixed(4),
      regimeAdjustment: +regimeAdjustment.toFixed(4),
      freshnessAdjustment: +freshnessAdjustment.toFixed(4),
      uncertaintyPenalty: +uncertaintyPenalty.toFixed(4),
      finalContribution: +finalContribution.toFixed(4),
    };
    totalContribution += finalContribution;
  }

  const reasonCodes: string[] = [];
  if (vetoApplied) reasonCodes.push("strategy_veto");
  if (vetoGate) reasonCodes.push(`hard_gate:${vetoGate.gateId}`);

  let ensembleStrength = Math.max(0, Math.min(100, Math.round((totalContribution + 1) * 50)));
  if (vetoGate || vetoApplied) ensembleStrength = 0;

  return {
    schemaVersion: 1,
    conductorVersion: CONDUCTOR_VERSION,
    evaluations: allEvals,
    correlationGroups,
    independentConfirmationCount: independentConfirmation,
    hardGateResults: hardGates,
    contributionModel,
    ensembleStrength,
    vetoApplied: vetoApplied || Boolean(vetoGate),
    decisionReasonCodes: reasonCodes,
  };
}

/** Deterministic hash for replay verification */
export function ensembleDecisionFingerprint(d: EnsembleDecision): string {
  const keys = Object.keys(d.contributionModel).sort();
  const payload = keys.map((k) => `${k}:${d.contributionModel[k].finalContribution}`).join("|");
  let h = 5381;
  for (let i = 0; i < payload.length; i++) h = (((h << 5) + h) ^ payload.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
