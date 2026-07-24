/**
 * B6 soak — daily readiness report generation (append-only, idempotent per ET day).
 * Does not enable flags or perform cutover. Observational only.
 */
import { brokerId } from "./id.ts";
import { appendAuditEvent, type BrokerDb } from "./audit.ts";
import { evaluateBrokerV2Readiness, type ReadinessReport, type ReadinessStatus } from "./readiness.ts";
import { BROKER_RECORD_SCHEMA_VERSION } from "./types.ts";

export const SOAK_REPORT_VERSION = 1;

export interface DailyReadinessSummary {
  reportDay: string; // YYYY-MM-DD America/New_York
  status: ReadinessStatus;
  mirroredTrades: number;
  completedRoundTrips: number;
  distinctTradingDays: number;
  tradeParitySuccessRatePct: number | null;
  fillPriceParityRatePct: number | null;
  realizedPnlParityRatePct: number | null;
  returnParityRatePct: number | null;
  lifecycleParityRatePct: number | null;
  auditChainCompletenessRatePct: number | null;
  equityReconciliationRatePct: number | null;
  unresolvedCriticalFailures: number;
  unresolvedParityFailures: number;
  orphanCount: number;
  duplicateCount: number;
  missingMarkCount: number;
  staleMarkCount: number;
  incompleteEquitySnapshotCount: number;
  shadowReadEvents: number;
  shadowReadMismatches: number;
  continuousHealthyParityMs: number | null;
  warnings: string[];
  regressions: string[];
  flags: ReadinessReport["flags"];
  recommendedNextAction: string;
  reachedControlledCutoverGate: boolean;
}

export interface SoakPeriodSummary {
  reportCount: number;
  firstReportDay: string | null;
  latestReportDay: string | null;
  soakCalendarDays: number | null;
  statusHistory: Array<{ day: string; status: string }>;
  latestStatus: string | null;
  everReachedControlledCutoverGate: boolean;
  latestSummary: DailyReadinessSummary | null;
  regressionDays: string[];
}

