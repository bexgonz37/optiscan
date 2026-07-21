/**
 * lib/research/forward/report.ts — the Phase-F product-readiness report (forward validation +
 * latency). PURE assembler. Until enough forward observations AND a measured production-latency
 * sample exist, the report is COLLECTING_DATA and lists exactly what evidence is still missing —
 * it NEVER claims the latency targets or edge are achieved on synthetic/backtest data alone.
 */
import { bucketStats, calibrationByConfidence, maxDrawdown, winRate, expectancy, type GradedItem } from "./aggregate.ts";
import type { LatencyMetrics } from "./latency.ts";

export type ForwardReportStatus = "COLLECTING_DATA" | "READY_FOR_REVIEW";

export interface BacktestBaseline { winRate: number; expectancy: number; reportId: string | null }
export interface DiscordReliability { delivered: number; failed: number; retried: number; duplicateSuppressed: number }
export interface OutageSummary { providerOutages: number; discordOutages: number; lastOutageMs: number | null }

export interface ForwardReportInput {
  graded: GradedItem[];                 // one row per (recommendation, primary horizon) with an outcome
  primaryHorizon: string;
  latency: LatencyMetrics;
  backtest: BacktestBaseline | null;
  discord: DiscordReliability;
  outages: OutageSummary;
  // gates for declaring the infrastructure "ready to review" (NOT "ready to charge")
  minForwardSample?: number;
  minLatencySample?: number;
  targets?: { earlyWatchP50Ms: number; earlyWatchP95Ms: number };
}

export interface ForwardReport {
  status: ForwardReportStatus;
  generatedAtMs: number;
  forwardSampleSize: number;
  headline: { winRate: number; expectancy: number; maxDrawdown: number };
  byStrategy: ReturnType<typeof bucketStats>;
  calibration: ReturnType<typeof calibrationByConfidence>;
  backtestVsForward: { bucketKey: string; forwardWin: number; backtestWin: number | null; winDelta: number | null; forwardExpectancy: number; degraded: boolean }[];
  latency: LatencyMetrics;
  latencyTargets: { earlyWatchP50Ms: number; earlyWatchP95Ms: number; p50Met: boolean | null; p95Met: boolean | null; heavyWorkOffCriticalPath: boolean | null };
  alertHealth: { tooLatePct: number; canceledPct: number; expiredPct: number; lateEntryPct: number };
  discord: DiscordReliability & { deliveryRatePct: number | null };
  outages: OutageSummary;
  missingEvidence: string[];
  disclaimer: string;
}

const DISCLAIMER = "COLLECTING_DATA infrastructure. Forward performance and latency figures are only valid once measured on real production traffic; synthetic/backtest numbers are NOT evidence of a live edge or of meeting latency targets. No real-money execution. Bearish is research-only (BEARISH_ACTIONABLE off); puts are RESEARCH_ONLY.";

export function buildForwardReport(input: ForwardReportInput, nowMs: number = Date.now()): ForwardReport {
  const minForward = input.minForwardSample ?? 100;
  const minLatency = input.minLatencySample ?? 100;
  const targets = input.targets ?? { earlyWatchP50Ms: 3000, earlyWatchP95Ms: 8000 };
  const graded = input.graded;
  const n = graded.length;

  const ew = input.latency.triggerToEarlyWatch; // event→early-watch delivery proxy for the fast path
  const p50Met = ew.p50 == null ? null : ew.p50 <= targets.earlyWatchP50Ms;
  const p95Met = ew.p95 == null ? null : ew.p95 <= targets.earlyWatchP95Ms;
  const heavyOff = input.latency.total === 0 ? null : input.latency.heavyWorkOnCriticalPath === 0;

  const byStrategy = bucketStats(graded);
  const backtestVsForward = byStrategy.map((b) => {
    const forwardWin = b.winRate;
    const backtestWin = input.backtest ? input.backtest.winRate : null;
    const winDelta = backtestWin == null ? null : +(forwardWin - backtestWin).toFixed(4);
    return { bucketKey: b.bucketKey, forwardWin, backtestWin, winDelta, forwardExpectancy: b.expectancy, degraded: winDelta != null && winDelta < -0.1 };
  });

  const missingEvidence: string[] = [];
  if (n < minForward) missingEvidence.push(`forward sample ${n} < ${minForward} graded recommendations`);
  if (input.latency.total < minLatency) missingEvidence.push(`production latency sample ${input.latency.total} < ${minLatency} measured alerts`);
  if (p50Met !== true) missingEvidence.push(`EARLY_WATCH p50 not proven ≤ ${targets.earlyWatchP50Ms}ms in production`);
  if (p95Met !== true) missingEvidence.push(`EARLY_WATCH p95 not proven ≤ ${targets.earlyWatchP95Ms}ms in production`);
  if (heavyOff !== true) missingEvidence.push("heavy work (analog/language-model/news) not yet proven OFF the critical path in production");
  if (!input.backtest) missingEvidence.push("no Phase-D backtest baseline linked for backtest-vs-forward degradation");
  if (input.discord.delivered + input.discord.failed === 0) missingEvidence.push("no Discord delivery reliability sample");
  // commercial-readiness gaps are always outstanding until explicitly cleared (see docs/PHASE_F)
  missingEvidence.push("commercial-readiness gaps outstanding (uptime/incident monitoring, disclaimers/terms, data-vendor redistribution approval, access control, audit history, support/refund policy) — see docs/PHASE_F_FORWARD_VALIDATION.md");

  const deliveredTotal = input.discord.delivered + input.discord.failed;
  return {
    status: missingEvidence.length === 1 && n >= minForward ? "READY_FOR_REVIEW" : "COLLECTING_DATA",
    generatedAtMs: nowMs,
    forwardSampleSize: n,
    headline: { winRate: winRate(graded), expectancy: expectancy(graded), maxDrawdown: maxDrawdown(graded) },
    byStrategy,
    calibration: calibrationByConfidence(graded),
    backtestVsForward,
    latency: input.latency,
    latencyTargets: { earlyWatchP50Ms: targets.earlyWatchP50Ms, earlyWatchP95Ms: targets.earlyWatchP95Ms, p50Met, p95Met, heavyWorkOffCriticalPath: heavyOff },
    alertHealth: { tooLatePct: input.latency.tooLatePct, canceledPct: input.latency.canceledPct, expiredPct: input.latency.expiredPct, lateEntryPct: input.latency.lateEntryPct },
    discord: { ...input.discord, deliveryRatePct: deliveredTotal ? +((input.discord.delivered / deliveredTotal) * 100).toFixed(2) : null },
    outages: input.outages,
    missingEvidence,
    disclaimer: DISCLAIMER,
  };
}
