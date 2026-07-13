/**
 * improvement/proposal.ts — the immutable ImprovementProposal (Phase 9). PURE.
 *
 * The code-improvement agent NEVER edits code or trading rules autonomously. It
 * produces immutable, classified PROPOSALS. This module defines the proposal
 * shape, a deterministic content id, the per-category risk/auto-merge policy, and
 * the hard guards that force anything touching a safety-critical path or carrying
 * a forbidden intent (enabling bearish actionability, live/real-money execution,
 * weakening risk, or editing the agent's own safety policy) to HIGH risk +
 * forbidden — so it can never be auto-merged.
 *
 * A proposal is FROZEN on construction: it is an immutable record, never mutated.
 */
import { createHash } from "node:crypto";

export const PROPOSAL_VERSION = 1;

export type ImprovementCategory =
  // Low-risk, mechanically safe.
  | "test_coverage"
  | "documentation"
  | "dead_code"
  | "type_safety"
  // Medium-risk, human-reviewed.
  | "refactor_readability"
  | "performance"
  | "dependency_hygiene"
  | "config_tuning"
  // High-risk — human review always required.
  | "risk_policy"
  | "strategy_logic"
  | "execution_path"
  // Forbidden — never proposed for merge, always blocked.
  | "bearish_enablement"
  | "live_execution"
  | "safety_policy";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

interface CategoryPolicy { risk: RiskLevel; autoMergeAllowed: boolean; forbidden: boolean }

/** Per-category baseline risk + whether the category may EVER be auto-merged. */
export const CATEGORY_POLICY: Record<ImprovementCategory, CategoryPolicy> = {
  test_coverage: { risk: "LOW", autoMergeAllowed: true, forbidden: false },
  documentation: { risk: "LOW", autoMergeAllowed: true, forbidden: false },
  dead_code: { risk: "LOW", autoMergeAllowed: true, forbidden: false },
  type_safety: { risk: "LOW", autoMergeAllowed: true, forbidden: false },
  refactor_readability: { risk: "MEDIUM", autoMergeAllowed: false, forbidden: false },
  performance: { risk: "MEDIUM", autoMergeAllowed: false, forbidden: false },
  dependency_hygiene: { risk: "MEDIUM", autoMergeAllowed: false, forbidden: false },
  config_tuning: { risk: "MEDIUM", autoMergeAllowed: false, forbidden: false },
  risk_policy: { risk: "HIGH", autoMergeAllowed: false, forbidden: false },
  strategy_logic: { risk: "HIGH", autoMergeAllowed: false, forbidden: false },
  execution_path: { risk: "HIGH", autoMergeAllowed: false, forbidden: false },
  bearish_enablement: { risk: "HIGH", autoMergeAllowed: false, forbidden: true },
  live_execution: { risk: "HIGH", autoMergeAllowed: false, forbidden: true },
  safety_policy: { risk: "HIGH", autoMergeAllowed: false, forbidden: true },
};

/**
 * Files that encode the product's safety invariants. A proposal that would touch
 * ANY of these is forced forbidden — the improvement agent may never modify its
 * own guardrails, the bearish gate, the risk engine, or a live-execution path.
 */
export const SAFETY_PROTECTED_PATHS = [
  "lib/bearish-gate.ts",
  "lib/paper-risk.ts",
  "lib/improvement/policy.ts",
  "lib/improvement/proposal.ts",
  "lib/improvement-store.ts",
];

/** Substrings that indicate a live-execution / brokerage path (never touchable). */
export const LIVE_EXECUTION_MARKERS = ["broker", "live-execution", "live_execution", "real-money", "real_money"];

/** Intent phrases that must force a proposal forbidden regardless of category. */
export const FORBIDDEN_INTENT = [
  "enable bearish", "bearish actionable", "make bearish actionable",
  "live execution", "live trade", "real money", "real-money", "brokerage",
  "disable gate", "bypass gate", "bypass risk", "weaken risk", "remove risk",
  "disable safety", "bypass safety", "force push", "force-push",
  "self-approve", "auto-approve high", "override veto",
];

