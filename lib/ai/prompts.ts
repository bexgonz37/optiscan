/**
 * ai/prompts.ts — PURE prompt construction for the advisory AI jobs. The model is
 * a NARRATOR/PROPOSER over pre-computed deterministic statistics; the prompts make
 * that explicit and forbid inventing numbers or crossing any safety boundary. The
 * model receives SUMMARIES only — never raw market tape and never the repository.
 */
import type { NightlySummary } from "./nightly-summary.ts";
import { buildQuantEvidenceRegistry } from "./schemas.ts";

export interface Prompt { system: string; user: string; }

export const NIGHTLY_NARRATION_PROMPT_VERSION = "nightly-narration-v2";
export const WEEKLY_PROPOSAL_PROMPT_VERSION = "weekly-proposals-v1";

const SAFETY = [
  "You are an OFFLINE advisory analyst for a deterministic options scanner.",
  "You never make trade decisions and never touch the live signal path.",
  "You may ONLY use numbers that appear in the supplied JSON. Do not invent, estimate, or extrapolate any statistic.",
  "If the data is insufficient for a claim, say so explicitly instead of guessing.",
  "Respond with STRICT JSON only — no prose, no markdown, no code fences.",
].join(" ");

/** Nightly miss-diagnosis narration prompt over the deterministic summary. */
export function nightlyNarrationPrompt(summary: NightlySummary): Prompt {
  const evidence = buildQuantEvidenceRegistry(summary);
  const system = [
    SAFETY,
    "Task: explain the day's scanner results for the operator.",
    "Output JSON with exactly these keys:",
    "headline (string), whatHappened (string), repeatedPatterns (string[]), successPatterns (string[]),",
    "bottlenecks (string[]), supportedConclusions (string[]), needsMoreEvidence (string[]), prioritizedIssue (string).",
    "Cite only counts/values present in the structured evidence registry.",
    "Do not calculate percentages, ratios, averages, totals, conversions, or durations yourself.",
    "Preserve supplied time-bucket labels exactly. If a derived metric is absent, cite only the raw count.",
    "Do not introduce unprovided dollar amounts, percentages, sample sizes, time durations, or performance claims.",
    "Keep it concise and operator-readable.",
  ].join(" ");
  const user = [
    "Deterministic nightly summary (the ONLY source of truth):",
    JSON.stringify(summary),
    "",
    "Structured quantitative evidence registry (the ONLY quantitative claims you may make):",
    JSON.stringify(evidence),
    "",
    "Write the narrative. The prioritizedIssue must correspond to the summary's prioritizedIssue when present.",
  ].join("\n");
  return { system, user };
}

export interface WeeklyPromptContext {
  weekKey: string;
  weeklySummary: unknown;
  recentNightly: unknown[];
  acceptedLessons: unknown[];
  rejectedLessons: unknown[];
  priorProposals: unknown[];
  currentConfig: Record<string, unknown>;
  quantResearch?: unknown;
  relevantFiles: string[];
  strategyVersion: string | null;
}

/** Weekly strategy-improvement proposal prompt. Proposals are PENDING_APPROVAL. */
export function weeklyProposalPrompt(ctx: WeeklyPromptContext): Prompt {
  const system = [
    SAFETY.replace("Respond with STRICT JSON only", "Respond with STRICT JSON only (an object { proposals: [...] })"),
    "Task: propose at most 3 concrete, testable strategy-improvement proposals from the weekly evidence.",
    "Use Evidence Learning only as long-term aggregate evidence. Do not analyze one-off trades individually.",
    "Each proposal is ADVISORY and PENDING human approval. You must NOT: apply changes, merge, deploy, enable real-money trading,",
    "enable bearish actionable alerts, bypass eligibility/evidence gates, or change Discord actionable criteria.",
    "Each proposal object must have keys: title, problem, evidence, sampleSize (number), affectedStrategy, affectedSession,",
    "affectedConfig, proposedChange, relevantFiles (string[] from the provided list only), changeLevel ('config-only'|'code-level'),",
    "expectedBenefit, downsideRisk, overfittingRisk, requiredTests, backtestPlan, shadowTestPlan, paperTestPlan, rollbackPlan,",
    "suggestedPatch (text or empty), confidence ('LOW'|'MEDIUM'|'HIGH').",
    "Prefer config-only changes with a clear rollback. If evidence is thin, return { proposals: [] } rather than a weak proposal.",
  ].join(" ");
  const user = [
    `Week: ${ctx.weekKey}. Current strategy version: ${ctx.strategyVersion ?? "unknown"}.`,
    "Weekly deterministic summary:", JSON.stringify(ctx.weeklySummary),
    "Recent nightly summaries:", JSON.stringify(ctx.recentNightly),
    "Accepted lessons:", JSON.stringify(ctx.acceptedLessons),
    "Rejected lessons (do not re-propose):", JSON.stringify(ctx.rejectedLessons),
    "Prior proposals (avoid duplicates):", JSON.stringify(ctx.priorProposals),
    "Current relevant configuration:", JSON.stringify(ctx.currentConfig),
    "Weekly AI quant research context (calculation inventory, Evidence Learning aggregates, gate trace requirements, and experiment rules):", JSON.stringify(ctx.quantResearch ?? null),
    "Relevant files you may reference (curated; the ONLY files you may name):", JSON.stringify(ctx.relevantFiles),
  ].join("\n");
  return { system, user };
}
