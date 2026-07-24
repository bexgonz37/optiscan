/**
 * Machine-readable metric dictionary for Scanner Health / funnel observability.
 * Human docs: docs/METRIC_DICTIONARY.md
 *
 * Every production dashboard metric must have an entry here. Metrics that cannot
 * be computed from stored deterministic data must set available=false and explain why.
 */

export type MetricPipeline =
  | "STOCK_MOMENTUM"
  | "SUPERVISOR_OPTIONS"
  | "INDEPENDENT_OPTIONS"
  | "PAPER_OUTCOMES"
  | "CROSS_PIPELINE" // only when explicitly labeled as multi-pipeline
  | "INFRA";

export interface MetricDefinition {
  id: string;
  label: string;
  pipeline: MetricPipeline;
  /** Exact SQL or pseudo-SQL documenting the computation. */
  sql: string;
  sourceTables: string[];
  timestampField: string;
  numerator: string;
  denominator: string;
  assumptions: string[];
  limitations: string[];
  /** When false, dashboard must show n/a — never invent a fallback from another pipeline. */
  computableFromStoredData: boolean;
}

export const METRIC_DICTIONARY: Record<string, MetricDefinition> = {
  stock_early_alert_rate: {
    id: "stock_early_alert_rate",
    label: "Early Alert Rate",
    pipeline: "STOCK_MOMENTUM",
    sql: `SELECT earliness.pctEarly FROM nightly_summary.momentum.earliness
-- underlying: summarizeEarliness(SENT/RESCUED_SENT rows in momentum_diagnostics WHERE trading_day=?)`,
    sourceTables: ["momentum_diagnostics", "ai_reports.summary"],
    timestampField: "momentum_diagnostics.eval_at_ms (trading_day ET)",
    numerator: "SENT/RESCUED_SENT alerts graded EARLY by summarizeEarliness",
    denominator: "SENT/RESCUED_SENT alerts with gradable earliness",
    assumptions: ["Only stock momentum alerts that actually sent", "Earliness graded post-hoc from stored move snapshots"],
    limitations: ["Does not include independent options path", "Null when no SENT rows that day"],
    computableFromStoredData: true,
  },
  stock_missed_runner_rate: {
    id: "stock_missed_runner_rate",
    label: "Missed Runner Rate",
    pipeline: "STOCK_MOMENTUM",
    sql: `SELECT
  COUNT(*) FILTER (WHERE decision='NEAR_MISS') * 100.0
  / NULLIF(COUNT(*),0)
FROM momentum_diagnostics
WHERE trading_day = ?`,
    sourceTables: ["momentum_diagnostics"],
    timestampField: "eval_at_ms / trading_day",
    numerator: "COUNT(decision='NEAR_MISS') — raw rows, NOT opportunity-deduplicated (Phase 4)",
    denominator: "COUNT(*) all momentum_diagnostics rows for the day",
    assumptions: ["Persisted diagnostics only (not in-memory near-miss ring)", "NEAR_MISS throttle ≈30s/symbol still allows multiple rows per symbol/day"],
    limitations: [
      "Inflated vs unique opportunities until Phase 4 dedup",
      "Does not mean 'missed profitable trade' — means near-trigger gate blocked",
      "Never mix with options delivery counts",
    ],
    computableFromStoredData: true,
  },
  stock_missed_fast_movers_count: {
    id: "stock_missed_fast_movers_count",
    label: "Missed Fast Movers",
    pipeline: "STOCK_MOMENTUM",
    sql: `SELECT COUNT(*) FROM momentum_diagnostics
WHERE trading_day = ? AND decision = 'NEAR_MISS'`,
    sourceTables: ["momentum_diagnostics"],
    timestampField: "eval_at_ms / trading_day",
    numerator: "NEAR_MISS row count",
    denominator: "1 (absolute count)",
    assumptions: ["Single source: summary.momentum.nearMisses from persisted table"],
    limitations: [
      "NOT the in-memory /api/scanner/live nearMisses buffer (cleared on restart)",
      "Not opportunity-deduplicated",
    ],
    computableFromStoredData: true,
  },
  paper_false_positive_rate: {
    id: "paper_false_positive_rate",
    label: "False Positive Rate",
    pipeline: "PAPER_OUTCOMES",
    sql: `SELECT losses * 100.0 / NULLIF(wins+losses+breakeven,0)
-- from nightly summary.overall built from graded paper_trade_outcomes`,
    sourceTables: ["paper_trade_outcomes", "ai_reports.summary"],
    timestampField: "outcome entry/exit timestamps aggregated by trading_day",
    numerator: "graded LOSS outcomes",
    denominator: "graded WIN+LOSS+BREAKEVEN outcomes",
    assumptions: ["Paper outcomes only", "UNGRADEABLE excluded from denominator"],
    limitations: ["Not live Discord alert quality", "Sample-size sensitive"],
    computableFromStoredData: true,
  },
  paper_win_rate: {
    id: "paper_win_rate",
    label: "Win Rate",
    pipeline: "PAPER_OUTCOMES",
    sql: `SELECT wins * 100.0 / NULLIF(wins+losses+breakeven,0) -- summary.overall.winRate`,
    sourceTables: ["paper_trade_outcomes", "ai_reports.summary"],
    timestampField: "trading_day of graded outcomes",
    numerator: "WIN count",
    denominator: "graded outcomes",
    assumptions: ["Deterministic paper grading"],
    limitations: ["Does not equal live subscriber fill P&L"],
    computableFromStoredData: true,
  },
  paper_signal_quality: {
    id: "paper_signal_quality",
    label: "Signal Quality / Opportunity Grade Success",
    pipeline: "PAPER_OUTCOMES",
    sql: `SELECT opportunityHits * 100.0 / NULLIF(opportunityGradable,0) -- summary.overall.opportunityHitRate`,
    sourceTables: ["paper_trade_outcomes", "ai_reports.summary"],
    timestampField: "trading_day",
    numerator: "opportunityGrade = HIT",
    denominator: "opportunityGrade HIT or NONE",
    assumptions: ["Opportunity grade is separate from realized WIN/LOSS"],
    limitations: ["Null when no opportunity-gradable outcomes"],
    computableFromStoredData: true,
  },
  stock_avg_alert_delay_ms: {
    id: "stock_avg_alert_delay_ms",
    label: "Average Alert Delay",
    pipeline: "STOCK_MOMENTUM",
    sql: `SELECT AVG(trigger_to_discord_ms) FROM momentum_diagnostics
WHERE trading_day = ? AND trigger_to_discord_ms IS NOT NULL`,
    sourceTables: ["momentum_diagnostics"],
    timestampField: "discord_delivered_ms - trigger (stored as trigger_to_discord_ms)",
    numerator: "SUM(trigger_to_discord_ms)",
    denominator: "COUNT(non-null trigger_to_discord_ms)",
    assumptions: ["Only rows that recorded Discord latency"],
    limitations: ["Null when no SENT rows with latency", "Falls back to summary.timing only when that field is stock-sourced"],
    computableFromStoredData: true,
  },
  supervisor_options_capture_rate: {
    id: "supervisor_options_capture_rate",
    label: "Opportunity Capture Rate (Supervisor Options)",
    pipeline: "SUPERVISOR_OPTIONS",
    sql: `SELECT SUM(delivered) * 100.0 / NULLIF(SUM(canonical),0)
FROM options_diagnostics WHERE trading_day = ?`,
    sourceTables: ["options_diagnostics"],
    timestampField: "cycle_at_ms / trading_day",
    numerator: "SUM(delivered) across supervisor cycles",
    denominator: "SUM(canonical) across supervisor cycles",
    assumptions: [
      "Supervisor/canonical-path funnel ONLY",
      "Requires SUPERVISOR_RUNTIME cycles recorded",
    ],
    limitations: [
      "DOES NOT measure independent options monitor (INDEPENDENT_OPTIONS_DISCOVERY)",
      "0% often means supervisor path idle or config-blocked — not 'scanner broken'",
      "Canonical is cycle-summed; may double-count same underlying across cycles",
    ],
    computableFromStoredData: true,
  },
  independent_options_capture_rate: {
    id: "independent_options_capture_rate",
    label: "Opportunity Capture Rate (Independent Options)",
    pipeline: "INDEPENDENT_OPTIONS",
    sql: `SELECT
  (SELECT COUNT(*) FROM options_alerts WHERE state='SENT' AND created_at_ms >= ? AND created_at_ms < ?) * 100.0
  / NULLIF((SELECT COUNT(*) FROM options_candidates WHERE state='READY' AND created_at_ms >= ? AND created_at_ms < ?), 0)`,
    sourceTables: ["options_alerts", "options_candidates"],
    timestampField: "created_at_ms (ms epoch)",
    numerator: "options_alerts SENT in window",
    denominator: "options_candidates READY in window",
    assumptions: ["Independent monitor path", "READY is the delivery-eligible candidate state"],
    limitations: [
      "READY→SENT can fail at portfolio ranking / hard delivery gates",
      "Not opportunity-deduplicated across retries",
    ],
    computableFromStoredData: true,
  },
  profit_factor: {
    id: "profit_factor",
    label: "Profit Factor",
    pipeline: "PAPER_OUTCOMES",
    sql: `-- NOT stored in nightly summary today`,
    sourceTables: [],
    timestampField: "n/a",
    numerator: "gross wins",
    denominator: "gross losses",
    assumptions: [],
    limitations: ["Not available in nightly summary — dashboard must show n/a"],
    computableFromStoredData: false,
  },
};

export function metricDefinition(id: string): MetricDefinition | null {
  return METRIC_DICTIONARY[id] ?? null;
}

export function metricsForPipeline(pipeline: MetricPipeline): MetricDefinition[] {
  return Object.values(METRIC_DICTIONARY).filter((m) => m.pipeline === pipeline);
}
