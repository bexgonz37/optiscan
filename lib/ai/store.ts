/**
 * ai/store.ts — persistence for the advisory AI layer. Testable `*OnDb` cores take
 * a better-sqlite3 handle; the public wrappers resolve `@/lib/db` lazily so the
 * PURE test path never imports server-only SQLite.
 *
 * Tables (see lib/db.ts SCHEMA): ai_reports, ai_lessons, ai_proposals, ai_job_runs.
 * Nothing here calls a model or the network — it only records deterministic
 * summaries, validated narratives, lessons, proposals, and the cost/audit log, and
 * answers the monthly-spend cost gate.
 */
import { tradingDay } from "../trading-session.ts";
import type { AiConfig } from "./config.ts";

export type DbLike = {
  prepare: (sql: string) => {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { lastInsertRowid: number | bigint };
  };
};

/** YYYY-MM in US/Eastern — the spend rollup bucket. */
export function monthKey(nowMs: number = Date.now()): string {
  return tradingDay(nowMs).slice(0, 7);
}

// ── AI job audit + cost log ──────────────────────────────────────────────────

export interface AiJobRunInput {
  jobType: string;
  model: string | null;
  status: string;
  errorCategory?: string | null;
  error?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  latencyMs?: number;
  retryCount?: number;
  nowMs?: number;
}

