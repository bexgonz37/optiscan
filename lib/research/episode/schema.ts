/**
 * lib/research/episode/schema.ts — the Setup Episode contract (Analog Engine, Phase A).
 * PURE types + deterministic helpers. No I/O.
 *
 * The Episode is the unit of historical memory. It is split by PROVENANCE ZONE so
 * look-ahead leakage is structurally impossible:
 *   Zone A — decision-time context (this file's `Episode`) — the ONLY thing retrieval
 *            may read. Every feature block carries its own `asOfMs`, all <= t0Ms.
 *   Zone B — forward outcomes (`EpisodeLabel`) — computed strictly after t0.
 *   Zone C — real executions (existing paper_trades).
 *   Zone D — counterfactual/observation (existing counterfactual_outcomes).
 *
 * Nothing here consults an outcome. Nothing here fabricates data — a missing block is
 * null and its absence is recorded, never zero-filled.
 */

export const FEATURE_SCHEMA_VERSION = 1;

export type EpisodeSource = "replay" | "live_scanner" | "live_supervisor";
export type EpisodeSession = "premarket" | "regular" | "afterhours" | "closed";
export type ThesisSide = "bullish" | "bearish";

/** Fixed intraday horizons (ms). EOD and day-based horizons are resolved at label time
 *  against the trading calendar, so they are marked, not given a fixed ms offset. */
export type Horizon = "15m" | "30m" | "1h" | "EOD" | "1d" | "3d" | "5d" | "10d";
export const HORIZONS: readonly Horizon[] = Object.freeze(["15m", "30m", "1h", "EOD", "1d", "3d", "5d", "10d"]);
export const INTRADAY_HORIZON_MS: Partial<Record<Horizon, number>> = Object.freeze({
  "15m": 15 * 60_000, "30m": 30 * 60_000, "1h": 60 * 60_000,
});
/** Whole-trading-day horizons (resolved against the session calendar at label time). */
export const DAY_HORIZONS: Partial<Record<Horizon, number>> = Object.freeze({ "1d": 1, "3d": 3, "5d": 5, "10d": 10 });

export type TargetKind = "UNDERLYING" | "OPTION_ATM_CALL" | "OPTION_OTM_CALL" | "OPTION_ATM_PUT" | "OPTION_OTM_PUT";
export const TARGET_KINDS: readonly TargetKind[] = Object.freeze(["UNDERLYING", "OPTION_ATM_CALL", "OPTION_OTM_CALL", "OPTION_ATM_PUT", "OPTION_OTM_PUT"]);
export type OutcomeKind = "REAL_UNDERLYING" | "MODELED_OPTION";

/** One Zone-A feature block. `asOfMs` is the timestamp of the LATEST input that produced
 *  it — the leakage guard requires asOfMs <= t0Ms. `values` never contains fabricated data. */
export interface FeatureBlock {
  asOfMs: number;
  values: Record<string, number | string | boolean | null>;
}

export type FeatureBlockName =
  | "priceStructure" | "momentum" | "volume" | "volatility" | "regime"
  | "sector" | "breadth" | "optionsContext" | "catalyst" | "liquidity" | "dataQuality";

export interface Episode {
  source: EpisodeSource;
  symbol: string;
  /** Decision time — the ONLY time Zone A may reference. */
  t0Ms: number;
  tradingDay: string;
  session: EpisodeSession;
  todBucket: string | null;
  assetClass: "stock" | "option";
  direction: ThesisSide | null;
  regimeLabel: string | null;
  regimeModelVersion: number | null;
  liquidityTier: string | null;
  validityTier: string | null;
  /** Zone-A feature blocks (any may be null; nulls are recorded in `missing`). */
  blocks: Partial<Record<FeatureBlockName, FeatureBlock | null>>;
  /** Missing-data indicators — which blocks/fields were genuinely unavailable. */
  missing: string[];
  gateResults: unknown;
  featureSchemaVersion: number;
  provenance: Record<string, unknown> | null;
}

export interface EpisodeLabel {
  horizon: Horizon;
  targetKind: TargetKind;
  outcomeKind: OutcomeKind;
  returnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  targetBeforeStop: "TARGET" | "STOP" | "NEITHER" | null;
  timeToTargetMs: number | null;
  timeToInvalidationMs: number | null;
  realizedVol: number | null;
  gapPct: number | null;
  gapFilled: boolean | null;
  modelAssumptions: Record<string, unknown> | null;
  /** Timestamp of the last bar used — MUST be > t0Ms (a Zone-B invariant). */
  labelAsOfMs: number;
}

/** Deterministic, reproducible episode identity (stable hash). */
export function episodeKeyOf(source: EpisodeSource, symbol: string, t0Ms: number, schemaVersion: number = FEATURE_SCHEMA_VERSION): string {
  return `ep_${djb2(`${source}|${symbol.toUpperCase()}|${t0Ms}|${schemaVersion}`)}`;
}

/** Max asOfMs across present feature blocks — the value stored for the leakage guard.
 *  Returns 0 when no blocks are present (an empty episode carries no future information). */
export function maxFeatureAsOf(ep: Episode): number {
  let max = 0;
  for (const b of Object.values(ep.blocks)) if (b && Number.isFinite(b.asOfMs)) max = Math.max(max, b.asOfMs);
  return max;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}
