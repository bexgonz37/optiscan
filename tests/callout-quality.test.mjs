import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCalloutQuality, passesGoldTrade, passesGoldWatch } from "../lib/callout-quality.ts";

const meta = {
  setupScore: 93,
  shortRate: 0.347,
  surge: 4.02,
  direction: "bullish",
  moveStatus: "early",
  callWatch: 75,
  putWatch: 33,
  worthScore: 90,
  contractScore: 90,
  liquidityScore: 81,
  efficiency: 0.45,
  accel: 0.12,
  aboveVwap: true,
  hodBreak: false,
  lodBreak: false,
  tradeBlockers: [],
};

test("META #436 passes gold TRADE bar", () => {
  assert.equal(evaluateCalloutQuality(meta).tier, "TRADE");
  assert.equal(passesGoldTrade(meta).length, 0);
});

test("GOOGL-class weak speed fails gold bar (was 0% follow-through @5m)", () => {
  const googl = { ...meta, shortRate: 0.171, surge: 4.45, setupScore: 96 };
  assert.equal(evaluateCalloutQuality(googl).tier, "SKIP");
  assert.ok(passesGoldTrade(googl).some((f) => f.includes("0.28")));
});

test("PLTR-class continuing + weak surge is SKIP", () => {
  const pltr = {
    ...meta,
    shortRate: 0.203,
    surge: 1.47,
    moveStatus: "continuing",
    setupScore: 81,
    callWatch: 88,
    putWatch: 35,
  };
  assert.equal(evaluateCalloutQuality(pltr).tier, "SKIP");
});

test("Strong WATCH passes popup bar without full META BUY numbers", () => {
  const watch = {
    ...meta,
    shortRate: 0.22,
    surge: 2.4,
    setupScore: 80,
    callWatch: 68,
    putWatch: 40,
    worthScore: 75,
    contractScore: 65,
  };
  assert.equal(evaluateCalloutQuality(watch).tier, "WATCH");
  assert.ok(passesGoldWatch(watch).length === 0);
});