export function recordAiJobRunOnDb(db: DbLike, r: AiJobRunInput): number {
  const nowMs = r.nowMs ?? Date.now();
  const info = db.prepare(
    `INSERT INTO ai_job_runs
       (job_type, model, status, error_category, error, input_tokens, output_tokens,
        estimated_cost_usd, latency_ms, retry_count, month_key, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    r.jobType, r.model ?? null, r.status, r.errorCategory ?? null, (r.error ?? null) && String(r.error).slice(0, 500),
    Math.max(0, Math.floor(r.inputTokens ?? 0)), Math.max(0, Math.floor(r.outputTokens ?? 0)),
    Math.max(0, r.estimatedCostUsd ?? 0), Math.max(0, Math.floor(r.latencyMs ?? 0)),
    Math.max(0, Math.floor(r.retryCount ?? 0)), monthKey(nowMs), nowMs,
  );
  return Number(info.lastInsertRowid);
}

/** Total estimated USD spend recorded for a month (SUCCESS + failed attempts). */
export function monthlySpendUsdOnDb(db: DbLike, mk: string = monthKey()): number {
  const row = db.prepare("SELECT COALESCE(SUM(estimated_cost_usd),0) AS s FROM ai_job_runs WHERE month_key=?").get(mk);
  return Number(row?.s ?? 0);
}

export interface CostGate {
  allowed: boolean;       // false once the HARD limit is reached
  atSoftLimit: boolean;   // warn threshold reached
  atHardLimit: boolean;
  spendUsd: number;
  softLimitUsd: number;
  hardLimitUsd: number;
}

/**
 * The monthly cost gate. Optional AI jobs are skipped once spend ≥ hard limit; a
 * soft-limit crossing only warns. Deterministic OptiScan behavior is unaffected
 * either way. A hard limit of 0 means "no AI spend allowed" (fully off).
 */
export function costGateOnDb(db: DbLike, cfg: AiConfig, nowMs: number = Date.now()): CostGate {
  const spendUsd = monthlySpendUsdOnDb(db, monthKey(nowMs));
  const atHardLimit = spendUsd >= cfg.monthlyHardLimitUsd;
  const atSoftLimit = spendUsd >= cfg.monthlySoftLimitUsd;
  return {
    allowed: !atHardLimit,
    atSoftLimit,
    atHardLimit,
    spendUsd,
    softLimitUsd: cfg.monthlySoftLimitUsd,
    hardLimitUsd: cfg.monthlyHardLimitUsd,
  };
}

export interface AiUsage {
  monthKey: string;
  spendUsd: number;
  totalRuns: number;
  byStatus: Record<string, number>;
  byJobType: Record<string, { runs: number; costUsd: number; inputTokens: number; outputTokens: number }>;
}

/** Aggregate AI usage/cost for a month from the audit log. */
export function aiUsageOnDb(db: DbLike, mk: string = monthKey()): AiUsage {
  const rows = db.prepare(
    "SELECT job_type, status, estimated_cost_usd, input_tokens, output_tokens FROM ai_job_runs WHERE month_key=?",
  ).all(mk) as any[];
  const byStatus: Record<string, number> = {};
  const byJobType: AiUsage["byJobType"] = {};
  let spendUsd = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const jt = (byJobType[r.job_type] ??= { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
    jt.runs += 1;
    jt.costUsd += Number(r.estimated_cost_usd ?? 0);
    jt.inputTokens += Number(r.input_tokens ?? 0);
    jt.outputTokens += Number(r.output_tokens ?? 0);
    spendUsd += Number(r.estimated_cost_usd ?? 0);
  }
  return { monthKey: mk, spendUsd: Math.round(spendUsd * 1_000_000) / 1_000_000, totalRuns: rows.length, byStatus, byJobType };
}

/** Recent AI job failures (for the ops surface). */
export function recentJobFailuresOnDb(db: DbLike, limit = 20): any[] {
  return db.prepare(
    `SELECT id, job_type, model, status, error_category, error, retry_count, latency_ms, created_at_ms
       FROM ai_job_runs WHERE status NOT IN ('SUCCESS') ORDER BY created_at_ms DESC LIMIT ?`,
  ).all(limit) as any[];
}

export interface AiJobRunStats {
  lastRunAtMs: number | null;
  lastRunType: string | null;
  lastRunStatus: string | null;
  lastSuccessAtMs: number | null;
  lastSuccessType: string | null;
  lastFailureAtMs: number | null;
  lastFailureType: string | null;
  lastFailureError: string | null;
  totalRuns: number;
}

/** Deterministic "when did the AI job machinery last run / succeed / fail" summary. */
export function aiJobRunStatsOnDb(db: DbLike): AiJobRunStats {
  const last = db.prepare("SELECT job_type, status, created_at_ms FROM ai_job_runs ORDER BY created_at_ms DESC LIMIT 1").get() as any;
  const ok = db.prepare("SELECT job_type, created_at_ms FROM ai_job_runs WHERE status='SUCCESS' ORDER BY created_at_ms DESC LIMIT 1").get() as any;
  const fail = db.prepare("SELECT job_type, error, created_at_ms FROM ai_job_runs WHERE status IN ('ERROR','TIMEOUT','VALIDATION_FAILED') ORDER BY created_at_ms DESC LIMIT 1").get() as any;
  const total = db.prepare("SELECT COUNT(*) AS n FROM ai_job_runs").get() as any;
  return {
    lastRunAtMs: last?.created_at_ms ?? null,
    lastRunType: last?.job_type ?? null,
    lastRunStatus: last?.status ?? null,
    lastSuccessAtMs: ok?.created_at_ms ?? null,
    lastSuccessType: ok?.job_type ?? null,
    lastFailureAtMs: fail?.created_at_ms ?? null,
    lastFailureType: fail?.job_type ?? null,
    lastFailureError: fail?.error ?? null,
    totalRuns: Number(total?.n ?? 0),
  };
}

// ── Reports (nightly / weekly) ───────────────────────────────────────────────

export interface AiReportRow {
  id: number;
  reportType: string;
  periodKey: string;
  periodStartMs: number | null;
  periodEndMs: number | null;
  summary: any;
  narrative: any | null;
  narrativeStatus: string;
  model: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

function mapReport(r: any): AiReportRow {
  const parse = (s: any) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return {
    id: r.id, reportType: r.report_type, periodKey: r.period_key,
    periodStartMs: r.period_start_ms ?? null, periodEndMs: r.period_end_ms ?? null,
    summary: parse(r.summary_json), narrative: parse(r.narrative_json),
    narrativeStatus: r.narrative_status, model: r.model ?? null,
    createdAtMs: r.created_at_ms, updatedAtMs: r.updated_at_ms,
  };
}

export function getReportOnDb(db: DbLike, reportType: string, periodKey: string): AiReportRow | null {
  const r = db.prepare("SELECT * FROM ai_reports WHERE report_type=? AND period_key=?").get(reportType, periodKey);
  return r ? mapReport(r) : null;
}

/**
 * Insert the deterministic summary for a report period, idempotently. If a row for
 * (report_type, period_key) already exists it is returned unchanged (the job for
 * that period already ran) — the deterministic summary is never overwritten.
 */
export function insertReportOnDb(
  db: DbLike,
  input: { reportType: string; periodKey: string; periodStartMs: number | null; periodEndMs: number | null; summary: unknown; nowMs?: number },
): { row: AiReportRow; created: boolean } {
  const existing = getReportOnDb(db, input.reportType, input.periodKey);
  if (existing) return { row: existing, created: false };
  const nowMs = input.nowMs ?? Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO ai_reports
       (report_type, period_key, period_start_ms, period_end_ms, summary_json, narrative_status, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?, 'PENDING', ?, ?)`,
  ).run(input.reportType, input.periodKey, input.periodStartMs, input.periodEndMs, JSON.stringify(input.summary ?? {}), nowMs, nowMs);
  const row = getReportOnDb(db, input.reportType, input.periodKey)!;
  return { row, created: true };
}

