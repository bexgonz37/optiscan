/**
 * improvement/audit.ts — deterministic proposal generation from REAL repo facts
 * (Phase 9). PURE. The agent never invents work: proposals are derived only from
 * concrete, checkable facts supplied by the runtime (e.g. a `lib/` module with no
 * corresponding test file). No fabricated rationale, no speculative refactors.
 */
import { buildProposal, isSafetyProtected, type ImprovementProposal } from "./proposal.ts";

export interface RepoAudit {
  /** `lib/**` module paths (repo-relative, forward slashes) that have no test. */
  modulesWithoutTests: string[];
  nowMs: number;
}

/**
 * Turn a repo audit into immutable, LOW-risk test-coverage proposals — one per
 * untested module, skipping any safety-protected path (those are never touched by
 * the agent, so it does not even propose adding tests there autonomously; they are
 * covered by human-authored, source-spec tests).
 */
export function proposalsFromAudit(audit: RepoAudit): ImprovementProposal[] {
  const targets = [...new Set(audit.modulesWithoutTests.map((p) => String(p).replace(/\\/g, "/").trim()).filter(Boolean))]
    .filter((p) => !isSafetyProtected(p))
    .sort();

  return targets.map((path) =>
    buildProposal({
      category: "test_coverage",
      title: `Add test coverage for ${path}`,
      rationale: `Module ${path} has no corresponding tests/*.test.mjs. Add deterministic unit tests covering its exported behavior to lock in current correctness before any future change.`,
      targetPaths: [path],
      createdAtMs: audit.nowMs,
      sourceRecommendation: "repo audit: untested module",
    }),
  );
}
