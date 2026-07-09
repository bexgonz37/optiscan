import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ema, atr, realizedVol, trendScore, momentumScore, participationScore,
  volRegimeScore, contractScore, regimeScore, pickSwingContract, scoreSwingCandidate,
} from "../lib/swing-score.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Synthetic daily bars: steady drift with mild range, constant volume. */
function bars(days, { start = 100, driftPct = 0, rangePct = 1.5, vol = 1_000_000, volRamp = 1 } = {}) {
  const out = [];
  let c = start;
  for (let i = 0; i < days; i++) {
    const o = c;
    c = c * (1 + driftPct / 100);
    const hi = Math.max(o, c) * (1 + rangePct / 200);
    const lo = Math.min(o, c) * (1 - rangePct / 200);
    out.push({ t: i, o, h: hi, l: lo, c, v: vol * (i >= days - 10 ? volRamp : 1) });
  }
  return out;
}

const CONTRACT = {
  optionSymbol: "O:TST260807C00100000", side: "call", strike: 100, expiration: "2026-08-07",
  dte: 24, bid: 2.9, ask: 3.05, mid: 2.98, spreadPct: 5.0, delta: 0.55, iv: 0.3, openInterest: 1200,
};

test("ema/atr/realizedVol primitives behave", () => {
  assert.equal(ema([2, 2, 2, 2], 3).at(-1), 2);
  const a = atr(bars(30, { rangePct: 2 }));
  assert.ok(a > 0);
  const rv = realizedVol(bars(30, { driftPct: 0.5 }));
  assert.ok(rv > 0 && rv < 1);
});

test("trend: strong uptrend outscores chop; downtrend reads bearish stack", () => {
  const up = trendScore(bars(60, { driftPct: 0.8 }));
  const flat = trendScore(bars(60, { driftPct: 0 }));
  const down = trendScore(bars(60, { driftPct: -0.8 }));
  assert.ok(up.score > 70, `up ${up.score}`);
  assert.ok(flat.score < 40, `flat ${flat.score}`);
  assert.ok(down.score > 70, `down-stack is also a (bearish) trend: ${down.score}`);
  assert.match(up.why, /up-stack/);
  assert.match(down.why, /down-stack/);
});

test("momentum: bigger ATR-normalized ROC scores higher", () => {
  const strong = momentumScore(bars(40, { driftPct: 0.9, rangePct: 1.5 }));
  const weak = momentumScore(bars(40, { driftPct: 0.1, rangePct: 1.5 }));
  assert.ok(strong.score > weak.score);
});

test("participation: rising 10d volume scores above fading volume", () => {
  const rising = participationScore(bars(60, { volRamp: 1.6 }));
  const fading = participationScore(bars(60, { volRamp: 0.5 }));
  assert.ok(rising.score > 60);
  assert.ok(fading.score < 20);
});

test("vol regime: dead tape and chaos both score below the sweet spot", () => {
  const dead = volRegimeScore(bars(30, { rangePct: 0.3 }));
  const sweet = volRegimeScore(bars(30, { rangePct: 2.2 }));
  const wild = volRegimeScore(bars(30, { rangePct: 9 }));
  assert.ok(sweet.score > dead.score);
  assert.ok(sweet.score > wild.score);
});

test("contract gates: spread, OI, delta zone, DTE window", () => {
  const pick = (over) => pickSwingContract([{ ...CONTRACT, ...over }], "call");
  assert.ok(pick({}), "baseline qualifies");
  assert.equal(pick({ spreadPct: 9 }), null, "spread > 8% rejected");
  assert.equal(pick({ openInterest: 100 }), null, "thin OI rejected");
  assert.equal(pick({ delta: 0.2 }), null, "lotto delta rejected");
  assert.equal(pick({ dte: 3 }), null, "gamma-week DTE rejected");
  assert.equal(pick({ dte: 50 }), null, "too far out rejected");
});

test("contract selection prefers the 21–28 DTE window near 0.55 delta", () => {
  const picked = pickSwingContract([
    { ...CONTRACT, dte: 10, delta: 0.55, optionSymbol: "TEN" },
    { ...CONTRACT, dte: 24, delta: 0.48, optionSymbol: "SWEET" },
    { ...CONTRACT, dte: 33, delta: 0.55, optionSymbol: "FAR" },
  ], "call");
  assert.equal(picked?.optionSymbol, "SWEET");
});

test("contract economics rewards fair IV vs realized", () => {
  const rv = 0.30;
  const fair = contractScore({ ...CONTRACT, iv: 0.30 }, rv);
  const rich = contractScore({ ...CONTRACT, iv: 0.60 }, rv);
  assert.ok(fair.score > rich.score);
  assert.equal(contractScore(null, rv).score, 0, "no contract = 0");
});

test("market regime: counter-index candidates get dampened", () => {
  const spyUp = bars(60, { driftPct: 0.5 });
  const withIndex = regimeScore(spyUp, "call");
  const against = regimeScore(spyUp, "put");
  assert.ok(withIndex.score > 50);
  assert.ok(against.score < 50);
  assert.equal(regimeScore(null, "call").score, 50, "missing SPY = neutral");
});

test("composite: trending name with a good contract ranks far above chop with none", () => {
  const spy = bars(60, { driftPct: 0.4 });
  const good = scoreSwingCandidate("GOOD", bars(60, { driftPct: 0.8, volRamp: 1.5 }), [CONTRACT], spy);
  const bad = scoreSwingCandidate("BAD", bars(60, { driftPct: 0, rangePct: 0.4 }), [], spy);
  assert.ok(good.score >= bad.score + 30, `${good.score} vs ${bad.score}`);
  assert.equal(good.direction, "call");
  assert.ok(good.bestContract, "contract attached");
  assert.ok(good.flags.some((f) => /earnings/.test(f)), "earnings warning always present");
  assert.ok(good.flags.some((f) => /uncalibrated/.test(f)), "research-preview flag always present");
});

test("every factor is documented in docs/SWING-SCANNER.md", () => {
  const doc = readFileSync(join(root, "docs/SWING-SCANNER.md"), "utf8");
  for (const section of ["F1 Trend", "F2 Momentum", "F3 Participation", "F4 Volatility regime", "F5 Contract economics", "F6 Market regime", "21–28"]) {
    assert.ok(doc.includes(section), `SWING-SCANNER.md missing ${section}`);
  }
});
