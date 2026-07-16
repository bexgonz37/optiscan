/**
 * Deterministic Quant Research Dashboard read model.
 *
 * This module consumes stored reports, lessons, proposals, and diagnostic rows.
 * It never calls an AI provider, never writes to storage, and never affects the
 * live scanner. Missing source data is returned as null / "not recorded" rather
 * than inferred.
 */
import type { AiReportRow, LessonRow, ProposalRow } from "./store.ts";
import { weeklyQuantResearchContext } from "./quant-research.ts";
import type { MomentumDiagnosticRow } from "../momentum-diagnostics.ts";

type Tone = "bull" | "warn" | "bear" | "muted";

export interface QuantMetric {
  label: string;
  value: number | string | null;
  unit?: string;
  score: number | null;
  source: string;
  available: boolean;
}

export interface QuantTrend {
  value: number | null;
  label: string;
}

export interface ScannerHealth {
  score: number | null;
  grade: string;
  components: QuantMetric[];
  trendVsYesterday: QuantTrend;
  trendVsLastWeek: QuantTrend;
  trendVsLastMonth: QuantTrend;
}

export interface ReportCardMetric {
  label: string;
  value: number | string | null;
  unit?: string;
  source: string;
  tone: Tone;
}

export interface GateBreakdownRow {
  gate: string;
  count: number;
  pct: number | null;
  trend: QuantTrend;
  sampleExamples: string[];
  aiExplanation: string;
  source: string;
}

export interface MissedRunnerRow {
  ticker: string;
  timeMs: number | null;
  currentMovePct: number | null;
  peakMovePct: number | null;
  discoveryTimeMs: number | null;
  alertTimeMs: number | null;
  peakTimeMs: number | null;
  delayMs: number | null;
  reasonNotAlerted: string;
  responsibleGate: string;
  fixable: string;
  aiExplanation: string;
  source: string;
}

export interface StrategyScorecardRow {
  strategy: string;
  winRate: number | null;
  profitFactor: number | null;
  averageReturnPct: number | null;
  medianReturnPct: number | null;
  averageHoldTimeMs: number | null;
  opportunityGradeSuccess: number | null;
  falsePositivePct: number | null;
  missRate: number | null;
  trend: QuantTrend;
  healthGrade: string;
  aiSummary: string;
}

export interface ReadinessRequirement {
  label: string;
  value: number | null;
  target: string;
  passed: boolean | null;
  source: string;
}

export interface CopyTradingReadiness {
  score: number | null;
  grade: string;
  requirements: ReadinessRequirement[];
  aiExplanation: string;
}

export interface ResearchTopicRow {
  question: string;
  currentFormula: string;
  historicalFormula: string;
  challengerFormula: string;
  baseline: string;
  status: string;
  source: string;
}

export interface RecommendedExperimentRow {
  title: string;
  reason: string;
  supportingEvidence: string;
  expectedImprovement: string | null;
  confidence: string;
  risk: string | null;
  metricsAffected: string[];
  historicalSimulation: string;
  status: string;
}

export interface PortfolioComparisonRow {
  portfolio: string;
  equityCurve: string;
  returns: number | null;
  drawdown: number | null;
  winRate: number | null;
  profitFactor: number | null;
  largestWinner: number | null;
  largestLoser: number | null;
  opportunityGrade: number | null;
  strategyMix: string;
  capitalUsage: string;
}

export interface DailyAiSummary {
  scannerGrade: string;
  scannerHealth: number | null;
  missedFastMovers: number | null;
  lateAlerts: number | null;
  falsePositives: number | null;
  bestStrategy: string | null;
  worstStrategy: string | null;
  topRejectingGate: string | null;
  mostCommonFailure: string | null;
  mostImprovedMetric: string | null;
  mostRegressedMetric: string | null;
  recommendedExperiment: string | null;
  expectedImpact: string | null;
  confidence: string;
}

export interface ChartPoint {
  periodKey: string;
  value: number | null;
}

