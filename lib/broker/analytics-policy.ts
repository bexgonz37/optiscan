/**
 * B5 analytics methodology constants.
 * See docs/BROKER_ANALYTICS_POLICY.md for full assumptions.
 */

export const ANALYTICS_METHODOLOGY_VERSION = 1;

export const ANALYTICS_SURFACE_LABEL = "Research Analytics — Not Yet Authoritative";

/** Advisory Kelly must never feed execution / sizing / delivery. */
export const KELLY_ADVISORY_ONLY = true as const;

export interface AnalyticsPolicyConfig {
  /** Equity return sampling interval label. */
  returnInterval: "snapshot_to_snapshot_dailyized";
  /** Trading days/year for annualization when window is long enough. */
  annualizationFactor: number;
  /** Risk-free rate (annual, decimal). Default 0 for paper research. */
  riskFreeRate: number;
  /** Minimum closed trades for trade-level advanced stats. */
  minTradesForAdvanced: number;
  /** Minimum return observations for Sharpe/Sortino/VaR. */
  minReturnObservations: number;
  /** Minimum calendar days before showing annualized ratios. */
  minDaysForAnnualization: number;
  /** Historical VaR confidence (e.g. 0.95). */
  varConfidence: number;
  /** Max quote age / incomplete handling is inherited from equity completeness. */
  excludeIncompleteSnapshotsByDefault: boolean;
}

export function defaultAnalyticsPolicy(
  env: NodeJS.ProcessEnv = process.env,
): AnalyticsPolicyConfig {
  const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    returnInterval: "snapshot_to_snapshot_dailyized",
    annualizationFactor: num(env.BROKER_V2_ANALYTICS_ANNUALIZATION, 252),
    riskFreeRate: num(env.BROKER_V2_ANALYTICS_RISK_FREE, 0),
    minTradesForAdvanced: Math.max(1, Math.floor(num(env.BROKER_V2_ANALYTICS_MIN_TRADES, 10))),
    minReturnObservations: Math.max(2, Math.floor(num(env.BROKER_V2_ANALYTICS_MIN_RETURNS, 20))),
    minDaysForAnnualization: Math.max(1, Math.floor(num(env.BROKER_V2_ANALYTICS_MIN_DAYS, 30))),
    varConfidence: Math.min(0.99, Math.max(0.8, num(env.BROKER_V2_ANALYTICS_VAR_CONFIDENCE, 0.95))),
    excludeIncompleteSnapshotsByDefault: env.BROKER_V2_ANALYTICS_REQUIRE_COMPLETE !== "0",
  };
}

export type MetricValue = {
  value: number | null;
  reason: string | null;
};

export function metric(value: number | null, reason: string | null = null): MetricValue {
  if (value == null || !Number.isFinite(value)) {
    return { value: null, reason: reason ?? "unavailable" };
  }
  return { value, reason: null };
}

export function insufficient(reason: string): MetricValue {
  return { value: null, reason };
}
