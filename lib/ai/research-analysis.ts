/**
 * ai/research-analysis.ts — the nightly reasoning pass whose output is KEPT.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE NARRATOR
 *
 * The nightly narrator produces prose for a Discord recap and the AI Lab. Prose is read once and
 * discarded, so the system was answering the same questions every night — "what separated the
 * winners", "did the experiment reject a winner" — and remembering none of the answers. This job
 * asks a fixed list of evidence-grounded questions over the SAME research context the narrator
 * received, and writes each conclusion into `options_learning_findings`, the store the next
 * night's context is built from. That is the difference between a system that narrates itself and
 * one that accumulates.
 *
 * WHAT A FINDING COSTS TO MAKE
 *
 * Every finding must name its limitations. `validateAnalysis` rejects a finding with an empty
 * `limitations` array rather than defaulting one in, because a claim whose qualification can be
 * omitted will be quoted without it. A finding whose evidence is thin must say INSUFFICIENT or
 * WEAK, and `openQuestions` is the correct answer when the evidence supports nothing — an empty
 * `findings` array is a SUCCESSFUL run.
 *
 * AUTHORITY BOUNDARY
 *
 * Findings are written to a namespaced id (`AI_NIGHTLY_…`) that cannot collide with a
 * deterministic finding, are screened for forbidden intent before storage, and carry no
 * mechanism to change a threshold, a delivery, a readiness state or an experiment status.
 * Budget-gated by the EXISTING cost gate; a skip here costs the night nothing that has not
 * already been computed and persisted deterministically.
 *
 * Impure (DB + provider). Never throws.
 */
import type { AiConfig } from "./config.ts";
import { runStructuredAiJob, type ProviderDeps } from "./provider.ts";
import { costGateOnDb, recordAiJobRunOnDb, type DbLike } from "./store.ts";
import { estimateCostUsd, maxJobCostUsd } from "./pricing.ts";
import { NIGHTLY_ANALYSIS_QUESTIONS } from "../research/options/ai-research-context.ts";
import { upsertAiFindingOnDb } from "../research/options/findings-store.ts";

export const RESEARCH_ANALYSIS_JOB_TYPE = "nightly_research_analysis";
export const RESEARCH_ANALYSIS_PROMPT_VERSION = "nightly-research-analysis-v1";

/** Output is small by design: this is a reasoning pass, not a second report. */
const MAX_OUTPUT_TOKENS = 2_000;
const MAX_FINDINGS = 5;

export type AnalysisEvidenceStrength = "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT";

export interface AnalysisFinding {
  /** Slug, namespaced on write. Stable across nights so a repeated conclusion updates, not duplicates. */
  key: string;
  question: string;
  title: string;
  statement: string;
  evidenceStrength: AnalysisEvidenceStrength;
  sampleSize: number;
  limitations: string[];
  mustNotBeSummarizedAs: string | null;
  recommendedExperiment: string | null;
}

export interface ResearchAnalysis {
  findings: AnalysisFinding[];
  /** What the evidence could not answer tonight. Naming these is a successful outcome. */
  openQuestions: string[];
  /** One bounded SHADOW/PAPER proposal, or null when nothing is justified. */
  proposedExperiment: string | null;
}

const STRENGTHS: AnalysisEvidenceStrength[] = ["STRONG", "MODERATE", "WEAK", "INSUFFICIENT"];

/**
 * Claims a finding may never make. These are the summaries that would convert an unvalidated
 * shadow arm into an apparent authorization, which is the one failure this whole subsystem is
 * built to prevent.
 */
const FORBIDDEN_CLAIMS: { re: RegExp; reason: string }[] = [
  { re: /\b(validated|proven|confirmed\s+edge|ready\s+for\s+subscribers?|subscriber[_\s-]*approved)\b/i, reason: "claims validation or subscriber readiness" },
  { re: /\b(promote|approve|enable|deploy|ship)\s+(it|this|the\s+(rule|experiment|strategy|arm))\b/i, reason: "asks for promotion or deployment" },
  { re: /real[\s-]*money|live\s+(broker|trad|execut|order)/i, reason: "refers to live execution" },
  { re: /bypass|disable|override|relax\s+(the\s+)?(gate|threshold|guard)/i, reason: "asks to weaken a gate" },
];

