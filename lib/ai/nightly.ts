/**
 * ai/nightly.ts — the nightly miss-diagnosis job orchestration. Impure (DB +
 * provider), but every step fails closed: the deterministic summary is computed
 * and STORED first (always), candidate lessons are derived deterministically, and
 * only THEN is the optional LLM narration attempted. An AI/network/budget failure
 * leaves the stored summary + lessons intact and never throws to the scheduler.
 *
 * Idempotent: one ai_reports row per (nightly, trading-day). A re-run for a day
 * that already has a report is a no-op — safe across restarts and duplicate beats.
 */
import { tradingDay } from "../trading-session.ts";
import { aiConfig, type AiConfig } from "./config.ts";
import { buildNightlySummary, type NightlySummary } from "./nightly-summary.ts";
import { deriveCandidateLessons } from "./lessons.ts";
import { gatherOutcomesForDay, gatherCandidatesForDay, gatherLiveInstrumentation, gatherMomentumDigestForDay, gatherOptionsDigestForDay } from "./queries.ts";
import { nightlyNarrationPrompt } from "./prompts.ts";
import { validateNightlyNarrative, type NightlyNarrative } from "./schemas.ts";
import { runStructuredAiJob, type ProviderDeps } from "./provider.ts";
import { estimateCostUsd } from "./pricing.ts";
import {
  insertReportOnDb, setReportNarrativeOnDb, upsertLessonOnDb, recordAiJobRunOnDb,
  costGateOnDb, type DbLike,
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

  // 1. Deterministic summary — always computed and stored (idempotent).
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

  // Already reported this day (restart/duplicate beat) — nothing more to do.
  if (!created) {
    return { ...result, narrativeStatus: report.narrativeStatus, skippedReason: "already reported for this trading day" };
  }

  // 2. Candidate lessons — deterministic, evidence-gated, deduped.
  const minSample = Number(opts.env?.AI_LESSON_MIN_SAMPLE ?? process.env.AI_LESSON_MIN_SAMPLE ?? 3);
  try {
    for (const l of deriveCandidateLessons(summary, { minSample })) {
      const { created: madeNew } = upsertLessonOnDb(db, { ...l, sourceReportId: report.id, nowMs });
      if (madeNew) result.lessonsCreated += 1;
    }
  } catch { /* lessons are best-effort; never block the report */ }

  // 2b. Optional private recap — DETERMINISTIC (no LLM), routed ONLY to the recap
  // webhook. Fires whenever AI_RECAP_ENABLED regardless of narration success, since
  // it uses only stored summary values. A missing recap webhook is a no-op (the
  // report is still stored; AI Lab shows the recap status).
  if (cfg.recapEnabled) {
    try { await deliverNightlyRecapOnDb(db, summary, cfg, { env: opts.env, nowMs }); }
    catch { /* recap is best-effort; never block the report */ }
  }

  // 3. Optional LLM narration — gated by config + monthly budget. Fails closed.
  if (!cfg.nightlyDiagnosisEnabled) {
    setReportNarrativeOnDb(db, report.id, { narrative: null, status: "SKIPPED", model: null, nowMs });
    recordAiJobRunOnDb(db, { jobType: "nightly_diagnosis", model: cfg.nightlyModel, status: "SKIPPED_DISABLED", errorCategory: "disabled", nowMs });
    return { ...result, narrativeStatus: "SKIPPED" };
  }

  const gate = costGateOnDb(db, cfg, nowMs);
  if (!gate.allowed) {
    setReportNarrativeOnDb(db, report.id, { narrative: null, status: "SKIPPED", model: cfg.nightlyModel, nowMs });
    recordAiJobRunOnDb(db, { jobType: "nightly_diagnosis", model: cfg.nightlyModel, status: "SKIPPED_HARD_LIMIT", errorCategory: "budget", error: `monthly hard limit reached ($${gate.spendUsd.toFixed(2)} ≥ $${gate.hardLimitUsd})`, nowMs });
    return { ...result, narrativeStatus: "SKIPPED" };
  }

  const { system, user } = nightlyNarrationPrompt(summary);
  const call = await runStructuredAiJob<NightlyNarrative>(
    { model: cfg.nightlyModel, system, user, maxOutputTokens: cfg.maxOutputTokensPerJob, timeoutMs: cfg.jobTimeoutMs, maxRetries: cfg.maxRetries },
    (json) => validateNightlyNarrative(json, summary),
    opts.provider,
  );
  const costUsd = estimateCostUsd(cfg.nightlyModel, call.inputTokens, call.outputTokens);
  result.costUsd = costUsd;
  const jobRunId = recordAiJobRunOnDb(db, {
    jobType: "nightly_diagnosis", model: cfg.nightlyModel,
    status: call.ok ? "SUCCESS" : call.errorCategory === "timeout" ? "TIMEOUT" : call.errorCategory === "validation" ? "VALIDATION_FAILED" : "ERROR",
    errorCategory: call.ok ? "none" : call.errorCategory, error: call.error,
    inputTokens: call.inputTokens, outputTokens: call.outputTokens, estimatedCostUsd: costUsd,
    latencyMs: call.latencyMs, retryCount: call.retries, nowMs,
  });

  if (call.ok && call.data) {
    setReportNarrativeOnDb(db, report.id, { narrative: call.data, status: "OK", model: cfg.nightlyModel, aiJobRunId: jobRunId, nowMs });
    result.narrativeStatus = "OK";
  } else {
    setReportNarrativeOnDb(db, report.id, { narrative: null, status: call.errorCategory === "validation" ? "VALIDATION_FAILED" : "ERROR", model: cfg.nightlyModel, aiJobRunId: jobRunId, nowMs });
    result.narrativeStatus = call.errorCategory === "validation" ? "VALIDATION_FAILED" : "ERROR";
  }

  return result;
}
