import type { AiReportRow, ProposalRow } from "./store.ts";
import { listResearchQuestions, type ResearchQuestionDefinition } from "./research-question-registry.ts";
import type { MomentumDiagnosticRow } from "../momentum-diagnostics.ts";

export type FindingPipeline =
  | "INDEPENDENT_OPTIONS"
  | "SUPERVISOR_OPTIONS"
  | "STOCK_MOMENTUM"
  | "DELIVERED_ALERT_PAPER"
  | "ZERO_DTE_RESEARCH"
  | "SHADOW_REPLAY"
  | "LEGACY_AUDIT";

export type FindingClassification = "FACT" | "INFERENCE" | "RECOMMENDATION" | "DATA_QUALITY_WARNING";
export type MetricQuality =
  | "VALID"
  | "VALID_BUT_MISLEADING"
  | "STALE"
  | "PIPELINE_MIXED"
  | "DUPLICATED"
  | "UNIT_ERROR"
  | "TIMESTAMP_ERROR"
  | "MISSING_DATA"
  | "BROKEN_QUERY";
export type LatencyStatus = "VALID" | "MISSING" | "CLOCK_SKEW" | "CROSS_SESSION" | "LEGACY_UNIT_UNKNOWN" | "INVALID";
export type EvidenceConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface MetricEvidence {
  id: string;
  label: string;
  value: number | string | null;
  unit?: string;
  pipeline: FindingPipeline;
  lane: string;
  timeWindow: string;
  sampleSize: number | null;
  confidence: EvidenceConfidence;
  freshness: string;
  source: {
    table: string;
    function: string;
    field: string;
  };
  qualityStatus: MetricQuality;
  safeForTopLine: boolean;
  meaning: string;
  whyItMatters: string;
  better: "higher" | "lower" | "neutral";
}

export interface Finding {
  id: string;
  title: string;
  summary: string;
  classification: FindingClassification;
  pipeline: FindingPipeline;
  severity: "positive" | "info" | "warning" | "critical";
  confidence: EvidenceConfidence;
  metricIds: string[];
  sourceRefs: string[];
  recommendedNextStep?: string;
}

export interface MissedOpportunitySummary {
  rawObservations: MetricEvidence;
  uniqueOpportunities: MetricEvidence;
  uniqueMeaningfulMisses: MetricEvidence;
  repeatedScans: MetricEvidence;
  blockedWinners: MetricEvidence;
  lateDiscoveries: MetricEvidence;
  examples: Array<{ fingerprint: string; symbol: string; count: number; reason: string; qualityStatus: MetricQuality }>;
}

export interface LatencyMetricSummary {
  id: string;
  label: string;
  metric: MetricEvidence;
  validCount: number;
  invalidCount: number;
  statuses: Record<LatencyStatus, number>;
}

export interface SidePerformance {
  side: "CALL" | "PUT";
  status: "VALID" | "NO_DATA";
  sampleSize: number;
  winRate: number | null;
  avgReturnPct: number | null;
  profitFactor: number | null;
  confidence: EvidenceConfidence;
  qualityStatus: MetricQuality;
}

export interface LinkedReadyToSent {
  ready: number;
  sent: number;
  ratePct: number | null;
  source: string;
  available: boolean;
}

export interface FixQueueItem {
  findingId: string;
  status:
    | "DATA_BUG"
    | "NEEDS_INVESTIGATION"
    | "READY_FOR_SHADOW"
    | "SHADOW_TESTING"
    | "READY_FOR_HUMAN_REVIEW"
    | "APPROVED"
    | "REJECTED"
    | "IMPLEMENTED"
    | "VALIDATING"
    | "ROLLED_BACK";
  title: string;
  explanation: string;
  evidenceWindow: string;
  sampleSize: number | null;
  currentBehavior: string;
  proposedBehavior: string;
  affectedCodeAreas: string[];
  testPlan: string;
  rollbackPlan: string;
  humanApprovalStatus: string;
}

export interface CanonicalFindingsReport {
  reportId: string;
  sourceReportId: number | null;
  generatedAtMs: number;
  tradingDay: string | null;
  reportVersion: number;
  overallState: string;
  overallConfidence: EvidenceConfidence;
  activeProductionPipeline: FindingPipeline;
  sourceReferences: string[];
  metrics: MetricEvidence[];
  topFindings: Finding[];
  workingFindings: Finding[];
  failingFindings: Finding[];
  dataQualityFindings: Finding[];
  missedOpportunities: MissedOpportunitySummary;
  timingFindings: LatencyMetricSummary[];
  entryFindings: Finding[];
  exitFindings: Finding[];
  discordFindings: Finding[];
  paperFindings: Finding[];
  callsVsPuts: {
    call: SidePerformance;
    put: SidePerformance;
    comparison: "CALL_BETTER" | "PUT_BETTER" | "NO_VALID_COMPARISON";
  };
  strategyFindings: Finding[];
  recommendedInvestigations: Finding[];
  fixQueue: FixQueueItem[];
  researchQuestionRegistry: ResearchQuestionDefinition[];
  narrative: {
    status: string | null;
    message: string;
  };
  dataGaps: string[];
  safety: {
    productionBehaviorChanged: false;
    aiAuthority: "ADVISORY_ONLY";
    liveBehaviorChangeSource: "HUMAN_REVIEWED_CODE_DEPLOYMENT_ONLY";
  };
}