export interface AnalysisScreen { ok: boolean; violations: string[] }

/** PURE. Screen one finding's text for forbidden intent. */
export function screenAnalysisFinding(f: AnalysisFinding): AnalysisScreen {
  const text = [f.title, f.statement, f.recommendedExperiment ?? "", f.mustNotBeSummarizedAs ?? ""].join("  ");
  const violations = FORBIDDEN_CLAIMS.filter(({ re }) => re.test(text)).map(({ reason }) => reason);
  return { ok: violations.length === 0, violations };
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`field '${field}' must be a non-empty string`);
  return v.trim();
}

/** PURE. Throws on anything that would produce an unqualified or over-claiming finding. */
export function validateAnalysis(json: unknown): ResearchAnalysis {
  if (!json || typeof json !== "object") throw new Error("analysis must be a JSON object");
  const o = json as Record<string, unknown>;
  const rawFindings = Array.isArray(o.findings) ? o.findings : [];
  if (rawFindings.length > MAX_FINDINGS) throw new Error(`at most ${MAX_FINDINGS} findings`);

  const findings: AnalysisFinding[] = rawFindings.map((r: any, i: number) => {
    const limitations = Array.isArray(r?.limitations)
      ? r.limitations.map((x: unknown) => String(x ?? "").trim()).filter(Boolean)
      : [];
    // Not defaulted. A finding that cannot name what it does not prove is not a finding.
    if (!limitations.length) throw new Error(`findings[${i}].limitations must be a non-empty array`);
    const strength = String(r?.evidenceStrength ?? "").toUpperCase() as AnalysisEvidenceStrength;
    if (!STRENGTHS.includes(strength)) throw new Error(`findings[${i}].evidenceStrength must be one of ${STRENGTHS.join("|")}`);
    const sampleSize = Number(r?.sampleSize);
    if (!Number.isFinite(sampleSize) || sampleSize < 0) throw new Error(`findings[${i}].sampleSize must be a non-negative number`);
    // A claim above WEAK needs something to rest on. Zero rows cannot be STRONG evidence of
    // anything, and this is the exact shape of the "PF 0" error applied to conclusions.
    if (sampleSize === 0 && strength !== "INSUFFICIENT") {
      throw new Error(`findings[${i}] has sampleSize 0 and must be INSUFFICIENT, not ${strength}`);
    }
    return {
      key: asString(r?.key, `findings[${i}].key`).toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 48),
      question: asString(r?.question, `findings[${i}].question`),
      title: asString(r?.title, `findings[${i}].title`),
      statement: asString(r?.statement, `findings[${i}].statement`),
      evidenceStrength: strength,
      sampleSize: Math.floor(sampleSize),
      limitations,
      mustNotBeSummarizedAs: typeof r?.mustNotBeSummarizedAs === "string" && r.mustNotBeSummarizedAs.trim()
        ? r.mustNotBeSummarizedAs.trim() : null,
      recommendedExperiment: typeof r?.recommendedExperiment === "string" && r.recommendedExperiment.trim()
        ? r.recommendedExperiment.trim() : null,
    };
  });

  return {
    findings,
    openQuestions: Array.isArray(o.openQuestions)
      ? o.openQuestions.map((x: unknown) => String(x ?? "").trim()).filter(Boolean).slice(0, 12)
      : [],
    proposedExperiment: typeof o.proposedExperiment === "string" && o.proposedExperiment.trim()
      ? o.proposedExperiment.trim() : null,
  };
}