function etDayKey(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

function orphanTotal(r: ReadinessReport): number {
  const m = r.metrics;
  return (
    m.orphanedOrders +
    m.orphanedFills +
    m.orphanedPositions +
    m.orphanedLedgerEntries +
    m.orphanedSnapshots
  );
}

function detectRegressions(
  prev: DailyReadinessSummary | null,
  cur: DailyReadinessSummary,
): string[] {
  if (!prev) return [];
  const out: string[] = [];
  const rank: Record<string, number> = {
    NOT_READY: 0,
    OBSERVING: 1,
    READY_FOR_SHADOW_READS: 2,
    READY_FOR_CONTROLLED_CUTOVER: 3,
  };
  if ((rank[cur.status] ?? 0) < (rank[prev.status] ?? 0)) {
    out.push(`status_regressed:${prev.status}->${cur.status}`);
  }
  if (cur.unresolvedCriticalFailures > prev.unresolvedCriticalFailures) {
    out.push(
      `critical_failures_up:${prev.unresolvedCriticalFailures}->${cur.unresolvedCriticalFailures}`,
    );
  }
  if (cur.orphanCount > prev.orphanCount) {
    out.push(`orphans_up:${prev.orphanCount}->${cur.orphanCount}`);
  }
  if (cur.duplicateCount > prev.duplicateCount) {
    out.push(`duplicates_up:${prev.duplicateCount}->${cur.duplicateCount}`);
  }
  if (
    prev.tradeParitySuccessRatePct != null &&
    cur.tradeParitySuccessRatePct != null &&
    cur.tradeParitySuccessRatePct + 0.5 < prev.tradeParitySuccessRatePct
  ) {
    out.push(
      `parity_rate_down:${prev.tradeParitySuccessRatePct}->${cur.tradeParitySuccessRatePct}`,
    );
  }
  if (cur.shadowReadMismatches > prev.shadowReadMismatches) {
    out.push(`shadow_mismatches_up:${prev.shadowReadMismatches}->${cur.shadowReadMismatches}`);
  }
  return out;
}

export function buildDailyReadinessSummary(
  report: ReadinessReport,
  reportDay: string,
  prev: DailyReadinessSummary | null,
): DailyReadinessSummary {
  const base: DailyReadinessSummary = {
    reportDay,
    status: report.status,
    mirroredTrades: report.metrics.mirroredTrades,
    completedRoundTrips: report.metrics.completedMirroredRoundTrips,
    distinctTradingDays: report.metrics.distinctTradingDaysObserved,
    tradeParitySuccessRatePct: report.metrics.tradeParitySuccessRatePct,
    fillPriceParityRatePct: report.metrics.fillPriceParityRatePct,
    realizedPnlParityRatePct: report.metrics.realizedPnlParityRatePct,
    returnParityRatePct: report.metrics.returnParityRatePct,
    lifecycleParityRatePct: report.metrics.lifecycleParityRatePct,
    auditChainCompletenessRatePct: report.metrics.auditChainCompletenessRatePct,
    equityReconciliationRatePct: report.metrics.equityReconciliationRatePct,
    unresolvedCriticalFailures: report.metrics.unresolvedCriticalFailures,
    unresolvedParityFailures: report.metrics.unresolvedParityFailures,
    orphanCount: orphanTotal(report),
    duplicateCount: report.metrics.duplicateV2Mirrors,
    missingMarkCount: report.metrics.missingMarkCount,
    staleMarkCount: report.metrics.staleMarkCount,
    incompleteEquitySnapshotCount: report.metrics.incompleteEquitySnapshotCount,
    shadowReadEvents: report.shadowReadSummary.events,
    shadowReadMismatches: report.shadowReadSummary.mismatches,
    continuousHealthyParityMs: report.metrics.continuousHealthyParityMs,
    warnings: [...report.dataQualityWarnings],
    regressions: [],
    flags: report.flags,
    recommendedNextAction: report.recommendedNextAction,
    reachedControlledCutoverGate: report.status === "READY_FOR_CONTROLLED_CUTOVER",
  };
  base.regressions = detectRegressions(prev, base);
  if (base.regressions.length) {
    base.warnings.push(...base.regressions.map((r) => `regression:${r}`));
  }
  return base;
}

function tableReady(db: BrokerDb): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_readiness_daily_reports'`).get(),
  );
}

export function getDailyReadinessReport(
  db: BrokerDb,
  reportDay: string,
): { id: string; summary: DailyReadinessSummary; fullReport: ReadinessReport } | null {
  if (!tableReady(db)) return null;
  const row = db
    .prepare(`SELECT id, summary_json, report_json FROM broker_readiness_daily_reports WHERE report_day=?`)
    .get(reportDay) as { id: string; summary_json: string; report_json: string } | undefined;
  if (!row) return null;
  try {
    return {
      id: row.id,
      summary: JSON.parse(row.summary_json) as DailyReadinessSummary,
      fullReport: JSON.parse(row.report_json) as ReadinessReport,
    };
  } catch {
    return null;
  }
}

export function listDailyReadinessReports(
  db: BrokerDb,
  limit = 90,
): DailyReadinessSummary[] {
  if (!tableReady(db)) return [];
  const rows = (db
    .prepare(
      `SELECT summary_json FROM broker_readiness_daily_reports ORDER BY report_day DESC LIMIT ?`,
    )
    .all?.(limit) ?? []) as Array<{ summary_json: string }>;
  const out: DailyReadinessSummary[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.summary_json) as DailyReadinessSummary);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function buildSoakPeriodSummary(db: BrokerDb): SoakPeriodSummary {
  const reports = listDailyReadinessReports(db, 365).slice().reverse(); // ascending
  if (!reports.length) {
    return {
      reportCount: 0,
      firstReportDay: null,
      latestReportDay: null,
      soakCalendarDays: null,
      statusHistory: [],
      latestStatus: null,
      everReachedControlledCutoverGate: false,
      latestSummary: null,
      regressionDays: [],
    };
  }
  const first = reports[0].reportDay;
  const latest = reports[reports.length - 1].reportDay;
  const t0 = Date.parse(`${first}T12:00:00Z`);
  const t1 = Date.parse(`${latest}T12:00:00Z`);
  const soakCalendarDays =
    Number.isFinite(t0) && Number.isFinite(t1)
      ? Math.max(1, Math.round((t1 - t0) / 86_400_000) + 1)
      : reports.length;
  return {
    reportCount: reports.length,
    firstReportDay: first,
    latestReportDay: latest,
    soakCalendarDays,
    statusHistory: reports.map((r) => ({ day: r.reportDay, status: r.status })),
    latestStatus: reports[reports.length - 1].status,
    everReachedControlledCutoverGate: reports.some((r) => r.reachedControlledCutoverGate),
    latestSummary: reports[reports.length - 1],
    regressionDays: reports.filter((r) => r.regressions.length > 0).map((r) => r.reportDay),
  };
}

