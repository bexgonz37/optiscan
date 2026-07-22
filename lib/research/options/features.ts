/**
 * lib/research/options/features.ts — decision-time UNDERLYING feature engine for the options monitor
 * (Stage 1.5). PURE. Computes every feature from bars available AT `nowMs` only (no look-ahead), from
 * compact recent 1-minute bars + optional level context. Maps to the monitor's UnderlyingSnapshot so
 * the existing 18-strategy scoring gets richer, earlier evidence. Never fabricates: missing inputs
 * yield null features (recorded), not guesses.
 */
import { sessionState } from "./session-state.ts";

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }
export type Session = "premarket" | "regular" | "afterhours" | "closed";

export interface FeatureContext {
  nowMs: number; session: Session;
  prevClose?: number | null;
  prevDayHigh?: number | null; prevDayLow?: number | null;
  premarketHigh?: number | null; premarketLow?: number | null;
  openingRangeHigh?: number | null; openingRangeLow?: number | null;
  timeOfDayAvgVolume?: number | null; // cumulative volume normally seen by this time of day
  maxBarAgeMs?: number;               // freshness limit for the latest bar
}

export interface OptionsFeatures {
  price: number | null; lastBarAgeMs: number | null; stale: boolean;
  relVolume: number | null; volumeAccel: number | null; dollarVolume: number | null; dollarVolumeAccel: number | null;
  vwap: number | null; vwapDistPct: number | null; aboveVwap: boolean | null;
  hod: number | null; lod: number | null; hodProxPct: number | null; lodProxPct: number | null; hodBreak: boolean | null;
  nearestResistance: number | null; nearestResistanceDistPct: number | null;
  nearestSupport: number | null; nearestSupportDistPct: number | null;
  trendSlopePctPerBar: number | null; shortMomentumPct: number | null; velPct: number | null; accelPct: number | null;
  realizedVol: number | null; realizedVolExpanding: boolean | null; atrPct: number | null;
  compressionScore: number | null; expansionScore: number | null;
  gapPct: number | null; gapBehavior: "continuation" | "fade" | null;
  openingRange: boolean | null; premarketLevelTest: boolean | null;
  missing: string[];
}

const pct = (a: number, b: number) => (b !== 0 ? ((a - b) / b) * 100 : 0);
function std(xs: number[]): number { if (xs.length < 2) return 0; const m = xs.reduce((a, x) => a + x, 0) / xs.length; return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); }
function slope(ys: number[]): number { const n = ys.length; if (n < 2) return 0; const xm = (n - 1) / 2, ym = ys.reduce((a, y) => a + y, 0) / n; let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (i - xm) * (ys[i] - ym); den += (i - xm) ** 2; } return den ? num / den : 0; }