export interface QuantDashboard {
  scannerHealth: ScannerHealth;
  reportCard: ReportCardMetric[];
  gateBreakdown: GateBreakdownRow[];
  missedRunners: MissedRunnerRow[];
  strategyScorecards: StrategyScorecardRow[];
  copyTradingReadiness: CopyTradingReadiness;
  researchTopics: ResearchTopicRow[];
  recommendedExperiments: RecommendedExperimentRow[];
  portfolioComparison: PortfolioComparisonRow[];
  dailyAiSummary: DailyAiSummary;
  charts: Record<string, ChartPoint[]>;
  guardrails: string[];
  dataGaps: string[];
}

export interface QuantDashboardInput {
  nightlyReports: AiReportRow[];
  weeklyReports: AiReportRow[];
  lessons: LessonRow[];
  proposals: ProposalRow[];
  jobFailures: any[];
  latestMomentumDiagnostics?: MomentumDiagnosticRow[];
  env?: NodeJS.ProcessEnv;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

function pct(num: number | null | undefined, den: number | null | undefined): number | null {
  if (!isNum(num) || !isNum(den) || den <= 0) return null;
  return round1((num / den) * 100);
}

function gradeFor(score: number | null): string {
  if (!isNum(score)) return "N/A";
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 63) return "D";
  return "F";
}

function scoreAvg(values: Array<number | null>): number | null {
  const xs = values.filter(isNum);
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}

function trend(current: number | null, previous: number | null): QuantTrend {
  if (!isNum(current) || !isNum(previous)) return { value: null, label: "not enough deterministic history" };
  const delta = round1(current - previous);
  return { value: delta, label: `${delta >= 0 ? "+" : ""}${delta}` };
}

function latestSummary(reports: AiReportRow[]) {
  return reports[0]?.summary ?? null;
}

function healthScoreForSummary(summary: any): number | null {
  if (!summary) return null;
  const components = healthComponents(summary);
  return scoreAvg(components.map((m) => m.score));
}

function healthComponents(summary: any): QuantMetric[] {
  const totalMomentum = summary?.momentum?.total ?? null;
  const sentMomentum = summary?.momentum?.sent ?? null;
  const nearMisses = summary?.momentum?.nearMisses ?? summary?.counts?.nearMisses ?? null;
  const losses = summary?.overall?.losses ?? null;
  const graded = summary?.counts?.outcomesGraded ?? summary?.overall?.n ?? null;
  const missedRunnerRate = pct(nearMisses, isNum(totalMomentum) ? totalMomentum : (isNum(sentMomentum) || isNum(nearMisses)) ? Number(sentMomentum ?? 0) + Number(nearMisses ?? 0) : null);
  const falsePositiveRate = pct(losses, graded);
  const alertDelayMs = summary?.timing?.avgTriggerToDiscordMs ?? summary?.momentum?.avgLatencyMs ?? null;
  const opportunityCaptureRate = pct(summary?.options?.delivered ?? summary?.counts?.created ?? null, summary?.options?.canonical ?? summary?.counts?.candidates ?? null);
  const early = summary?.momentum?.earliness?.pctEarly ?? null;
  return [
    { label: "Early Alert Rate", value: early, unit: "%", score: isNum(early) ? clamp(early) : null, source: "summary.momentum.earliness.pctEarly", available: isNum(early) },
    { label: "Missed Runner Rate", value: missedRunnerRate, unit: "%", score: isNum(missedRunnerRate) ? clamp(100 - missedRunnerRate) : null, source: "summary.momentum.nearMisses / summary.momentum.total", available: isNum(missedRunnerRate) },
    { label: "False Positive Rate", value: falsePositiveRate, unit: "%", score: isNum(falsePositiveRate) ? clamp(100 - falsePositiveRate) : null, source: "summary.overall.losses / summary.counts.outcomesGraded", available: isNum(falsePositiveRate) },
    { label: "Signal Quality", value: summary?.overall?.opportunityHitRate ?? null, unit: "%", score: summary?.overall?.opportunityHitRate ?? null, source: "summary.overall.opportunityHitRate", available: isNum(summary?.overall?.opportunityHitRate) },
    { label: "Win Rate", value: summary?.overall?.winRate ?? null, unit: "%", score: summary?.overall?.winRate ?? null, source: "summary.overall.winRate", available: isNum(summary?.overall?.winRate) },
    { label: "Profit Factor", value: null, score: null, source: "not stored in nightly summary", available: false },
    { label: "Average Alert Delay", value: alertDelayMs, unit: "ms", score: isNum(alertDelayMs) ? clamp(100 - alertDelayMs / 600) : null, source: "summary.timing.avgTriggerToDiscordMs or summary.momentum.avgLatencyMs", available: isNum(alertDelayMs) },
    { label: "Opportunity Capture Rate", value: opportunityCaptureRate, unit: "%", score: opportunityCaptureRate, source: "summary.options.delivered / summary.options.canonical", available: isNum(opportunityCaptureRate) },
    { label: "Opportunity Grade Success", value: summary?.overall?.opportunityHitRate ?? null, unit: "%", score: summary?.overall?.opportunityHitRate ?? null, source: "summary.overall.opportunityHitRate", available: isNum(summary?.overall?.opportunityHitRate) },
  ];
}

