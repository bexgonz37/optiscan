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