/** Compute the decision-time feature block from compact recent bars (chronological, t ≤ nowMs). */
export function computeOptionsFeatures(barsIn: Bar[], ctx: FeatureContext): OptionsFeatures {
  const missing: string[] = [];
  const openingRangeActive = ctx.session === "regular" && sessionState(ctx.nowMs) === "OPENING_DISCOVERY";
  const bars = [...barsIn].filter((b) => b.t <= ctx.nowMs).sort((a, b) => a.t - b.t);
  const base: OptionsFeatures = {
    price: null, lastBarAgeMs: null, stale: true, relVolume: null, volumeAccel: null, dollarVolume: null, dollarVolumeAccel: null,
    vwap: null, vwapDistPct: null, aboveVwap: null, hod: null, lod: null, hodProxPct: null, lodProxPct: null, hodBreak: null,
    nearestResistance: null, nearestResistanceDistPct: null, nearestSupport: null, nearestSupportDistPct: null,
    trendSlopePctPerBar: null, shortMomentumPct: null, velPct: null, accelPct: null, realizedVol: null, realizedVolExpanding: null, atrPct: null,
    compressionScore: null, expansionScore: null, gapPct: null, gapBehavior: null, openingRange: openingRangeActive ? true : null, premarketLevelTest: null, missing,
  };
  if (bars.length === 0) { missing.push("bars"); return base; }
  const last = bars[bars.length - 1];
  const price = last.c;
  const lastBarAgeMs = ctx.nowMs - last.t;
  const stale = ctx.maxBarAgeMs != null ? lastBarAgeMs > ctx.maxBarAgeMs : lastBarAgeMs > 5 * 60_000;

  // volume / dollar volume
  const cumVol = bars.reduce((a, b) => a + b.v, 0);
  const relVolume = ctx.timeOfDayAvgVolume && ctx.timeOfDayAvgVolume > 0 ? +(cumVol / ctx.timeOfDayAvgVolume).toFixed(3) : (missing.push("timeOfDayAvgVolume"), null);
  const recentN = Math.min(5, bars.length), priorN = Math.min(5, Math.max(0, bars.length - 5));
  const recentVol = bars.slice(-recentN).reduce((a, b) => a + b.v, 0) / recentN;
  const priorVol = priorN > 0 ? bars.slice(-recentN - priorN, -recentN).reduce((a, b) => a + b.v, 0) / priorN : recentVol;
  const volumeAccel = priorVol > 0 ? +((recentVol - priorVol) / priorVol).toFixed(3) : 0;
  const dollarVolume = +(cumVol * price).toFixed(0);
  const dollarVolumeAccel = volumeAccel; // same shape (volume × ~constant price intraday)

  // VWAP
  const vwapNum = bars.reduce((a, b) => a + ((b.h + b.l + b.c) / 3) * b.v, 0);
  const vwap = cumVol > 0 ? +(vwapNum / cumVol).toFixed(4) : null;
  const vwapDistPct = vwap ? +pct(price, vwap).toFixed(4) : null;
  const aboveVwap = vwap != null ? price >= vwap : null;

  // HOD/LOD + proximity
  const hod = Math.max(...bars.map((b) => b.h)), lod = Math.min(...bars.map((b) => b.l));
  const hodProxPct = +Math.abs(pct(price, hod)).toFixed(4), lodProxPct = +Math.abs(pct(price, lod)).toFixed(4);
  const hodBreak = price >= hod - 1e-9;

  // key levels: nearest resistance ABOVE, nearest support BELOW
  const resistances = [ctx.prevDayHigh, ctx.premarketHigh, ctx.openingRangeHigh, hod].filter((x): x is number => x != null && x > price);
  const supports = [ctx.prevDayLow, ctx.premarketLow, ctx.openingRangeLow, lod].filter((x): x is number => x != null && x < price);
  const nearestResistance = resistances.length ? Math.min(...resistances) : null;
  const nearestSupport = supports.length ? Math.max(...supports) : null;
  const nearestResistanceDistPct = nearestResistance != null ? +pct(nearestResistance, price).toFixed(4) : null;
  const nearestSupportDistPct = nearestSupport != null ? +pct(price, nearestSupport).toFixed(4) : null;

  // trend / momentum / acceleration
  const closes = bars.map((b) => b.c);
  const trendSlopePctPerBar = closes.length >= 3 ? +((slope(closes) / price) * 100).toFixed(5) : null;
  const kBack = Math.min(15, bars.length - 1);
  const shortMomentumPct = kBack > 0 ? +pct(price, bars[bars.length - 1 - kBack].c).toFixed(4) : null;
  const velWin = Math.min(5, bars.length - 1);
  const velPct = velWin > 0 ? +pct(price, bars[bars.length - 1 - velWin].c).toFixed(4) : 0;
  const prevVelPct = velWin > 0 && bars.length - 2 - velWin >= 0 ? pct(bars[bars.length - 2].c, bars[bars.length - 2 - velWin].c) : velPct;
  const accelPct = +(velPct - prevVelPct).toFixed(4);

  // volatility / range
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) if (bars[i - 1].c > 0) rets.push(bars[i].c / bars[i - 1].c - 1);
  const realizedVol = +std(rets).toFixed(6);
  const recentRV = +std(rets.slice(-5)).toFixed(6), priorRV = +std(rets.slice(-10, -5)).toFixed(6);
  const realizedVolExpanding = rets.length >= 10 ? recentRV > priorRV * 1.15 : null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  const atr = trs.length ? trs.slice(-14).reduce((a, x) => a + x, 0) / Math.min(14, trs.length) : 0;
  const atrPct = price > 0 ? +((atr / price) * 100).toFixed(4) : null;
  const recentRange = Math.max(...bars.slice(-10).map((b) => b.h)) - Math.min(...bars.slice(-10).map((b) => b.l));
  const compressionScore = atr > 0 ? +(recentRange / (atr * 10)).toFixed(3) : null; // <1 = compressed
  const expansionScore = atr > 0 ? +((last.h - last.l) / atr).toFixed(3) : null;      // >1 = expanding

  // gap
  const gapPct = ctx.prevClose && ctx.prevClose > 0 && bars[0] ? +pct(bars[0].o, ctx.prevClose).toFixed(4) : (missing.push("prevClose"), null);
  const gapBehavior: OptionsFeatures["gapBehavior"] = gapPct == null ? null : (gapPct > 0 ? (price >= bars[0].o ? "continuation" : "fade") : (price <= bars[0].o ? "continuation" : "fade"));

  const premarketLevelTest = ctx.session === "premarket" && ((ctx.premarketHigh != null && Math.abs(pct(price, ctx.premarketHigh)) <= 0.3) || (ctx.premarketLow != null && Math.abs(pct(price, ctx.premarketLow)) <= 0.3));

  return {
    price, lastBarAgeMs, stale, relVolume, volumeAccel, dollarVolume, dollarVolumeAccel,
    vwap, vwapDistPct, aboveVwap, hod, lod, hodProxPct, lodProxPct, hodBreak,
    nearestResistance, nearestResistanceDistPct, nearestSupport, nearestSupportDistPct,
    trendSlopePctPerBar, shortMomentumPct, velPct, accelPct, realizedVol, realizedVolExpanding, atrPct,
    compressionScore, expansionScore, gapPct, gapBehavior, openingRange: openingRangeActive ? true : null, premarketLevelTest, missing,
  };
}

