/**
 * Regime context attachment for Opportunity Case — extends market-context, cannot bypass gates.
 */
import type { OpportunityCase } from "./schema.ts";

export const REGIME_CONFIG_VERSION = "1";

export interface RegimeSnapshot {
  label: string | null;
  reasonCodes: string[];
  timestampMs: number;
  uncertainty: number | null;
  metrics: Record<string, number | string | null>;
  missing: string[];
}

export function attachRegimeToCase(c: OpportunityCase, regime: RegimeSnapshot): OpportunityCase {
  return {
    ...c,
    marketRegime: {
      label: regime.label,
      reasonCodes: regime.reasonCodes,
      timestampMs: regime.timestampMs,
      uncertainty: regime.uncertainty,
      configVersion: REGIME_CONFIG_VERSION,
      freshnessState: regime.label ? "present" : regime.missing.length > 0 ? "missing" : "insufficient",
    },
    updatedAtMs: Date.now(),
  };
}

export function regimeFromMarketContext(ctx: Record<string, unknown> | null, nowMs: number): RegimeSnapshot {
  if (!ctx) {
    return { label: null, reasonCodes: ["no_context"], timestampMs: nowMs, uncertainty: null, metrics: {}, missing: ["market_context"] };
  }
  const label = typeof ctx.regime === "string" ? ctx.regime : typeof ctx.regimeLabel === "string" ? ctx.regimeLabel : null;
  return {
    label,
    reasonCodes: label ? ["market_context_snapshot"] : ["unknown_regime"],
    timestampMs: nowMs,
    uncertainty: label ? 0.2 : 1,
    metrics: {
      trend: typeof ctx.trend === "string" ? ctx.trend : null,
      volatility: typeof ctx.volatilityRegime === "string" ? ctx.volatilityRegime : null,
    } as Record<string, number | string | null>,
    missing: label ? [] : ["regime_label"],
  };
}
