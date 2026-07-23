/**
 * ai/nightly.ts - nightly miss-diagnosis orchestration.
 *
 * Deterministic summaries are stored first and always survive provider failures.
 * Optional AI narration is advisory only, validated, budget-gated, and isolated
 * from scanner/Discord/paper paths.
 */
import { tradingDay } from "../trading-session.ts";
import { aiConfig, type AiConfig } from "./config.ts";
import { buildNightlySummary, type NightlySummary } from "./nightly-summary.ts";
import { deriveCandidateLessons } from "./lessons.ts";
import { gatherOutcomesForDay, gatherCandidatesForDay, gatherLiveInstrumentation, gatherMomentumDigestForDay, gatherOptionsDigestForDay } from "./queries.ts";
import { NIGHTLY_NARRATION_PROMPT_VERSION, nightlyNarrationPrompt } from "./prompts.ts";
import { NIGHTLY_NARRATIVE_TOOL_SCHEMA, validateNightlyNarrative, type NightlyNarrative } from "./schemas.ts";
import { runStructuredAiJob, type ProviderDeps } from "./provider.ts";
import { estimateCostUsd, maxJobCostUsd } from "./pricing.ts";
import {
  insertReportOnDb, setReportNarrativeOnDb, upsertLessonOnDb, recordAiJobRunOnDb,
  costGateOnDb, getReportOnDb, type AiReportRow, type DbLike,
} from "./store.ts";
import { deliverNightlyRecapOnDb } from "./recap.ts";

function lazyDb(): DbLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/db").getDb();
}

export interface NightlyJobResult {
  ran: boolean;
  skippedReason?: string;
  tradingDay: string;
  reportId: number | null;
  summary: NightlySummary | null;
  narrativeStatus: string;
  lessonsCreated: number;
  costUsd: number;
  diagnostic?: unknown;
}

export interface NightlyJobOptions {
  nowMs?: number;
  /** Report a specific trading day instead of the one derived from nowMs. */
  day?: string;
  env?: NodeJS.ProcessEnv;
  db?: DbLike;
  provider?: ProviderDeps;
  /** Override config (tests). */
  config?: AiConfig;
}

function aiFailureDiagnostic(call: Awaited<ReturnType<typeof runStructuredAiJob<NightlyNarrative>>>) {
  return {
    provider: "anthropic",
    httpStatus: call.diagnostics.httpStatus,
    responseType: call.diagnostics.responseType,
    contentTypes: call.diagnostics.contentTypes,
    markdownFenceStripped: call.diagnostics.markdownFenceStripped,
    extractedJson: call.diagnostics.extractedJson,
    validationErrors: call.diagnostics.validationErrors.slice(0, 5),
    validationStage: call.diagnostics.validationStage,
    validatorName: call.diagnostics.validatorName,
    failingField: call.diagnostics.failingField,
    expectedValue: call.diagnostics.expectedValue,
    receivedValue: call.diagnostics.receivedValue,
    aiResponseLength: call.diagnostics.aiResponseLength,
    parserOutput: call.diagnostics.parserOutput,
    schemaViolations: call.diagnostics.schemaViolations.slice(0, 10),
    retryCount: call.diagnostics.retryCount,
    providerModel: call.diagnostics.providerModel,
    promptVersion: call.diagnostics.promptVersion,
    parseError: call.diagnostics.parseError,
    stoppedEarly: call.diagnostics.stoppedEarly,
    attempts: call.diagnostics.attempts,
    errorCategory: call.errorCategory,
    error: call.error,
  };
}

