/**
 * Realized volatility estimators + IV premium helper.
 * Parkinson / close-to-close from OHLC bars — no GARCH dependency.
 */
export interface VolBar {
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Annualize from per-bar variance assuming `barsPerYear`. */
function annualize(variance: number, barsPerYear: number): number {
  if (!(variance > 0) || !(barsPerYear > 0)) return 0;
  return Math.sqrt(variance * barsPerYear);
}

/** Close-to-close realized vol (decimal). */
export function closeToCloseRv(bars: VolBar[], barsPerYear = 252 * 390): number | null {
  if (bars.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].c;
    const b = bars[i].c;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return null;
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1);
  return +annualize(v, barsPerYear).toFixed(6);
}

/**
 * Bars-per-year for an intraday bar interval: 252 sessions x 390 RTH minutes.
 * Annualization MUST match the bar interval — treating 5-minute bars as
 * 1-minute ones overstates vol by sqrt(5).
 */
export function barsPerYearForIntervalMs(intervalMs: number): number {
  const minutes = intervalMs / 60_000;
  if (!(minutes > 0)) return 252 * 390;
  return 252 * (390 / minutes);
}

/** Median gap between bar timestamps, for interval inference. */
function inferIntervalMs(bars: Array<{ t?: number | null }>): number {
  const gaps: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1]?.t;
    const b = bars[i]?.t;
    if (a != null && b != null && b > a) gaps.push(b - a);
  }
  if (!gaps.length) return 60_000;
  gaps.sort((x, y) => x - y);
  return gaps[Math.floor(gaps.length / 2)];
}

export interface RvSnapshot {
  realizedVol: number | null;
  dailyRangeFrac: number | null;
  intervalMs: number;
  bars: number;
}

type LooseBar = { t?: number | null; o?: number | null; h?: number | null; l?: number | null; c?: number | null };

/**
 * Annualized realized vol (Parkinson, falling back to close-to-close) plus the
 * range fraction over the supplied bars — the two inputs the universe filter
 * chain and the IV-premium check both need.
 */
export function realizedVolSnapshot(rawBars: LooseBar[], opts?: { intervalMs?: number }): RvSnapshot {
  const bars: VolBar[] = (Array.isArray(rawBars) ? rawBars : [])
    .filter((b) => b?.o != null && b?.h != null && b?.l != null && b?.c != null)
    .map((b) => ({ o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c) }));
  const intervalMs = opts?.intervalMs ?? inferIntervalMs(Array.isArray(rawBars) ? rawBars : []);
  const barsPerYear = barsPerYearForIntervalMs(intervalMs);
  const realizedVol = parkinsonRv(bars, barsPerYear) ?? closeToCloseRv(bars, barsPerYear);
  let dailyRangeFrac: number | null = null;
  if (bars.length) {
    const high = Math.max(...bars.map((b) => b.h));
    const low = Math.min(...bars.map((b) => b.l));
    if (low > 0 && high >= low) dailyRangeFrac = +((high - low) / low).toFixed(6);
  }
  return { realizedVol, dailyRangeFrac, intervalMs, bars: bars.length };
}

/** Parkinson high-low RV (more efficient than close-to-close). */
export function parkinsonRv(bars: VolBar[], barsPerYear = 252 * 390): number | null {
  if (bars.length < 2) return null;
  const factor = 1 / (4 * Math.log(2));
  let sum = 0;
  let n = 0;
  for (const b of bars) {
    if (!(b.h > 0) || !(b.l > 0) || b.h < b.l) continue;
    const x = Math.log(b.h / b.l);
    sum += x * x;
    n += 1;
  }
  if (n < 2) return null;
  return +annualize(factor * (sum / n), barsPerYear).toFixed(6);
}

/**
 * IV premium = contractIV / realizedVol.
 * > ~1.5 means option is priced for a larger move than the stock typically makes.
 */
export function ivPremium(contractIv: number | null | undefined, realizedVol: number | null | undefined): number | null {
  if (contractIv == null || realizedVol == null) return null;
  if (!(contractIv > 0) || !(realizedVol > 0)) return null;
  return +(contractIv / realizedVol).toFixed(4);
}

export function ivPremiumRiskLabel(premium: number | null): "cheap" | "fair" | "rich" | "extreme" | null {
  if (premium == null) return null;
  if (premium < 0.85) return "cheap";
  if (premium < 1.25) return "fair";
  if (premium < 1.75) return "rich";
  return "extreme";
}

/** Simple 25-delta-ish skew proxy from call/put ATM IVs when both exist. */
export function callPutIvSkew(callIv: number | null, putIv: number | null): number | null {
  if (callIv == null || putIv == null) return null;
  if (!(callIv > 0) || !(putIv > 0)) return null;
  return +((putIv - callIv) / ((putIv + callIv) / 2)).toFixed(4);
}
