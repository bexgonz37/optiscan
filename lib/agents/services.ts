/**
 * agents/services.ts — the shared SERVICE agents (Phase 5). Each is a thin,
 * auditable wrapper that DELEGATES to an existing subsystem — none of them
 * re-implements freshness, selection, risk, statistics, context, or model logic.
 * Impure: resolves `@/lib/*` lazily so the module stays node-importable.
 *
 * The Risk Agent's veto is absolute and is enforced again by the Supervisor.
 */
import type { AgentEvidence, AgentModelState, AgentRiskVerdict } from "./types.ts";

function req<T = any>(mod: string): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(mod) as T;
}

/** 14. Market Data Agent — reuses the freshness subsystem (no new provider call). */
export function marketDataAgent(ticker: string, kinds: string[]): { ok: boolean; reason: string | null } {
  try {
    const { actionableFreshness } = req("@/lib/data-freshness");
    const f = actionableFreshness(ticker, kinds);
    return { ok: Boolean(f?.ok), reason: f?.reason ?? null };
  } catch (err: any) {
    return { ok: false, reason: `freshness unavailable: ${err?.message}` };
  }
}

/** 13. Market Context Agent — reuses the Phase-3 context engine. */
export function marketContextAgent(): Record<string, unknown> | null {
  try {
    const { latestMarketContext, buildCurrentMarketContext } = req("@/lib/market-context-store");
    return latestMarketContext() ?? buildCurrentMarketContext();
  } catch {
    return null;
  }
}

/** 17. Performance / 18. Outcome Agent — reuses the authoritative statistics layer. */
export function performanceAgentByStrategy(strategy: string): AgentEvidence {
  try {
    const { listStatistics } = req("@/lib/statistics-store");
    const rows = listStatistics("strategy");
    const hit = rows.find((r: any) => r.groupKey === strategy);
    if (!hit) return { evidenceStatus: "NOT_TRACKED", evidenceSummary: "No graded outcomes for this strategy yet.", gradedSampleSize: 0 };
    return { evidenceStatus: hit.evidenceState, evidenceSummary: hit.stats?.evidenceSummary ?? "", gradedSampleSize: hit.gradedSampleSize };
  } catch {
    return { evidenceStatus: "NOT_TRACKED", evidenceSummary: "Evidence unavailable.", gradedSampleSize: 0 };
  }
}

/** 19/21. Research & Learning Agent — reuses the model registry (never fabricates). */
export function modelAgent(featureInput: Record<string, unknown>): AgentModelState {
  try {
    const { modelStatus, predictFor } = req("@/lib/model-registry");
    const status = modelStatus();
    const pred = predictFor(featureInput as any);
    return {
      // Phase 8: expose the three explicit states. An experimental probability is
      // present but carries ACTIVE_EXPERIMENTAL_RESEARCH_ONLY so downstream never
      // treats it as validated. A validated champion ⇒ ACTIVE_VALIDATED.
      status: pred.state ?? status.state,
      modelVersion: pred.modelVersion ?? status.championVersion ?? null,
      probability: pred.proba, // null unless a champion (validated or experimental) legitimately permits it
      calibration: status.metrics?.ece != null ? `ECE ${status.metrics.ece}` : null,
    };
  } catch {
    return { status: "INACTIVE_NO_TRAINABLE_DATA", modelVersion: null, probability: null, calibration: null };
  }
}

/** 15. Risk Agent — reuses the paper risk engine. Veto is absolute. */
export function riskAgent(proposed: { ticker: string; optionType: "call" | "put"; dte: number | null; entryLimit: number; contracts: number; stopLossPct: number | null; assetClass?: "option" | "stock" }): AgentRiskVerdict {
  try {
    const { checkRisk, defaultRiskConfig } = req("@/lib/paper-risk");
    const { riskContext } = req("@/lib/paper-engine");
    const verdict = checkRisk(
      { ticker: proposed.ticker, optionType: proposed.optionType, dte: proposed.dte, entryLimit: proposed.entryLimit, contracts: proposed.contracts, stopLossPct: proposed.stopLossPct, assetClass: proposed.assetClass === "stock" ? "stock" : undefined },
      riskContext(),
      defaultRiskConfig(),
    );
    return { allowed: Boolean(verdict.allowed), failures: verdict.failures ?? [], vetoed: !verdict.allowed };
  } catch (err: any) {
    // On any failure, FAIL CLOSED (no actionability) — the safe default.
    return { allowed: false, failures: [`risk engine unavailable: ${err?.message}`], vetoed: true };
  }
}

/** 20. Missed-Opportunity Research Agent — COUNTERFACTUAL research only. */
export interface MissedOpportunity {
  ticker: string;
  horizon: string;
  rejectionReason: string;
  observedAtMs: number;
  note: string;
}
export function missedOpportunityAgent(ticker: string, horizon: string, rejectionReason: string, nowMs: number): MissedOpportunity {
  return {
    ticker,
    horizon,
    rejectionReason,
    observedAtMs: nowMs,
    // Research-only: a non-filled missed setup is NEVER a graded trade outcome and
    // must never feed post-event data into a live decision.
    note: "Counterfactual research only — not a trade, not a graded outcome, no look-ahead into live decisions.",
  };
}

/** 22. Explanation Agent — reuses the deterministic explanation vocabulary (no generative model). */
export function explanationAgent(input: any): any {
  try {
    const { buildPaperExplanation } = req("@/lib/paper-explain");
    return buildPaperExplanation(input);
  } catch {
    return null;
  }
}

/** 19b. Quality-Control Agent — reuses the read-only NBBO diagnostic. */
export function qualityControlAgent(): Record<string, unknown> {
  try {
    const { nbboDiagnostic } = req("@/lib/outcome-store");
    return nbboDiagnostic();
  } catch (err: any) {
    return { ok: false, note: `qc unavailable: ${err?.message}` };
  }
}
