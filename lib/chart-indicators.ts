/**
 * chart-indicators.ts — series (not scalar) indicator math for the chart panel.
 *
 * The scalar versions in lib/momentum-signals.js (sma/ema/rsi/vwap/macd) return
 * only the latest value, which is what the scanner needs. Charts need the full
 * aligned series, so these mirror the same formulas but emit one point per bar.
 */

export interface Bar {
  t: number; // ms epoch
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface LinePoint {
  time: number; // seconds epoch (lightweight-charts UTCTimestamp)
  value: number;
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const sec = (ms: number) => Math.floor(ms / 1000);

/** Simple moving average series, null until enough data. */
export function smaSeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/** EMA series seeded with the SMA of the first `period` values. */
export function emaSeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  let e = seed / period;
  out[period - 1] = e;
  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** Wilder's RSI series, null until `period` deltas are available. */
export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdSeries {
  macd: (number | null)[];
  signal: (number | null)[];
  hist: (number | null)[];
}

/** MACD line, signal line, and histogram series. */
export function macdSeries(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  const macd = closes.map((_, i) => (isNum(fastE[i]) && isNum(slowE[i]) ? (fastE[i] as number) - (slowE[i] as number) : null));
  const macdDefined = macd.map((v) => (isNum(v) ? (v as number) : 0));
  const firstDefined = macd.findIndex((v) => isNum(v));
  const signalRaw = firstDefined >= 0 ? emaSeries(macdDefined.slice(firstDefined), signalPeriod) : [];
  const signal: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 0; i < signalRaw.length; i++) {
    if (isNum(signalRaw[i])) signal[firstDefined + i] = signalRaw[i];
  }
  const hist = macd.map((v, i) => (isNum(v) && isNum(signal[i]) ? (v as number) - (signal[i] as number) : null));
  return { macd, signal, hist };
}

/** Session-scoped VWAP: cumulative typical*vol / cumulative vol, reset per ET day. */
export function vwapSeries(bars: Bar[]): (number | null)[] {
  const out: (number | null)[] = [];
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
  let day = "";
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const d = isNum(b.t) ? fmt.format(new Date(b.t)) : "";
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const typical = isNum(b.h) && isNum(b.l) && isNum(b.c) ? (b.h + b.l + b.c) / 3 : b.c;
    const v = isNum(b.v) ? b.v : 0;
    pv += typical * v;
    vol += v;
    out.push(vol > 0 ? pv / vol : null);
  }
  return out;
}

/** Map an aligned scalar series to lightweight-charts line points, dropping nulls. */
export function toLine(bars: Bar[], values: (number | null)[]): LinePoint[] {
  const out: LinePoint[] = [];
  for (let i = 0; i < bars.length; i++) {
    const v = values[i];
    if (isNum(v)) out.push({ time: sec(bars[i].t), value: +(v as number).toFixed(4) });
  }
  return out;
}
