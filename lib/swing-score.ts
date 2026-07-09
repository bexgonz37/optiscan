/**
 * swing-score.ts — 1–4 week options opportunity scoring (RESEARCH PREVIEW).
 *
 * Pure functions: daily bars + an option chain in, factor scores + a
 * documented composite out. Every formula and weight is explained in
 * docs/SWING-SCANNER.md with its rationale and limitations. Nothing here is
 * an arbitrary magic number without a written reason.
 *
 * STATUS: principled but UNCALIBRATED — formulas follow established momentum/
 * options practice, but they have not yet been validated against OptiScan's
 * own tracked outcomes. Treat rankings as a research queue, not signals.
 */

export interface DailyBar { t: number; o: number; h: number; l: number; c: number; v: number }

export interface SwingContract {
  optionSymbol: string | null;
  side: string;             // "call" | "put"
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadPct: number | null;
  delta: number | null;
  iv: number | null;
  openInterest: number | null;
}

export interface FactorScore { score: number; weight: number; why: string }

export interface SwingCandidate {
  ticker: string;
  direction: "call" | "put";
  score: number; // 0–100 composite
  factors: Record<string, FactorScore>;
  bestContract: SwingContract | null;
  flags: string[];
  suggestedDte: string;
}

// ── Indicator primitives (documented in docs/SWING-SCANNER.md §2) ───────────

export function ema(values: number[], period: number): number[] {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

/** Wilder ATR over daily bars. */
export function atr(bars: DailyBar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prevC = bars[i - 1].c;
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prevC), Math.abs(bars[i].l - prevC)));
  }
  let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

