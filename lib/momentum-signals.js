/**
 * momentum-signals.js — pure functions that turn a quote + intraday candles into
 * a ranked momentum signal (score, grade, direction, reasons). No network,
 * no orders — safe to unit test.
 */

export const DEFAULT_MOMENTUM_CONFIG = {
  minPrice: 3,
  minMovePct: 1.0,
  minRelVol: 1.2,
  rsiOverbought: 82,
  rsiOversold: 18,
};

export function momentumConfigFromEnv(env = process.env) {
  return {
    minPrice: Number(env.RADAR_MIN_PRICE ?? DEFAULT_MOMENTUM_CONFIG.minPrice),
    minMovePct: Number(env.RADAR_MIN_MOVE_PCT ?? DEFAULT_MOMENTUM_CONFIG.minMovePct),
    minRelVol: Number(env.RADAR_MIN_REL_VOL ?? DEFAULT_MOMENTUM_CONFIG.minRelVol),
    rsiOverbought: Number(env.RADAR_RSI_OVERBOUGHT ?? DEFAULT_MOMENTUM_CONFIG.rsiOverbought),
    rsiOversold: Number(env.RADAR_RSI_OVERSOLD ?? DEFAULT_MOMENTUM_CONFIG.rsiOversold),
  };
}

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

export function sma(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

export function rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

export function vwap(bars) {
  if (!Array.isArray(bars) || !bars.length) return null;
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    if (!isNum(b.c)) continue;
    const typical = isNum(b.h) && isNum(b.l) ? (b.h + b.l + b.c) / 3 : b.c;
    const v = isNum(b.v) ? b.v : 0;
    pv += typical * v;
    vol += v;
  }
  if (vol <= 0) return null;
  return +(pv / vol).toFixed(4);
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (!Array.isArray(closes) || closes.length < slow + signalPeriod) {
    return { value: null, signal: null, hist: null, bullish: false, bearish: false };
  }
  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) => fastSeries[i] - slowSeries[i]).slice(slow - 1);
  const signalSeries = emaSeries(macdLine, signalPeriod);
  const value = macdLine[macdLine.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  const hist = value - signal;
  return {
    value: +value.toFixed(4),
    signal: +signal.toFixed(4),
    hist: +hist.toFixed(4),
    bullish: value > signal && value > 0,
    bearish: value < signal && value < 0,
  };
}

/** Compute all indicators from OHLCV bars. Returns nulls when data is thin. */
export function computeIndicators(bars = []) {
  const closes = bars.map((b) => b.c).filter(isNum);
  const vols = bars.map((b) => (isNum(b.v) ? b.v : 0));
  const lastClose = closes.length ? closes[closes.length - 1] : null;
  const vw = vwap(bars);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
  const lastVol = vols.length ? vols[vols.length - 1] : null;
  return {
    lastClose,
    vwap: vw,
    rsi: rsi(closes),
    ema9: ema(closes, 9),
    ema20: ema(closes, 20),
    sma50: sma(closes, 50),
    avgVol,
    lastVol,
    relVol: avgVol && avgVol > 0 && isNum(lastVol) ? +(lastVol / avgVol).toFixed(2) : null,
    macd: macd(closes),
    bars: closes.length,
  };
}

function gradeFromScore(score) {
  if (score >= 80) return "STRONG";
  if (score >= 65) return "GOOD";
  if (score >= 50) return "WATCH";
  return "SKIP";
}

/**
 * Build a momentum signal from a quote and intraday candles.
 */
