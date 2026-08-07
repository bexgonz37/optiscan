/**
 * ai/weekly.ts — the weekly strategy-improvement proposal job. Impure (DB +
 * provider). Like the nightly job it fails closed: the deterministic weekly
 * summary is stored first (always), then — only if AI is enabled and within budget
 * — the model proposes at most a few ADVISORY, PENDING-approval changes. Every
 * proposal passes a hard safety screen before it is stored. Nothing is applied,
 * merged, or deployed. Never throws.
 *
 * Idempotent: one ai_reports row + one proposal set per ISO year-week.
 */
import { tradingDay } from "../trading-session.ts";
import { aiConfig, type AiConfig } from "./config.ts";
import { buildNightlySummary, type NightlySummary } from "./nightly-summary.ts";
import { isoWeekKey } from "./schedule.ts";
import { recentTradingDays, gatherOutcomesForDays, gatherCandidatesForDays } from "./queries.ts";
import { WEEKLY_PROPOSAL_PROMPT_VERSION, weeklyProposalPrompt } from "./prompts.ts";
import { weeklyQuantResearchContext } from "./quant-research.ts";
import { refreshEvidenceLearningOnDb, evidenceLearningSnapshotOnDb } from "./evidence-learning.ts";
import { PRIMARY_PORTFOLIO, CHALLENGE_PORTFOLIO, STOCK_DAY_TRADER_PORTFOLIO } from "../paper-challenge.ts";
import { validateWeeklyProposals, WEEKLY_PROPOSALS_TOOL_SCHEMA, type WeeklyProposalDraft } from "./schemas.ts";
import { screenProposalSafety } from "./safety.ts";
import { runStructuredAiJob, type ProviderDeps } from "./provider.ts";
import { buildEvidencePacket, persistEvidencePacketOnDb } from "./evidence-packet.ts";
import { estimateCostUsd, maxJobCostUsd } from "./pricing.ts";
import {
  insertReportOnDb, insertProposalOnDb, listReportsOnDb, listLessonsOnDb, listProposalsOnDb,
  recordAiJobRunOnDb, setReportNarrativeOnDb, costGateOnDb, getReportOnDb, type DbLike,
} from "./store.ts";

function lazyDb(): DbLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/db").getDb();
}

const INTERNAL_RESEARCH_BANNER = "INTERNAL RESEARCH — MARKET CLOSED";

function labelInternalResearchSummary<T extends { patterns: string[] }>(summary: T): T {
  if (summary.patterns.includes(INTERNAL_RESEARCH_BANNER)) return summary;
  return { ...summary, patterns: [INTERNAL_RESEARCH_BANNER, ...summary.patterns] };
}

/** Hand-maintained map of decision-relevant files (roadmap §10 — NOT repo RAG). */
export const CURATED_STRATEGY_FILES = [
  "lib/entry-window.ts",
  "lib/breakout-latch.ts",
  "lib/contract-selector.ts",
  "lib/callouts/eligibility.ts",
  "lib/callout-opportunity.ts",
  "lib/paper-exits.ts",
  "lib/scanner-loop.ts",
];