export function setReportNarrativeOnDb(
  db: DbLike,
  reportId: number,
  input: { narrative: unknown | null; status: string; model: string | null; aiJobRunId?: number | null; nowMs?: number },
): void {
  const nowMs = input.nowMs ?? Date.now();
  db.prepare(
    "UPDATE ai_reports SET narrative_json=?, narrative_status=?, model=?, ai_job_run_id=?, updated_at_ms=? WHERE id=?",
  ).run(
    input.narrative == null ? null : JSON.stringify(input.narrative),
    input.status, input.model ?? null, input.aiJobRunId ?? null, nowMs, reportId,
  );
}

export function listReportsOnDb(db: DbLike, reportType: string | null, limit = 30): AiReportRow[] {
  const rows = reportType
    ? db.prepare("SELECT * FROM ai_reports WHERE report_type=? ORDER BY created_at_ms DESC LIMIT ?").all(reportType, limit)
    : db.prepare("SELECT * FROM ai_reports ORDER BY created_at_ms DESC LIMIT ?").all(limit);
  return (rows as any[]).map(mapReport);
}

// ── Lessons memory ───────────────────────────────────────────────────────────

export interface LessonInput {
  dedupKey: string;
  findingType: string;
  title: string;
  summary: string;
  evidence: unknown;
  sampleSize: number;
  affectedTicker?: string | null;
  affectedStrategy?: string | null;
  affectedSession?: string | null;
  affectedDuration?: string | null;
  dateRangeStart?: string | null;
  dateRangeEnd?: string | null;
  sourceReportId?: number | null;
  confidence?: string;
  strategyVersion?: string | null;
  nowMs?: number;
}

export interface LessonRow extends LessonInput {
  id: number;
  status: string;
  decisionState: string;
  decisionNotes: string | null;
  linkedProposalId: number | null;
  resultAfterImplementation: string | null;
  occurrences: number;
  createdAtMs: number;
  updatedAtMs: number;
}

function mapLesson(r: any): LessonRow {
  const parse = (s: any) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return {
    id: r.id, dedupKey: r.dedup_key, findingType: r.finding_type, title: r.title, summary: r.summary,
    evidence: parse(r.evidence_json), sampleSize: r.sample_size,
    affectedTicker: r.affected_ticker ?? null, affectedStrategy: r.affected_strategy ?? null,
    affectedSession: r.affected_session ?? null, affectedDuration: r.affected_duration ?? null,
    dateRangeStart: r.date_range_start ?? null, dateRangeEnd: r.date_range_end ?? null,
    sourceReportId: r.source_report_id ?? null, confidence: r.confidence,
    status: r.status, decisionState: r.decision_state, decisionNotes: r.decision_notes ?? null,
    linkedProposalId: r.linked_proposal_id ?? null, strategyVersion: r.strategy_version ?? null,
    resultAfterImplementation: r.result_after_implementation ?? null,
    occurrences: r.occurrences, createdAtMs: r.created_at_ms, updatedAtMs: r.updated_at_ms,
  };
}

/**
 * Create or refresh a lesson keyed by dedup_key. A repeated finding UPDATES the
 * existing row (occurrences++, refreshed evidence/sample) instead of inserting a
 * near-duplicate — but a lesson a human has already ACCEPTED or REJECTED is never
 * silently reopened or overwritten (only its occurrence count/evidence refresh).
 */
