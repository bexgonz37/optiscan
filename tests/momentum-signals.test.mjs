import test from "node:test";
import assert from "node:assert/strict";
import {
  sma,
  ema,
  rsi,
  vwap,
  sessionBars,
  inferBarIntervalMs,
  relativeVolume,
  buildMomentumSignal,
  gradeFromScore,
} from "../lib/momentum-signals.js";

const MIN5 = 5 * 60 * 1000;
// 2026-07-02 15:00:00 UTC = 11:00 ET (regular session, DST)
const SESSION_T0 = Date.parse("2026-07-02T15:00:00Z");

/** Build n 5-min bars ending near SESSION_T0 + n*5min. */
function mkBars(n, { t0 = SESSION_T0, close = (i) => 100 + i * 0.1, vol = () => 1000 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const c = close(i);
    return { t: t0 + i * MIN5, o: c - 0.05, h: c + 0.1, l: c - 0.1, c, v: vol(i) };
  });
}

test("sma / ema return null on thin data and sane values otherwise", () => {
  assert.equal(sma([1, 2], 5), null);
  assert.equal(sma([1, 2, 3, 4], 4), 2.5);
  assert.equal(ema([], 9), null);
  const e = ema([10, 10, 10, 10, 10, 10, 10, 10, 10], 9);
  assert.ok(Math.abs(e - 10) < 1e-9);
});

test("rsi: monotonic rise -> 100, needs period+1 closes", () => {
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.equal(rsi(up), 100);
  assert.equal(rsi(up.slice(0, 10)), null);
  const down = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.ok(rsi(down) < 5);
});

test("vwap weights by volume", () => {
  const bars = [
    { t: 1, o: 10, h: 10, l: 10, c: 10, v: 100 },
    { t: 2, o: 20, h: 20, l: 20, c: 20, v: 300 },
  ];
  // typical prices 10 and 20, weights 100/300 -> 17.5
  assert.equal(vwap(bars), 17.5);
});

test("sessionBars keeps only the latest ET trading day", () => {
  const yesterday = mkBars(10, { t0: SESSION_T0 - 24 * 3600 * 1000 });
  const today = mkBars(10);
  const both = [...yesterday, ...today];
  const s = sessionBars(both);
  assert.equal(s.length, 10);
  assert.equal(s[0].t, today[0].t);
});

test("inferBarIntervalMs infers from timestamps", () => {
  assert.equal(inferBarIntervalMs(mkBars(10)), MIN5);
  assert.equal(inferBarIntervalMs([]), MIN5); // fallback
});

test("relativeVolume ignores the still-forming candle", () => {
  const bars = mkBars(21, { vol: (i) => (i === 20 ? 5 : 100) }); // last bar barely traded yet
  const lastT = bars[bars.length - 1].t;
  // "now" is 10s into the last bar -> it is partial -> compare bar 19 (100) to baseline (100)
  const partialNow = lastT + 10_000;
  assert.equal(relativeVolume(bars, partialNow), 1);
  // once the last bar completes, it becomes the compared bar (5 / 100 = 0.05)
  const completeNow = lastT + MIN5 + 1;
  assert.equal(relativeVolume(bars, completeNow), 0.05);
});

test("relativeVolume: spike on the last completed bar", () => {
  const bars = mkBars(21, { vol: (i) => (i === 19 ? 300 : 100) });
  const now = bars[bars.length - 1].t + 10_000; // last bar partial -> bar 19 is current
  assert.equal(relativeVolume(bars, now), 3);
});

test("relativeVolume returns null on thin data", () => {
  assert.equal(relativeVolume(mkBars(3), SESSION_T0 + 10 * MIN5), null);
  assert.equal(relativeVolume([], Date.now()), null);
});

test("buildMomentumSignal: bullish setup goes long with bounded score", () => {
  const bars = mkBars(60, { close: (i) => 100 + i * 0.2, vol: (i) => (i > 55 ? 3000 : 1000) });
  const now = bars[bars.length - 1].t + MIN5 + 1;
  const sig = buildMomentumSignal(
    { symbol: "test", price: 112, changePercent: 3.2 },
    bars,
    { nowMs: now },
  );
  assert.equal(sig.symbol, "TEST");
  assert.equal(sig.side, "long");
  assert.equal(sig.bias, "bullish");
  assert.ok(sig.score >= 0 && sig.score <= 100);
  assert.equal(sig.grade, gradeFromScore(sig.score));
  assert.ok(sig.reasons.length > 0);
});

test("buildMomentumSignal survives empty bars", () => {
  const sig = buildMomentumSignal({ symbol: "XYZ", price: 50, changePercent: -2 }, []);
  assert.equal(sig.side, "short");
  assert.equal(sig.relVol, null);
  assert.equal(sig.vwap, null);
  assert.ok(Number.isFinite(sig.score));
});

test("buildMomentumSignal caps score for sub-threshold moves and low price", () => {
  const bars = mkBars(60);
  const now = bars[bars.length - 1].t + MIN5 + 1;
  const flat = buildMomentumSignal({ symbol: "A", price: 100, changePercent: 0.2 }, bars, { nowMs: now });
  assert.ok(flat.score <= 45, `expected <=45, got ${flat.score}`);
  const penny = buildMomentumSignal({ symbol: "B", price: 1.5, changePercent: 8 }, bars, { nowMs: now });
  assert.ok(penny.score <= 40, `expected <=40, got ${penny.score}`);
  assert.ok(penny.warnings.some((w) => w.includes("Low price")));
});

test("gradeFromScore thresholds", () => {
  assert.equal(gradeFromScore(80), "STRONG");
  assert.equal(gradeFromScore(79), "GOOD");
  assert.equal(gradeFromScore(64), "WATCH");
  assert.equal(gradeFromScore(49), "SKIP");
});
