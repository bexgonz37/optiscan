/**
 * lib/research/forward/schema.ts — Phase F (forward paper validation + two-speed alerts) types.
 * PURE. No I/O. Every field a recommendation carries is DECISION-TIME (knowable before the
 * outcome); outcomes live in a SEPARATE table so a recommendation is never mutated after the fact.
 *
 * Safety invariants (unchanged from production): BEARISH_ACTIONABLE off ⇒ bearish is research-only,
 * bearish-gate.ts is the final authority, puts are RESEARCH_ONLY, and nothing here executes real money.
 */

export const FORWARD_SCHEMA_VERSION = 1;

/** Two-speed alert lifecycle. EARLY_WATCH ships fast; the rest are confirmation UPDATES. */
export type AlertState = "EARLY_WATCH" | "CONFIRMED" | "CANCELED" | "TOO_LATE" | "EXPIRED";
export const ALERT_STATES: AlertState[] = ["EARLY_WATCH", "CONFIRMED", "CANCELED", "TOO_LATE", "EXPIRED"];

/** Forward grading horizons (same ladder as the episode labels). */
export const FORWARD_HORIZONS = ["15m", "30m", "1h", "EOD", "1d", "3d", "5d"] as const;
export type ForwardHorizon = (typeof FORWARD_HORIZONS)[number];

export type ThesisDirection = "bullish" | "bearish";
export type Vehicle = "call" | "put" | "stock";
export type Tenor = "0dte" | "short" | "longer" | "na";

export interface StrategyBucket { direction: ThesisDirection; vehicle: Vehicle; tenor: Tenor; key: string }

/** Deterministic strategy bucket so forward performance can be split as required. */
export function classifyStrategy(input: { direction: string; vehicle: string; dte?: number | null }): StrategyBucket {
  const direction: ThesisDirection = String(input.direction).toLowerCase() === "bearish" ? "bearish" : "bullish";
  const v = String(input.vehicle).toLowerCase();
  const vehicle: Vehicle = v === "put" ? "put" : v === "stock" ? "stock" : "call";
  let tenor: Tenor = "na";
  if (vehicle !== "stock") {
    const dte = input.dte ?? null;
    tenor = dte == null ? "na" : dte <= 0 ? "0dte" : dte < 10 ? "short" : "longer";
  }
  const key = vehicle === "stock" ? `${direction}_stock` : `${direction}_${vehicle}_${tenor}`;
  return { direction, vehicle, tenor, key };
}

/** One consistent-clock latency record for a single alert. All values are epoch-ms from Date.now(). */
export const LATENCY_STAGES = [
  "market_data_received", "trigger_detected", "hard_gate_start", "hard_gate_end", "early_watch_queued",
  "discord_request_start", "discord_request_end", "options_analysis_start", "options_analysis_end",
  "news_analysis_start", "news_analysis_end", "analog_lookup_start", "analog_lookup_end",
  "confirmation_decision", "final_discord_update",
] as const;
export type LatencyStage = (typeof LATENCY_STAGES)[number];
export type LatencyRecord = Partial<Record<LatencyStage, number>>;

/** Immutable, decision-time recommendation captured BEFORE the outcome is known. */
export interface ForwardRecommendation {
  recId: string;                 // deterministic; capture is idempotent and never overwritten
  schemaVersion: number;
  capturedAtMs: number;          // decision time (t0)
  tradingDay: string;
  symbol: string;
  strategy: StrategyBucket;
  direction: ThesisDirection;
  side: Vehicle;
  productionEligible: boolean;   // false for research-only (e.g. puts with BEARISH_ACTIONABLE off)
  researchOnly: boolean;
  underlyingPrice: number;       // OBSERVED at decision time
  observedAtMs: number;          // when underlyingPrice was observed
  contract: { optionSymbol: string; strike: number; expiration: string; dte: number; bid: number | null; ask: number | null; spreadPct: number | null } | null;
  entryZone: [number, number] | null;
  maxChasePct: number | null;    // freshness / slippage threshold
  confidence: number;            // calibrated win probability (0..1)
  analogCount: number;
  effectiveSample: number;
  catalyst: string | null;
  technicalState: Record<string, number> | null;
  gatesPassed: string[];
  rejectionReason: string | null;
  abstainReason: string | null;
  outcomeBasis: string;          // OBSERVED underlying vs MODELED option — carried verbatim
  provenance: { source: string; backtestReportId: string | null };
}

/** Forward outcome graded at a horizon. Written to a SEPARATE table; recommendation stays immutable. */
export interface ForwardOutcome {
  recId: string;
  horizon: ForwardHorizon;
  labelAsOfMs: number;           // MUST be > capturedAtMs (forward-only, no look-ahead)
  returnPct: number;             // side-aware underlying return
  win: boolean;
  mfePct: number;
  maePct: number;
  outcomeKind: "REAL_UNDERLYING"; // never a modeled option fill
}