function scannerHealth(reports: AiReportRow[]): ScannerHealth {
  const summary = latestSummary(reports);
  const components = healthComponents(summary);
  const score = scoreAvg(components.map((m) => m.score));
  return {
    score,
    grade: gradeFor(score),
    components,
    trendVsYesterday: trend(score, healthScoreForSummary(reports[1]?.summary)),
    trendVsLastWeek: trend(score, healthScoreForSummary(reports[6]?.summary)),
    trendVsLastMonth: trend(score, healthScoreForSummary(reports[29]?.summary)),
  };
}

function toneForBadCount(n: unknown): Tone {
  return isNum(n) && n > 0 ? "warn" : "bull";
}

function reportCard(summary: any, jobFailures: any[]): ReportCardMetric[] {
  const e = summary?.momentum?.earliness ?? null;
  return [
    { label: "Missed Fast Movers", value: summary?.momentum?.nearMisses ?? summary?.counts?.nearMisses ?? null, source: "summary.momentum.nearMisses", tone: toneForBadCount(summary?.momentum?.nearMisses ?? summary?.counts?.nearMisses) },
    { label: "Late Alerts", value: summary?.counts?.lateCallouts ?? e?.counts?.LATE ?? null, source: "summary.counts.lateCallouts or summary.momentum.earliness.counts.LATE", tone: toneForBadCount(summary?.counts?.lateCallouts ?? e?.counts?.LATE) },
    { label: "False Positives", value: summary?.overall?.losses ?? null, source: "summary.overall.losses", tone: toneForBadCount(summary?.overall?.losses) },
    { label: "Rejected Good Setups", value: summary?.signalCorrectExitFailed ?? null, source: "summary.signalCorrectExitFailed", tone: toneForBadCount(summary?.signalCorrectExitFailed) },
    { label: "Early Alert %", value: e?.pctEarly ?? null, unit: "%", source: "summary.momentum.earliness.pctEarly", tone: "bull" },
    { label: "Average Alert Delay", value: summary?.timing?.avgTriggerToDiscordMs ?? summary?.momentum?.avgLatencyMs ?? null, unit: "ms", source: "summary.timing.avgTriggerToDiscordMs or summary.momentum.avgLatencyMs", tone: "muted" },
    { label: "Average Discovery Delay", value: summary?.momentum?.medianDiscoveryLatencyMs ?? null, unit: "ms", source: "summary.momentum.medianDiscoveryLatencyMs", tone: "muted" },
    { label: "Average Time: Discovery -> Alert", value: summary?.momentum?.medianDiscordLatencyMs ?? null, unit: "ms", source: "summary.momentum.medianDiscordLatencyMs", tone: "muted" },
    { label: "Average Time: Alert -> Peak", value: null, unit: "ms", source: "not yet stored", tone: "muted" },
    { label: "Average Time: Peak -> Exhaustion", value: null, unit: "ms", source: "not yet stored", tone: "muted" },
    { label: "Average Quote Freshness", value: null, unit: "ms", source: "not aggregated in nightly summary", tone: "muted" },
    { label: "Average Option Quote Freshness", value: null, unit: "ms", source: "not aggregated in nightly summary", tone: "muted" },
    { label: "Average Chain Age", value: null, unit: "ms", source: "not aggregated in nightly summary", tone: "muted" },
    { label: "Provider Errors", value: jobFailures.length, source: "ai_job_runs recent failures", tone: toneForBadCount(jobFailures.length) },
    { label: "Missing Data Events", value: Array.isArray(summary?.dataGaps) ? summary.dataGaps.length : null, source: "summary.dataGaps", tone: toneForBadCount(Array.isArray(summary?.dataGaps) ? summary.dataGaps.length : null) },
    { label: "Top Issue", value: summary?.prioritizedIssue ?? "none", source: "summary.prioritizedIssue", tone: summary?.prioritizedIssue ? "warn" : "bull" },
    { label: "Confidence", value: confidenceForSummary(summary), source: "sample size + data gaps", tone: "muted" },
  ];
}

