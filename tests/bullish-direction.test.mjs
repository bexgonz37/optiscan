import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bullishDirectionOk, bullishDirectionConfig, BULLISH_ALLOWED_CLASSES } from "../lib/bullish-direction.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// A genuine fresh after-hours accelerator: positive velocity + positive current returns, above base.
const freshAH = (over = {}) => ({
  session: "afterhours", direction: "bullish", shortRate: 0.35,
  ret10sPct: 0.12, ret30sPct: 0.18, ret60sPct: 0.25,
  aboveVwap: true, hodBreak: true, classification: "FRESH_ACCELERATION",
  vwapDistPct: 0.8, quoteAgeMs: 2000, ...over,
});

test("META case: after-hours DOWN and still falling → NOT bullish", () => {
  // Regular session closed +4.7% but AH is falling: current returns negative.
  const v = bullishDirectionOk(freshAH({ shortRate: -0.4, ret10sPct: -0.2, ret30sPct: -0.3, ret60sPct: -0.5 }));
  assert.equal(v.ok, false);
  assert.equal(v.currentDirection, "down");
  assert.equal(v.failedInvariant, "velocity_not_bullish");
});

test("weak bounce inside an after-hours decline → NOT bullish (30s still red)", () => {
  // A 10s pop but 30s/60s still negative — the classic dead-cat bounce.
  const v = bullishDirectionOk(freshAH({ shortRate: 0.22, ret10sPct: 0.10, ret30sPct: -0.15, ret60sPct: -0.4 }));
  assert.equal(v.ok, false);
  assert.equal(v.failedInvariant, "ret30s_not_bullish");
});

test("60s deep-red reversal bounce → NOT bullish", () => {
  const v = bullishDirectionOk(freshAH({ ret10sPct: 0.12, ret30sPct: 0.08, ret60sPct: -0.9 }));
  assert.equal(v.ok, false);
  assert.equal(v.failedInvariant, "ret60s_reversal");
});

test("regular-session gain does NOT matter — invariant never reads the day move", () => {
  // No day-move field exists in the input at all; only current-session evidence.
  const v = bullishDirectionOk(freshAH());
  assert.equal(v.ok, true);
  assert.equal(v.currentDirection, "up");
});

test("valid fresh after-hours acceleration → allowed", () => {
  assert.equal(bullishDirectionOk(freshAH()).ok, true);
});

test("valid premarket runner → allowed (session-aware config, stricter but passes)", () => {
  const v = bullishDirectionOk(freshAH({ session: "premarket" }));
  assert.equal(v.ok, true);
});

test("valid regular-session runner → allowed", () => {
  const v = bullishDirectionOk(freshAH({ session: "regular" }));
  assert.equal(v.ok, true);
});

test("bearish direction never passes the bullish invariant", () => {
  const v = bullishDirectionOk(freshAH({ direction: "bearish" }));
  assert.equal(v.ok, false);
  assert.equal(v.failedInvariant, "not_bullish");
});

test("blocked classes (slow grinder / late exhaustion / noisy) never pass", () => {
  for (const c of ["SLOW_GRINDER", "LATE_EXHAUSTION", "NOISY_ILLIQUID_SPIKE"]) {
    const v = bullishDirectionOk(freshAH({ classification: c }));
    assert.equal(v.ok, false, c);
    assert.equal(v.failedInvariant, "class_not_allowed");
  }
  assert.ok(BULLISH_ALLOWED_CLASSES.has("FRESH_ACCELERATION"));
  assert.ok(BULLISH_ALLOWED_CLASSES.has("CONTINUATION"));
});

test("stale quote is rejected (can't prove current direction)", () => {
  const v = bullishDirectionOk(freshAH({ quoteAgeMs: 60_000 }));
  assert.equal(v.ok, false);
  assert.equal(v.failedInvariant, "stale_quote");
});

test("excessive extension above base is rejected", () => {
  const v = bullishDirectionOk(freshAH({ vwapDistPct: 5.0 }));
  assert.equal(v.ok, false);
  assert.equal(v.failedInvariant, "extended");
});

test("below base and not breaking session high is rejected", () => {
  const v = bullishDirectionOk(freshAH({ aboveVwap: false, hodBreak: false }));
  assert.equal(v.ok, false);
  assert.equal(v.failedInvariant, "below_base");
});

test("extended-hours config demands more evidence than regular", () => {
  const ah = bullishDirectionConfig("afterhours", {});
  const reg = bullishDirectionConfig("regular", {});
  assert.ok(ah.minRet30sPct >= reg.minRet30sPct);
  assert.ok(ah.minShortRatePctMin >= reg.minShortRatePctMin);
});

// ── wiring (capture path needs the DB alias — assert on source) ──
test("captureStockAlert enforces the invariant and downgrades LONG TRADE on failure", () => {
  const src = readFileSync(join(root, "lib/stock-capture.ts"), "utf8");
  assert.match(src, /bullishDirectionOk/, "invariant evaluated at capture");
  assert.match(src, /directionBlocksTrade/, "LONG BUY downgraded when the invariant fails");
  assert.match(src, /ret10sPct: sig\.ret10sPct/, "session-current returns feed the invariant");
});

test("delivery-time revalidation suppresses + persists DELIVERY_REVALIDATION_FAILED", () => {
  const src = readFileSync(join(root, "lib/stock-capture.ts"), "utf8");
  assert.match(src, /revalidateBullishAtDelivery/, "delivery-time revalidation present");
  assert.match(src, /DELIVERY_REVALIDATION_FAILED/, "exact suppression code persisted");
  assert.match(src, /freshestTapeRow/, "uses the freshest in-memory tape (no new provider call)");
  assert.match(src, /suppressAlertDelivery/, "the alert is downgraded so paper/Discord skip it");
});

test("scanner passes session-current returns into the capture verdict", () => {
  const src = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");
  assert.match(src, /ret10sPct: opts\.ret10s/, "ret10s threaded into captureStockAlert");
  assert.match(src, /ret30sPct: opts\.ret30s/, "ret30s threaded into captureStockAlert");
});

test("REGRESSION: AI stays out of the live stock capture path", () => {
  const src = readFileSync(join(root, "lib/stock-capture.ts"), "utf8");
  assert.doesNotMatch(src, /from "@\/lib\/ai\//, "no AI import in stock-capture");
  assert.doesNotMatch(src, /anthropic|openai|callModel/i, "no model calls in capture");
});
