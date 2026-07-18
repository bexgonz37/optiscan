/**
 * lib/research/tiering.ts — the deterministic setup-tier classifier (Phase 1).
 *
 * PURE. Given an agent's normalized verdict it produces a SetupTier plus the
 * structured per-gate results and the rejection reasons. This is production
 * AUTHORITY logic: it uses only deterministic signals (contract identity,
 * freshness, risk veto, status, spread). Probability / model / AI outputs are
 * NEVER consulted here.
 *
 * Honesty rule: a setup whose data cannot support a defensible real fill
 * (no valid two-sided contract, or failed freshness) is REJECTED_INVALID — it is
 * still recorded for counterfactual analysis but must never be paper-filled.
 */
import type { AgentActionability, AgentContractRef, CandidateStatus } from "../agents/types.ts";
import type { GateResult, GateResults, SetupTier } from "./types.ts";

/** Minimal deterministic signal set the classifier reads (subset of AgentResult). */
export interface TieringInput {
  assetClass: "stock" | "option";
  candidateStatus: CandidateStatus;
  actionability: AgentActionability;
  freshnessOk: boolean;
  freshnessReason: string | null;
  riskAllowed: boolean;
  riskVetoed: boolean;
  riskFailures: string[];
  contract: AgentContractRef | null;
  /** Underlying/stock price when assetClass === "stock". */
  price: number | null;
  /** Max spread% a research fill will tolerate (production is stricter downstream). */
  maxResearchSpreadPct?: number;
}

export interface TieringOutput {
  tier: SetupTier;
  gateResults: GateResults;
  rejectionReasons: string[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A valid, non-crossed two-sided option quote (the only thing we can fill). */
function hasTradeableContract(input: TieringInput): boolean {
  if (input.assetClass === "stock") return isNum(input.price) && (input.price as number) > 0;
  const k = input.contract;
  return !!k && !!k.optionSymbol && isNum(k.bid) && isNum(k.ask) && (k.bid as number) > 0 && (k.ask as number) >= (k.bid as number);
}

/** Statuses that indicate the setup is close/analyzable but failing a threshold. */
const NEAR_MISS_STATUSES: ReadonlySet<CandidateStatus> = new Set<CandidateStatus>([
  "WAIT_FOR_PULLBACK", "EXTENDED", "WATCH", "MISSED",
  "MODEL_EXPERIMENTAL", "MODEL_INACTIVE", "INSUFFICIENT_EVIDENCE",
]);

/** Hard-invalid statuses — the setup itself is not a real, fillable opportunity. */
const INVALID_STATUSES: ReadonlySet<CandidateStatus> = new Set<CandidateStatus>([
  "NO_VALID_CONTRACT", "INVALIDATED",
]);

export function classifySetupTier(input: TieringInput): TieringOutput {
  const maxSpread = input.maxResearchSpreadPct ?? 15;
  const contractOk = hasTradeableContract(input);
  const spreadPct = input.contract?.spreadPct ?? null;
  const spreadOk = input.assetClass === "stock" || (isNum(spreadPct) && (spreadPct as number) <= maxSpread);

  const gateResults: GateResults = {
    contractIdentity: gate(contractOk, contractOk ? null : "no valid two-sided contract/price to fill"),
    freshness: gate(input.freshnessOk, input.freshnessOk ? null : (input.freshnessReason ?? "data stale/unavailable")),
    risk: gate(input.riskAllowed, input.riskAllowed ? null : input.riskFailures.join("; ") || "risk veto"),
    spread: gate(spreadOk, spreadOk ? null : `spread ${spreadPct}% exceeds research max ${maxSpread}%`, isNum(spreadPct) ? spreadScore(spreadPct as number, maxSpread) : null),
    status: gate(true, null),
  };

  const rejectionReasons: string[] = [];

  // 1) REJECTED_INVALID — cannot defensibly fill, or hard safety veto, or invalid status.
  if (!contractOk) rejectionReasons.push(gateResults.contractIdentity.reason ?? "invalid contract");
  if (!input.freshnessOk) rejectionReasons.push(`freshness: ${gateResults.freshness.reason}`);
  if (input.riskVetoed) rejectionReasons.push(`safety veto: ${gateResults.risk.reason}`);
  if (INVALID_STATUSES.has(input.candidateStatus)) rejectionReasons.push(`status ${input.candidateStatus}`);
  if (!contractOk || !input.freshnessOk || input.riskVetoed || INVALID_STATUSES.has(input.candidateStatus)) {
    return { tier: "REJECTED_INVALID", gateResults, rejectionReasons };
  }

  // 2) PRODUCTION_QUALITY — passes every strict live production gate.
  if (input.actionability === "ACTIONABLE" && input.candidateStatus === "ACTIONABLE_NOW" && input.riskAllowed && spreadOk) {
    return { tier: "PRODUCTION_QUALITY", gateResults, rejectionReasons };
  }

  // Below production quality: record precisely why.
  if (input.actionability !== "ACTIONABLE") rejectionReasons.push(`actionability ${input.actionability}`);
  if (input.candidateStatus !== "ACTIONABLE_NOW") rejectionReasons.push(`status ${input.candidateStatus} (not actionable-now)`);
  if (!input.riskAllowed) rejectionReasons.push(`risk: ${gateResults.risk.reason}`);
  if (!spreadOk) rejectionReasons.push(gateResults.spread.reason ?? "spread too wide");

  // 3) NEAR_MISS_VALID — valid+analyzable, close but failing a threshold.
  if (NEAR_MISS_STATUSES.has(input.candidateStatus)) {
    return { tier: "NEAR_MISS_VALID", gateResults, rejectionReasons };
  }

  // 4) EXPERIMENTAL_VALID — real+trustworthy data, fails a production/confidence gate
  //    (includes RESEARCH_ONLY puts and developing/near-trigger setups).
  return { tier: "EXPERIMENTAL_VALID", gateResults, rejectionReasons };
}

function gate(passed: boolean, reason: string | null, score: number | null = null): GateResult {
  return { passed, score, reason };
}

/** 1.0 at zero spread → 0.0 at the max tolerated spread (clamped). */
function spreadScore(spreadPct: number, maxSpread: number): number {
  if (maxSpread <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - spreadPct / maxSpread));
}