function confidenceForSummary(summary: any): string {
  const graded = Number(summary?.counts?.outcomesGraded ?? 0);
  const gaps = Array.isArray(summary?.dataGaps) ? summary.dataGaps.length : 0;
  if (graded >= 30 && gaps === 0) return "HIGH";
  if (graded >= 10 && gaps <= 2) return "MEDIUM";
  return "LOW";
}

function normalizeGate(name: string): string {
  const s = name.toLowerCase();
  if (/rank|discovery/.test(s)) return "Discovery Ranking";
  if (/vwap|extended|chase/.test(s)) return "VWAP Extension";
  if (/liquid/.test(s)) return "Liquidity";
  if (/spread/.test(s)) return "Spread";
  if (/accel|momentum|velocity|fast/.test(s)) return "Acceleration";
  if (/volume|rel.?vol/.test(s)) return "Volume";
  if (/cooldown/.test(s)) return "Cooldown";
  if (/duplicate|dedup/.test(s)) return "Duplicate";
  if (/quote|stale|fresh/.test(s)) return "Quote Freshness";
  if (/chain/.test(s)) return "Chain Freshness";
  if (/option|contract|occ|strike|expiration/.test(s)) return "Options Selection";
  if (/probability|model/.test(s)) return "Probability";
  if (/risk/.test(s)) return "Risk";
  return name || "Unspecified";
}

function gateBreakdown(reports: AiReportRow[], latestMomentum: MomentumDiagnosticRow[]): GateBreakdownRow[] {
  const latest = reports[0]?.summary ?? {};
  const prev = reports[1]?.summary ?? {};
  const counts = new Map<string, { count: number; samples: string[]; source: string }>();
  const add = (gate: string, count: number, sample: string, source: string) => {
    if (!Number.isFinite(count) || count <= 0) return;
    const key = normalizeGate(gate);
    const cur = counts.get(key) ?? { count: 0, samples: [], source };
    cur.count += count;
    if (sample && cur.samples.length < 3) cur.samples.push(sample);
    counts.set(key, cur);
  };
  for (const [reason, count] of Object.entries(latest.rejectionReasons ?? {})) add(reason, Number(count), reason, "summary.rejectionReasons");
  for (const [reason, count] of Object.entries(latest.waitWatchReasons ?? {})) add(reason, Number(count), reason, "summary.waitWatchReasons");
  if (latest.options?.configBlockedCycles) add(latest.options.topDeliveryGateReason ?? "Options delivery", latest.options.configBlockedCycles, latest.options.diagnosis ?? "options delivery gate", "summary.options");
  if (latest.momentum?.extendedRejections) add("VWAP Extension", latest.momentum.extendedRejections, "extended momentum rejection", "summary.momentum.extendedRejections");
  if (latest.momentum?.staleRejected) add("Quote Freshness", latest.momentum.staleRejected, "stale quote rejection", "summary.momentum.staleRejected");
  for (const row of latestMomentum.filter((r) => r.decision === "NEAR_MISS" || r.decision === "REJECTED").slice(0, 50)) {
    add(row.reason ?? row.dominantReason ?? row.classification ?? "Momentum gate", 1, `${row.ticker}: ${row.reason ?? row.classification ?? "blocked"}`, "momentum_diagnostics");
  }
  const total = [...counts.values()].reduce((a, c) => a + c.count, 0);
  return [...counts.entries()]
    .map(([gate, row]) => {
      const prevCount = previousGateCount(prev, gate);
      return {
        gate,
        count: row.count,
        pct: pct(row.count, total),
        trend: trend(row.count, prevCount),
        sampleExamples: row.samples,
        aiExplanation: `${row.count} deterministic rejection/event(s) map to ${gate}. Evidence source: ${row.source}.`,
        source: row.source,
      };
    })
    .sort((a, b) => b.count - a.count);
}

