/**
 * lib/research/shadow/analog-bridge.ts — connect the Analog Engine to LIVE candidates in SHADOW
 * mode only (Analog Shadow Bridge). PURE core. Everything here is ANALOG_SHADOW_ONLY.
 *
 * The bridge builds a DECISION-TIME feature snapshot (only data available at that timestamp),
 * queries the (already-fitted) AnalogScorer, and records the evidence + whether it agrees with the
 * live scanner + the lookup latency. It MUST NOT: block EARLY_WATCH, modify actionable scores,
 * modify thresholds, override bearish-gate.ts, make puts actionable, cause a Discord alert, or
 * suppress a live alert. It only produces a record.
 */
import type { AnalogExplain } from "../analog/engine.ts";
import { buildAnalogFeatureVector } from "../analog/feature-vector.ts";

/** Decision-time live features (same keys the episode library uses, so scorer dims line up). */
export interface LiveDecisionFeatures {
  velPct: number; accelPct: number; rvol: number; realizedVol: number; atrPct: number; posInRange: number; gapPct: number;
  liquidityTier: "high" | "medium" | "low"; direction: "bullish" | "bearish"; symbol: string;
}

/**
 * Build the ScoreInput feature record from decision-time live features (no future data).
 *
 * The field definitions come from ANALOG_FEATURE_VECTOR_V1. This used to be a second,
 * independent copy of the vector — including its own `encLiquidity` and `hashNum` — sitting
 * beside the training-side copy in `analog/evaluate.ts`. Two definitions that must agree
 * exactly, in different files, with no shared identity: they agreed only until someone
 * edited one, and the failure would have been silent, because a query vector built in the
 * wrong space still returns a confident number (the metric scores an absent dimension as
 * the training mean).
 *
 * `cmp_direction` keeps the legacy "not bearish ⇒ bullish" reading so the fitted V1 model
 * and this query path stay in the same space; `LiveDecisionFeatures.direction` is a closed
 * union, so the case cannot arise from the live scanner.
 */
export function buildDecisionSnapshot(f: LiveDecisionFeatures, t0Ms: number, id: string): { id: string; t0Ms: number; features: Record<string, number> } {
  const v = buildAnalogFeatureVector({
    velPct: f.velPct, accelPct: f.accelPct, rvol: f.rvol, realizedVol: f.realizedVol,
    atrPct: f.atrPct, posInRange: f.posInRange, gapPct: f.gapPct,
    liquidityTier: f.liquidityTier, direction: f.direction, symbol: f.symbol,
  });
  const features: Record<string, number> = {};
  for (const [k, val] of Object.entries(v.values)) features[k] = val === null ? (k === "cmp_direction" ? 1 : 0) : val;
  return { id, t0Ms, features };
}

export interface LiveScannerDecision { actionable: boolean; direction: "bullish" | "bearish" }

export interface AnalogShadowResult {
  tag: "ANALOG_SHADOW_ONLY";
  symbol: string;
  t0Ms: number;
  abstain: boolean;
  abstainReason: string | null;
  comparableCount: number;         // nAnalogs
  effectiveSample: number;
  confidence: number;              // p (calibrated win prob)
  winRate: number;
  dispersion: number;
  contradiction: number;
  forwardReturn: { p10: number; p50: number; p90: number };
  nearestDistance: number | null;
  agreesWithLive: boolean | null;  // null on abstain
  agreement: "agree_strong" | "agree_weak" | "disagree" | "abstain";
  lookupMs: number;
}

/** Minimal scorer surface (so tests can inject a fake without the full engine). */
export interface ShadowScorer { explain(input: { id: string; t0Ms: number; features: Record<string, number> }): AnalogExplain }

/**
 * Query the analog engine in shadow. `clock()` supplies the single latency clock. Never throws
 * into the caller (a shadow failure must never affect the live path).
 */
export function queryAnalogShadow(scorer: ShadowScorer, f: LiveDecisionFeatures, t0Ms: number, live: LiveScannerDecision, clock: () => number = Date.now): AnalogShadowResult {
  const id = `${f.symbol}_${t0Ms}`;
  const started = clock();
  let ex: AnalogExplain;
  try {
    ex = scorer.explain(buildDecisionSnapshot(f, t0Ms, id));
  } catch {
    ex = { abstain: true, reason: "shadow scorer error", p: 0, nAnalogs: 0, effectiveSample: 0, winRate: 0, expectancy: 0, dispersion: 0, contradiction: 0, p10: 0, p50: 0, p90: 0, nearest: [], nearestWin: null, nearestLoss: null };
  }
  const lookupMs = clock() - started;

  let agreement: AnalogShadowResult["agreement"];
  let agreesWithLive: boolean | null;
  if (ex.abstain) { agreement = "abstain"; agreesWithLive = null; }
  else {
    // Live actionable ⇒ it expects a WIN; analog p is the modeled win prob. Agreement compares them.
    const analogFavorable = ex.p >= 0.5;
    agreesWithLive = live.actionable === analogFavorable;
    agreement = !agreesWithLive ? "disagree" : ex.p >= 0.55 ? "agree_strong" : "agree_weak";
  }

  return {
    tag: "ANALOG_SHADOW_ONLY", symbol: f.symbol, t0Ms,
    abstain: ex.abstain, abstainReason: ex.reason,
    comparableCount: ex.nAnalogs, effectiveSample: ex.effectiveSample, confidence: +ex.p.toFixed(4),
    winRate: ex.winRate, dispersion: ex.dispersion, contradiction: ex.contradiction,
    forwardReturn: { p10: ex.p10, p50: ex.p50, p90: ex.p90 },
    nearestDistance: ex.nearest?.[0]?.distance ?? null,
    agreesWithLive, agreement, lookupMs,
  };
}
