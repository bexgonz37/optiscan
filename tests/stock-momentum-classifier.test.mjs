import test from "node:test";
import assert from "node:assert/strict";
import { classifyStockMomentum, freshMoverGateAllowed } from "../lib/stock-momentum-classifier.ts";

const base = {
  direction: "bullish",
  shortRate: 0.32,
  instantRate: 0.38,
  acceleration: 0.06,
  volumeSurge: 1.8,
  relVol: 2.2,
  volumeAcceleration: 0.28,
  movePct: 2.4,
  vwapDistPct: 0.9,
  hodBreak: true,
  lodBreak: false,
  efficiency: 0.72,
  quoteAgeMs: 900,
  spreadPct: 0.08,
};

test("classifyStockMomentum: fresh accelerating liquid runner", () => {
  const c = classifyStockMomentum(base);
  assert.equal(c.classification, "FRESH_ACCELERATION");
  assert.ok(c.scoreBoost > 0);
  assert.equal(c.fresh, true);
});

test("classifyStockMomentum: slow grinder is not promoted as fresh", () => {
  const c = classifyStockMomentum({
    ...base,
    shortRate: 0.08,
    instantRate: 0.06,
    acceleration: 0.01,
    volumeSurge: 1.05,
    relVol: 1.1,
    volumeAcceleration: 0.02,
    movePct: 2.1,
    hodBreak: false,
  });
  assert.equal(c.classification, "SLOW_GRINDER");
  assert.ok(c.scoreBoost < 0);
});

test("classifyStockMomentum: extended decelerating move is late exhaustion", () => {
  const c = classifyStockMomentum({
    ...base,
    shortRate: 0.18,
    instantRate: 0.12,
    acceleration: -0.08,
    volumeSurge: 1.0,
    relVol: 1.0,
    movePct: 8.5,
    vwapDistPct: 3.1,
    hodBreak: false,
  });
  assert.equal(c.classification, "LATE_EXHAUSTION");
  assert.equal(c.late, true);
});

test("classifyStockMomentum: stale wide-spread spike is noisy/illiquid", () => {
  const c = classifyStockMomentum({
    ...base,
    quoteAgeMs: 18_000,
    spreadPct: 1.1,
  });
  assert.equal(c.classification, "NOISY_ILLIQUID_SPIKE");
});

test("recent-return refinement: up on the day but flat last 60s is a slow grinder", () => {
  const c = classifyStockMomentum({
    ...base,
    shortRate: 0.17, instantRate: 0.15, acceleration: 0.01,
    movePct: 2.2, ret10sPct: 0.02, ret30sPct: 0.03, ret60sPct: 0.05,
    hodBreak: false,
  });
  assert.equal(c.classification, "SLOW_GRINDER");
});

test("recent-return refinement: rolling-over recent returns while up = late exhaustion", () => {
  const c = classifyStockMomentum({
    ...base,
    movePct: 3.5, ret10sPct: -0.1, ret30sPct: -0.05,
  });
  assert.equal(c.classification, "LATE_EXHAUSTION");
  assert.equal(c.late, true);
});

test("recent-return fields absent → classifier behaves exactly as before (fresh stays fresh)", () => {
  const c = classifyStockMomentum(base); // no ret fields
  assert.equal(c.classification, "FRESH_ACCELERATION");
});

test("freshMoverGateAllowed blocks slow/late/noisy, allows fresh/continuation", () => {
  assert.equal(freshMoverGateAllowed("FRESH_ACCELERATION", {}).allowed, true);
  assert.equal(freshMoverGateAllowed("CONTINUATION", {}).allowed, true);
  assert.equal(freshMoverGateAllowed("SLOW_GRINDER", {}).allowed, false);
  assert.equal(freshMoverGateAllowed("LATE_EXHAUSTION", {}).allowed, false);
  assert.equal(freshMoverGateAllowed("NOISY_ILLIQUID_SPIKE", {}).allowed, false);
  // The gate can be disabled (surfaced, never silent).
  assert.equal(freshMoverGateAllowed("SLOW_GRINDER", { STOCK_MOMENTUM_CLASS_GATE: "0" }).allowed, true);
});