function previousGateCount(summary: any, gate: string): number | null {
  let total = 0;
  for (const [reason, count] of Object.entries(summary?.rejectionReasons ?? {})) {
    if (normalizeGate(reason) === gate) total += Number(count);
  }
  for (const [reason, count] of Object.entries(summary?.waitWatchReasons ?? {})) {
    if (normalizeGate(reason) === gate) total += Number(count);
  }
  if (gate === "VWAP Extension") total += Number(summary?.momentum?.extendedRejections ?? 0);
  if (gate === "Quote Freshness") total += Number(summary?.momentum?.staleRejected ?? 0);
  return total || null;
}

function missedRunners(rows: MomentumDiagnosticRow[]): MissedRunnerRow[] {
  return rows
    .filter((r) => r.decision === "NEAR_MISS" || r.decision === "REJECTED")
    .slice(0, 25)
    .map((r) => {
      const delay = isNum(r.discordDeliveredMs) && isNum(r.firstSeenMs) ? r.discordDeliveredMs - r.firstSeenMs : isNum(r.triggerToDiscordMs) ? r.triggerToDiscordMs : null;
      const responsibleGate = normalizeGate(r.reason ?? r.dominantReason ?? r.classification ?? "Momentum gate");
      return {
        ticker: r.ticker,
        timeMs: r.evalAtMs ?? null,
        currentMovePct: r.movePct ?? r.discordMovePct ?? null,
        peakMovePct: null,
        discoveryTimeMs: r.firstSeenMs ?? r.firstDetectedMs ?? null,
        alertTimeMs: r.discordDeliveredMs ?? null,
        peakTimeMs: null,
        delayMs: delay,
        reasonNotAlerted: r.reason ?? r.dominantReason ?? r.classification ?? "not recorded",
        responsibleGate,
        fixable: /stale|quote|chain|data unavailable/i.test(String(r.reason ?? "")) ? "data quality first" : "research candidate",
        aiExplanation: `${r.ticker} was stored as ${r.decision}; the blocker was ${responsibleGate}. No trade decision is made here.`,
        source: "momentum_diagnostics",
      };
    });
}

function strategyScorecards(reports: AiReportRow[]): StrategyScorecardRow[] {
  const latest = reports[0]?.summary ?? {};
  const prev = reports[1]?.summary ?? {};
  const rows: Array<[string, any, any]> = [
    ["Momentum Options", latest.overall, prev.overall],
    ["Calls", latest.callsVsPuts?.call, prev.callsVsPuts?.call],
    ["Puts", latest.callsVsPuts?.put, prev.callsVsPuts?.put],
    ["0DTE", latest.zeroDteVsLonger?.zeroDte, prev.zeroDteVsLonger?.zeroDte],
    ["Weeklies", latest.zeroDteVsLonger?.longer, prev.zeroDteVsLonger?.longer],
    ["Premarket", latest.byTimeOfDay?.open_0930_1000, prev.byTimeOfDay?.open_0930_1000],
    ["After Hours", latest.byTimeOfDay?.extended, prev.byTimeOfDay?.extended],
  ];
  for (const [name, bucket] of Object.entries(latest.byStrategy ?? {})) rows.push([name, bucket, prev.byStrategy?.[name]]);
  return rows
    .filter(([, b]) => b)
    .map(([strategy, bucket, prevBucket]) => {
      const fp = pct(bucket?.losses, bucket?.n);
      const miss = bucket?.opportunityHitRate == null ? null : round1(100 - bucket.opportunityHitRate);
      const score = scoreAvg([bucket?.winRate ?? null, bucket?.opportunityHitRate ?? null, fp == null ? null : 100 - fp]);
      return {
        strategy,
        winRate: bucket?.winRate ?? null,
        profitFactor: bucket?.profitFactor ?? null,
        averageReturnPct: bucket?.avgReturnPct ?? null,
        medianReturnPct: bucket?.medianReturnPct ?? null,
        averageHoldTimeMs: bucket?.avgHoldTimeMs ?? null,
        opportunityGradeSuccess: bucket?.opportunityHitRate ?? null,
        falsePositivePct: fp,
        missRate: miss,
        trend: trend(score, scoreAvg([prevBucket?.winRate ?? null, prevBucket?.opportunityHitRate ?? null])),
        healthGrade: gradeFor(score),
        aiSummary: `${strategy}: ${bucket?.n ?? 0} deterministic sample(s), win rate ${bucket?.winRate ?? "n/a"}%, opportunity success ${bucket?.opportunityHitRate ?? "n/a"}%.`,
      };
    });
}

