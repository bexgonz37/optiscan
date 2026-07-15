/**
 * ai/schemas.ts — PURE validators for AI responses. A response is trusted ONLY
 * after it passes these; anything malformed throws and the provider fails closed.
 *
 * The nightly narrative additionally passes an anti-fabrication guard: every number
 * that appears in the narrative text must also appear in the deterministic summary
 * (roadmap §14 — "no fabricated statistics"). Weekly proposals are exempt from that
 * numeric guard because a proposal legitimately introduces NEW candidate config
 * values; they are validated structurally instead.
 */

function asString(v: unknown, field: string, { min = 1 } = {}): string {
  if (typeof v !== "string" || v.trim().length < min) throw new Error(`field '${field}' must be a non-empty string`);
  return v.trim();
}
function asStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new Error(`field '${field}' must be an array`);
  return v.map((x, i) => asString(x, `${field}[${i}]`));
}
function optString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Recursively collect every number in an object as normalized string tokens. */
export function flattenNumbers(obj: unknown, acc: Set<string> = new Set()): Set<string> {
  if (typeof obj === "number" && Number.isFinite(obj)) {
    acc.add(String(obj));
    acc.add(String(Math.round(obj)));
    acc.add(String(Math.round(obj * 10) / 10));
    acc.add(String(Math.abs(obj)));
  } else if (Array.isArray(obj)) {
    for (const x of obj) flattenNumbers(x, acc);
  } else if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) flattenNumbers(v, acc);
  } else if (typeof obj === "string") {
    // Numbers embedded in string keys/labels (e.g. rejection reasons) are allowed too.
    for (const m of obj.matchAll(/\d+(?:\.\d+)?/g)) acc.add(m[0]);
  }
  return acc;
}

/**
 * Assert the text introduces no number absent from `allowed`. Percent signs and
 * thousands separators are ignored; 0 and 1 are always permitted (neutral
 * connectives). Throws with the offending token on the first violation.
 */
export function assertNoFabricatedNumbers(text: string, allowed: Set<string>): void {
  const tokens = String(text).matchAll(/\d+(?:\.\d+)?/g);
  for (const m of tokens) {
    const raw = m[0];
    if (raw === "0" || raw === "1") continue;
    const norm = String(Number(raw));
    const norm1 = String(Math.round(Number(raw) * 10) / 10);
    if (allowed.has(raw) || allowed.has(norm) || allowed.has(norm1)) continue;
    throw new Error(`narrative contains a number not present in the deterministic summary: ${raw}`);
  }
}

export interface NightlyNarrative {
  headline: string;
  whatHappened: string;
  repeatedPatterns: string[];
  successPatterns: string[];
  bottlenecks: string[];
  supportedConclusions: string[];
  needsMoreEvidence: string[];
  prioritizedIssue: string;
}

export const NIGHTLY_NARRATIVE_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "headline",
    "whatHappened",
    "repeatedPatterns",
    "successPatterns",
    "bottlenecks",
    "supportedConclusions",
    "needsMoreEvidence",
    "prioritizedIssue",
  ],
  properties: {
    headline: { type: "string", minLength: 1 },
    whatHappened: { type: "string", minLength: 1 },
    repeatedPatterns: { type: "array", items: { type: "string" } },
    successPatterns: { type: "array", items: { type: "string" } },
    bottlenecks: { type: "array", items: { type: "string" } },
    supportedConclusions: { type: "array", items: { type: "string" } },
    needsMoreEvidence: { type: "array", items: { type: "string" } },
    prioritizedIssue: { type: "string", minLength: 1 },
  },
} as const;

/**
 * Validate the nightly narrative structure AND enforce the anti-fabrication guard
 * against the numbers present in the deterministic summary.
 */
