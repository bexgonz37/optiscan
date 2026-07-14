/**
 * ai/safety.ts — PURE hard safety screen for AI weekly proposals. Even though the
 * prompt forbids it, a proposal is DROPPED if its text would enable a permanent
 * safety boundary to be crossed (roadmap §14): enabling bearish actionable alerts,
 * real-money/live execution, auto-merge/auto-deploy, or bypassing eligibility/
 * evidence gates. This is defense-in-depth — a human still approves everything.
 */
import type { WeeklyProposalDraft } from "./schemas.ts";

const FORBIDDEN_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /enable\s+bearish|bearish[_\s-]*actionable|BEARISH_ACTIONABLE\s*=\s*1|allow\s+put.*actionable/i, reason: "would enable bearish actionable alerts" },
  { re: /real[\s-]*money|live\s+(broker|trad|execut|order)|place\s+(a\s+)?(real\s+)?order|brokerage\s+account/i, reason: "would enable real-money / live execution" },
  { re: /auto[\s-]*merge|auto[\s-]*deploy|automatic(ally)?\s+(merge|deploy|apply|push)|IMPROVEMENT_AUTO_MERGE\s*=\s*1|IMPROVEMENT_AUTOMATION\s*=\s*1/i, reason: "would enable automatic merge/deploy" },
  { re: /bypass|disable|override|skip|relax|remove.*(gate|eligibilit|freshness|liquidity|risk|evidence\s+threshold)/i, reason: "would bypass a deterministic gate / evidence threshold" },
  { re: /change.*discord.*actionable|discord.*actionable.*criteria/i, reason: "would change Discord actionable criteria automatically" },
];

export interface ProposalScreen { ok: boolean; violations: string[]; }

/** Screen one proposal's text for forbidden intent. ok=false ⇒ do not store it. */
export function screenProposalSafety(p: WeeklyProposalDraft): ProposalScreen {
  const text = [p.title, p.problem, p.proposedChange, p.affectedConfig ?? "", p.suggestedPatch ?? "", p.expectedBenefit ?? ""].join("  ");
  const violations: string[] = [];
  for (const { re, reason } of FORBIDDEN_PATTERNS) if (re.test(text)) violations.push(reason);
  return { ok: violations.length === 0, violations };
}
