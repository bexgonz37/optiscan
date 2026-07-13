/**
 * callouts/callout.ts — deterministic callout builder (Phase 6). PURE.
 *
 * Turns ONE canonical AgentResult (already deduped by the Supervisor) into a
 * single callout with the specified status set, verified fields, and language
 * that never implies a guarantee. Puts are always RESEARCH_ONLY; expectancy /
 * probability appear ONLY when their evidence/model gates legitimately permit it.
 */
import type { AgentResult, CandidateStatus } from "../agents/types.ts";
import { EXPERIMENTAL_LABEL, SETUP_SCORE_LABEL } from "../model-experimental.ts";
import { bearishActionable } from "../bearish-gate.ts";

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
  /**
   * Phase 8 disclosure that must accompany the probability/score:
   *   experimental model ⇒ "EXPERIMENTAL — LIMITED DATA — RESEARCH ONLY"
   *   no active model    ⇒ "SETUP SCORE — NOT A PROBABILITY"
   *   validated model    ⇒ null (a plain validated probability)
   */
  modelLabel: string | null;
  probabilityIsExperimental: boolean;
  modelVersion: number | null;
  calibration: string | null;
  primaryBlockingReason: string | null;
  researchOnlyWarning: string | null;
  insufficientEvidenceWarning: string | null;
  actionable: boolean;
  timestamp: number;
  /** Portfolio layer (optional): thesis-reconciliation note when a ticker's
   * bullish/bearish ideas conflict; and the composite portfolio rank (higher =
   * stronger). Set by lib/agents/portfolio.ts; undefined before that runs. */
  thesisNote?: string | null;
  portfolioRank?: number | null;
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

  // Phase 8 model-state disclosure. A validated probability stands alone; an
  // experimental one is always tagged research-only; when no model is active we
  // fall back to the setup score and say plainly it is not a probability.
  const experimentalModel = r.modelStatus === "ACTIVE_EXPERIMENTAL_RESEARCH_ONLY";
  const validatedModel = r.modelStatus === "ACTIVE_VALIDATED";
  const modelLabel = experimentalModel ? EXPERIMENTAL_LABEL : (validatedModel ? null : SETUP_SCORE_LABEL);

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
    modelLabel,
    probabilityIsExperimental: experimentalModel && r.probability != null,
    modelVersion: extras.modelVersion ?? null,
    calibration: extras.calibration ?? null,
    primaryBlockingReason,
    // Bearish is research-only ONLY while bearish trading is disabled; once enabled
    // it earns/loses actionability on the same terms as bullish (never a hard
    // "disabled" message — it either qualifies or it does not).
    researchOnlyWarning:
      (isBearish && !bearishActionable())
        ? "RESEARCH ONLY — bearish trading is not enabled."
        : (r.researchOnly ? "Research only — not currently actionable." : null),
    insufficientEvidenceWarning: r.evidenceStatus === "ESTABLISHED_EVIDENCE" ? null : "Not enough graded outcomes yet for statistical conclusions.",
    actionable: r.actionability === "ACTIONABLE" && (!isBearish || bearishActionable()),
    timestamp: r.timestamp,
  };
  return c;
}