export function validateNightlyNarrative(json: unknown, summary: unknown): NightlyNarrative {
  if (!json || typeof json !== "object") throw new Error("narrative must be a JSON object");
  const j = json as Record<string, unknown>;
  const narrative: NightlyNarrative = {
    headline: asString(j.headline, "headline"),
    whatHappened: asString(j.whatHappened, "whatHappened"),
    repeatedPatterns: asStringArray(j.repeatedPatterns ?? [], "repeatedPatterns"),
    successPatterns: asStringArray(j.successPatterns ?? [], "successPatterns"),
    bottlenecks: asStringArray(j.bottlenecks ?? [], "bottlenecks"),
    supportedConclusions: asStringArray(j.supportedConclusions ?? [], "supportedConclusions"),
    needsMoreEvidence: asStringArray(j.needsMoreEvidence ?? [], "needsMoreEvidence"),
    prioritizedIssue: asString(j.prioritizedIssue, "prioritizedIssue"),
  };
  const allowed = flattenNumbers(summary);
  const allText = [
    narrative.headline, narrative.whatHappened, narrative.prioritizedIssue,
    ...narrative.repeatedPatterns, ...narrative.successPatterns, ...narrative.bottlenecks,
    ...narrative.supportedConclusions, ...narrative.needsMoreEvidence,
  ].join("  ");
  assertNoFabricatedNumbers(allText, allowed);
  return narrative;
}

export interface WeeklyProposalDraft {
  title: string;
  problem: string;
  evidence: string;
  sampleSize: number;
  affectedStrategy: string | null;
  affectedSession: string | null;
  affectedConfig: string | null;
  proposedChange: string;
  relevantFiles: string[];
  changeLevel: "config-only" | "code-level" | null;
  expectedBenefit: string | null;
  downsideRisk: string | null;
  overfittingRisk: string | null;
  requiredTests: string | null;
  backtestPlan: string | null;
  shadowTestPlan: string | null;
  paperTestPlan: string | null;
  rollbackPlan: string | null;
  suggestedPatch: string | null;
  confidence: "LOW" | "MEDIUM" | "HIGH";
}

function asConfidence(v: unknown): "LOW" | "MEDIUM" | "HIGH" {
  const s = String(v ?? "").toUpperCase();
  return s === "HIGH" ? "HIGH" : s === "MEDIUM" ? "MEDIUM" : "LOW";
}

function validateOneProposal(j: Record<string, unknown>): WeeklyProposalDraft {
  const changeLevelRaw = String(j.changeLevel ?? "").toLowerCase();
  const changeLevel = changeLevelRaw === "config-only" ? "config-only" : changeLevelRaw === "code-level" ? "code-level" : null;
  const sample = Number(j.sampleSize);
  return {
    title: asString(j.title, "title"),
    problem: asString(j.problem, "problem"),
    evidence: asString(j.evidence, "evidence"),
    sampleSize: Number.isFinite(sample) ? Math.max(0, Math.floor(sample)) : 0,
    affectedStrategy: optString(j.affectedStrategy),
    affectedSession: optString(j.affectedSession),
    affectedConfig: optString(j.affectedConfig),
    proposedChange: asString(j.proposedChange, "proposedChange"),
    relevantFiles: Array.isArray(j.relevantFiles) ? j.relevantFiles.map(String).filter(Boolean).slice(0, 20) : [],
    changeLevel,
    expectedBenefit: optString(j.expectedBenefit),
    downsideRisk: optString(j.downsideRisk),
    overfittingRisk: optString(j.overfittingRisk),
    requiredTests: optString(j.requiredTests),
    backtestPlan: optString(j.backtestPlan),
    shadowTestPlan: optString(j.shadowTestPlan),
    paperTestPlan: optString(j.paperTestPlan),
    rollbackPlan: optString(j.rollbackPlan),
    suggestedPatch: optString(j.suggestedPatch),
    confidence: asConfidence(j.confidence),
  };
}

/** Validate the weekly proposals payload: { proposals: [...] } or a bare array. */
export function validateWeeklyProposals(json: unknown): WeeklyProposalDraft[] {
  const arr = Array.isArray(json)
    ? json
    : (json && typeof json === "object" && Array.isArray((json as any).proposals))
      ? (json as any).proposals
      : null;
  if (!arr) throw new Error("weekly proposals must be an array or { proposals: [...] }");
  if (arr.length === 0) return [];
  return arr.slice(0, 10).map((p: unknown, i: number) => {
    if (!p || typeof p !== "object") throw new Error(`proposal[${i}] must be an object`);
    return validateOneProposal(p as Record<string, unknown>);
  });
}
