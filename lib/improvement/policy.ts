/**
 * improvement/policy.ts — disposition + absolute prohibitions (Phase 9). PURE.
 *
 * Given an immutable proposal and the current automation capability, decides what
 * may happen to it. The agent operates under ABSOLUTE prohibitions that no
 * configuration can override:
 *   • never force-push (there is no push path at all here — documented, not coded)
 *   • never self-approve a high-risk change
 *   • never enable bearish actionability or live/real-money execution
 *   • never modify its own safety policy or the risk/bearish guardrails
 *   • auto-merge is limited to LOW-risk, auto-merge-eligible categories, and only
 *     when automation + auto-merge are BOTH explicitly enabled
 *
 * When no coding-agent / GitHub automation is available, non-forbidden work is
 * surfaced as READY_FOR_CODING_AGENT — a durable, human-pickup record — rather
 * than being applied.
 */
import type { ImprovementProposal } from "./proposal.ts";
import { categoryAutoMergeAllowed } from "./proposal.ts";

export type Disposition =
  | "AUTO_MERGE_ELIGIBLE"
  | "HUMAN_REVIEW_REQUIRED"
  | "READY_FOR_CODING_AGENT"
  | "BLOCKED";

/** Human-readable statement of the invariants, surfaced in the UI/audit. */
export const ABSOLUTE_PROHIBITIONS = [
  "Never force-push.",
  "Never self-approve or auto-merge a high-risk change.",
  "Never enable bearish actionability.",
  "Never enable live or real-money execution.",
  "Never modify the risk engine, bearish gate, or this safety policy.",
  "Auto-merge only LOW-risk, auto-merge-eligible categories with automation AND auto-merge both explicitly enabled.",
];

export interface AutomationContext {
  automationAvailable: boolean; // a coding agent / GitHub automation is wired up
  autoMergeEnabled: boolean;    // operator explicitly enabled low-risk auto-merge
}

/** Read the automation context from env (both OFF unless explicitly enabled). */
export function automationContextFromEnv(env: NodeJS.ProcessEnv = process.env): AutomationContext {
  return {
    automationAvailable: env.IMPROVEMENT_AUTOMATION === "1",
    autoMergeEnabled: env.IMPROVEMENT_AUTO_MERGE === "1",
  };
}

export interface DispositionResult {
  disposition: Disposition;
  reasons: string[];
}

/**
 * Decide the disposition for one proposal. Precedence is strict and safety-first:
 *   1. forbidden                       → BLOCKED
 *   2. HIGH risk                       → HUMAN_REVIEW_REQUIRED (never self-approved)
 *   3. no automation                   → READY_FOR_CODING_AGENT
 *   4. LOW + auto-merge-eligible + auto-merge enabled → AUTO_MERGE_ELIGIBLE
 *   5. otherwise                       → HUMAN_REVIEW_REQUIRED
 */
export function decideDisposition(p: ImprovementProposal, ctx: AutomationContext): DispositionResult {
  const reasons: string[] = [];

  if (p.forbidden) {
    reasons.push("Forbidden — cannot be merged under any configuration.");
    reasons.push(...p.forbiddenReasons);
    return { disposition: "BLOCKED", reasons };
  }

  if (p.risk === "HIGH") {
    reasons.push("High-risk change — human review is mandatory; the agent never self-approves it.");
    return { disposition: "HUMAN_REVIEW_REQUIRED", reasons };
  }

  if (!ctx.automationAvailable) {
    reasons.push("No coding-agent / GitHub automation configured — surfaced for a human or coding agent to pick up.");
    return { disposition: "READY_FOR_CODING_AGENT", reasons };
  }

  if (p.risk === "LOW" && categoryAutoMergeAllowed(p.category) && ctx.autoMergeEnabled) {
    reasons.push("Low-risk, auto-merge-eligible category with automation and auto-merge both enabled.");
    return { disposition: "AUTO_MERGE_ELIGIBLE", reasons };
  }

  reasons.push(
    ctx.autoMergeEnabled
      ? "Medium-risk (or non-auto-merge category) — requires human review."
      : "Auto-merge not enabled — requires human review.",
  );
  return { disposition: "HUMAN_REVIEW_REQUIRED", reasons };
}