async function narrateStoredNightlyReport(
  db: DbLike,
  report: AiReportRow,
  cfg: AiConfig,
  opts: { nowMs: number; provider?: ProviderDeps; jobType?: string },
): Promise<{ status: string; costUsd: number; diagnostic?: unknown; jobRunId?: number | null; skippedReason?: string }> {
  const jobType = opts.jobType ?? "nightly_diagnosis";
  if (report.narrativeStatus === "OK" && report.narrative) {
    return { status: "OK", costUsd: 0, jobRunId: report.aiJobRunId, skippedReason: "report already has a validated narrative" };
  }

  if (!cfg.nightlyDiagnosisEnabled) {
    const diagnostic = { reason: "AI nightly diagnosis disabled or API key missing", flags: { enabled: cfg.enabled, hasApiKey: cfg.hasApiKey, nightlyDiagnosisEnabled: cfg.nightlyDiagnosisEnabled } };
    const jobRunId = recordAiJobRunOnDb(db, { jobType, model: cfg.nightlyModel, status: "SKIPPED_DISABLED", errorCategory: "disabled", diagnostic, nowMs: opts.nowMs });
    setReportNarrativeOnDb(db, report.id, { narrative: null, status: "SKIPPED", model: cfg.nightlyModel, aiJobRunId: jobRunId, diagnostic, nowMs: opts.nowMs });
    return { status: "SKIPPED", costUsd: 0, diagnostic, jobRunId };
  }

  // PRE-FLIGHT hard block: reserve this call's max possible cost so it can never exceed the hard limit.
  const nightlyReserveUsd = maxJobCostUsd(cfg.nightlyModel, cfg.maxInputTokensPerJob, cfg.maxOutputTokensPerJob);
  const gate = costGateOnDb(db, cfg, opts.nowMs, nightlyReserveUsd);
  if (!gate.allowed) {
    const diagnostic = { reason: "monthly hard limit reached", spendUsd: gate.spendUsd, hardLimitUsd: gate.hardLimitUsd };
    const jobRunId = recordAiJobRunOnDb(db, {
      jobType, model: cfg.nightlyModel, status: "SKIPPED_HARD_LIMIT", errorCategory: "budget",
      error: `monthly hard limit reached ($${gate.spendUsd.toFixed(2)} >= $${gate.hardLimitUsd})`,
      diagnostic, nowMs: opts.nowMs,
    });
    setReportNarrativeOnDb(db, report.id, { narrative: null, status: "SKIPPED", model: cfg.nightlyModel, aiJobRunId: jobRunId, diagnostic, nowMs: opts.nowMs });
    return { status: "SKIPPED", costUsd: 0, diagnostic, jobRunId };
  }

  const { system, user } = nightlyNarrationPrompt(report.summary);
  const call = await runStructuredAiJob<NightlyNarrative>(
    {
      model: cfg.nightlyModel,
      system,
      user,
      maxOutputTokens: cfg.maxOutputTokensPerJob,
      timeoutMs: cfg.jobTimeoutMs,
      maxRetries: cfg.maxRetries,
      toolName: "nightly_narrative",
      toolInputSchema: NIGHTLY_NARRATIVE_TOOL_SCHEMA as unknown as Record<string, unknown>,
      validatorName: "validateNightlyNarrative",
      promptVersion: NIGHTLY_NARRATION_PROMPT_VERSION,
    },
    (json) => validateNightlyNarrative(json, report.summary),
    opts.provider,
  );

  const costUsd = estimateCostUsd(cfg.nightlyModel, call.inputTokens, call.outputTokens);
  const diagnostic = call.ok ? null : aiFailureDiagnostic(call);
  const status = call.ok ? "SUCCESS" : call.errorCategory === "timeout" ? "TIMEOUT" : call.errorCategory === "validation" ? "VALIDATION_FAILED" : "ERROR";
  const jobRunId = recordAiJobRunOnDb(db, {
    jobType, model: cfg.nightlyModel, status,
    errorCategory: call.ok ? "none" : call.errorCategory, error: call.error,
    inputTokens: call.inputTokens, outputTokens: call.outputTokens, estimatedCostUsd: costUsd,
    latencyMs: call.latencyMs, retryCount: call.retries, diagnostic, nowMs: opts.nowMs,
  });

  if (call.ok && call.data) {
    setReportNarrativeOnDb(db, report.id, { narrative: call.data, status: "OK", model: cfg.nightlyModel, aiJobRunId: jobRunId, diagnostic: null, nowMs: opts.nowMs });
    return { status: "OK", costUsd, jobRunId };
  }

  const reportStatus = call.errorCategory === "validation" ? "VALIDATION_FAILED" : "ERROR";
  setReportNarrativeOnDb(db, report.id, { narrative: null, status: reportStatus, model: cfg.nightlyModel, aiJobRunId: jobRunId, diagnostic, nowMs: opts.nowMs });
  return { status: reportStatus, costUsd, diagnostic, jobRunId };
}