function copyTradingReadiness(health: ScannerHealth, summary: any): CopyTradingReadiness {
  const falsePositiveRate = pct(summary?.overall?.losses ?? null, summary?.counts?.outcomesGraded ?? summary?.overall?.n ?? null);
  const missRate = summary?.overall?.opportunityHitRate == null ? null : round1(100 - summary.overall.opportunityHitRate);
  const reqs: ReadinessRequirement[] = [
    { label: "Stable Win Rate", value: summary?.overall?.winRate ?? null, target: ">= 60%", passed: isNum(summary?.overall?.winRate) ? summary.overall.winRate >= 60 : null, source: "summary.overall.winRate" },
    { label: "Stable Profit Factor", value: null, target: "stored profitFactor required", passed: null, source: "not stored in nightly summary" },
    { label: "Stable Drawdown", value: null, target: "stored drawdown required", passed: null, source: "not stored in nightly summary" },
    { label: "Stable Opportunity Capture", value: summary?.overall?.opportunityHitRate ?? null, target: ">= 70%", passed: isNum(summary?.overall?.opportunityHitRate) ? summary.overall.opportunityHitRate >= 70 : null, source: "summary.overall.opportunityHitRate" },
    { label: "Low False Positives", value: falsePositiveRate, target: "<= 25%", passed: isNum(falsePositiveRate) ? falsePositiveRate <= 25 : null, source: "summary.overall.losses / graded" },
    { label: "Low Miss Rate", value: missRate, target: "<= 25%", passed: isNum(missRate) ? missRate <= 25 : null, source: "100 - summary.overall.opportunityHitRate" },
    { label: "Low Strategy Drift", value: health.trendVsLastWeek.value, target: "weekly health delta >= -5", passed: isNum(health.trendVsLastWeek.value) ? health.trendVsLastWeek.value >= -5 : null, source: "scanner health trend" },
    { label: "Consistent Paper Performance", value: health.score, target: "health score >= 80", passed: isNum(health.score) ? health.score >= 80 : null, source: "scannerHealth.score" },
  ];
  const score = scoreAvg(reqs.map((r) => r.passed ? 100 : 0));
  return {
    score,
    grade: gradeFor(score),
    requirements: reqs,
    aiExplanation: "Readiness is a deterministic consistency score. Missing required evidence counts against readiness; this is not a trade recommendation and cannot place trades.",
  };
}