/** Map enriched features → the monitor's UnderlyingSnapshot shape used by activeSignals/scoreStrategies. */
export function featuresToUnderlying(f: OptionsFeatures): {
  price: number | null; dayDollarVolume: number | null; relVolume: number | null; velPct: number | null; accelPct: number | null; gapPct: number | null;
  aboveVwap: boolean | null; hodBreak: boolean | null; nearResistancePct: number | null; compressionPct: number | null; realizedVolExpanding: boolean | null; openingRange: boolean | null; premarketLevelTest: boolean | null;
} {
  // relVolume prefers a real time-of-day baseline; absent that, a bar-based volume-surge PROXY (only
  // when volume is clearly accelerating) so the rel_volume signal can fire without fabricating a baseline.
  const relVolume = f.relVolume ?? (f.volumeAccel != null && f.volumeAccel > 0.5 ? +(2 + f.volumeAccel).toFixed(2) : null);
  return {
    price: f.price, dayDollarVolume: f.dollarVolume, relVolume, velPct: f.velPct, accelPct: f.accelPct, gapPct: f.gapPct,
    aboveVwap: f.aboveVwap, hodBreak: f.hodBreak,
    nearResistancePct: f.nearestResistanceDistPct, compressionPct: f.compressionScore, realizedVolExpanding: f.realizedVolExpanding,
    openingRange: f.openingRange, premarketLevelTest: f.premarketLevelTest,
  };
}