/**
 * Run the nightly diagnosis for a trading day. The deterministic summary + lessons
 * are always produced; the narrative is added only when AI is enabled and within
 * the monthly budget. Never throws.
 */
export async function runNightlyDiagnosis(opts: NightlyJobOptions = {}): Promise<NightlyJobResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const day = opts.day ?? tradingDay(nowMs);
  const db = opts.db ?? lazyDb();
  const cfg = opts.config ?? aiConfig(opts.env);

  const result: NightlyJobResult = {
    ran: false, tradingDay: day, reportId: null, summary: null,
    narrativeStatus: "PENDING", lessonsCreated: 0, costUsd: 0,
  };

  let summary: NightlySummary;
  try {
    const outcomes = gatherOutcomesForDay(day, nowMs, db);
    const candidates = gatherCandidatesForDay(day, nowMs, db);
    const live = gatherLiveInstrumentation(day);
    const momentum = gatherMomentumDigestForDay(day, db);
    const options = gatherOptionsDigestForDay(day, db);
    summary = buildNightlySummary({ tradingDay: day, periodStartMs: null, periodEndMs: nowMs, outcomes, candidates, live, momentum, options });
  } catch (err: any) {
    return { ...result, skippedReason: `summary failed: ${err?.message ?? err}` };
  }
  result.summary = summary;

  const { row: report, created } = insertReportOnDb(db, {
    reportType: "nightly", periodKey: day, periodStartMs: null, periodEndMs: nowMs, summary, nowMs,
  });
  result.reportId = report.id;
  result.ran = true;

  if (!created) {
    return { ...result, narrativeStatus: report.narrativeStatus, skippedReason: "already reported for this trading day" };
  }

  const minSample = Number(opts.env?.AI_LESSON_MIN_SAMPLE ?? process.env.AI_LESSON_MIN_SAMPLE ?? 3);
  try {
    for (const l of deriveCandidateLessons(summary, { minSample })) {
      const { created: madeNew } = upsertLessonOnDb(db, { ...l, sourceReportId: report.id, nowMs });
      if (madeNew) result.lessonsCreated += 1;
    }
  } catch {
    // Lessons are best-effort; never block the report.
  }

  if (cfg.recapEnabled) {
    try { await deliverNightlyRecapOnDb(db, summary, cfg, { env: opts.env, nowMs }); }
    catch {
      // Recap is best-effort; never block the report.
    }
  }

  const narrated = await narrateStoredNightlyReport(db, report, cfg, { nowMs, provider: opts.provider, jobType: "nightly_diagnosis" });
  result.costUsd = narrated.costUsd;
  result.narrativeStatus = narrated.status;
  result.diagnostic = narrated.diagnostic;
  return result;
}

/** Manual retry: narrate an existing stored summary without recalculating outcomes. */
export async function retryNightlyNarrative(opts: NightlyJobOptions & { reportId?: number; periodKey?: string } = {}): Promise<NightlyJobResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const db = opts.db ?? lazyDb();
  const cfg = opts.config ?? aiConfig(opts.env);
  const periodKey = opts.periodKey ?? opts.day ?? tradingDay(nowMs);
  const row = opts.reportId
    ? (db.prepare("SELECT * FROM ai_reports WHERE id=? AND report_type='nightly'").get(opts.reportId) as any)
    : null;
  const report = row ? getReportOnDb(db, "nightly", row.period_key) : getReportOnDb(db, "nightly", periodKey);

  if (!report) {
    return { ran: false, skippedReason: `stored nightly report not found for ${periodKey}`, tradingDay: periodKey, reportId: null, summary: null, narrativeStatus: "MISSING", lessonsCreated: 0, costUsd: 0 };
  }

  const narrated = await narrateStoredNightlyReport(db, report, cfg, { nowMs, provider: opts.provider, jobType: "nightly_diagnosis_retry" });
  return {
    ran: true,
    skippedReason: narrated.skippedReason,
    tradingDay: report.periodKey,
    reportId: report.id,
    summary: report.summary,
    narrativeStatus: narrated.status,
    lessonsCreated: 0,
    costUsd: narrated.costUsd,
    diagnostic: narrated.diagnostic,
  };
}