export function buildMomentumSignal(quote = {}, bars = [], opts = {}) {
  const cfg = { ...DEFAULT_MOMENTUM_CONFIG, ...opts };
  const symbol = String(quote.symbol || "").toUpperCase() || null;
  const price = Number(quote.price ?? quote.last ?? 0) || null;
  const movePct = Number(quote.changePercent ?? quote.movePct ?? 0) || 0;
  const ind = computeIndicators(bars);

  const priceVsVwapPct = price && ind.vwap ? +(((price - ind.vwap) / ind.vwap) * 100).toFixed(2) : null;
  const reasons = [];
  const warnings = [];

  let bull = 0;
  let bear = 0;
  if (movePct > 0) bull += 1; else if (movePct < 0) bear += 1;
  if (priceVsVwapPct != null) { if (priceVsVwapPct >= 0) bull += 1; else bear += 1; }
  const stackedUp = isNum(ind.ema9) && isNum(ind.ema20) && ind.ema9 > ind.ema20;
  const stackedDown = isNum(ind.ema9) && isNum(ind.ema20) && ind.ema9 < ind.ema20;
  if (stackedUp) bull += 1; if (stackedDown) bear += 1;
  if (ind.macd.bullish) bull += 1; if (ind.macd.bearish) bear += 1;

  let side = null;
  let bias = "neutral";
  if (bull > bear) { side = "long"; bias = "bullish"; }
  else if (bear > bull) { side = "short"; bias = "bearish"; }
  else if (movePct !== 0) { side = movePct > 0 ? "long" : "short"; bias = movePct > 0 ? "bullish" : "bearish"; }

  const dirUp = side === "long";

  let score = 0;

  const absMove = Math.abs(movePct);
  const movePart = Math.min(30, absMove * 6);
  score += movePart;
  if (absMove >= cfg.minMovePct) reasons.push(`${movePct >= 0 ? "Up" : "Down"} ${absMove.toFixed(1)}% on the day`);

  if (priceVsVwapPct != null) {
    const aligned = dirUp ? priceVsVwapPct >= 0 : priceVsVwapPct < 0;
    if (aligned) { score += 15; reasons.push(`${dirUp ? "Above" : "Below"} VWAP (${priceVsVwapPct > 0 ? "+" : ""}${priceVsVwapPct}%)`); }
    else { warnings.push(`Price ${priceVsVwapPct >= 0 ? "above" : "below"} VWAP against bias`); }
  }

  const trendAligned = dirUp ? stackedUp : stackedDown;
  if (trendAligned) {
    let bonus = 12;
    if (isNum(ind.sma50) && isNum(ind.ema20)) {
      const above50 = dirUp ? ind.ema20 > ind.sma50 : ind.ema20 < ind.sma50;
      if (above50) bonus = 20;
    }
    score += bonus;
    reasons.push(dirUp ? "EMAs stacked up (uptrend)" : "EMAs stacked down (downtrend)");
  }

  if (isNum(ind.rsi)) {
    if (dirUp) {
      if (ind.rsi >= 55 && ind.rsi < 72) { score += 15; reasons.push(`RSI ${ind.rsi} (strong)`); }
      else if (ind.rsi >= 72 && ind.rsi < cfg.rsiOverbought) { score += 8; reasons.push(`RSI ${ind.rsi} (extended)`); }
      else if (ind.rsi >= cfg.rsiOverbought) { score += 2; warnings.push(`Overbought RSI ${ind.rsi}`); }
      else if (ind.rsi >= 45) { score += 5; }
    } else {
      if (ind.rsi <= 45 && ind.rsi > 28) { score += 15; reasons.push(`RSI ${ind.rsi} (weak)`); }
      else if (ind.rsi <= 28 && ind.rsi > cfg.rsiOversold) { score += 8; reasons.push(`RSI ${ind.rsi} (extended down)`); }
      else if (ind.rsi <= cfg.rsiOversold) { score += 2; warnings.push(`Oversold RSI ${ind.rsi}`); }
      else if (ind.rsi <= 55) { score += 5; }
    }
  }

  if (isNum(ind.relVol)) {
    if (ind.relVol >= cfg.minRelVol) {
      const volBonus = Math.min(20, (ind.relVol - 1) * 20);
      score += volBonus;
      reasons.push(`Volume ${ind.relVol}x average`);
    }
  }

  if ((dirUp && ind.macd.bullish) || (!dirUp && ind.macd.bearish)) {
    score += 10;
    reasons.push(`MACD ${dirUp ? "bullish" : "bearish"}`);
  }

  if (price != null && price < cfg.minPrice) {
    warnings.push(`Low price $${price}`);
    score = Math.min(score, 40);
  }
  if (absMove < cfg.minMovePct) {
    score = Math.min(score, 45);
  }

  score = Math.round(Math.max(0, Math.min(100, score)));
  const grade = gradeFromScore(score);

  const accelerating = trendAligned && isNum(ind.relVol) && ind.relVol >= cfg.minRelVol;
  const fading = dirUp ? (priceVsVwapPct != null && priceVsVwapPct < 0) : (priceVsVwapPct != null && priceVsVwapPct > 0);

  return {
    symbol,
    price,
    movePct,
    changePercent: movePct,
    priceVsVwapPct,
    vwap: ind.vwap,
    rsi: ind.rsi,
    relVol: ind.relVol,
    ema9: ind.ema9,
    ema20: ind.ema20,
    sma50: ind.sma50,
    macd: ind.macd,
    momentum: { accelerating, fading },
    trend: stackedUp ? "up" : stackedDown ? "down" : "mixed",
    side,
    bias,
    signalScore: score,
    score,
    grade,
    reason: reasons.slice(0, 4).join(" · ") || "No strong momentum",
    reasons,
    warnings,
    bars: ind.bars,
    generatedAt: new Date().toISOString(),
  };
}

export { gradeFromScore };