function researchTopics(env: NodeJS.ProcessEnv | undefined): ResearchTopicRow[] {
  const ctx = weeklyQuantResearchContext({ env });
  const questions = [
    "Was Discovery Ranking too strict?",
    "Were acceleration thresholds too strict?",
    "Were acceleration thresholds too loose?",
    "Were quote freshness limits appropriate?",
    "Was VWAP rejection appropriate?",
    "Was liquidity filtering too strict?",
    "Were options spreads too strict?",
    "Were chain filters too strict?",
    "Were large-cap options behaving differently?",
    "Were low-float runners behaving differently?",
    "Were calls outperforming puts?",
    "Were puts outperforming calls?",
    "Were premarket rules appropriate?",
    "Were after-hours rules appropriate?",
    "Were exits occurring too early?",
    "Were exits occurring too late?",
    "Would deterministic threshold X have improved results?",
    "Would deterministic threshold Y have worsened false positives?",
  ];
  return questions.map((question, i) => {
    const inv = ctx.calculationInventory[i % ctx.calculationInventory.length];
    return {
      question,
      currentFormula: inv.formula,
      historicalFormula: "current production formula over stored historical paper data",
      challengerFormula: "pending deterministic replay/shadow calculation",
      baseline: "baseline_current_policy",
      status: "research only",
      source: inv.ownerFile,
    };
  });
}

function recommendedExperiments(proposals: ProposalRow[]): RecommendedExperimentRow[] {
  return proposals.slice(0, 20).map((p) => ({
    title: p.title,
    reason: p.problem,
    supportingEvidence: typeof p.evidence === "string" ? p.evidence : JSON.stringify(p.evidence ?? {}),
    expectedImprovement: p.expectedBenefit ?? null,
    confidence: p.confidence ?? "not recorded",
    risk: p.downsideRisk ?? p.overfittingRisk ?? null,
    metricsAffected: [p.affectedStrategy, p.affectedSession, p.affectedConfig].filter(Boolean).map(String),
    historicalSimulation: p.backtestPlan ?? p.shadowTestPlan ?? "not available yet",
    status: p.status === "PENDING_APPROVAL" ? "Pending" : p.status === "ACCEPTED" ? "Accepted" : p.status === "REJECTED" ? "Rejected" : p.status,
  }));
}

function portfolioComparison(weeklyReports: AiReportRow[], latestSummary: any): PortfolioComparisonRow[] {
  const weekly = weeklyReports[0]?.summary?.quantResearch?.outcomeComparisons?.portfolios ?? null;
  const portfolios = [
    { key: "PRIMARY", fallbackKey: null, label: "Primary" },
    { key: "AGGRESSIVE_CHALLENGE", fallbackKey: "CHALLENGE", label: "Aggressive Challenge" },
    { key: "STOCK_DAY_TRADER", fallbackKey: null, label: "Stock Day Trader" },
  ];
  return portfolios.map(({ key, fallbackKey, label }) => {
    const p = weekly?.[key] ?? (fallbackKey ? weekly?.[fallbackKey] : null) ?? null;
    const baseline = p?.baseline ?? (key === "PRIMARY" ? {
      winRate: latestSummary?.overall?.winRate ?? null,
      avgReturnPct: latestSummary?.overall?.avgReturnPct ?? null,
      opportunityHitRate: latestSummary?.overall?.opportunityHitRate ?? null,
    } : {});
    return {
      portfolio: label,
      equityCurve: p ? "stored weekly quant context" : "not stored",
      returns: baseline?.avgReturnPct ?? null,
      drawdown: p?.drawdown ?? null,
      winRate: baseline?.winRate ?? null,
      profitFactor: p?.profitFactor ?? null,
      largestWinner: p?.largestWinner ?? null,
      largestLoser: p?.largestLoser ?? null,
      opportunityGrade: baseline?.opportunityHitRate ?? null,
      strategyMix: p?.sampleSizes ? JSON.stringify(p.sampleSizes) : "not stored",
      capitalUsage: p?.capitalUsage ?? "not stored",
    };
  });
}

