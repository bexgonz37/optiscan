/**
 * Wraps options strategy-catalog scoring into standard StrategyEvaluation records.
 */
import { getStrategy, strategyKeys } from "../research/options/strategy-catalog.ts";
import type { StrategySelection } from "../research/options/discovery.ts";
import type { StrategyEvaluation, EvidenceItem, SignalClassification } from "./evaluation.ts";

export function evaluationFromOptionsSelection(
  selection: StrategySelection,
  nowMs: number,
  latencyMs = 0,
): StrategyEvaluation[] {
  const out: StrategyEvaluation[] = [];
  for (const c of selection.considered) {
    const strat = getStrategy(c.key);
    if (!strat) continue;
    const matched = c.matched ?? [];
    const required = strat.earlySignals.length;
    const signal: SignalClassification =
      c.key === selection.selected?.key ? "SUPPORTIVE"
        : c.score >= 0.5 ? "NEUTRAL"
          : "INSUFFICIENT_DATA";
    const evidence: EvidenceItem[] = [{
      evidenceId: `${c.key}_score`,
      category: "price_momentum",
      source: "options_discovery",
      observedValue: c.score,
      unit: "score",
      benchmark: "0.5",
      timestampMs: nowMs,
      freshnessMs: 0,
      lineage: ["polygon_snapshot", "polygon_bars"],
      classification: signal,
      correlationGroup: strat.key.split("_")[0] ?? null,
      reasonCode: matched.length > 0 ? "signals_matched" : "insufficient_signals",
      explanation: matched.length > 0
        ? `${matched.length}/${required} signals matched: ${matched.join(", ")}`
        : c.rejection ?? "Insufficient signals for applicability",
    }];
    const isPut = defSideResearchOnly(c.key, selection);
    out.push({
      schemaVersion: 1,
      strategyId: c.key,
      strategyVersion: "1",
      strategyFamily: strat.key.split("_")[0] ?? "options",
      lifecycleStatus: isPut ? "RESEARCH_ONLY" : c.applicable ? "ACTIVE" : "INACTIVE",
      applicable: c.applicable,
      evaluatedDirection: c.key === selection.selected?.key && selection.direction ? selection.direction : null,
      evaluatedHorizon: strat.preferredDte.join(","),
      signal,
      rawMetrics: { score: c.score, signalsMatched: matched.length, signalsRequired: required },
      strength: Math.min(100, Math.max(0, Math.round(c.score * 100))),
      evidence,
      contradictingEvidence: [],
      missingDataRequirements: matched.length < required ? ["additional_signals"] : [],
      regimeCompatible: null,
      historicalCohortKey: null,
      latencyMs,
      dataFreshnessMs: 0,
      limitations: c.rejection ? [c.rejection] : [],
      reasonCodes: [signal.toLowerCase()],
      error: null,
    });
  }
  return out;
}

function defSideResearchOnly(key: string, selection: StrategySelection): boolean {
  return selection.selected?.key === key && selection.selected.researchOnly;
}

export function allCatalogStrategyIds(): string[] {
  return strategyKeys();
}