/**
 * Generate today's readiness report if not already stored.
 * Idempotent on (report_day). Never mutates financial history.
 */
export function generateDailyReadinessReportIfDue(
  db: BrokerDb,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): {
  created: boolean;
  reportDay: string;
  summary: DailyReadinessSummary | null;
  fullReport: ReadinessReport | null;
  readyForControlledCutoverEvidence: boolean;
} {
  const reportDay = etDayKey(nowMs);
  const existing = getDailyReadinessReport(db, reportDay);
  if (existing) {
    return {
      created: false,
      reportDay,
      summary: existing.summary,
      fullReport: existing.fullReport,
      readyForControlledCutoverEvidence: existing.summary.reachedControlledCutoverGate,
    };
  }

  const fullReport = evaluateBrokerV2Readiness(db, env, nowMs);
  const priorDays = listDailyReadinessReports(db, 2);
  const prev = priorDays.find((r) => r.reportDay < reportDay) ?? null;
  const summary = buildDailyReadinessSummary(fullReport, reportDay, prev);

  const id = brokerId("brdr");
  db.prepare(
    `INSERT INTO broker_readiness_daily_reports
      (id, report_day, status, summary_json, report_json, record_schema_version, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    reportDay,
    summary.status,
    JSON.stringify(summary),
    JSON.stringify(fullReport),
    BROKER_RECORD_SCHEMA_VERSION,
    nowMs,
  );

  appendAuditEvent(db, {
    eventKind: "READINESS_DAILY_REPORT",
    entityKind: "ACCOUNT",
    entityId: id,
    payload: {
      reportDay,
      status: summary.status,
      mirroredTrades: summary.mirroredTrades,
      unresolvedCriticalFailures: summary.unresolvedCriticalFailures,
      regressions: summary.regressions,
      reachedControlledCutoverGate: summary.reachedControlledCutoverGate,
      soak: true,
      cutoverPerformed: false,
    },
    createdAtMs: nowMs,
  });

  if (summary.reachedControlledCutoverGate) {
    console.warn(
      `[broker-soak] READY_FOR_CONTROLLED_CUTOVER on ${reportDay} — evidence package ready; do NOT auto-cutover`,
    );
    appendAuditEvent(db, {
      eventKind: "READINESS_CUTOVER_GATE_MET",
      entityKind: "ACCOUNT",
      entityId: id,
      payload: {
        reportDay,
        message: "Gate met — human approval required before any V2 read cutover",
        cutoverPerformed: false,
      },
      createdAtMs: nowMs,
    });
  }

  return {
    created: true,
    reportDay,
    summary,
    fullReport,
    readyForControlledCutoverEvidence: summary.reachedControlledCutoverGate,
  };
}

/** Scheduler entry — safe no-op when schema missing. */
export function runBrokerReadinessSoakJob(
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): ReturnType<typeof generateDailyReadinessReportIfDue> | { skipped: true; reason: string } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ensureBrokerSchemaOnDb } = require("./schema-migrate.ts");
  const db = getDb() as BrokerDb;
  ensureBrokerSchemaOnDb(db as never);
  if (!tableReady(db)) {
    return { skipped: true, reason: "broker_readiness_daily_reports_missing" };
  }
  return generateDailyReadinessReportIfDue(db, env, nowMs);
}