export const RESEARCH_ANALYSIS_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "openQuestions"],
  properties: {
    findings: {
      type: "array",
      description: "Conclusions the evidence actually supports. Use [] when it supports none.",
      maxItems: MAX_FINDINGS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "question", "title", "statement", "evidenceStrength", "sampleSize", "limitations"],
        properties: {
          key: { type: "string", minLength: 1, description: "Stable slug for this recurring conclusion, e.g. CONFIRMATION_DELAY_COST" },
          question: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          statement: { type: "string", minLength: 1 },
          evidenceStrength: { type: "string", enum: STRENGTHS },
          sampleSize: { type: "number", description: "Rows this rests on. 0 requires evidenceStrength INSUFFICIENT." },
          limitations: { type: "array", minItems: 1, items: { type: "string" }, description: "Required. What this does NOT establish." },
          mustNotBeSummarizedAs: { type: "string" },
          recommendedExperiment: { type: "string" },
        },
      },
    },
    openQuestions: { type: "array", items: { type: "string" }, description: "What tonight's evidence could not answer." },
    proposedExperiment: { type: "string", description: "One bounded SHADOW or PAPER_VALIDATION proposal, or omit." },
  },
} as const;

export function researchAnalysisPrompt(
  sessionDate: string,
  research: unknown,
  questions: readonly string[],
): { system: string; user: string } {
  const system = [
    "You are an OFFLINE research analyst for a deterministic options scanner.",
    "You never make trade decisions and never touch the live signal path.",
    "You may ONLY use numbers present in the supplied context. Do not invent, estimate, or extrapolate.",
    "A null metric means UNAVAILABLE. It never means zero, and you must never render it as zero.",
    "A finding MUST name its limitations. A finding you cannot qualify is not a finding — omit it.",
    "A conclusion resting on 0 rows must be evidenceStrength INSUFFICIENT.",
    "Returning { findings: [], openQuestions: [...] } is a CORRECT and expected answer when the evidence",
    "supports nothing yet. Do not manufacture a conclusion to fill the array.",
    "You may propose a bounded SHADOW or PAPER_VALIDATION experiment. You may NOT promote, approve,",
    "validate, deploy, enable, or authorize anything, and you may not describe any experiment as validated.",
    "Answer through the submit_research_analysis tool only.",
  ].join(" ");
  const user = [
    `Session: ${sessionDate}.`,
    "Answer these questions from the evidence, skipping any the evidence cannot support:",
    questions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
    "",
    "Research context (the ONLY source of truth — obey its readingRules and instructions):",
    JSON.stringify(research),
  ].join("\n");
  return { system, user };
}

export interface ResearchAnalysisResult {
  status: string;
  costUsd: number;
  findingsPersisted: number;
  findingsBlocked: number;
  openQuestions: string[];
  proposedExperiment: string | null;
  skippedReason?: string;
  diagnostic?: unknown;
}

const EMPTY: ResearchAnalysisResult = {
  status: "SKIPPED", costUsd: 0, findingsPersisted: 0, findingsBlocked: 0,
  openQuestions: [], proposedExperiment: null,
};

/**
 * Run the reasoning pass and persist its findings.
 *
 * Returns SKIPPED (never throws) when AI is disabled, the budget is exhausted, or no research
 * context could be built. Every one of those paths leaves the deterministic evidence, the recap
 * and the narrative exactly as they were.
 */