function dailySummary(health: ScannerHealth, summary: any, strategies: StrategyScorecardRow[], gates: GateBreakdownRow[], proposals: ProposalRow[]): DailyAiSummary {
  const ranked = [...strategies].filter((s) => isNum(s.winRate)).sort((a, b) => Number(b.winRate) - Number(a.winRate));
  const pending = proposals.find((p) => p.status === "PENDING_APPROVAL") ?? proposals[0] ?? null;
  return {
    scannerGrade: health.grade,
    scannerHealth: health.score,
    missedFastMovers: summary?.momentum?.nearMisses ?? summary?.counts?.nearMisses ?? null,
    lateAlerts: summary?.counts?.lateCallouts ?? summary?.momentum?.earliness?.counts?.LATE ?? null,
    falsePositives: summary?.overall?.losses ?? null,
    bestStrategy: ranked[0]?.strategy ?? null,
    worstStrategy: ranked[ranked.length - 1]?.strategy ?? null,
    topRejectingGate: gates[0]?.gate ?? null,
    mostCommonFailure: summary?.prioritizedIssue ?? gates[0]?.gate ?? null,
    mostImprovedMetric: health.trendVsYesterday.value != null && health.trendVsYesterday.value > 0 ? "Scanner Health" : null,
    mostRegressedMetric: health.trendVsYesterday.value != null && health.trendVsYesterday.value < 0 ? "Scanner Health" : null,
    recommendedExperiment: pending?.title ?? null,
    expectedImpact: pending?.expectedBenefit ?? null,
    confidence: confidenceForSummary(summary),
  };
}

function chart(reports: AiReportRow[], selector: (s: any) => number | null): ChartPoint[] {
  return [...reports].reverse().map((r) => ({ periodKey: r.periodKey, value: selector(r.summary) }));
}

export function buildQuantDashboard(input: QuantDashboardInput): QuantDashboard {
  const nightly = input.nightlyReports ?? [];
  const latest = latestSummary(nightly) ?? {};
  const health = scannerHealth(nightly);
  const gates = gateBreakdown(nightly, input.latestMomentumDiagnostics ?? []);
  const strategies = strategyScorecards(nightly);
  const dataGaps = Array.isArray(latest?.dataGaps) ? [...latest.dataGaps] : [];
  if (!input.latestMomentumDiagnostics?.length) dataGaps.push("per-runner missed-runner examples unavailable unless momentum_diagnostics rows exist for the latest nightly day");
  return {
    scannerHealth: health,
    reportCard: reportCard(latest, input.jobFailures ?? []),
    gateBreakdown: gates,
    missedRunners: missedRunners(input.latestMomentumDiagnostics ?? []),
    strategyScorecards: strategies,
    copyTradingReadiness: copyTradingReadiness(health, latest),
    researchTopics: researchTopics(input.env),
    recommendedExperiments: recommendedExperiments(input.proposals ?? []),
    portfolioComparison: portfolioComparison(input.weeklyReports ?? [], latest),
    dailyAiSummary: dailySummary(health, latest, strategies, gates, input.proposals ?? []),
    charts: {
      scannerHealth: chart(nightly, healthScoreForSummary),
      missedRunnerTrend: chart(nightly, (s) => s?.momentum?.nearMisses ?? s?.counts?.nearMisses ?? null),
      falsePositiveTrend: chart(nightly, (s) => pct(s?.overall?.losses ?? null, s?.counts?.outcomesGraded ?? s?.overall?.n ?? null)),
      lateAlertTrend: chart(nightly, (s) => s?.counts?.lateCallouts ?? s?.momentum?.earliness?.counts?.LATE ?? null),
      averageDelay: chart(nightly, (s) => s?.timing?.avgTriggerToDiscordMs ?? s?.momentum?.avgLatencyMs ?? null),
      opportunityGradeTrend: chart(nightly, (s) => s?.overall?.opportunityHitRate ?? null),
      callsVsPuts: chart(nightly, (s) => (s?.callsVsPuts?.call?.winRate ?? 0) - (s?.callsVsPuts?.put?.winRate ?? 0)),
      discoveryDelay: chart(nightly, (s) => s?.momentum?.medianDiscoveryLatencyMs ?? null),
      gateRejectionDistribution: gates.map((g) => ({ periodKey: g.gate, value: g.count })),
    },
    guardrails: [
      "AI remains outside the live scanner path.",
      "AI never changes gates, thresholds, scanner logic, or deterministic safety.",
      "AI proposals remain pending until human approval.",
      "Every metric is read from stored deterministic reports, diagnostics, lessons, or proposals.",
    ],
    dataGaps,
  };
}
