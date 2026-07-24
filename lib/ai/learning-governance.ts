/**
 * Advisory learning proposal lifecycle — no automatic promotion to live.
 */
export type LearningProposalStatus =
  | "DISCOVERED"
  | "RESEARCH"
  | "BACKTESTED"
  | "OUT_OF_SAMPLE_VALIDATED"
  | "SHADOW"
  | "FORWARD_VALIDATED"
  | "REVIEWED"
  | "APPROVED"
  | "ACTIVE"
  | "DEGRADED"
  | "RETIRED";

export interface LearningProposal {
  proposalId: string;
  hypothesis: string;
  status: LearningProposalStatus;
  sampleSize: number;
  dateRange: string;
  validationMethod: string;
  outOfSampleResult: string | null;
  expectedBenefit: string;
  expectedAlertVolumeChange: string;
  risks: string[];
  affectedStrategies: string[];
  rollbackPlan: string;
  productionAuthority: "none" | "human_review_required";
}

export function createLearningProposal(hypothesis: string, affectedStrategies: string[]): LearningProposal {
  return {
    proposalId: `lp_${Date.now().toString(36)}`,
    hypothesis,
    status: "DISCOVERED",
    sampleSize: 0,
    dateRange: "",
    validationMethod: "pending",
    outOfSampleResult: null,
    expectedBenefit: "TBD",
    expectedAlertVolumeChange: "TBD",
    risks: ["Requires human review before any live config change"],
    affectedStrategies,
    rollbackPlan: "Revert versioned config to prior deterministic snapshot",
    productionAuthority: "none",
  };
}

export function canPromoteToLive(proposal: LearningProposal): boolean {
  return proposal.status === "APPROVED" && proposal.productionAuthority === "human_review_required";
}

/** Shadow/learning proposals NEVER auto-modify live behavior */
export function learningAffectsLiveBehavior(): false {
  return false;
}
