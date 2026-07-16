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
import { weeklyProposalPrompt } from "./prompts.ts";
import { weeklyQuantResearchContext } from "./quant-research.ts";
import { PRIMARY_PORTFOLIO, CHALLENGE_PORTFOLIO, STOCK_DAY_TRADER_PORTFOLIO } from "../paper-challenge.ts";
import { validateWeeklyProposals, type WeeklyProposalDraft } from "./schemas.ts";
import { screenProposalSafety } from "./safety.ts";
import { runStructuredAiJob, type ProviderDeps } from "./provider.ts";
import { estimateCostUsd } from "./pricing.ts";
import {
  insertReportOnDb, insertProposalOnDb, listReportsOnDb, listLessonsOnDb, listProposalsOnDb,
  recordAiJobRunOnDb, costGateOnDb, type DbLike,
} from "./store.ts";

function lazyDb(): DbLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/db").getDb();
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
    summary = {
      ...primary,
      quantResearch: weeklyQuantResearchContext({
        env: opts.env,
        metrics: weeklyQuantMetrics({ primary, challenge, stockDayTrader }),
      }),
    };
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

  if (!cfg.weeklyProposalsEnabled) {
    recordAiJobRunOnDb(db, { jobType: "weekly_proposals", model: cfg.weeklyModel, status: "SKIPPED_DISABLED", errorCategory: "disabled", nowMs });
    return { ...result, narrativeStatus: "SKIPPED" };
  }
  const gate = costGateOnDb(db, cfg, nowMs);
  if (!gate.allowed) {
    recordAiJobRunOnDb(db, { jobType: "weekly_proposals", model: cfg.weeklyModel, status: "SKIPPED_HARD_LIMIT", errorCategory: "budget", error: `monthly hard limit reached ($${gate.spendUsd.toFixed(2)})`, nowMs });
    return { ...result, narrativeStatus: "SKIPPED" };
  }

  // 2. Curated context (summaries + lessons + prior proposals + config + file map).
  const lessons = listLessonsOnDb(db, 100);
  const { system, user } = weeklyProposalPrompt({
    weekKey,
    weeklySummary: summary,
    recentNightly: listReportsOnDb(db, "nightly", 7).map((r) => r.summary),
    acceptedLessons: lessons.filter((l) => l.status === "ACCEPTED"),
    rejectedLessons: lessons.filter((l) => l.status === "REJECTED"),
    priorProposals: listProposalsOnDb(db, 20).map((p) => ({ title: p.title, status: p.status, affectedStrategy: p.affectedStrategy })),
    currentConfig: weeklyContextConfig(opts.env),
    quantResearch: summary.quantResearch,
    relevantFiles: CURATED_STRATEGY_FILES,
    strategyVersion: currentStrategyVersion(db),
  });

  const call = await runStructuredAiJob<WeeklyProposalDraft[]>(
    { model: cfg.weeklyModel, system, user, maxOutputTokens: cfg.maxOutputTokensPerJob, timeoutMs: cfg.jobTimeoutMs, maxRetries: cfg.maxRetries },
    (json) => validateWeeklyProposals(json),
    opts.provider,
  );
  const costUsd = estimateCostUsd(cfg.weeklyModel, call.inputTokens, call.outputTokens);
  result.costUsd = costUsd;
  recordAiJobRunOnDb(db, {
    jobType: "weekly_proposals", model: cfg.weeklyModel,
    status: call.ok ? "SUCCESS" : call.errorCategory === "timeout" ? "TIMEOUT" : call.errorCategory === "validation" ? "VALIDATION_FAILED" : "ERROR",
    errorCategory: call.ok ? "none" : call.errorCategory, error: call.error,
    inputTokens: call.inputTokens, outputTokens: call.outputTokens, estimatedCostUsd: costUsd,
    latencyMs: call.latencyMs, retryCount: call.retries, nowMs,
  });

  if (!call.ok || !call.data) {
    result.narrativeStatus = call.errorCategory === "validation" ? "VALIDATION_FAILED" : "ERROR";
    return result;
  }
  result.narrativeStatus = "OK";

  // 3. Store each proposal — after a HARD safety screen. Nothing is applied.
  for (const draft of call.data) {
    const screen = screenProposalSafety(draft);
    if (!screen.ok) { result.proposalsBlocked += 1; continue; }
    const dedupKey = `${weekKey}|${draft.affectedStrategy ?? "all"}|${slug(draft.title)}`;
    const { created: madeNew } = insertProposalOnDb(db, {
      dedupKey, periodKey: weekKey, title: draft.title, problem: draft.problem,
      evidence: draft.evidence, sampleSize: draft.sampleSize, affectedStrategy: draft.affectedStrategy,
      affectedSession: draft.affectedSession, affectedConfig: draft.affectedConfig, proposedChange: draft.proposedChange,
      relevantFiles: draft.relevantFiles, changeLevel: draft.changeLevel, expectedBenefit: draft.expectedBenefit,
      downsideRisk: draft.downsideRisk, overfittingRisk: draft.overfittingRisk, requiredTests: draft.requiredTests,
      backtestPlan: draft.backtestPlan, shadowTestPlan: draft.shadowTestPlan, paperTestPlan: draft.paperTestPlan,
      rollbackPlan: draft.rollbackPlan, suggestedPatch: draft.suggestedPatch, confidence: draft.confidence,
      sourceReportId: report.id, model: cfg.weeklyModel, nowMs,
    });
    if (madeNew) result.proposalsCreated += 1;
  }
  return result;
}
