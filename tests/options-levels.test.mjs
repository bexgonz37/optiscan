import test from "node:test";
import assert from "node:assert/strict";
import { deriveDecisionLevels } from "../lib/research/options/levels.ts";
import { computeOptionsFeatures, featuresToUnderlying } from "../lib/research/options/features.ts";
import { activeSignals, scoreStrategies } from "../lib/research/options/discovery.ts";

// July → US options session is EDT (UTC-4). ET times below are expressed as their UTC epoch.
const U = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi, 0);
const bar = (t, o, h, l, c, v = 1000) => ({ t, o, h, l, c, v });

test("deriveDecisionLevels: prev-day H/L/close, premarket H/L, opening-range H/L from one bar window", () => {
  const bars = [
    // prev trading day (Fri 2026-07-17)
    bar(U(2026, 7, 17, 15, 0), 103, 106, 102, 105), // prevDayHigh 106, prevDayLow 102
    bar(U(2026, 7, 17, 20, 0), 105, 105.5, 104, 104), // last prev-day bar → prevClose 104
    // today (Mon 2026-07-20) premarket 04:00–09:29 ET
    bar(U(2026, 7, 20, 8, 0), 106, 107, 101, 106), // premarketHigh 107, premarketLow 101
    bar(U(2026, 7, 20, 12, 0), 106, 106.5, 105, 106),
    // today opening range 09:30–09:44 ET
    bar(U(2026, 7, 20, 13, 30), 106.5, 108, 106, 107), // ORHigh 108, ORLow 106
    bar(U(2026, 7, 20, 13, 44), 107, 107.8, 106.5, 107.5),
    // current regular bar 10:00 ET
    bar(U(2026, 7, 20, 14, 0), 107.5, 107.6, 107.2, 107.6),
  ];
  const lv = deriveDecisionLevels(bars, U(2026, 7, 20, 14, 1));
  assert.equal(lv.prevClose, 104);
  assert.equal(lv.prevDayHigh, 106);
  assert.equal(lv.prevDayLow, 102);
  assert.equal(lv.premarketHigh, 107);
  assert.equal(lv.premarketLow, 101);
  assert.equal(lv.openingRangeHigh, 108);
  assert.equal(lv.openingRangeLow, 106);
});

test("deriveDecisionLevels is missing-data-safe: no prev-day / no premarket ⇒ nulls, no fabrication", () => {
  const lv = deriveDecisionLevels([bar(U(2026, 7, 20, 14, 0), 100, 100.5, 99.5, 100)], U(2026, 7, 20, 14, 1));
  assert.equal(lv.prevClose, null);
  assert.equal(lv.prevDayHigh, null);
  assert.equal(lv.premarketHigh, null);
  assert.deepEqual(deriveDecisionLevels([], U(2026, 7, 20, 14, 1)), { prevClose: null, prevDayHigh: null, prevDayLow: null, premarketHigh: null, premarketLow: null, openingRangeHigh: null, openingRangeLow: null });
});

test("UNLOCKS EARLY DETECTION: approaching yesterday's high at NEW intraday highs fires breakout_proximity ONLY with wired levels", () => {
  const now = U(2026, 7, 20, 14, 30);
  // today the stock is grinding to fresh intraday highs (price == hod), still BELOW yesterday's high.
  const bars = [];
  for (let i = 0; i < 30; i++) { const c = 106 + i * (1.6 / 29); bars.push(bar(U(2026, 7, 20, 14, 0) + i * 60_000, c - 0.02, c, c - 0.05, c)); }
  const price = bars[bars.length - 1].c; // ≈107.6, and it is the session high (hodBreak)

  // WITHOUT levels (today's bars only): the only resistance is HOD, which equals price → none above →
  // breakout_proximity cannot fire. This is the pre-fix blind spot.
  const fNo = computeOptionsFeatures(bars, { nowMs: now, session: "regular" });
  const uNo = featuresToUnderlying(fNo);
  assert.equal(fNo.nearestResistanceDistPct, null, "no resistance above price without wired levels");
  assert.equal(activeSignals({ symbol: "X", nowMs: now, session: "regular", tier: 1, underlying: uNo }).has("breakout_proximity"), false);

  // WITH wired levels (yesterday's high 108 sits just above): a real resistance appears → the early
  // pre-breakout signal fires and a level-based strategy becomes plausible.
  const fLv = computeOptionsFeatures(bars, { nowMs: now, session: "regular", prevDayHigh: 108, prevDayLow: 101, prevClose: 105 });
  const uLv = featuresToUnderlying(fLv);
  assert.ok(fLv.nearestResistanceDistPct != null && fLv.nearestResistanceDistPct <= 0.5, "resistance ≈0.37% above → within the breakout-proximity band");
  const active = activeSignals({ symbol: "X", nowMs: now, session: "regular", tier: 1, underlying: uLv });
  assert.equal(active.has("breakout_proximity"), true, "breakout_proximity now fires (early, pre-breakout)");
  const plausibleNo = scoreStrategies({ symbol: "X", nowMs: now, session: "regular", tier: 1, underlying: uNo }).some((s) => s.applicable && s.matched.includes("breakout_proximity"));
  const plausibleLv = scoreStrategies({ symbol: "X", nowMs: now, session: "regular", tier: 1, underlying: uLv }).some((s) => s.matched.includes("breakout_proximity"));
  assert.equal(plausibleNo, false);
  assert.equal(plausibleLv, true, "a level-based strategy keys on the newly-available breakout proximity");
});

test("levels also enable gap context (prevClose) that is null without wiring", () => {
  const bars = [bar(U(2026, 7, 20, 13, 30), 104, 104.2, 103.8, 104), bar(U(2026, 7, 20, 14, 0), 104, 104.3, 103.9, 104.1)];
  const now = U(2026, 7, 20, 14, 1);
  assert.equal(computeOptionsFeatures(bars, { nowMs: now, session: "regular" }).gapPct, null, "no prevClose ⇒ no gap");
  const withGap = computeOptionsFeatures(bars, { nowMs: now, session: "regular", prevClose: 100 });
  assert.ok(withGap.gapPct != null && withGap.gapPct > 0, "prevClose wired ⇒ gap computed (continuation/fade classifiable)");
});