export async function runNightlyResearchAnalysis(
  db: DbLike,
  cfg: AiConfig,
  opts: {
    sessionDate: string;
    research: unknown;
    nowMs?: number;
    provider?: ProviderDeps;
    deploymentSha?: string | null;
  },
): Promise<ResearchAnalysisResult> {
  const nowMs = opts.nowMs ?? Date.now();
  try {
    if (opts.research == null) {
      return { ...EMPTY, skippedReason: "no research context could be built" };
    }
    if (!cfg.nightlyDiagnosisEnabled) {
      const diagnostic = { reason: "AI nightly analysis disabled or API key missing" };
      recordAiJobRunOnDb(db, {
        jobType: RESEARCH_ANALYSIS_JOB_TYPE, model: cfg.nightlyModel,
        status: "SKIPPED_DISABLED", errorCategory: "disabled", diagnostic, nowMs,
      });
      return { ...EMPTY, skippedReason: "ai disabled", diagnostic };
    }

    // PRE-FLIGHT hard block, reserving this call's maximum possible cost, exactly as the
    // narrator does. Optional reasoning is what the budget is allowed to stop.
    const reserveUsd = maxJobCostUsd(cfg.nightlyModel, cfg.maxInputTokensPerJob, MAX_OUTPUT_TOKENS);
    const gate = costGateOnDb(db, cfg, nowMs, reserveUsd);
    if (!gate.allowed) {
      const diagnostic = { reason: "monthly hard limit reached", spendUsd: gate.spendUsd, hardLimitUsd: gate.hardLimitUsd };
      recordAiJobRunOnDb(db, {
        jobType: RESEARCH_ANALYSIS_JOB_TYPE, model: cfg.nightlyModel,
        status: "SKIPPED_HARD_LIMIT", errorCategory: "budget",
        error: `monthly hard limit reached ($${gate.spendUsd.toFixed(2)} >= $${gate.hardLimitUsd})`,
        diagnostic, nowMs,
      });
      return { ...EMPTY, skippedReason: "budget exhausted", diagnostic };
    }

    const { system, user } = researchAnalysisPrompt(opts.sessionDate, opts.research, NIGHTLY_ANALYSIS_QUESTIONS);

    const call = await runStructuredAiJob<ResearchAnalysis>(
      {
        model: cfg.nightlyModel,
        system,
        user,
        maxOutputTokens: Math.min(cfg.maxOutputTokensPerJob, MAX_OUTPUT_TOKENS),
        timeoutMs: cfg.jobTimeoutMs,
        maxRetries: cfg.maxRetries,
        toolName: "submit_research_analysis",
        toolInputSchema: RESEARCH_ANALYSIS_TOOL_SCHEMA as unknown as Record<string, unknown>,
        validatorName: "validateResearchAnalysis",
        promptVersion: RESEARCH_ANALYSIS_PROMPT_VERSION,
        jobType: RESEARCH_ANALYSIS_JOB_TYPE,
      },
      validateAnalysis,
      opts.provider,
    );

    const costUsd = estimateCostUsd(cfg.nightlyModel, call.inputTokens, call.outputTokens);
    const status = call.ok ? "SUCCESS" : call.errorCategory === "timeout" ? "TIMEOUT"
      : call.errorCategory === "validation" ? "VALIDATION_FAILED" : "ERROR";

    let findingsPersisted = 0;
    let findingsBlocked = 0;
    if (call.ok && call.data) {
      for (const f of call.data.findings) {
        if (!screenAnalysisFinding(f).ok) { findingsBlocked += 1; continue; }
        try {
          const r = upsertAiFindingOnDb(db as never, {
            key: f.key,
            sessionDate: opts.sessionDate,
            title: f.title,
            statement: f.statement,
            question: f.question,
            evidenceStrength: f.evidenceStrength,
            sampleSize: f.sampleSize,
            limitations: f.limitations,
            mustNotBeSummarizedAs: f.mustNotBeSummarizedAs,
            recommendedExperiment: f.recommendedExperiment,
          }, { deploymentSha: opts.deploymentSha ?? null }, nowMs);
          if (r.written) findingsPersisted += 1;
        } catch { findingsBlocked += 1; }
      }
    }

    const diagnostic = call.ok
      ? { findingsPersisted, findingsBlocked, openQuestions: call.data?.openQuestions.length ?? 0 }
      : { errorCategory: call.errorCategory, error: call.error, validationErrors: call.diagnostics.validationErrors.slice(0, 5) };

    recordAiJobRunOnDb(db, {
      jobType: RESEARCH_ANALYSIS_JOB_TYPE, model: cfg.nightlyModel, status,
      errorCategory: call.ok ? "none" : call.errorCategory, error: call.error,
      inputTokens: call.inputTokens, outputTokens: call.outputTokens, estimatedCostUsd: costUsd,
      latencyMs: call.latencyMs, retryCount: call.retries, diagnostic, nowMs,
    });

    return {
      status, costUsd, findingsPersisted, findingsBlocked,
      openQuestions: call.data?.openQuestions ?? [],
      proposedExperiment: call.data?.proposedExperiment ?? null,
      diagnostic: call.ok ? undefined : diagnostic,
    };
  } catch (err: any) {
    return { ...EMPTY, status: "ERROR", skippedReason: String(err?.message ?? err).slice(0, 200) };
  }
}