/** A small, secret-free snapshot of the deterministic knobs a proposal may touch. */
export function weeklyContextConfig(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const n = (k: string, d: number) => (Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
  return {
    maxEntryVwapDistPct: n("ENTRY_MAX_VWAP_DIST_PCT", 1.5),
    extendedVwapDistPct: n("ENTRY_EXTENDED_VWAP_DIST_PCT", 3.0),
    minRelVol: n("ENTRY_MIN_REL_VOL", 1.2),
    entryMaxSpreadPct: n("ENTRY_MAX_SPREAD_PCT", 8),
    crossLatchTtlMs: n("CROSS_LATCH_TTL_MS", 90_000),
    crossLatchTolerancePct: n("CROSS_LATCH_TOLERANCE_PCT", 0.6),
    opportunityMinFavorablePct: n("OPPORTUNITY_MIN_FAVORABLE_PCT", 25),
    supervisorMs: n("SCHED_SUPERVISOR_MS", 30_000),
  };
}

function slug(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

function currentStrategyVersion(db: DbLike): string | null {
  try {
    const r = db.prepare("SELECT name, version FROM strategy_versions ORDER BY id DESC LIMIT 1").get() as any;
    return r ? `${r.name} ${r.version}` : null;
  } catch { return null; }
}

function aiFailureDiagnostic(call: Awaited<ReturnType<typeof runStructuredAiJob<WeeklyProposalDraft[]>>>) {
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

function weeklyQuantMetrics(input: {
  primary: NightlySummary;
  challenge: NightlySummary;
  stockDayTrader: NightlySummary;
}): Record<string, unknown> {
  const portfolio = (summary: NightlySummary) => ({
    sampleSizes: {
      overall: summary.overall.n,
      graded: summary.counts.outcomesGraded,
      ungradable: summary.counts.outcomesUngradable,
      calls: summary.callsVsPuts.call.n,
      puts: summary.callsVsPuts.put.n,
    },
    callsVsPuts: summary.callsVsPuts,
    stockSessions: summary.byTimeOfDay,
    acceptedVsRejected: {
      created: summary.counts.created,
      eligible: summary.counts.eligible,
      rejected: summary.counts.rejected,
      rejectionReasons: summary.rejectionReasons,
      waitWatchReasons: summary.waitWatchReasons,
    },
    entryQualityVsExitQuality: {
      opportunityGrade: summary.opportunityGrade,
      realizedGrade: summary.realizedGrade,
      signalCorrectExitFailed: summary.signalCorrectExitFailed,
      bothFailed: summary.bothFailed,
    },
    baseline: {
      winRate: summary.overall.winRate,
      avgReturnPct: summary.overall.avgReturnPct,
      opportunityHitRate: summary.overall.opportunityHitRate,
      prioritizedIssue: summary.prioritizedIssue,
      patterns: summary.patterns,
    },
  });
  return {
    baselineVsChallenger: {
      baseline: "current deterministic production policy",
      challenger: null,
      rule: "challenger metrics must be computed by deterministic replay/shadow tests before the AI may recommend promotion",
    },
    portfolios: {
      [PRIMARY_PORTFOLIO]: portfolio(input.primary),
      [CHALLENGE_PORTFOLIO]: portfolio(input.challenge),
      [STOCK_DAY_TRADER_PORTFOLIO]: portfolio(input.stockDayTrader),
    },
  };
}

export interface WeeklyJobResult {
  ran: boolean;
  skippedReason?: string;
  weekKey: string;
  reportId: number | null;
  summary: NightlySummary | null;
  proposalsCreated: number;
  proposalsBlocked: number;
  narrativeStatus: string;
  costUsd: number;
  diagnostic?: unknown;
}

export interface WeeklyJobOptions {
  nowMs?: number;
  weekKey?: string;
  env?: NodeJS.ProcessEnv;
  db?: DbLike;
  provider?: ProviderDeps;
  config?: AiConfig;
}

export async function runWeeklyProposals(opts: WeeklyJobOptions = {}): Promise<WeeklyJobResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const weekKey = opts.weekKey ?? isoWeekKey(tradingDay(nowMs));
  const db = opts.db ?? lazyDb();
  const cfg = opts.config ?? aiConfig(opts.env);

  const result: WeeklyJobResult = {
    ran: false, weekKey, reportId: null, summary: null,
    proposalsCreated: 0, proposalsBlocked: 0, narrativeStatus: "PENDING", costUsd: 0,
  };

  // 1. Deterministic weekly summary — always stored (idempotent per week).
  let summary: NightlySummary & { quantResearch?: ReturnType<typeof weeklyQuantResearchContext> };
  try {
    const days = recentTradingDays(nowMs, 7);
    const outcomes = gatherOutcomesForDays(days, nowMs, db, PRIMARY_PORTFOLIO);
    const challengeOutcomes = gatherOutcomesForDays(days, nowMs, db, CHALLENGE_PORTFOLIO);
    const stockDayOutcomes = gatherOutcomesForDays(days, nowMs, db, STOCK_DAY_TRADER_PORTFOLIO);
    const candidates = gatherCandidatesForDays(days, nowMs, db);
    const primary = buildNightlySummary({ tradingDay: weekKey, periodStartMs: nowMs - 7 * 24 * 3600_000, periodEndMs: nowMs, outcomes, candidates, live: null });
    const challenge = buildNightlySummary({ tradingDay: weekKey, periodStartMs: nowMs - 7 * 24 * 3600_000, periodEndMs: nowMs, outcomes: challengeOutcomes, candidates: [], live: null });
    const stockDayTrader = buildNightlySummary({ tradingDay: weekKey, periodStartMs: nowMs - 7 * 24 * 3600_000, periodEndMs: nowMs, outcomes: stockDayOutcomes, candidates: [], live: null });
    try { refreshEvidenceLearningOnDb(db, { nowMs }); } catch { /* evidence learning is advisory-only */ }
    // Deterministic OptiScan weekly review. Computed and persisted before any AI call, and the
    // ONLY place an experiment can reach PROMISING or READY_FOR_HUMAN_REVIEW. Isolated: a
    // failure here must not cost the week its report.
    let optiscanResearch: unknown = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { runWeeklyResearchOnDb } = require("@/lib/research/options/weekly-research");
      optiscanResearch = runWeeklyResearchOnDb(db, {
        weekKey,
        nowMs,
        monthlyBudgetUsd: Number.isFinite(Number(cfg.monthlyHardLimitUsd)) ? Number(cfg.monthlyHardLimitUsd) : null,
      });
    } catch { /* additive; never blocks the weekly report */ }
    summary = {
      ...primary,
      quantResearch: weeklyQuantResearchContext({
        env: opts.env,
        metrics: weeklyQuantMetrics({ primary, challenge, stockDayTrader }),
        evidenceLearning: evidenceLearningSnapshotOnDb(db),
      }),
      optiscanResearch,
    } as typeof summary;
    summary = labelInternalResearchSummary(summary);
  } catch (err: any) {
    return { ...result, skippedReason: `weekly summary failed: ${err?.message ?? err}` };
  }
  result.summary = summary;

  const { row: report, created } = insertReportOnDb(db, {
    reportType: "weekly", periodKey: weekKey, periodStartMs: nowMs - 7 * 24 * 3600_000, periodEndMs: nowMs, summary, nowMs,
  });
  result.reportId = report.id;
  result.ran = true;
  if (!created) return { ...result, narrativeStatus: report.narrativeStatus, skippedReason: "already ran for this week" };

  const outcome = await generateWeeklyProposalsForReport(db, cfg, {
    reportId: report.id, summary, weekKey, nowMs, env: opts.env, provider: opts.provider, jobType: "weekly_proposals",
  });
  return { ...result, ...outcome };
}

interface WeeklyAiOutcome {
  narrativeStatus: string;
  costUsd: number;
  proposalsCreated: number;
  proposalsBlocked: number;
  diagnostic?: unknown;
}

/**
 * The AI-call portion of the weekly job, shared by the scheduled run and the
 * manual retry. The deterministic evidence packet is built and persisted BEFORE
 * the model is called so it survives any provider failure. The model MUST answer
 * through the forced submit_weekly_proposals tool; { proposals: [] } is success.
 */
async function generateWeeklyProposalsForReport(
  db: DbLike,
  cfg: AiConfig,
  args: {
    reportId: number;
    summary: NightlySummary & { quantResearch?: ReturnType<typeof weeklyQuantResearchContext> };
    weekKey: string;
    nowMs: number;
    env?: NodeJS.ProcessEnv;
    provider?: ProviderDeps;
    jobType: string;
  },
): Promise<WeeklyAiOutcome> {
  const { reportId, summary, weekKey, nowMs, jobType } = args;
  const outcome: WeeklyAiOutcome = { narrativeStatus: "PENDING", costUsd: 0, proposalsCreated: 0, proposalsBlocked: 0 };

  if (!cfg.weeklyProposalsEnabled) {
    const diagnostic = { reason: "AI weekly proposals disabled or API key missing", flags: { enabled: cfg.enabled, hasApiKey: cfg.hasApiKey, weeklyProposalsEnabled: cfg.weeklyProposalsEnabled } };
    const jobRunId = recordAiJobRunOnDb(db, { jobType, model: cfg.weeklyModel, status: "SKIPPED_DISABLED", errorCategory: "disabled", diagnostic, nowMs });
    setReportNarrativeOnDb(db, reportId, { narrative: null, status: "SKIPPED", model: cfg.weeklyModel, aiJobRunId: jobRunId, diagnostic, nowMs });
    return { ...outcome, narrativeStatus: "SKIPPED", diagnostic };
  }
  // PRE-FLIGHT hard block: reserve this call's max possible cost so it can never exceed the hard limit.
  const weeklyReserveUsd = maxJobCostUsd(cfg.weeklyModel, cfg.maxInputTokensPerJob, cfg.maxOutputTokensPerJob);
  const gate = costGateOnDb(db, cfg, nowMs, weeklyReserveUsd);
  if (!gate.allowed) {
    const diagnostic = { reason: "monthly hard limit reached", spendUsd: gate.spendUsd, hardLimitUsd: gate.hardLimitUsd };
    const jobRunId = recordAiJobRunOnDb(db, { jobType, model: cfg.weeklyModel, status: "SKIPPED_HARD_LIMIT", errorCategory: "budget", error: `monthly hard limit reached ($${gate.spendUsd.toFixed(2)})`, diagnostic, nowMs });
    setReportNarrativeOnDb(db, reportId, { narrative: null, status: "SKIPPED", model: cfg.weeklyModel, aiJobRunId: jobRunId, diagnostic, nowMs });
    return { ...outcome, narrativeStatus: "SKIPPED", diagnostic };
  }

  // 2. Curated context (summaries + lessons + prior proposals + config + file map).
  // The evidence packet is persisted BEFORE the provider call — model failures can
  // never lose the deterministic evidence for this window.
  const lessons = listLessonsOnDb(db, 100);
  const periodStartMs = nowMs - 7 * 24 * 3600_000;
  const evidencePacket = buildEvidencePacket(db, { periodStartMs, periodEndMs: nowMs, env: args.env });
  persistEvidencePacketOnDb(db, evidencePacket);
  const { system, user } = weeklyProposalPrompt({
    weekKey,
    weeklySummary: summary,
    recentNightly: listReportsOnDb(db, "nightly", 7).map((r) => r.summary),
    acceptedLessons: lessons.filter((l) => l.status === "ACCEPTED"),
    rejectedLessons: lessons.filter((l) => l.status === "REJECTED"),
    priorProposals: listProposalsOnDb(db, 20).map((p) => ({ title: p.title, status: p.status, affectedStrategy: p.affectedStrategy })),
    currentConfig: weeklyContextConfig(args.env),
    quantResearch: summary.quantResearch,
    relevantFiles: CURATED_STRATEGY_FILES,
    strategyVersion: currentStrategyVersion(db),
    evidencePacket,
  });

  const call = await runStructuredAiJob<WeeklyProposalDraft[]>(
    {
      model: cfg.weeklyModel,
      system,
      user,
      maxOutputTokens: cfg.maxOutputTokensPerJob,
      timeoutMs: cfg.jobTimeoutMs,
      maxRetries: cfg.maxRetries,
      toolName: "submit_weekly_proposals",
      toolInputSchema: WEEKLY_PROPOSALS_TOOL_SCHEMA as unknown as Record<string, unknown>,
      validatorName: "validateWeeklyProposals",
      promptVersion: WEEKLY_PROPOSAL_PROMPT_VERSION,
    },
    (json) => validateWeeklyProposals(json),
    args.provider,
  );
  const costUsd = estimateCostUsd(cfg.weeklyModel, call.inputTokens, call.outputTokens);
  outcome.costUsd = costUsd;
  const diagnostic = call.ok ? null : aiFailureDiagnostic(call);
  const status = call.ok ? "SUCCESS" : call.errorCategory === "timeout" ? "TIMEOUT" : call.errorCategory === "validation" ? "VALIDATION_FAILED" : "ERROR";
  const jobRunId = recordAiJobRunOnDb(db, {
    jobType, model: cfg.weeklyModel,
    status,
    errorCategory: call.ok ? "none" : call.errorCategory, error: call.error,
    inputTokens: call.inputTokens, outputTokens: call.outputTokens, estimatedCostUsd: costUsd,
    latencyMs: call.latencyMs, retryCount: call.retries, diagnostic, nowMs,
  });

  if (!call.ok || !call.data) {
    outcome.narrativeStatus = call.errorCategory === "validation" ? "VALIDATION_FAILED" : "ERROR";
    outcome.diagnostic = diagnostic;
    setReportNarrativeOnDb(db, reportId, { narrative: null, status: outcome.narrativeStatus, model: cfg.weeklyModel, aiJobRunId: jobRunId, diagnostic, nowMs });
    return outcome;
  }
  outcome.narrativeStatus = "OK";
  setReportNarrativeOnDb(db, reportId, { narrative: { proposals: call.data.length }, status: "OK", model: cfg.weeklyModel, aiJobRunId: jobRunId, diagnostic: null, nowMs });

  // 3. Store each proposal — after a HARD safety screen. Nothing is applied.
  for (const draft of call.data) {
    const screen = screenProposalSafety(draft);
    if (!screen.ok) { outcome.proposalsBlocked += 1; continue; }
    const dedupKey = `${weekKey}|${draft.affectedStrategy ?? "all"}|${slug(draft.title)}`;
    const { created: madeNew } = insertProposalOnDb(db, {
      dedupKey, periodKey: weekKey, title: draft.title, problem: draft.problem,
      evidence: { text: draft.evidence, packetId: evidencePacket.id, completenessPct: evidencePacket.lanes[0]?.completenessPct ?? null }, sampleSize: draft.sampleSize, affectedStrategy: draft.affectedStrategy,
      affectedSession: draft.affectedSession, affectedConfig: draft.affectedConfig, proposedChange: draft.proposedChange,
      relevantFiles: draft.relevantFiles, changeLevel: draft.changeLevel, expectedBenefit: draft.expectedBenefit,
      downsideRisk: draft.downsideRisk, overfittingRisk: draft.overfittingRisk, requiredTests: draft.requiredTests,
      backtestPlan: draft.backtestPlan, shadowTestPlan: draft.shadowTestPlan, paperTestPlan: draft.paperTestPlan,
      rollbackPlan: draft.rollbackPlan, suggestedPatch: draft.suggestedPatch, confidence: draft.confidence,
      sourceReportId: reportId, model: cfg.weeklyModel, nowMs,
    });
    if (madeNew) outcome.proposalsCreated += 1;
  }
  return outcome;
}

/**
 * Manually re-run the AI proposal portion of an ALREADY-STORED weekly report
 * (e.g. after a provider failure) without waiting for the next ISO week. The
 * deterministic summary is never rebuilt or overwritten; proposals stay
 * deduplicated per week. Never throws.
 */
export async function retryWeeklyProposals(
  opts: WeeklyJobOptions & { reportId?: number; periodKey?: string } = {},
): Promise<WeeklyJobResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const db = opts.db ?? lazyDb();
  const cfg = opts.config ?? aiConfig(opts.env);
  const periodKey = opts.periodKey ?? opts.weekKey ?? isoWeekKey(tradingDay(nowMs));
  const row = opts.reportId
    ? (db.prepare("SELECT period_key FROM ai_reports WHERE id=? AND report_type='weekly'").get(opts.reportId) as any)
    : null;
  const report = row ? getReportOnDb(db, "weekly", row.period_key) : getReportOnDb(db, "weekly", periodKey);
  if (!report) {
    return {
      ran: false, skippedReason: `stored weekly report not found for ${periodKey}`, weekKey: periodKey,
      reportId: null, summary: null, proposalsCreated: 0, proposalsBlocked: 0, narrativeStatus: "MISSING", costUsd: 0,
    };
  }

  const outcome = await generateWeeklyProposalsForReport(db, cfg, {
    reportId: report.id, summary: report.summary, weekKey: report.periodKey,
    nowMs, env: opts.env, provider: opts.provider, jobType: "weekly_proposals_retry",
  });
  return {
    ran: true, weekKey: report.periodKey, reportId: report.id, summary: report.summary, ...outcome,
  };
}