export function upsertLessonOnDb(db: DbLike, l: LessonInput): { row: LessonRow; created: boolean } {
  const nowMs = l.nowMs ?? Date.now();
  const existing = db.prepare("SELECT * FROM ai_lessons WHERE dedup_key=?").get(l.dedupKey);
  if (existing) {
    db.prepare(
      `UPDATE ai_lessons SET occurrences=occurrences+1, sample_size=?, evidence_json=?,
         date_range_end=?, confidence=?, updated_at_ms=? WHERE dedup_key=?`,
    ).run(l.sampleSize, JSON.stringify(l.evidence ?? {}), l.dateRangeEnd ?? null, l.confidence ?? existing.confidence, nowMs, l.dedupKey);
    return { row: mapLesson(db.prepare("SELECT * FROM ai_lessons WHERE dedup_key=?").get(l.dedupKey)), created: false };
  }
  db.prepare(
    `INSERT INTO ai_lessons
       (dedup_key, finding_type, title, summary, evidence_json, sample_size, affected_ticker,
        affected_strategy, affected_session, affected_duration, date_range_start, date_range_end,
        source_report_id, status, confidence, decision_state, strategy_version, occurrences, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?, ?,?,?,?,?, ?, 'OPEN', ?, 'NEEDS_MORE_DATA', ?, 1, ?, ?)`,
  ).run(
    l.dedupKey, l.findingType, l.title, l.summary, JSON.stringify(l.evidence ?? {}), Math.max(0, Math.floor(l.sampleSize)),
    l.affectedTicker ?? null, l.affectedStrategy ?? null, l.affectedSession ?? null, l.affectedDuration ?? null,
    l.dateRangeStart ?? null, l.dateRangeEnd ?? null, l.sourceReportId ?? null, l.confidence ?? "LOW",
    l.strategyVersion ?? null, nowMs, nowMs,
  );
  return { row: mapLesson(db.prepare("SELECT * FROM ai_lessons WHERE dedup_key=?").get(l.dedupKey)), created: true };
}

export function listLessonsOnDb(db: DbLike, limit = 100): LessonRow[] {
  return (db.prepare("SELECT * FROM ai_lessons ORDER BY updated_at_ms DESC LIMIT ?").all(limit) as any[]).map(mapLesson);
}

export function decideLessonOnDb(
  db: DbLike,
  id: number,
  decision: { status: string; decisionState: string; notes?: string | null; nowMs?: number },
): void {
  const nowMs = decision.nowMs ?? Date.now();
  db.prepare("UPDATE ai_lessons SET status=?, decision_state=?, decision_notes=?, updated_at_ms=? WHERE id=?")
    .run(decision.status, decision.decisionState, decision.notes ?? null, nowMs, id);
}

// ── Weekly proposals ─────────────────────────────────────────────────────────

export interface ProposalInput {
  dedupKey: string;
  periodKey: string;
  title: string;
  problem: string;
  evidence: unknown;
  sampleSize: number;
  affectedStrategy?: string | null;
  affectedSession?: string | null;
  affectedConfig?: string | null;
  proposedChange: string;
  relevantFiles?: string[];
  changeLevel?: string | null;
  expectedBenefit?: string | null;
  downsideRisk?: string | null;
  overfittingRisk?: string | null;
  requiredTests?: string | null;
  backtestPlan?: string | null;
  shadowTestPlan?: string | null;
  paperTestPlan?: string | null;
  rollbackPlan?: string | null;
  suggestedPatch?: string | null;
  confidence?: string;
  sourceReportId?: number | null;
  model?: string | null;
  nowMs?: number;
}