export interface FindingsReportInput {
  nightlyReports: AiReportRow[];
  weeklyReports?: AiReportRow[];
  proposals?: ProposalRow[];
  jobFailures?: any[];
  latestMomentumDiagnostics?: MomentumDiagnosticRow[];
  linkedReadyToSent?: LinkedReadyToSent;
  nowMs?: number;
}

const REPORT_VERSION = 1;
const MS_2000 = 946_684_800_000;
const MAX_INTRADAY_LATENCY_MS = 8 * 60 * 60_000;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round1 = (n: number) => Math.round(n * 10) / 10;

function pct(num: number | null | undefined, den: number | null | undefined): number | null {
  if (!isNum(num) || !isNum(den) || den <= 0) return null;
  return round1((num / den) * 100);
}

function confidenceForSample(n: number | null | undefined, quality: MetricQuality = "VALID"): EvidenceConfidence {
  if (quality !== "VALID" && quality !== "VALID_BUT_MISLEADING") return "LOW";
  const sample = Number(n ?? 0);
  if (sample >= 30) return "HIGH";
  if (sample >= 10) return "MEDIUM";
  return "LOW";
}

function metric(input: Omit<MetricEvidence, "confidence"> & { confidence?: EvidenceConfidence }): MetricEvidence {
  return {
    ...input,
    confidence: input.confidence ?? confidenceForSample(input.sampleSize, input.qualityStatus),
  };
}

export function latencyStatus(startMs: unknown, endMs: unknown): { status: LatencyStatus; durationMs: number | null } {
  if (!isNum(startMs) || !isNum(endMs)) return { status: "MISSING", durationMs: null };
  const a = Number(startMs);
  const b = Number(endMs);
  if ((a < MS_2000 && b >= MS_2000) || (b < MS_2000 && a >= MS_2000)) return { status: "LEGACY_UNIT_UNKNOWN", durationMs: null };
  if (a < MS_2000 || b < MS_2000) return { status: "LEGACY_UNIT_UNKNOWN", durationMs: null };
  const d = b - a;
  if (d < 0) return { status: "CLOCK_SKEW", durationMs: null };
  if (d > MAX_INTRADAY_LATENCY_MS) return { status: "CROSS_SESSION", durationMs: null };
  return { status: "VALID", durationMs: d };
}

function median(xs: number[]): number | null {
  const vals = xs.filter(isNum).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
}

function summarizeLatency(
  id: string,
  label: string,
  rows: MomentumDiagnosticRow[],
  getStart: (r: MomentumDiagnosticRow) => unknown,
  getEnd: (r: MomentumDiagnosticRow) => unknown,
  field: string,
): LatencyMetricSummary {
  const statuses: Record<LatencyStatus, number> = {
    VALID: 0,
    MISSING: 0,
    CLOCK_SKEW: 0,
    CROSS_SESSION: 0,
    LEGACY_UNIT_UNKNOWN: 0,
    INVALID: 0,
  };
  const valid: number[] = [];
  for (const r of rows) {
    const res = latencyStatus(getStart(r), getEnd(r));
    statuses[res.status] += 1;
    if (res.status === "VALID" && res.durationMs != null) valid.push(res.durationMs);
  }
  const invalidCount = rows.length - valid.length;
  const quality: MetricQuality = invalidCount > 0 ? "TIMESTAMP_ERROR" : valid.length ? "VALID" : "MISSING_DATA";
  return {
    id,
    label,
    validCount: valid.length,
    invalidCount,
    statuses,
    metric: metric({
      id,
      label,
      value: median(valid),
      unit: "ms",
      pipeline: "STOCK_MOMENTUM",
      lane: "momentum_diagnostics",
      timeWindow: "latest nightly trading day",
      sampleSize: valid.length,
      freshness: "latest nightly report",
      source: { table: "momentum_diagnostics", function: "buildCanonicalFindingsReport", field },
      qualityStatus: quality,
      safeForTopLine: quality === "VALID",
      meaning: "Median duration after invalid, cross-session, mixed-unit, and clock-skew rows are excluded.",
      whyItMatters: "Latency should only influence health when the timestamps describe the same valid event window.",
      better: "lower",
    }),
  };
}

function directionForRow(r: MomentumDiagnosticRow): string {
  const raw = (r as any).direction ?? (r.movePct != null && Number(r.movePct) < 0 ? "bearish" : "bullish");
  return String(raw || "unknown").toLowerCase();
}

function bucketTime(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "unknown";
  return String(Math.floor(n / (10 * 60_000)));
}

export function missedOpportunityFingerprint(row: MomentumDiagnosticRow): string {
  return [
    String(row.ticker ?? "").toUpperCase(),
    String(row.tradingDay ?? ""),
    directionForRow(row),
    String(row.classification ?? row.dominantReason ?? "unknown").toLowerCase(),
    bucketTime(row.firstSeenMs ?? row.evalAtMs ?? row.createdAtMs),
  ].join("|");
}

