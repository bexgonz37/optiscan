/**
 * lib/research/episode/labels.ts — PURE forward-outcome label computation (Phase A).
 *
 * Labels are Zone-B: computed ONLY from bars strictly after t0 (enforced by
 * assertForwardBars). The underlying label is real; the option label is MODELED from
 * the underlying path + entry Greeks (a documented Greeks/Taylor reprice) and is
 * always flagged MODELED_OPTION — never a real historical fill. Nothing is fabricated:
 * with no forward bars in the window, the labeler returns null (the caller skips it).
 */
import { assertForwardBars } from "./leakage.ts";
import type { EpisodeLabel, Horizon, ThesisSide } from "./schema.ts";

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

function windowBars(bars: Bar[], t0Ms: number, horizonEndMs: number): Bar[] {
  const w = bars.filter((b) => b.t > t0Ms && b.t <= horizonEndMs).sort((a, b) => a.t - b.t);
  assertForwardBars(w, t0Ms);
  return w;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export interface UnderlyingLabelInput {
  t0Ms: number; horizon: Horizon; entryPrice: number; side: ThesisSide;
  forwardBars: Bar[]; horizonEndMs: number;
  /** Target / stop as % of entry (magnitude; direction is applied by side). */
  targetPct: number; stopPct: number;
}

/** Real underlying outcome label. Side-aware: favorable is positive for the thesis. */
export function computeUnderlyingLabel(input: UnderlyingLabelInput): EpisodeLabel | null {
  const w = windowBars(input.forwardBars, input.t0Ms, input.horizonEndMs);
  if (w.length === 0 || !(input.entryPrice > 0)) return null;
  const e = input.entryPrice;
  const sign = input.side === "bullish" ? 1 : -1;
  const last = w[w.length - 1];
  const returnPct = (sign * (last.c - e) / e) * 100;

  // Side-aware excursions.
  let mfe = -Infinity, mae = Infinity;
  for (const b of w) {
    const fav = input.side === "bullish" ? (b.h - e) / e : (e - b.l) / e; // favorable
    const adv = input.side === "bullish" ? (b.l - e) / e : (e - b.h) / e; // adverse (<=0)
    mfe = Math.max(mfe, fav); mae = Math.min(mae, adv);
  }

  // Target-before-stop (conservative: if a bar spans both, count the STOP first).
  const target = input.side === "bullish" ? e * (1 + input.targetPct / 100) : e * (1 - input.targetPct / 100);
  const stop = input.side === "bullish" ? e * (1 - input.stopPct / 100) : e * (1 + input.stopPct / 100);
  let tbs: "TARGET" | "STOP" | "NEITHER" = "NEITHER";
  let ttTarget: number | null = null, ttStop: number | null = null;
  for (const b of w) {
    const stopHit = input.side === "bullish" ? b.l <= stop : b.h >= stop;
    const targetHit = input.side === "bullish" ? b.h >= target : b.l <= target;
    if (stopHit) { tbs = "STOP"; ttStop = b.t - input.t0Ms; break; }
    if (targetHit) { tbs = "TARGET"; ttTarget = b.t - input.t0Ms; break; }
  }

  const rets: number[] = [];
  for (let i = 1; i < w.length; i++) if (w[i - 1].c > 0) rets.push(w[i].c / w[i - 1].c - 1);
  const gapPct = ((w[0].o - e) / e) * 100;
  const gapFilled = input.side === "bullish" ? w.some((b) => b.l <= e) : w.some((b) => b.h >= e);

  return {
    horizon: input.horizon, targetKind: "UNDERLYING", outcomeKind: "REAL_UNDERLYING",
    returnPct: +returnPct.toFixed(4), mfePct: +(mfe * 100).toFixed(4), maePct: +(mae * 100).toFixed(4),
    targetBeforeStop: tbs, timeToTargetMs: ttTarget, timeToInvalidationMs: ttStop,
    realizedVol: +stdev(rets).toFixed(6), gapPct: +gapPct.toFixed(4), gapFilled,
    modelAssumptions: null, labelAsOfMs: last.t,
  };
}

export interface ModeledOptionLabelInput {
  t0Ms: number; horizon: Horizon; targetKind: EpisodeLabel["targetKind"];
  underlyingEntry: number; forwardBars: Bar[]; horizonEndMs: number;
  entryPremium: number; delta: number; gamma: number; theta: number; vega: number; entryIV: number;
  /** Assumed IV change per day in vol points (default 0 — flat IV). Documented, not fabricated data. */
  ivPathPerDay?: number;
  optTargetPct?: number; optStopPct?: number;
}

/**
 * MODELED option outcome via a Greeks/Taylor reprice along the underlying path:
 *   value ≈ premium + δ·dS + ½γ·dS² + θ·dtDays + ν·dIV,  clamped at 0.
 * Explicitly labeled MODELED_OPTION with its assumptions. NOT a real historical fill.
 */
export function computeModeledOptionLabel(input: ModeledOptionLabelInput): EpisodeLabel | null {
  const w = windowBars(input.forwardBars, input.t0Ms, input.horizonEndMs);
  if (w.length === 0 || !(input.entryPremium > 0)) return null;
  const ivPathPerDay = input.ivPathPerDay ?? 0;
  const optTarget = input.entryPremium * (1 + (input.optTargetPct ?? 50) / 100);
  const optStop = input.entryPremium * (1 - (input.optStopPct ?? 30) / 100);

  const value = (bar: Bar): number => {
    const dS = bar.c - input.underlyingEntry;
    const dtDays = (bar.t - input.t0Ms) / 86_400_000;
    const dIV = ivPathPerDay * dtDays;
    const v = input.entryPremium + input.delta * dS + 0.5 * input.gamma * dS * dS + input.theta * dtDays + input.vega * dIV;
    return Math.max(0, v);
  };

  let mfe = -Infinity, mae = Infinity;
  let tbs: "TARGET" | "STOP" | "NEITHER" = "NEITHER";
  let ttTarget: number | null = null, ttStop: number | null = null;
  const optRets: number[] = [];
  let prev: number | null = null;
  for (const b of w) {
    const val = value(b);
    const r = (val - input.entryPremium) / input.entryPremium;
    mfe = Math.max(mfe, r); mae = Math.min(mae, r);
    if (prev != null && prev > 0) optRets.push(val / prev - 1);
    prev = val;
    if (tbs === "NEITHER") {
      if (val <= optStop) { tbs = "STOP"; ttStop = b.t - input.t0Ms; }
      else if (val >= optTarget) { tbs = "TARGET"; ttTarget = b.t - input.t0Ms; }
    }
  }
  const last = w[w.length - 1];
  const returnPct = ((value(last) - input.entryPremium) / input.entryPremium) * 100;

  return {
    horizon: input.horizon, targetKind: input.targetKind, outcomeKind: "MODELED_OPTION",
    returnPct: +returnPct.toFixed(4), mfePct: +(mfe * 100).toFixed(4), maePct: +(mae * 100).toFixed(4),
    targetBeforeStop: tbs, timeToTargetMs: ttTarget, timeToInvalidationMs: ttStop,
    realizedVol: +stdev(optRets).toFixed(6), gapPct: null, gapFilled: null,
    modelAssumptions: { method: "greeks_taylor_reprice", ivPathPerDay, note: "MODELED from underlying path + entry Greeks; not a real historical option fill" },
    labelAsOfMs: last.t,
  };
}