export interface ProposalRow extends Omit<ProposalInput, "relevantFiles"> {
  id: number;
  relevantFiles: string[];
  status: string;
  decisionNotes: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

function mapProposal(r: any): ProposalRow {
  const parse = (s: any) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return {
    id: r.id, dedupKey: r.dedup_key, periodKey: r.period_key, title: r.title, problem: r.problem,
    evidence: parse(r.evidence_json), sampleSize: r.sample_size,
    affectedStrategy: r.affected_strategy ?? null, affectedSession: r.affected_session ?? null,
    affectedConfig: r.affected_config ?? null, proposedChange: r.proposed_change,
    relevantFiles: parse(r.relevant_files_json) ?? [], changeLevel: r.change_level ?? null,
    expectedBenefit: r.expected_benefit ?? null, downsideRisk: r.downside_risk ?? null,
    overfittingRisk: r.overfitting_risk ?? null, requiredTests: r.required_tests ?? null,
    backtestPlan: r.backtest_plan ?? null, shadowTestPlan: r.shadow_test_plan ?? null,
    paperTestPlan: r.paper_test_plan ?? null, rollbackPlan: r.rollback_plan ?? null,
    suggestedPatch: r.suggested_patch ?? null, confidence: r.confidence,
    status: r.status, decisionNotes: r.decision_notes ?? null,
    sourceReportId: r.source_report_id ?? null, model: r.model ?? null,
    createdAtMs: r.created_at_ms, updatedAtMs: r.updated_at_ms,
  };
}

/** Insert a proposal write-once by dedup_key (a re-run for the same week is a no-op). */
export function insertProposalOnDb(db: DbLike, p: ProposalInput): { row: ProposalRow; created: boolean } {
  const nowMs = p.nowMs ?? Date.now();
  const existing = db.prepare("SELECT * FROM ai_proposals WHERE dedup_key=?").get(p.dedupKey);
  if (existing) return { row: mapProposal(existing), created: false };
  db.prepare(
    `INSERT OR IGNORE INTO ai_proposals
       (dedup_key, period_key, title, problem, evidence_json, sample_size, affected_strategy, affected_session,
        affected_config, proposed_change, relevant_files_json, change_level, expected_benefit, downside_risk,
        overfitting_risk, required_tests, backtest_plan, shadow_test_plan, paper_test_plan, rollback_plan,
        suggested_patch, confidence, status, decision_notes, source_report_id, model, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?, 'PENDING_APPROVAL', NULL, ?, ?, ?, ?)`,
  ).run(
    p.dedupKey, p.periodKey, p.title, p.problem, JSON.stringify(p.evidence ?? {}), Math.max(0, Math.floor(p.sampleSize)),
    p.affectedStrategy ?? null, p.affectedSession ?? null, p.affectedConfig ?? null, p.proposedChange,
    JSON.stringify(p.relevantFiles ?? []), p.changeLevel ?? null, p.expectedBenefit ?? null, p.downsideRisk ?? null,
    p.overfittingRisk ?? null, p.requiredTests ?? null, p.backtestPlan ?? null, p.shadowTestPlan ?? null,
    p.paperTestPlan ?? null, p.rollbackPlan ?? null, p.suggestedPatch ?? null, p.confidence ?? "LOW",
    p.sourceReportId ?? null, p.model ?? null, nowMs, nowMs,
  );
  return { row: mapProposal(db.prepare("SELECT * FROM ai_proposals WHERE dedup_key=?").get(p.dedupKey)), created: true };
}

export function listProposalsOnDb(db: DbLike, limit = 100): ProposalRow[] {
  return (db.prepare("SELECT * FROM ai_proposals ORDER BY created_at_ms DESC LIMIT ?").all(limit) as any[]).map(mapProposal);
}

export function decideProposalOnDb(
  db: DbLike,
  id: number,
  decision: { status: "ACCEPTED" | "REJECTED"; notes?: string | null; nowMs?: number },
): void {
  const nowMs = decision.nowMs ?? Date.now();
  db.prepare("UPDATE ai_proposals SET status=?, decision_notes=?, updated_at_ms=? WHERE id=?")
    .run(decision.status, decision.notes ?? null, nowMs, id);
}

// ── Lazy public wrappers ─────────────────────────────────────────────────────

function lazyDb(): DbLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/db").getDb();
}

export const recordAiJobRun = (r: AiJobRunInput) => recordAiJobRunOnDb(lazyDb(), r);
export const monthlySpendUsd = (mk?: string) => monthlySpendUsdOnDb(lazyDb(), mk);
export const aiUsage = (mk?: string) => aiUsageOnDb(lazyDb(), mk);
export const recentJobFailures = (limit?: number) => recentJobFailuresOnDb(lazyDb(), limit);
export const getReport = (t: string, k: string) => getReportOnDb(lazyDb(), t, k);
export const listReports = (t: string | null, limit?: number) => listReportsOnDb(lazyDb(), t, limit);
export const listLessons = (limit?: number) => listLessonsOnDb(lazyDb(), limit);
export const listProposals = (limit?: number) => listProposalsOnDb(lazyDb(), limit);
export const decideLesson = (id: number, d: { status: string; decisionState: string; notes?: string | null }) => decideLessonOnDb(lazyDb(), id, d);
export const decideProposal = (id: number, d: { status: "ACCEPTED" | "REJECTED"; notes?: string | null }) => decideProposalOnDb(lazyDb(), id, d);