function summarizeMissed(rows: MomentumDiagnosticRow[], tradingDay: string | null): MissedOpportunitySummary {
  const missed = rows.filter((r) => r.decision === "NEAR_MISS" || r.decision === "REJECTED");
  const groups = new Map<string, MomentumDiagnosticRow[]>();
  for (const row of missed) {
    const key = missedOpportunityFingerprint(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const uniqueRows = [...groups.entries()];
  const meaningful = uniqueRows.filter(([, rs]) => rs.some((r) =>
    Math.abs(Number(r.movePct ?? r.firstPromotedMovePct ?? r.firstRankedMovePct ?? 0)) >= 3
    || /winner|target|HIT/i.test(String(r.reason ?? r.dominantReason ?? r.classification ?? "")),
  ));
  const late = uniqueRows.filter(([, rs]) => rs.some((r) =>
    /late|exhaust|extended|chase/i.test(String(r.reason ?? r.classification ?? r.dominantReason ?? ""))
    || Math.abs(Number(r.firstRankedMovePct ?? r.firstPromotedMovePct ?? 0)) >= 6,
  ));
  const blockedWinners = uniqueRows.filter(([, rs]) => rs.some((r) =>
    /winner|target|HIT|would.*win|blocked.*win/i.test(String(r.reason ?? r.dominantReason ?? r.classification ?? "")),
  ));
  const repeated = missed.length - uniqueRows.length;
  const window = tradingDay ?? "latest nightly trading day";
  const base = {
    pipeline: "STOCK_MOMENTUM" as const,
    lane: "momentum_diagnostics",
    timeWindow: window,
    freshness: "latest nightly report",
    source: { table: "momentum_diagnostics", function: "summarizeMissed", field: "decision/reason/ticker/trading_day" },
  };
  return {
    rawObservations: metric({
      id: "missed.raw_observations",
      label: "Raw missed observations",
      value: missed.length,
      sampleSize: missed.length,
      ...base,
      qualityStatus: missed.length > uniqueRows.length ? "DUPLICATED" : "VALID",
      safeForTopLine: false,
      meaning: "Every persisted near-miss/rejected scan observation.",
      whyItMatters: "This is useful for diagnostics but can count the same setup many times.",
      better: "lower",
    }),
    uniqueOpportunities: metric({
      id: "missed.unique_opportunities",
      label: "Unique missed opportunities",
      value: uniqueRows.length,
      sampleSize: uniqueRows.length,
      ...base,
      qualityStatus: "VALID",
      safeForTopLine: true,
      meaning: "Missed observations deduplicated by symbol, day, direction, setup family, and trigger window.",
      whyItMatters: "This is the count that should be used in top-line AI Advisory.",
      better: "lower",
    }),
    uniqueMeaningfulMisses: metric({
      id: "missed.unique_meaningful_misses",
      label: "Unique meaningful misses",
      value: meaningful.length,
      sampleSize: meaningful.length,
      ...base,
      qualityStatus: "VALID",
      safeForTopLine: true,
      meaning: "Unique misses with meaningful movement or winner language in diagnostics.",
      whyItMatters: "This narrows raw scanner noise to setups worth reviewing.",
      better: "lower",
    }),
    repeatedScans: metric({
      id: "missed.repeated_scans",
      label: "Repeated scans",
      value: repeated,
      sampleSize: missed.length,
      ...base,
      qualityStatus: repeated > 0 ? "DUPLICATED" : "VALID",
      safeForTopLine: false,
      meaning: "Raw observations minus unique opportunity fingerprints.",
      whyItMatters: "Repeated scans explain inflated missed-runner totals.",
      better: "lower",
    }),
    blockedWinners: metric({
      id: "missed.blocked_winners",
      label: "Blocked winners",
      value: blockedWinners.length,
      sampleSize: uniqueRows.length,
      ...base,
      qualityStatus: blockedWinners.length ? "VALID_BUT_MISLEADING" : "MISSING_DATA",
      safeForTopLine: false,
      meaning: "Unique misses explicitly tagged as winners by available diagnostics.",
      whyItMatters: "This requires richer outcome linkage before it can drive a rule change.",
      better: "lower",
    }),
    lateDiscoveries: metric({
      id: "missed.late_discoveries",
      label: "Late discoveries",
      value: late.length,
      sampleSize: uniqueRows.length,
      ...base,
      qualityStatus: "VALID",
      safeForTopLine: true,
      meaning: "Unique misses that were already late, extended, exhausted, or large by first ranking/promotion.",
      whyItMatters: "Late discovery is an investigation target distinct from bad delivery.",
      better: "lower",
    }),
    examples: uniqueRows.slice(0, 8).map(([fingerprint, rs]) => ({
      fingerprint,
      symbol: String(rs[0]?.ticker ?? ""),
      count: rs.length,
      reason: String(rs[0]?.reason ?? rs[0]?.dominantReason ?? rs[0]?.classification ?? "not recorded"),
      qualityStatus: rs.length > 1 ? "DUPLICATED" : "VALID",
    })),
  };
}

function sidePerformance(side: "CALL" | "PUT", bucket: any): SidePerformance {
  const n = Number(bucket?.n ?? 0);
  if (!n) {
    return { side, status: "NO_DATA", sampleSize: 0, winRate: null, avgReturnPct: null, profitFactor: null, confidence: "LOW", qualityStatus: "MISSING_DATA" };
  }
  return {
    side,
    status: "VALID",
    sampleSize: n,
    winRate: isNum(bucket?.winRate) ? bucket.winRate : null,
    avgReturnPct: isNum(bucket?.avgReturnPct) ? bucket.avgReturnPct : null,
    profitFactor: isNum(bucket?.profitFactor) ? bucket.profitFactor : null,
    confidence: confidenceForSample(n),
    qualityStatus: "VALID",
  };
}

function canonicalProfitFactor(summary: any): MetricEvidence {
  const overall = summary?.overall ?? {};
  const n = Number(summary?.counts?.outcomesGraded ?? overall.n ?? 0);
  const value = isNum(overall.profitFactor) ? overall.profitFactor : null;
  return metric({
    id: "paper.profit_factor",
    label: "Canonical profit factor",
    value,
    pipeline: "DELIVERED_ALERT_PAPER",
    lane: "overall",
    timeWindow: summary?.tradingDay ?? "latest nightly trading day",
    sampleSize: n,
    freshness: "latest nightly report",
    source: { table: "ai_reports.summary_json", function: "buildNightlySummary", field: "overall.profitFactor" },
    qualityStatus: value == null ? "MISSING_DATA" : "VALID",
    safeForTopLine: value != null,
    meaning: "Gross winning return divided by gross losing return for the canonical delivered-alert paper lane.",
    whyItMatters: "Profit factor must come from one lane/window so the UI does not show n/a and a number for the same scope.",
    better: "higher",
  });
}

function worstSessionBucket(summary: any): { label: string; n: number; winRate: number | null; avgReturnPct: number | null } | null {
  const buckets = summary?.byTimeOfDay ?? summary?.sessions ?? null;
  if (!buckets || typeof buckets !== "object") return null;
  const rows = Object.entries(buckets)
    .map(([label, raw]: [string, any]) => ({
      label,
      n: Number(raw?.n ?? raw?.count ?? 0),
      winRate: isNum(raw?.winRate) ? Number(raw.winRate) : null,
      avgReturnPct: isNum(raw?.avgReturnPct) ? Number(raw.avgReturnPct) : null,
    }))
    .filter((row) => row.n > 0 && (row.avgReturnPct != null || row.winRate != null));
  if (!rows.length) return null;
  return rows.sort((a, b) => {
    const aScore = a.avgReturnPct ?? a.winRate ?? 0;
    const bScore = b.avgReturnPct ?? b.winRate ?? 0;
    return aScore - bScore;
  })[0] ?? null;
}

function aiValidationFailureCount(jobFailures: any[] | undefined, latest: AiReportRow | null): number {
  const jobCount = (jobFailures ?? []).filter((job) => /validation|schema|anti[-_ ]?fabrication/i.test([
    job?.status,
    job?.errorCategory,
    job?.error_category,
    job?.stage,
    job?.diagnostic,
    job?.message,
  ].map((v) => typeof v === "string" ? v : JSON.stringify(v ?? "")).join(" "))).length;
  const reportCount = latest?.narrativeStatus && latest.narrativeStatus !== "OK" ? 1 : 0;
  return jobCount + reportCount;
}

function linkedReadyMetric(linked: LinkedReadyToSent | null, tradingDay: string | null): MetricEvidence {
  return metric({
    id: "independent.ready_to_sent",
    label: "READY -> SENT linked cohort",
    value: linked?.ratePct ?? null,
    unit: "%",
    pipeline: "INDEPENDENT_OPTIONS",
    lane: "options_candidates_to_options_alerts",
    timeWindow: tradingDay ?? "latest nightly trading day",
    sampleSize: linked?.ready ?? 0,
    freshness: "live database read model",
    source: { table: "options_candidates/options_alerts/options_delivery_decisions", function: "linkedReadyToSentOnDb", field: "same candidate/opportunity identity" },
    qualityStatus: linked?.available ? "VALID" : "MISSING_DATA",
    safeForTopLine: Boolean(linked?.available),
    meaning: "Share of READY independent options candidates that can be linked to a SENT alert for the same opportunity identity.",
    whyItMatters: "This replaces unrelated READY and SENT totals with a real cohort conversion.",
    better: "higher",
  });
}

function makeFinding(
  id: string,
  title: string,
  summary: string,
  classification: FindingClassification,
  pipeline: FindingPipeline,
  severity: Finding["severity"],
  confidence: EvidenceConfidence,
  metricIds: string[],
  sourceRefs: string[],
  recommendedNextStep?: string,
): Finding {
  return { id, title, summary, classification, pipeline, severity, confidence, metricIds, sourceRefs, recommendedNextStep };
}

export function buildCanonicalFindingsReport(input: FindingsReportInput): CanonicalFindingsReport {
  const nowMs = input.nowMs ?? Date.now();
  const latest = input.nightlyReports[0] ?? null;
  const summary = latest?.summary ?? {};
  const tradingDay = latest?.periodKey ?? summary?.tradingDay ?? null;
  const rows = input.latestMomentumDiagnostics ?? [];
  const graded = Number(summary?.counts?.outcomesGraded ?? summary?.overall?.n ?? 0);
  const winRate = isNum(summary?.overall?.winRate) ? summary.overall.winRate : null;
  const avgReturn = isNum(summary?.overall?.avgReturnPct) ? summary.overall.avgReturnPct : null;
  const activeProductionPipeline: FindingPipeline = "INDEPENDENT_OPTIONS";

  const missed = summarizeMissed(rows, tradingDay);
  const discoveryLatency = summarizeLatency(
    "timing.discovery_delay_ms",
    "Discovery delay",
    rows,
    (r) => r.firstSeenMs,
    (r) => r.firstRankedMs,
    "first_seen_ms -> first_ranked_ms",
  );
  const discoveryToAlert = summarizeLatency(
    "timing.discovery_to_alert_ms",
    "Discovery -> alert",
    rows,
    (r) => r.firstSeenMs,
    (r) => r.discordDeliveredMs,
    "first_seen_ms -> discord_delivered_ms",
  );
  const pf = canonicalProfitFactor({ ...summary, tradingDay });
  const readySent = linkedReadyMetric(input.linkedReadyToSent ?? null, tradingDay);
  const call = sidePerformance("CALL", summary?.callsVsPuts?.call);
  const put = sidePerformance("PUT", summary?.callsVsPuts?.put);
  const falsePositiveRate = pct(summary?.overall?.losses ?? null, graded);
  const stopRate = pct(summary?.realizedGrade?.LOSS ?? summary?.overall?.losses ?? null, graded);
  const t1Rate = pct(summary?.realizedGrade?.T1 ?? summary?.realizedGrade?.TARGET_1 ?? null, graded);
  const worstSession = worstSessionBucket(summary);
  const validationFailures = aiValidationFailureCount(input.jobFailures, latest);

  const metrics: MetricEvidence[] = [
    metric({
      id: "paper.win_rate",
      label: "Win rate",
      value: winRate,
      unit: "%",
      pipeline: "DELIVERED_ALERT_PAPER",
      lane: "overall",
      timeWindow: tradingDay ?? "latest nightly trading day",
      sampleSize: graded,
      freshness: "latest nightly report",
      source: { table: "ai_reports.summary_json", function: "buildNightlySummary", field: "overall.winRate" },
      qualityStatus: graded > 0 ? "VALID" : "MISSING_DATA",
      safeForTopLine: graded >= 10,
      meaning: graded ? `${Math.round((Number(winRate ?? 0) / 100) * graded)} of ${graded} graded outcomes won under the current grading convention.` : "No graded outcomes are available.",
      whyItMatters: "Win rate is useful only with enough delivered-alert paper outcomes.",
      better: "higher",
    }),
    metric({
      id: "paper.avg_return_pct",
      label: "Average return",
      value: avgReturn,
      unit: "%",
      pipeline: "DELIVERED_ALERT_PAPER",
      lane: "overall",
      timeWindow: tradingDay ?? "latest nightly trading day",
      sampleSize: graded,
      freshness: "latest nightly report",
      source: { table: "ai_reports.summary_json", function: "buildNightlySummary", field: "overall.avgReturnPct" },
      qualityStatus: isNum(avgReturn) ? "VALID" : "MISSING_DATA",
      safeForTopLine: graded >= 10 && isNum(avgReturn),
      meaning: "Average return across graded delivered-alert paper outcomes.",
      whyItMatters: "Return can conflict with win rate when stops or large losses dominate.",
      better: "higher",
    }),
    metric({
      id: "paper.false_positive_rate",
      label: "False positive rate",
      value: falsePositiveRate,
      unit: "%",
      pipeline: "DELIVERED_ALERT_PAPER",
      lane: "overall",
      timeWindow: tradingDay ?? "latest nightly trading day",
      sampleSize: graded,
      freshness: "latest nightly report",
      source: { table: "ai_reports.summary_json", function: "buildNightlySummary", field: "overall.losses/counts.outcomesGraded" },
      qualityStatus: isNum(falsePositiveRate) ? "VALID" : "MISSING_DATA",
      safeForTopLine: graded >= 10 && isNum(falsePositiveRate),
      meaning: isNum(falsePositiveRate) ? `${summary?.overall?.losses ?? 0} of ${graded} graded outcomes lost.` : "No loss-rate denominator is available.",
      whyItMatters: "High false positives mean alerts are not converting under current grading.",
      better: "lower",
    }),
    metric({
      id: "paper.stop_rate",
      label: "Stop rate",
      value: stopRate,
      unit: "%",
      pipeline: "DELIVERED_ALERT_PAPER",
      lane: "exit",
      timeWindow: tradingDay ?? "latest nightly trading day",
      sampleSize: graded,
      freshness: "latest nightly report",
      source: { table: "ai_reports.summary_json", function: "buildNightlySummary", field: "realizedGrade/overall.losses" },
      qualityStatus: isNum(stopRate) ? "VALID_BUT_MISLEADING" : "MISSING_DATA",
      safeForTopLine: false,
      meaning: "Approximate stop/loss share from available nightly grade fields.",
      whyItMatters: "High stop rate needs lifecycle-grade details before changing entry or exit rules.",
      better: "lower",
    }),
    metric({
      id: "paper.t1_rate",
      label: "T1 rate",
      value: t1Rate,
      unit: "%",
      pipeline: "DELIVERED_ALERT_PAPER",
      lane: "exit",
      timeWindow: tradingDay ?? "latest nightly trading day",
      sampleSize: graded,
      freshness: "latest nightly report",
      source: { table: "ai_reports.summary_json", function: "buildNightlySummary", field: "realizedGrade.T1" },
      qualityStatus: isNum(t1Rate) ? "VALID" : "MISSING_DATA",
      safeForTopLine: false,
      meaning: "Share of graded outcomes that reached first target when the nightly summary stores that grade.",
      whyItMatters: "Low T1 rate points to either entry timing, target distance, or setup quality.",
      better: "higher",
    }),
    missed.rawObservations,
    missed.uniqueOpportunities,
    missed.uniqueMeaningfulMisses,
    missed.repeatedScans,
    missed.blockedWinners,
    missed.lateDiscoveries,
    discoveryLatency.metric,
    discoveryToAlert.metric,
    pf,
    readySent,
  ];

  const dataQualityFindings: Finding[] = [];
  if (missed.repeatedScans.value && Number(missed.repeatedScans.value) > 0) {
    dataQualityFindings.push(makeFinding(
      "duplicated-missed-runner-observations",
      "Missed-runner observations were inflated by repeat scans",
      `${missed.rawObservations.value} raw observations collapse to ${missed.uniqueOpportunities.value} unique opportunity fingerprints.`,
      "DATA_QUALITY_WARNING",
      "STOCK_MOMENTUM",
      "warning",
      "HIGH",
      ["missed.raw_observations", "missed.unique_opportunities", "missed.repeated_scans"],
      ["momentum_diagnostics"],
      "Use unique opportunity counts in top-line AI Advisory and keep raw observations in Advanced.",
    ));
  }
  if (discoveryLatency.invalidCount || discoveryToAlert.invalidCount) {
    dataQualityFindings.push(makeFinding(
      "invalid-latency-values",
      "Latency fields contain invalid timestamps",
      `${discoveryLatency.invalidCount + discoveryToAlert.invalidCount} timing observation(s) were excluded because they were missing, negative, mixed-unit, or cross-session.`,
      "DATA_QUALITY_WARNING",
      "STOCK_MOMENTUM",
      "critical",
      "HIGH",
      ["timing.discovery_delay_ms", "timing.discovery_to_alert_ms"],
      ["momentum_diagnostics"],
      "Normalize timestamp units and store validity flags before latency affects health grades.",
    ));
  }
  if (summary?.options?.configBlockedCycles > 0) {
    dataQualityFindings.push(makeFinding(
      "inactive-supervisor-contamination",
      "Inactive supervisor delivery cannot drive the active production diagnosis",
      `Supervisor options reported ${summary.options.configBlockedCycles} config-blocked cycle(s), but the active production owner path is ${activeProductionPipeline}.`,
      "DATA_QUALITY_WARNING",
      "SUPERVISOR_OPTIONS",
      "warning",
      "HIGH",
      [],
      ["ai_reports.summary_json.options"],
      "Keep supervisor config blocks under diagnostics unless that pipeline is the active owner path.",
    ));
  }
  if (pf.qualityStatus === "MISSING_DATA") {
    dataQualityFindings.push(makeFinding(
      "canonical-profit-factor-missing",
      "Profit factor has no canonical nightly source",
      "The canonical delivered-alert paper lane does not store gross win/loss profit factor for this report.",
      "DATA_QUALITY_WARNING",
      "DELIVERED_ALERT_PAPER",
      "warning",
      "HIGH",
      ["paper.profit_factor"],
      ["ai_reports.summary_json.overall"],
      "Store one canonical profit-factor value per lane/window and stop showing bucket-specific PF as top-line evidence.",
    ));
  }
  if (put.status === "NO_DATA" || call.status === "NO_DATA") {
    dataQualityFindings.push(makeFinding(
      "calls-puts-no-valid-comparison",
      "Calls and puts cannot be compared yet",
      `Call sample n=${call.sampleSize}; put sample n=${put.sampleSize}. Missing sides remain NO DATA, not zero.`,
      "DATA_QUALITY_WARNING",
      "DELIVERED_ALERT_PAPER",
      "warning",
      "HIGH",
      [],
      ["ai_reports.summary_json.callsVsPuts"],
      "Collect enough delivered call and put outcomes before presenting a directional comparison.",
    ));
  }
  if (validationFailures > 0) {
    dataQualityFindings.push(makeFinding(
      "ai-validation-failures",
      "AI narrative validation failed",
      `${validationFailures} AI narrative validation failure signal(s) were found; deterministic findings remain available and canonical.`,
      "DATA_QUALITY_WARNING",
      "DELIVERED_ALERT_PAPER",
      "warning",
      "HIGH",
      [],
      ["ai_reports.narrative_status", "ai_job_runs"],
      "Keep AI text advisory-only and render deterministic findings even when model output fails validation.",
    ));
  }

  const failingFindings: Finding[] = [];
  if (graded > 0 && graded < 10) {
    failingFindings.push(makeFinding(
      "low-graded-sample",
      "Low graded sample",
      `Only ${graded} graded nightly outcome(s) are available, so percentages should not drive production rule changes.`,
      "FACT",
      "DELIVERED_ALERT_PAPER",
      "warning",
      "HIGH",
      ["paper.win_rate", "paper.avg_return_pct"],
      ["ai_reports.summary_json.counts"],
      "Keep recommendations as investigations until sample size improves.",
    ));
  }
  if (winRate != null && winRate < 50) {
    failingFindings.push(makeFinding(
      "low-win-rate",
      "Win rate was weak",
      `Win rate was ${winRate}% over n=${graded}.`,
      "FACT",
      "DELIVERED_ALERT_PAPER",
      "warning",
      confidenceForSample(graded),
      ["paper.win_rate"],
      ["ai_reports.summary_json.overall"],
      "Review entry timing and exit lifecycle before changing formulas.",
    ));
  }
  if (avgReturn != null && avgReturn < 0) {
    failingFindings.push(makeFinding(
      "negative-average-return",
      "Average return was negative",
      `Average return was ${avgReturn}% over n=${graded}.`,
      "FACT",
      "DELIVERED_ALERT_PAPER",
      "warning",
      confidenceForSample(graded),
      ["paper.avg_return_pct"],
      ["ai_reports.summary_json.overall"],
      "Separate entry failures from exit-management failures in the next review.",
    ));
  }
  if (isNum(stopRate) && stopRate >= 50) {
    failingFindings.push(makeFinding(
      "high-stop-rate",
      "Stop/loss rate was high",
      `Approximate stop/loss rate was ${stopRate}% over n=${graded}.`,
      "INFERENCE",
      "DELIVERED_ALERT_PAPER",
      "warning",
      confidenceForSample(graded, "VALID_BUT_MISLEADING"),
      ["paper.stop_rate"],
      ["ai_reports.summary_json.realizedGrade"],
      "Audit lifecycle rows for exact stop/T1/T2 labels before changing targets.",
    ));
  }
  if (isNum(t1Rate) && t1Rate < 40) {
    failingFindings.push(makeFinding(
      "low-t1-rate",
      "T1 reach rate was low",
      `T1 rate was ${t1Rate}% over n=${graded}.`,
      "FACT",
      "DELIVERED_ALERT_PAPER",
      "warning",
      confidenceForSample(graded),
      ["paper.t1_rate"],
      ["ai_reports.summary_json.realizedGrade"],
      "Inspect entry quality and premium chase before changing target distances.",
    ));
  }
  if (worstSession && (Number(worstSession.avgReturnPct ?? 0) < 0 || Number(worstSession.winRate ?? 100) < 50)) {
    failingFindings.push(makeFinding(
      "session-underperformance",
      `${worstSession.label} underperformed`,
      `${worstSession.label} produced ${worstSession.avgReturnPct ?? "unknown"}% average return and ${worstSession.winRate ?? "unknown"}% win rate over n=${worstSession.n}.`,
      "FACT",
      "DELIVERED_ALERT_PAPER",
      "warning",
      confidenceForSample(worstSession.n),
      ["paper.avg_return_pct", "paper.win_rate"],
      ["ai_reports.summary_json.byTimeOfDay"],
      "Keep this as a session filter investigation until the shadow lane confirms it out of sample.",
    ));
  }

  const workingFindings: Finding[] = [];
  if (readySent.safeForTopLine && Number(readySent.value ?? 0) > 0) {
    workingFindings.push(makeFinding(
      "independent-ready-sent-linked",
      "Independent READY -> SENT cohort is linked",
      `${input.linkedReadyToSent?.sent ?? 0} of ${input.linkedReadyToSent?.ready ?? 0} READY candidates linked to SENT alerts.`,
      "FACT",
      "INDEPENDENT_OPTIONS",
      "positive",
      readySent.confidence,
      ["independent.ready_to_sent"],
      ["options_candidates", "options_alerts", "options_delivery_decisions"],
    ));
  }
  if (!workingFindings.length) {
    workingFindings.push(makeFinding(
      "deterministic-report-available",
      "Deterministic report is available",
      "The AI Advisory can render deterministic findings even when AI narration is unavailable.",
      "FACT",
      "DELIVERED_ALERT_PAPER",
      "info",
      "HIGH",
      [],
      ["ai_reports"],
    ));
  }

  const recommendedInvestigations: Finding[] = [
    ...dataQualityFindings.slice(0, 3).map((f) => ({ ...f, classification: "RECOMMENDATION" as const, severity: "info" as const })),
    ...failingFindings.slice(0, 2).map((f) => ({ ...f, classification: "RECOMMENDATION" as const, severity: "info" as const })),
  ].slice(0, 5);

  const topFindings = [
    ...dataQualityFindings.filter((f) => f.severity === "critical"),
    ...failingFindings,
    ...dataQualityFindings.filter((f) => f.severity !== "critical"),
    ...workingFindings,
  ].slice(0, 5);

  const lowSample = graded < 10;
  const overallConfidence: EvidenceConfidence = lowSample || dataQualityFindings.length ? "LOW" : confidenceForSample(graded);
  const overallState = dataQualityFindings.some((f) => f.severity === "critical")
    ? "DATA QUALITY REVIEW REQUIRED"
    : failingFindings.length
      ? "NEEDS INVESTIGATION"
      : "STABLE";

  const fixQueue: FixQueueItem[] = recommendedInvestigations.map((f) => ({
    findingId: f.id,
    status: f.classification === "DATA_QUALITY_WARNING" || f.id.includes("latency") || f.id.includes("profit") ? "DATA_BUG" : "NEEDS_INVESTIGATION",
    title: f.title,
    explanation: f.summary,
    evidenceWindow: tradingDay ?? "latest nightly report",
    sampleSize: metrics.find((m) => f.metricIds.includes(m.id))?.sampleSize ?? null,
    currentBehavior: "AI Advisory displays or derives the finding from raw deterministic tables.",
    proposedBehavior: "Use canonical, pipeline-labeled, quality-scored findings before advisory UI presentation.",
    affectedCodeAreas: ["lib/ai/findings-report.ts", "app/ai/page.tsx"],
    testPlan: "Add focused AI findings tests and keep full suite green.",
    rollbackPlan: "Revert AI Advisory read-model/UI changes only; live scanner and delivery paths are untouched.",
    humanApprovalStatus: "NOT_APPROVED_FOR_LIVE_LOGIC_CHANGE",
  }));

  return {
    reportId: latest ? `${latest.reportType}:${latest.id}` : "nightly:none",
    sourceReportId: latest?.id ?? null,
    generatedAtMs: nowMs,
    tradingDay,
    reportVersion: REPORT_VERSION,
    overallState,
    overallConfidence,
    activeProductionPipeline,
    sourceReferences: ["ai_reports", "momentum_diagnostics", "options_candidates", "options_alerts", "options_delivery_decisions"],
    metrics,
    topFindings,
    workingFindings,
    failingFindings,
    dataQualityFindings,
    missedOpportunities: missed,
    timingFindings: [discoveryLatency, discoveryToAlert],
    entryFindings: dataQualityFindings.filter((f) => /spread|entry|contract|quote/i.test(f.title + f.summary)),
    exitFindings: failingFindings.filter((f) => /stop|T1|exit|return/i.test(f.title + f.summary)),
    discordFindings: [readySent.safeForTopLine
      ? makeFinding("discord-linked-cohort", "Discord delivery cohort is linked", "READY -> SENT now uses linked opportunity identity.", "FACT", "INDEPENDENT_OPTIONS", "info", readySent.confidence, ["independent.ready_to_sent"], ["options_alerts"])
      : makeFinding("discord-linked-cohort-missing", "Discord delivery cohort needs linked data", "READY -> SENT cannot be trusted without linked candidate and SENT alert rows.", "DATA_QUALITY_WARNING", "INDEPENDENT_OPTIONS", "warning", "LOW", ["independent.ready_to_sent"], ["options_candidates", "options_alerts"])],
    paperFindings: failingFindings.filter((f) => f.pipeline === "DELIVERED_ALERT_PAPER"),
    callsVsPuts: {
      call,
      put,
      comparison: call.status !== "VALID" || put.status !== "VALID"
        ? "NO_VALID_COMPARISON"
        : Number(call.winRate ?? 0) > Number(put.winRate ?? 0)
          ? "CALL_BETTER"
          : Number(put.winRate ?? 0) > Number(call.winRate ?? 0)
            ? "PUT_BETTER"
            : "NO_VALID_COMPARISON",
    },
    strategyFindings: [],
    recommendedInvestigations,
    fixQueue,
    researchQuestionRegistry: listResearchQuestions(),
    narrative: {
      status: latest?.narrativeStatus ?? null,
      message: latest?.narrativeStatus === "OK"
        ? "AI narrative available; deterministic findings remain canonical."
        : "AI NARRATIVE UNAVAILABLE - DETERMINISTIC FINDINGS STILL VALID",
    },
    dataGaps: [
      ...(Array.isArray(summary?.dataGaps) ? summary.dataGaps : []),
      ...(lowSample ? [`low graded sample: n=${graded}`] : []),
      ...(dataQualityFindings.length ? dataQualityFindings.map((f) => f.title) : []),
    ],
    safety: {
      productionBehaviorChanged: false,
      aiAuthority: "ADVISORY_ONLY",
      liveBehaviorChangeSource: "HUMAN_REVIEWED_CODE_DEPLOYMENT_ONLY",
    },
  };
}

type ReportDb = {
  prepare: (sql: string) => { get: (...a: any[]) => any; all: (...a: any[]) => any[] };
};

function hasTable(db: ReportDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

export function linkedReadyToSentOnDb(db: ReportDb, startMs: number | null, endMs: number | null): LinkedReadyToSent {
  if (!hasTable(db, "options_candidates")) {
    return { ready: 0, sent: 0, ratePct: null, source: "options_candidates unavailable", available: false };
  }
  const start = startMs ?? 0;
  const end = endMs ?? Date.now();
  const candidates = db.prepare(
    `SELECT id, symbol, selected_strategy, side, state, created_at_ms
       FROM options_candidates
      WHERE state IN ('READY','SENT') AND created_at_ms >= ? AND created_at_ms < ?`,
  ).all(start, end) as any[];
  if (!candidates.length) {
    return { ready: 0, sent: 0, ratePct: null, source: "no READY candidates in window", available: false };
  }
  const alerts = hasTable(db, "options_alerts")
    ? db.prepare(
      `SELECT alert_id, candidate_symbol, strategy, side, state, created_at_ms, sent_at_ms
         FROM options_alerts
        WHERE state='SENT' AND created_at_ms >= ? AND created_at_ms < ?`,
    ).all(start - 15 * 60_000, end + 15 * 60_000) as any[]
    : [];
  const decisions = hasTable(db, "options_delivery_decisions")
    ? db.prepare(
      `SELECT alert_id, symbol, strategy, side, final_delivery_outcome, delivery_sent, created_at_ms
         FROM options_delivery_decisions
        WHERE created_at_ms >= ? AND created_at_ms < ?`,
    ).all(start - 15 * 60_000, end + 15 * 60_000) as any[]
    : [];
  let sent = 0;
  for (const c of candidates) {
    const cTime = Number(c.created_at_ms);
    const matches = (row: any) =>
      String(row.candidate_symbol ?? row.symbol ?? "").toUpperCase() === String(c.symbol ?? "").toUpperCase()
      && String(row.strategy ?? "") === String(c.selected_strategy ?? "")
      && String(row.side ?? "").toUpperCase() === String(c.side ?? "").toUpperCase()
      && Math.abs(Number(row.created_at_ms ?? 0) - cTime) <= 15 * 60_000;
    const alert = alerts.find(matches);
    const decision = decisions.find((d) =>
      (alert?.alert_id && d.alert_id === alert.alert_id) ||
      (matches(d) && (d.delivery_sent === 1 || d.final_delivery_outcome === "DELIVERED")),
    );
    if (String(c.state).toUpperCase() === "SENT" || alert || decision) sent += 1;
  }
  return {
    ready: candidates.length,
    sent,
    ratePct: pct(sent, candidates.length),
    source: "linked by candidate symbol/strategy/side/time window and alert/decision delivery proof",
    available: true,
  };
}
