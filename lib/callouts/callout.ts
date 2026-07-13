/**
 * callouts/callout.ts — deterministic callout builder (Phase 6). PURE.
 *
 * Turns ONE canonical AgentResult (already deduped by the Supervisor) into a
 * single callout with the specified status set, verified fields, and language
 * that never implies a guarantee. Puts are always RESEARCH_ONLY; expectancy /
 * probability appear ONLY when their evidence/model gates legitimately permit it.
 */
import type { AgentResult, CandidateStatus } from "../agents/types.ts";

/** Phrases that must never appear in any callout text. */
export const BANNED_PHRASES = [
  "guaranteed", "guarantee", "easy money", "safe winner", "guaranteed profit",
  "will definitely rise", "will definitely fall", "can't lose", "cannot lose",
  "sure thing", "risk-free", "risk free",
];

export function containsBannedLanguage(text: string): boolean {
  const t = String(text).toLowerCase();
  return BANNED_PHRASES.some((p) => t.includes(p));
}

export type CalloutStatus = CandidateStatus;

export interface Callout {
  key: string;                 // ticker|direction|horizon
  status: CalloutStatus;
  ticker: string;
  direction: "bullish" | "bearish";
  strategyAgent: string;
  horizon: string;
  dteRange: [number, number] | null;
  lifecycleStatus: string | null;
  reason: string;
  trigger: string | null;
  invalidation: string | null;
  management: string | null;
  contract: AgentResult["selectedContract"];
  estimatedFillNote: string | null;
  quoteFreshness: string;
  contractScore: number | null;
  contractReasons: string[];
  marketContext: Record<string, unknown> | null;
  riskVerdict: AgentResult["riskVerdict"];
  sampleSize: number;
  evidenceStatus: string;
  expectancy: number | null;
  profitFactor: number | null;
  modelState: string;
  probability: number | null;
  modelVersion: number | null;
  calibration: string | null;
  primaryBlockingReason: string | null;
  researchOnlyWarning: string | null;
  insufficientEvidenceWarning: string | null;
  actionable: boolean;
  timestamp: number;
}

const HORIZON_LABEL: Record<string, string> = {
  "0DTE": "0DTE", "1-5": "1–5 DTE", "6-10": "6–10 DTE", "11-35": "11–35 DTE", "36-90": "36–90 DTE", STOCK: "stock",
};

export interface BuildCalloutExtras {
  expectancy?: number | null;
  profitFactor?: number | null;
  modelVersion?: number | null;
  calibration?: string | null;
}

/** Build the single canonical callout for one supervised agent result. */
export function buildCallout(r: AgentResult, extras: BuildCalloutExtras = {}): Callout {
  const isBearish = r.direction === "bearish";
  const evidenceEstablished = r.evidenceStatus === "ESTABLISHED_EVIDENCE";

  // Expectancy / profit factor ONLY for an established sample.
  const expectancy = evidenceEstablished ? (extras.expectancy ?? null) : null;
  const profitFactor = evidenceEstablished ? (extras.profitFactor ?? null) : null;

  const primaryBlockingReason =
    r.candidateStatus === "DATA_STALE" ? (r.freshness.reason ?? "data stale")
      : r.candidateStatus === "NO_VALID_CONTRACT" ? (r.reasons[0] ?? "no valid contract")
      : r.riskVerdict && !r.riskVerdict.allowed ? `risk: ${r.riskVerdict.failures.join("; ")}`
      : null;

  const reason = (r.reasons[0] ?? "Setup under evaluation.").slice(0, 240);

  const c: Callout = {
    key: `${r.ticker}|${r.direction}|${r.horizon}`,
    status: r.candidateStatus,
    ticker: r.ticker,
    direction: r.direction,
    strategyAgent: r.agentId,
    horizon: HORIZON_LABEL[r.horizon] ?? r.horizon,
    dteRange: r.dteRange,
    lifecycleStatus: r.lifecycleStatus,
    reason,
    trigger: r.requiredConditions.length ? r.requiredConditions.join("; ") : null,
    invalidation: r.invalidationConditions.length ? r.invalidationConditions.join("; ") : null,
    management: null,
    contract: r.selectedContract,
    estimatedFillNote: r.selectedContract?.ask != null
      ? `Estimated paper fill ≈ ask ${r.selectedContract.ask} + bounded slippage (simulated, not a real fill).`
      : null,
    quoteFreshness: r.freshness.ok ? "fresh" : (r.freshness.reason ?? "stale"),
    contractScore: r.score,
    contractReasons: r.reasons.slice(0, 3),
    marketContext: r.marketContext,
    riskVerdict: r.riskVerdict,
    sampleSize: r.statisticsSnapshot?.gradedSampleSize ?? 0,
    evidenceStatus: r.evidenceStatus,
    expectancy,
    profitFactor,
    modelState: r.modelStatus,
    probability: r.probability,
    modelVersion: extras.modelVersion ?? null,
    calibration: extras.calibration ?? null,
    primaryBlockingReason,
    researchOnlyWarning: isBearish ? "RESEARCH ONLY — bearish/put idea; never an actionable entry." : (r.researchOnly ? "Research only — not currently actionable." : null),
    insufficientEvidenceWarning: r.evidenceStatus === "ESTABLISHED_EVIDENCE" ? null : "Not enough graded outcomes yet for statistical conclusions.",
    actionable: r.actionability === "ACTIONABLE" && !isBearish,
    timestamp: r.timestamp,
  };
  return c;
}