/** Annualized 20-day realized (close-to-close) volatility, as a fraction. */
export function realizedVol(bars: DailyBar[], days = 20): number | null {
  if (bars.length < days + 1) return null;
  const tail = bars.slice(-(days + 1));
  const rets: number[] = [];
  for (let i = 1; i < tail.length; i++) rets.push(Math.log(tail[i].c / tail[i - 1].c));
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const variance = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

// ── Factor scores (formulas + rationale in docs/SWING-SCANNER.md §3) ────────

/** F1 Trend (weight .25): EMA20/EMA50 stack + ATR-normalized EMA20 slope. */
export function trendScore(bars: DailyBar[]): FactorScore {
  const weight = 0.25;
  if (bars.length < 55) return { score: 0, weight, why: "insufficient history (<55 daily bars)" };
  const closes = bars.map((b) => b.c);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const px = closes[closes.length - 1];
  const a = atr(bars) ?? px * 0.02;
  const stackUp = px > e20[e20.length - 1] && e20[e20.length - 1] > e50[e50.length - 1];
  const stackDown = px < e20[e20.length - 1] && e20[e20.length - 1] < e50[e50.length - 1];
  // Slope: EMA20 change over 10 sessions, in ATR units (dimensionless across prices).
  const slopeAtr = (e20[e20.length - 1] - e20[e20.length - 11]) / a;
  const mag = clamp(Math.abs(slopeAtr) * 40, 0, 60); // ±1.5 ATR/10d saturates
  const stacked = stackUp || stackDown ? 40 : 0;
  const aligned = (stackUp && slopeAtr > 0) || (stackDown && slopeAtr < 0);
  const score = clamp(stacked + (aligned ? mag : mag * 0.3));
  return {
    score, weight,
    why: `${stackUp ? "up-stack (px>EMA20>EMA50)" : stackDown ? "down-stack" : "no EMA stack"}, EMA20 slope ${slopeAtr.toFixed(2)} ATR/10d`,
  };
}

/** F2 Momentum (weight .20): 20-day ROC normalized by ATR% (efficiency-adjusted). */
export function momentumScore(bars: DailyBar[]): FactorScore {
  const weight = 0.20;
  if (bars.length < 21) return { score: 0, weight, why: "insufficient history" };
  const px = bars[bars.length - 1].c;
  const then = bars[bars.length - 21].c;
  const rocPct = ((px - then) / then) * 100;
  const a = atr(bars) ?? px * 0.02;
  const atrPct = (a / px) * 100;
  // ROC in "ATR-days": how many typical daily ranges the month's move covered.
  const rocAtr = atrPct > 0 ? rocPct / atrPct : 0;
  const score = clamp(Math.abs(rocAtr) * 12.5); // 8 ATRs over a month = max
  return { score, weight, why: `20d ROC ${rocPct.toFixed(1)}% = ${rocAtr.toFixed(1)} ATRs` };
}

/** F3 Participation (weight .10): 10d vs 50d average volume ratio. */
export function participationScore(bars: DailyBar[]): FactorScore {
  const weight = 0.10;
  if (bars.length < 50) return { score: 0, weight, why: "insufficient history" };
  const avg = (xs: DailyBar[]) => xs.reduce((s, b) => s + b.v, 0) / xs.length;
  const v10 = avg(bars.slice(-10)), v50 = avg(bars.slice(-50));
  const ratio = v50 > 0 ? v10 / v50 : 0;
  const score = clamp((ratio - 0.7) * 100); // 0.7x → 0, 1.7x → 100
  return { score, weight, why: `10d/50d volume ${ratio.toFixed(2)}x` };
}

/** F4 Volatility regime (weight .10): ATR% inside the tradable band 1–6%. */
export function volRegimeScore(bars: DailyBar[]): FactorScore {
  const weight = 0.10;
  const px = bars[bars.length - 1]?.c;
  const a = atr(bars);
  if (!px || !a) return { score: 0, weight, why: "insufficient history" };
  const atrPct = (a / px) * 100;
  let score: number;
  if (atrPct < 0.8) score = clamp(atrPct * 50);            // dead tape — nothing to ride
  else if (atrPct <= 4) score = 100 - Math.abs(atrPct - 2.2) * 20; // sweet spot ~2.2%
  else score = clamp(100 - (atrPct - 4) * 25);             // premium too rich past ~4%
  return { score: clamp(score), weight, why: `ATR ${atrPct.toFixed(1)}% of price` };
}

/** F5 Contract economics (weight .25): spread gate, delta zone, OI, IV vs RV. */
export function contractScore(best: SwingContract | null, rv: number | null): FactorScore {
  const weight = 0.25;
  if (!best) return { score: 0, weight, why: "no qualifying contract (spread/OI gates)" };
  let s = 40; // qualifying at all (passed hard gates) earns the base
  const why: string[] = [`spread ${best.spreadPct?.toFixed(1)}%`];
  if (best.spreadPct != null) s += clamp((8 - best.spreadPct) * 3.5, 0, 25); // tighter = better
  if (best.delta != null) {
    const d = Math.abs(best.delta);
    s += clamp(20 - Math.abs(d - 0.55) * 100, 0, 20); // 0.55Δ swing sweet spot
    why.push(`Δ ${d.toFixed(2)}`);
  }
  if (best.iv != null && rv != null && rv > 0) {
    const ivPremium = best.iv / rv;
    // Buying options priced near/below realized movement = fair; >1.5x = paying up.
    s += ivPremium <= 1.1 ? 15 : ivPremium <= 1.5 ? 8 : 0;
    why.push(`IV ${ (best.iv * 100).toFixed(0) }% vs RV ${(rv * 100).toFixed(0)}%`);
  } else {
    why.push("IV/RV unavailable");
  }
  return { score: clamp(s), weight, why: why.join(", ") };
}

/** F6 Market regime (weight .10): SPY trend agreement (don't fight the index). */
export function regimeScore(spyBars: DailyBar[] | null, direction: "call" | "put"): FactorScore {
  const weight = 0.10;
  if (!spyBars || spyBars.length < 55) return { score: 50, weight, why: "SPY history unavailable — neutral" };
  const t = trendScore(spyBars);
  const closes = spyBars.map((b) => b.c);
  const e20 = ema(closes, 20);
  const spyUp = closes[closes.length - 1] > e20[e20.length - 1];
  const aligned = (direction === "call" && spyUp) || (direction === "put" && !spyUp);
  const score = aligned ? clamp(50 + t.score / 2) : clamp(50 - t.score / 2);
  return { score, weight, why: `SPY ${spyUp ? "above" : "below"} EMA20 — ${aligned ? "with" : "against"} the index` };
}

// ── Contract selection (hard gates documented in §4) ────────────────────────

export const SWING_MAX_SPREAD_PCT = Number(process.env.SWING_MAX_SPREAD_PCT ?? 8);
export const SWING_MIN_OI = Number(process.env.SWING_MIN_OI ?? 250);
export const SWING_DELTA_MIN = 0.40;
export const SWING_DELTA_MAX = 0.70;

export function pickSwingContract(contracts: SwingContract[], direction: "call" | "put"): SwingContract | null {
  const usable = contracts.filter((c) =>
    c.side === direction &&
    c.dte != null && c.dte >= 7 && c.dte <= 35 &&
    c.spreadPct != null && c.spreadPct <= SWING_MAX_SPREAD_PCT &&
    (c.openInterest ?? 0) >= SWING_MIN_OI &&
    c.delta != null && Math.abs(c.delta) >= SWING_DELTA_MIN && Math.abs(c.delta) <= SWING_DELTA_MAX &&
    c.mid != null && c.mid > 0.1,
  );
  // Prefer the 21–28 DTE window (avoids gamma week), then closest to 0.55Δ.
  return usable.sort((a, b) => {
    const dteScore = (c: SwingContract) => (c.dte! >= 21 && c.dte! <= 28 ? 0 : Math.min(Math.abs(c.dte! - 21), Math.abs(c.dte! - 28)));
    const dDelta = (c: SwingContract) => Math.abs(Math.abs(c.delta!) - 0.55);
    return dteScore(a) - dteScore(b) || dDelta(a) - dDelta(b);
  })[0] ?? null;
}

// ── Composite ────────────────────────────────────────────────────────────────

export function scoreSwingCandidate(
  ticker: string,
  bars: DailyBar[],
  contracts: SwingContract[],
  spyBars: DailyBar[] | null,
): SwingCandidate {
  // Direction from the trend factor's stack (trend-following, not mean reversion).
  const closes = bars.map((b) => b.c);
  const e20 = ema(closes, 20);
  const direction: "call" | "put" = closes.length && e20.length && closes[closes.length - 1] >= e20[e20.length - 1] ? "call" : "put";

  const best = pickSwingContract(contracts, direction);
  const rv = realizedVol(bars);
  const factors: Record<string, FactorScore> = {
    trend: trendScore(bars),
    momentum: momentumScore(bars),
    participation: participationScore(bars),
    volRegime: volRegimeScore(bars),
    contract: contractScore(best, rv),
    marketRegime: regimeScore(spyBars, direction),
  };
  const composite = Object.values(factors).reduce((s, f) => s + f.score * f.weight, 0);

  const flags: string[] = [];
  if (!best) flags.push("no fillable 1–4 week contract — watch the shares only");
  flags.push("earnings proximity NOT checked in v1 — verify the earnings date before any trade (IV crush risk)");
  flags.push("research preview: score uncalibrated against tracked outcomes");

  return {
    ticker,
    direction,
    score: Math.round(clamp(composite)),
    factors,
    bestContract: best,
    flags,
    suggestedDte: "21–28 days (rolls past gamma week; documented in SWING-SCANNER.md §4)",
  };
}
