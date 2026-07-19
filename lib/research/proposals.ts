/**
 * lib/research/proposals.ts — evidence-backed, human-review-only research proposals
 * (Phase 6). Impure (SQLite) with a pure validator.
 *
 * A proposal is ADVISORY DATA. It NEVER changes production. It cannot default to
 * APPROVED, cannot self-approve, and even when a human APPROVES it, `applyProposal`
 * is a hard no-op — actually executing an approved experiment is a separate, explicit
 * human implementation step OUTSIDE this pipeline.
 *
 * The proposal TYPE allow-list is itself a safety guard: there is no proposal type
 * that enables bearish actionability, promotes puts to production, disables a hard
 * gate, bypasses freshness, or changes Discord delivery — so a proposal cannot even
 * REQUEST those. Production-targeting lanes are additionally rejected.
 */

export type ProposalStatus = "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "EXPIRED" | "INVALIDATED";

/** The ONLY permitted proposal types — all advisory experiments/recommendations. */
export const ALLOWED_PROPOSAL_TYPES = Object.freeze([
  "threshold_experiment",
  "feature_inclusion",
  "feature_exclusion",
  "strategy_enablement_experiment",
  "strategy_pause_recommendation",
  "sizing_experiment",
  "cooldown_experiment",
  "regime_filter_experiment",
  "portfolio_allocation_experiment",
  "data_quality_improvement",
  "provider_data_requirement",
] as const);
export type ProposalType = typeof ALLOWED_PROPOSAL_TYPES[number];

export interface ProposalInput {
  proposalId: string;
  createdByPipeline: string;
  proposalType: string;
  hypothesis: string;
  affectedStrategy?: string | null;
  affectedStrategyVersion?: number | null;
  affectedLane?: string | null;
  affectedTier?: string | null;
  evidenceSummary: string;
  evidenceRefs?: unknown;
  sampleSize: number;
  wins?: number | null;
  losses?: number | null;
  expectancy?: number | null;
  confidence?: string | null;
  expectedEffect: string;
  risks: string;
  rollbackPlan: string;
  validationPlan: string;
  minimumValidationSample: number;
  modelVersion?: number | null;
  observationOnly?: boolean;
  /** Optional non-APPROVED initial status (DRAFT or PENDING_REVIEW). Never APPROVED. */
  status?: ProposalStatus;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Pure validation — every proposal must be fully evidenced and non-production-mutating. */
export function validateProposal(input: ProposalInput): ValidationResult {
  const errors: string[] = [];
  const req = (v: unknown, name: string) => { if (v == null || String(v).trim() === "") errors.push(`missing ${name}`); };
  req(input.proposalId, "proposal_id");
  req(input.hypothesis, "hypothesis");
  req(input.evidenceSummary, "evidence_summary");
  req(input.expectedEffect, "expected_effect");
  req(input.risks, "risks");
  req(input.rollbackPlan, "rollback_plan");
  req(input.validationPlan, "validation_plan");
  if (!Number.isFinite(input.sampleSize) || input.sampleSize < 0) errors.push("sample_size must be a provided, non-negative number");
  if (!Number.isFinite(input.minimumValidationSample) || input.minimumValidationSample < 1) errors.push("minimum_validation_sample must be >= 1");
  if (!(ALLOWED_PROPOSAL_TYPES as readonly string[]).includes(input.proposalType)) {
    errors.push(`proposal type '${input.proposalType}' is not permitted (advisory experiments only — cannot enable bearish, promote puts, disable gates, bypass freshness, or change Discord)`);
  }
  if (input.affectedLane === "PRODUCTION_DISCORD") errors.push("proposals may not target Production Discord directly");
  if ((input.status as string) === "APPROVED") errors.push("a proposal can never be created APPROVED");
  return { ok: errors.length === 0, errors };
}

interface ProposalDb {
  prepare(sql: string): { get: (...a: any[]) => any; run: (...a: any[]) => { changes: number } };
}

const j = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

export interface CreateProposalResult {
  ok: boolean;
  proposalId?: string;
  errors?: string[];
}

/** Create a proposal (idempotent per proposal_id). Never APPROVED at creation. */
export function createProposalOnDb(db: ProposalDb, input: ProposalInput, nowMs: number = Date.now()): CreateProposalResult {
  const v = validateProposal(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  // Status is ALWAYS non-approved at creation.
  const status: ProposalStatus = input.status === "DRAFT" ? "DRAFT" : "PENDING_REVIEW";
  db.prepare(
    `INSERT OR IGNORE INTO research_proposals
      (proposal_id, created_at_ms, created_by_pipeline, proposal_type, hypothesis, affected_strategy, affected_strategy_version,
       affected_lane, affected_tier, evidence_summary, evidence_refs_json, sample_size, wins, losses, expectancy, confidence,
       expected_effect, risks, rollback_plan, validation_plan, minimum_validation_sample, model_version, observation_only, status)
     VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?)`,
  ).run(
    input.proposalId, nowMs, input.createdByPipeline, input.proposalType, input.hypothesis, input.affectedStrategy ?? null, input.affectedStrategyVersion ?? null,
    input.affectedLane ?? null, input.affectedTier ?? null, input.evidenceSummary, j(input.evidenceRefs), input.sampleSize, input.wins ?? null, input.losses ?? null, input.expectancy ?? null, input.confidence ?? null,
    input.expectedEffect, input.risks, input.rollbackPlan, input.validationPlan, input.minimumValidationSample, input.modelVersion ?? null, input.observationOnly ? 1 : 0, status,
  );
  return { ok: true, proposalId: input.proposalId };
}

export interface ReviewResult { ok: boolean; error?: string }

/** Human review ONLY. APPROVED/REJECTED/INVALIDATED require a named human reviewer. */
export function reviewProposalOnDb(
  db: ProposalDb,
  proposalId: string,
  decision: Extract<ProposalStatus, "APPROVED" | "REJECTED" | "INVALIDATED" | "EXPIRED">,
  reviewedBy: string,
  notes: string | null,
  nowMs: number = Date.now(),
): ReviewResult {
  if ((decision === "APPROVED" || decision === "REJECTED" || decision === "INVALIDATED") && (!reviewedBy || reviewedBy.trim() === "")) {
    return { ok: false, error: "a named human reviewer is required to approve/reject/invalidate a proposal" };
  }
  db.prepare("UPDATE research_proposals SET status=?, reviewed_by=?, reviewed_at_ms=?, review_notes=? WHERE proposal_id=?")
    .run(decision, reviewedBy || null, nowMs, notes, proposalId);
  return { ok: true };
}

/**
 * The structural human-review boundary. An APPROVED proposal is NOT applied here —
 * ever. This function exists to make that boundary explicit and testable: any real
 * execution of an approved experiment is a separate, explicit human implementation
 * action outside the AI pipeline.
 */
export function applyProposal(_proposalId: string): { applied: false; reason: string } {
  return { applied: false, reason: "approved proposals never auto-apply; execution is a separate explicit human implementation step outside the AI pipeline" };
}
