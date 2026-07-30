/**
 * findings.ts — PURE canonical findings for the entry-timing, loss-protection,
 * and Watchlist research programmes.
 *
 * These are MetricEvidence/Finding rows in the same shape the canonical findings
 * report already uses, so the AI advisory layer can cite them by id instead of
 * querying raw tables. Every metric carries its sample size, quality, and
 * window; a zero-sample metric reports null and is never presented as a result.
 *
 * AI AUTHORITY IS ADVISORY ONLY. Nothing here can change scanner, entry, exit,
 * Watchlist, or delivery behaviour — these are read-model rows.
 */
import type {
  EvidenceConfidence,
  Finding,
  MetricEvidence,
  MetricQuality,
} from "../../ai/findings-report.ts";

export interface WatchlistFindingsInput {
  /** Window label, e.g. "last 30 sessions". */
  timeWindow: string;
  entryTiming?: {
    /** Median delay between earliest valid evidence and canonical SEND, ms. */
    avgAlertDelayMs: number | null;
    /** Trades classified as premium chase. */
    premiumChaseCount: number | null;
    /** Trades with any earlier valid entry evidence. */
    sampleSize: number;
    /** Median premium improvement an earlier entry would have captured, %. */
    earlyEntryImprovementPct: number | null;
  } | null;
  lossProtection?: {
    /** Median improvement of the best supported early-exit policy, %. */
    earlyExitImprovementPct: number | null;
    sampleSize: number;
    /** Whether the best policy is genuinely profitable or merely less bad. */
    bestPolicyProfitable: boolean;
    bestPolicyLabel: string | null;
  } | null;
  watchlist?: {
    publishedCount: number;
    triggerRatePct: number | null;
    conversionRatePct: number | null;
    outcomeRatePct: number | null;
    byFamily: Array<{ family: string; setupType: string; sample: number; triggered: number; outcomeRatePct: number | null }>;
    bySide: Array<{ side: "CALL" | "PUT"; triggered: number; outcomeRatePct: number | null }>;
    isSubscriberPerformance: boolean;
  } | null;
  nowMs?: number;
}

export interface WatchlistFindingsReport {
  metrics: MetricEvidence[];
  findings: Finding[];
  advisoryOnly: true;
  productionBehaviorChanged: false;
  aiAuthority: "ADVISORY_ONLY";
  dataGaps: string[];
}

const MIN_SUPPORTED_SAMPLE = 30;

function confidenceFor(sample: number | null, quality: MetricQuality): EvidenceConfidence {
  if (quality !== "VALID") return "LOW";
  const n = Number(sample ?? 0);
  if (n >= MIN_SUPPORTED_SAMPLE) return "HIGH";
  if (n >= 10) return "MEDIUM";
  return "LOW";
}

function metric(input: {
  id: string;
  label: string;
  value: number | string | null;
  unit?: string;
  lane: string;
  timeWindow: string;
  sampleSize: number | null;
  freshness: string;
  table: string;
  fn: string;
  field: string;
  meaning: string;
  whyItMatters: string;
  better: "higher" | "lower" | "neutral";
}): MetricEvidence {
  // A null value is MISSING_DATA, never a zero. A real value below the minimum
  // sample stays VALID but is not safe for a top line — the sample size, not the
  // quality flag, is what makes it unquotable on its own.
  const quality: MetricQuality = input.value == null ? "MISSING_DATA" : "VALID";
  const belowMinimum = (input.sampleSize ?? 0) < MIN_SUPPORTED_SAMPLE;
  return {
    id: input.id,
    label: input.label,
    value: input.value,
    unit: input.unit,
    pipeline: "SHADOW_REPLAY",
    lane: input.lane,
    timeWindow: input.timeWindow,
    sampleSize: input.sampleSize,
    confidence: confidenceFor(input.sampleSize, quality),
    freshness: input.freshness,
    source: { table: input.table, function: input.fn, field: input.field },
    qualityStatus: quality,
    safeForTopLine: quality === "VALID" && !belowMinimum,
    meaning: input.meaning,
    whyItMatters: input.whyItMatters,
    better: input.better,
  };
}

/**
 * Build the canonical findings. Missing inputs produce NO_DATA metrics with an
 * explicit data gap — never a zero presented as a measurement.
 */