export function isSafetyProtected(path: string): boolean {
  const p = String(path).replace(/\\/g, "/").toLowerCase();
  if (SAFETY_PROTECTED_PATHS.some((s) => p === s.toLowerCase() || p.endsWith("/" + s.toLowerCase()))) return true;
  return LIVE_EXECUTION_MARKERS.some((m) => p.includes(m));
}

export function containsForbiddenIntent(text: string): boolean {
  const t = String(text).toLowerCase();
  return FORBIDDEN_INTENT.some((p) => t.includes(p));
}

/** Deterministic isolated branch name: `auto-improve/<category>/<compact-utc>`. */
export function branchNameFor(category: ImprovementCategory, atMs: number): string {
  const iso = new Date(atMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `auto-improve/${category}/${iso}`;
}

export interface ImprovementProposalInput {
  category: ImprovementCategory;
  title: string;
  rationale: string;
  targetPaths: string[];
  createdAtMs: number;
  sourceRecommendation?: string | null;
}

export interface ImprovementProposal {
  readonly id: string;
  readonly version: number;
  readonly category: ImprovementCategory;
  readonly title: string;
  readonly rationale: string;
  readonly targetPaths: readonly string[];
  readonly risk: RiskLevel;
  readonly forbidden: boolean;
  readonly forbiddenReasons: readonly string[];
  readonly branchName: string;
  readonly sourceRecommendation: string | null;
  readonly createdAtMs: number;
}

function canonical(input: ImprovementProposalInput, targets: string[]): string {
  // Fixed key set, sorted targets, version embedded — matches the repo's
  // deterministic-id convention (no raw floats, stable ordering).
  return [
    `version=${PROPOSAL_VERSION}`,
    `category=${input.category}`,
    `title=${input.title.trim()}`,
    `rationale=${input.rationale.trim()}`,
    `targets=${targets.join(",")}`,
  ].join("|");
}

/**
 * Build an immutable, classified proposal. Risk is escalated to HIGH + forbidden
 * whenever a target path is safety-protected or the title/rationale carries a
 * forbidden intent — so a mislabeled "documentation" change to the bearish gate
 * can never slip through as auto-mergeable.
 */
export function buildProposal(input: ImprovementProposalInput): ImprovementProposal {
  const targets = [...new Set(input.targetPaths.map((p) => String(p).replace(/\\/g, "/").trim()).filter(Boolean))].sort();
  const base = CATEGORY_POLICY[input.category] ?? { risk: "HIGH" as RiskLevel, autoMergeAllowed: false, forbidden: true };

  const forbiddenReasons: string[] = [];
  const protectedHit = targets.filter(isSafetyProtected);
  if (protectedHit.length) forbiddenReasons.push(`touches safety-protected path(s): ${protectedHit.join(", ")}`);
  if (containsForbiddenIntent(`${input.title} ${input.rationale}`)) forbiddenReasons.push("carries a forbidden intent (bearish/live/risk/safety-policy change)");
  if (base.forbidden) forbiddenReasons.push(`category "${input.category}" is inherently forbidden`);

  const forbidden = forbiddenReasons.length > 0;
  const risk: RiskLevel = forbidden ? "HIGH" : base.risk;

  const hash = createHash("sha256").update(canonical(input, targets)).digest("hex").slice(0, 16);

  return Object.freeze({
    id: `imp${PROPOSAL_VERSION}_${hash}`,
    version: PROPOSAL_VERSION,
    category: input.category,
    title: input.title.trim(),
    rationale: input.rationale.trim(),
    targetPaths: Object.freeze(targets),
    risk,
    forbidden,
    forbiddenReasons: Object.freeze(forbiddenReasons),
    branchName: branchNameFor(input.category, input.createdAtMs),
    sourceRecommendation: input.sourceRecommendation ?? null,
    createdAtMs: input.createdAtMs,
  }) as ImprovementProposal;
}

/** Whether a proposal's category baseline permits auto-merge (before disposition). */
export function categoryAutoMergeAllowed(category: ImprovementCategory): boolean {
  return CATEGORY_POLICY[category]?.autoMergeAllowed === true;
}
