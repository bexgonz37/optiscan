import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gateBearishAction, isBearishIntent, BEARISH_DISABLED_REASON } from "../lib/bearish-gate.ts";
import { computeStockVerdict } from "../lib/stock-signals.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
delete process.env.BEARISH_ACTIONABLE; // gate active (default)

// A bearish read that WOULD have been a strong SHORT under the old logic:
const STRONG_BEAR = {
  direction: "bearish", directionConfidence: 85, shortRate: -0.45, accel: -0.03,
  surge: 2.8, relVol: 3.2, efficiency: 0.65, aboveVwap: false,
  hodBreak: false, lodBreak: true, movePct: -2.4,
};

test("even a STRONG bearish stock setup is WAIT, not actionable (gate active)", () => {
  const v = computeStockVerdict(STRONG_BEAR);
  assert.equal(v.action, "WAIT");
  assert.match(v.reason, new RegExp(BEARISH_DISABLED_REASON));
});

test("stock down 0.2% with no breakdown → not actionable", () => {
  const v = computeStockVerdict({ ...STRONG_BEAR, movePct: -0.2, lodBreak: false, shortRate: -0.2, surge: 1.5 });
  assert.notEqual(v.action, "BUY");
});

test("below VWAP with no sell-volume acceleration → not actionable", () => {
  const v = computeStockVerdict({ ...STRONG_BEAR, surge: 1.0, relVol: 0.9, lodBreak: false, movePct: -0.5 });
  assert.notEqual(v.action, "BUY");
});

test("one weak red read with no level break → not actionable", () => {
  const v = computeStockVerdict({ ...STRONG_BEAR, shortRate: -0.18, lodBreak: false, movePct: -0.6, efficiency: 0.4 });
  assert.notEqual(v.action, "BUY");
});

test("bullish behavior is untouched by the gate", () => {
  const v = computeStockVerdict({
    direction: "bullish", directionConfidence: 85, shortRate: 0.45, accel: 0.03,
    surge: 2.8, relVol: 3.2, efficiency: 0.65, aboveVwap: true,
    hodBreak: true, lodBreak: false, movePct: 2.4,
  });
  assert.equal(v.action, "BUY", "strong bullish setups must still fire");
  assert.equal(v.side, "LONG");
});

test("gateBearishAction: demotes put/short/bearish TRADEs, passes bullish", () => {
  assert.equal(gateBearishAction({ direction: "bearish" }, "TRADE").action, "WAIT");
  assert.equal(gateBearishAction({ optionSide: "put" }, "TRADE").gated, true);
  assert.equal(gateBearishAction({ side: "short" }, "BUY").gated, true);
  assert.equal(gateBearishAction({ direction: "bullish", optionSide: "call" }, "TRADE").gated, false);
  assert.equal(gateBearishAction({ direction: "bearish" }, "WAIT").gated, false, "non-actionable passes through");
});

test("re-enable requires explicit BEARISH_ACTIONABLE=1 (rebuild-validated only)", () => {
  process.env.BEARISH_ACTIONABLE = "1";
  assert.equal(gateBearishAction({ direction: "bearish" }, "TRADE").gated, false);
  delete process.env.BEARISH_ACTIONABLE;
  assert.equal(gateBearishAction({ direction: "bearish" }, "TRADE").gated, true);
});

test("isBearishIntent covers direction, put side, and short side", () => {
  assert.equal(isBearishIntent({ direction: "bearish" }), true);
  assert.equal(isBearishIntent({ optionSide: "PUT" }), true);
  assert.equal(isBearishIntent({ side: "short" }), true);
  assert.equal(isBearishIntent({ direction: "bullish", optionSide: "call" }), false);
});

test("options capture path wires the gate at the TRADE decision (source spec)", () => {
  const src = readFileSync(join(root, "lib/alert-capture.ts"), "utf8");
  assert.ok(src.includes("gateBearishAction"), "alert-capture must gate put TRADEs");
  const gateIdx = src.indexOf("gateBearishAction");
  const tierIdx = src.indexOf("const tier = resolveAlertTier");
  assert.ok(gateIdx < tierIdx, "gate must run BEFORE tier resolution so Discord/paper/UI all see WAIT");
});

test("old bearish code is preserved (gated, not deleted)", () => {
  const src = readFileSync(join(root, "lib/stock-signals.ts"), "utf8");
  assert.ok(src.includes('"Bet stock ↓"'), "old bearish branch still present behind the gate");
  assert.ok(src.includes("bearishActionable()"), "env-controlled gate present");
});