export function buildWatchlistQuantFindings(input: WatchlistFindingsInput): WatchlistFindingsReport {
  const metrics: MetricEvidence[] = [];
  const findings: Finding[] = [];
  const dataGaps: string[] = [];
  const tw = input.timeWindow;

  // ── Entry timing ──────────────────────────────────────────────────────────
  const entry = input.entryTiming ?? null;
  if (!entry) dataGaps.push("No entry-timing cohort available.");
  const entrySample = entry?.sampleSize ?? 0;
  metrics.push(metric({
    id: "watchlist.avg_alert_delay_ms",
    label: "Average alert delay",
    value: entry?.avgAlertDelayMs ?? null,
    unit: "ms",
    lane: "ENTRY_TIMING",
    timeWindow: tw,
    sampleSize: entry ? entrySample : null,
    freshness: "Shadow replay of completed sessions",
    table: "alerts + options_research_observations",
    fn: "analyzeEarlierEntries",
    field: "delayFromEarliestMs",
    meaning: "How long after the earliest valid, exact-contract evidence the canonical alert was sent.",
    whyItMatters: "Delay is the mechanism by which a good setup becomes a chased premium.",
    better: "lower",
  }));
  metrics.push(metric({
    id: "watchlist.premium_chase_rate_pct",
    label: "Premium chase rate",
    value: entry && entrySample > 0 && entry.premiumChaseCount != null
      ? Math.round((entry.premiumChaseCount / entrySample) * 1000) / 10
      : null,
    unit: "%",
    lane: "ENTRY_TIMING",
    timeWindow: tw,
    sampleSize: entry ? entrySample : null,
    freshness: "Shadow replay of completed sessions",
    table: "alerts + options_research_observations",
    fn: "analyzeEarlierEntries",
    field: "classificationCounts.PREMIUM_CHASE",
    meaning: "Share of alerts whose canonical entry ask was materially above the earliest valid entry.",
    whyItMatters: "A chased premium starts the trade behind before the thesis is tested.",
    better: "lower",
  }));
  metrics.push(metric({
    id: "watchlist.early_entry_improvement_pct",
    label: "Early-entry improvement",
    value: entry?.earlyEntryImprovementPct ?? null,
    unit: "%",
    lane: "ENTRY_TIMING",
    timeWindow: tw,
    sampleSize: entry ? entrySample : null,
    freshness: "Shadow replay of completed sessions",
    table: "options_research_observations",
    fn: "analyzeEarlierEntries",
    field: "candidateEntries",
    meaning: "Premium a shadow earlier entry would have captured, replayed from evidence available at that time.",
    whyItMatters: "Quantifies the size of the timing problem rather than asserting it.",
    better: "higher",
  }));

  // ── Loss protection ───────────────────────────────────────────────────────
  const loss = input.lossProtection ?? null;
  if (!loss) dataGaps.push("No loss-protection cohort available.");
  metrics.push(metric({
    id: "watchlist.early_exit_improvement_pct",
    label: "Early-exit improvement",
    value: loss?.earlyExitImprovementPct ?? null,
    unit: "%",
    lane: "LOSS_PROTECTION",
    timeWindow: tw,
    sampleSize: loss?.sampleSize ?? null,
    freshness: "Shadow replay of completed sessions",
    table: "options_research_observations",
    fn: "aggregateLossProtection",
    field: "bestSupportedPolicy",
    meaning: "How much the best supported shadow exit policy improved on the current policy.",
    whyItMatters: "Separates a genuinely better exit from one that merely loses less.",
    better: "higher",
  }));
  if (loss && loss.earlyExitImprovementPct != null && !loss.bestPolicyProfitable) {
    findings.push({
      id: "watchlist.loss_protection_less_bad",
      title: "The best shadow exit policy is less bad, not profitable",
      summary: `${loss.bestPolicyLabel ?? "The leading policy"} improves on the current policy but remains negative over ${loss.sampleSize} shadow trades. It must never be described as a winning or profitable policy.`,
      classification: "DATA_QUALITY_WARNING",
      pipeline: "SHADOW_REPLAY",
      severity: "warning",
      confidence: confidenceFor(loss.sampleSize, "VALID"),
      metricIds: ["watchlist.early_exit_improvement_pct"],
      sourceRefs: ["lib/research/options/loss-protection-aggregation.ts"],
      recommendedNextStep: "Collect a larger, cleaner shadow sample before considering any exit change.",
    });
  }

  // ── Watchlist ─────────────────────────────────────────────────────────────
  const wl = input.watchlist ?? null;
  if (!wl) dataGaps.push("No Watchlist outcome cohort available.");
  metrics.push(metric({
    id: "watchlist.trigger_rate_pct",
    label: "Watchlist trigger rate",
    value: wl?.triggerRatePct ?? null,
    unit: "%",
    lane: "WATCHLIST",
    timeWindow: tw,
    sampleSize: wl?.publishedCount ?? null,
    freshness: "Completed sessions",
    table: "watchlist_setup_outcomes",
    fn: "summarizeWatchlistOutcomes",
    field: "triggerRatePct",
    meaning: "Share of published setups whose published level actually traded.",
    whyItMatters: "A plan whose levels never trade is not a plan.",
    better: "higher",
  }));
  metrics.push(metric({
    id: "watchlist.alert_conversion_pct",
    label: "Watchlist-to-alert conversion",
    value: wl?.conversionRatePct ?? null,
    unit: "%",
    lane: "WATCHLIST",
    timeWindow: tw,
    sampleSize: wl?.publishedCount ?? null,
    freshness: "Completed sessions",
    table: "watchlist_setup_outcomes",
    fn: "summarizeWatchlistOutcomes",
    field: "conversionRatePct",
    meaning: "Share of triggered setups that became a verified canonical SEND with exact-contract evidence.",
    whyItMatters: "Shows where the revalidation gates stop a triggered setup, and why.",
    better: "neutral",
  }));
  metrics.push(metric({
    id: "watchlist.outcome_rate_pct",
    label: "Watchlist outcome rate",
    value: wl?.outcomeRatePct ?? null,
    unit: "%",
    lane: "WATCHLIST",
    timeWindow: tw,
    sampleSize: wl?.publishedCount ?? null,
    freshness: "Completed sessions",
    table: "watchlist_setup_outcomes",
    fn: "summarizeWatchlistOutcomes",
    field: "outcomeRatePct",
    meaning: "Share of triggered setups that produced favourable movement. Research only.",
    whyItMatters: "Measures the setups themselves, independently of whether an alert was ever sent.",
    better: "higher",
  }));

  for (const fam of wl?.byFamily ?? []) {
    metrics.push(metric({
      id: `watchlist.family.${fam.family.toLowerCase()}.outcome_rate_pct`,
      label: `${fam.setupType} outcome rate`,
      value: fam.outcomeRatePct,
      unit: "%",
      lane: "WATCHLIST_SETUP_FAMILY",
      timeWindow: tw,
      sampleSize: fam.sample,
      freshness: "Completed sessions",
      table: "watchlist_setup_outcomes",
      fn: "summarizeWatchlistOutcomes",
      field: "byFamily.outcomeRatePct",
      meaning: `Favourable-movement rate for ${fam.setupType} setups that triggered.`,
      whyItMatters: "Tells us which structures are worth publishing and which are noise.",
      better: "higher",
    }));
  }

  for (const side of wl?.bySide ?? []) {
    metrics.push(metric({
      id: `watchlist.side.${side.side.toLowerCase()}.outcome_rate_pct`,
      label: `${side.side}-trigger outcome rate`,
      value: side.outcomeRatePct,
      unit: "%",
      lane: "WATCHLIST_SIDE",
      timeWindow: tw,
      sampleSize: side.triggered,
      freshness: "Completed sessions",
      table: "watchlist_setup_outcomes",
      fn: "summarizeWatchlistOutcomes",
      field: "bySide.outcomeRatePct",
      meaning: `Favourable-movement rate for ${side.side} triggers.`,
      whyItMatters: "Directional asymmetry is a property of the setups, not of the alerting.",
      better: "higher",
    }));
  }

  if (wl && !wl.isSubscriberPerformance) {
    findings.push({
      id: "watchlist.outcomes_are_not_subscriber_results",
      title: "Watchlist outcomes are research, not subscriber results",
      summary: "These rates describe published setups. They are not subscriber performance: that requires a verified canonical SEND with exact-contract evidence for every counted row.",
      classification: "DATA_QUALITY_WARNING",
      pipeline: "SHADOW_REPLAY",
      severity: "info",
      confidence: "HIGH",
      metricIds: ["watchlist.trigger_rate_pct", "watchlist.outcome_rate_pct"],
      sourceRefs: ["lib/research/watchlist/outcomes.ts"],
      recommendedNextStep: "Report subscriber performance only from the verified-SEND cohort.",
    });
  }

  return {
    metrics,
    findings,
    advisoryOnly: true,
    productionBehaviorChanged: false,
    aiAuthority: "ADVISORY_ONLY",
    dataGaps,
  };
}
