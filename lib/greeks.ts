/**
 * Black-Scholes greeks + Newton–Raphson implied vol.
 * Time T is fractional years from minutes remaining to 16:00 ET — critical for 0DTE.
 * Pure; no provider calls.
 */
export type OptionSide = "call" | "put";

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/** Abramowitz & Stegun erf approximation → CDF. */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Minutes remaining until 16:00 America/New_York on the given epoch ms day. */
export function minutesToEtClose(nowMs: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  const hh = Number(parts.hour === "24" ? "0" : parts.hour);
  const mm = Number(parts.minute);
  const ss = Number(parts.second);
  const nowMins = hh * 60 + mm + ss / 60;
  const closeMins = 16 * 60;
  return Math.max(0, closeMins - nowMins);
}

/**
 * Year fraction for options pricing.
 * Prefer minutes-to-close on expiration day; else use dte + remaining session fraction.
 */
export function timeToExpiryYears(opts: {
  nowMs: number;
  dte: number | null | undefined;
  expiration?: string | null;
}): number {
  const mins = minutesToEtClose(opts.nowMs);
  const dte = opts.dte != null && Number.isFinite(opts.dte) ? Math.max(0, Number(opts.dte)) : null;
  if (dte === 0 || (dte != null && dte <= 0)) {
    // ~390 regular-session minutes / 252 trading days
    return Math.max(1 / (252 * 390), mins / (252 * 390));
  }
  if (dte != null) {
    return Math.max(1 / (252 * 390), (dte + mins / 390) / 252);
  }
  return Math.max(1 / (252 * 390), mins / (252 * 390));
}

export function bsPrice(
  side: OptionSide,
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) {
    return side === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  if (side === "call") return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

export function bsGreeks(
  side: OptionSide,
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): { price: number; delta: number; gamma: number; theta: number; vega: number } {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) {
    const intrinsic = side === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
    return {
      price: intrinsic,
      delta: side === "call" ? (S > K ? 1 : 0) : (S < K ? -1 : 0),
      gamma: 0,
      theta: 0,
      vega: 0,
    };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const pdf = normPdf(d1);
  const gamma = pdf / (S * sigma * sqrtT);
  const vega = (S * pdf * sqrtT) / 100; // per 1 vol point
  let delta: number;
  let theta: number;
  if (side === "call") {
    delta = normCdf(d1);
    theta =
      (-(S * pdf * sigma) / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCdf(d2)) / 365;
  } else {
    delta = normCdf(d1) - 1;
    theta =
      (-(S * pdf * sigma) / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCdf(-d2)) / 365;
  }
  return {
    price: bsPrice(side, S, K, T, r, sigma),
    delta: +delta.toFixed(6),
    gamma: +gamma.toFixed(8),
    theta: +theta.toFixed(6),
    vega: +vega.toFixed(6),
  };
}

/** Brenner–Subrahmanyam seed for IV. */
function ivSeed(side: OptionSide, S: number, K: number, T: number, price: number): number {
  const disc = Math.sqrt((2 * Math.PI) / Math.max(T, 1e-8));
  const seed = (price / S) * disc;
  return Math.min(5, Math.max(0.01, seed || 0.3));
}

/** Newton–Raphson implied vol (3–8 iterations typical). */
export function impliedVol(
  side: OptionSide,
  S: number,
  K: number,
  T: number,
  r: number,
  marketPrice: number,
  opts?: { maxIter?: number; tol?: number },
): number | null {
  if (!(marketPrice > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
  const intrinsic = side === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
  if (marketPrice < intrinsic * 0.999) return null;
  let sigma = ivSeed(side, S, K, T, marketPrice);
  const maxIter = opts?.maxIter ?? 12;
  const tol = opts?.tol ?? 1e-6;
  for (let i = 0; i < maxIter; i++) {
    const price = bsPrice(side, S, K, T, r, sigma);
    const diff = price - marketPrice;
    if (Math.abs(diff) < tol) return +sigma.toFixed(8);
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const vega = S * normPdf(d1) * sqrtT;
    if (!(vega > 1e-12)) break;
    sigma = Math.min(5, Math.max(1e-4, sigma - diff / vega));
  }
  const final = bsPrice(side, S, K, T, r, sigma);
  return Math.abs(final - marketPrice) < 0.05 ? +sigma.toFixed(8) : null;
}
