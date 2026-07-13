import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  firstFailedGate,
  shouldRecordNearMiss,
  recordNearMiss,
  nearMinuteBudget,
  NEAR_MISS_BUFFER_MAX,
  NEAR_MISS_THROTTLE_MS,
} from "../lib/near-miss.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const GATES_ALL_PASS = { persistOk: true, accelOk: true, tapeMoving: true, shouldTrigger: true, cooldownBlocked: false };

function entry(symbol = "SPY", t = 1_000_000) {
  return {
    t, symbol, session: "regular", failedGate: "persistOk",
    gates: { ...GATES_ALL_PASS, persistOk: false },
    values: { shortRate: 0.14, accel: 0.01, surge: 1.1, efficiency: 0.4, hodBreak: false, lodBreak: false },
    thresholds: { minRate: 0.17, minSurge: 1.32, minEfficiency: 0.3, minAccel: 0 },
  };
}

test("firstFailedGate follows the loop's evaluation order", () => {
  assert.equal(firstFailedGate({ ...GATES_ALL_PASS, cooldownBlocked: true, persistOk: false }), "cooldown");
  assert.equal(firstFailedGate({ ...GATES_ALL_PASS, persistOk: false }), "persistOk");
  assert.equal(firstFailedGate({ ...GATES_ALL_PASS, accelOk: false }), "accelOk");
  assert.equal(firstFailedGate({ ...GATES_ALL_PASS, tapeMoving: false }), "tapeMoving");
  assert.equal(firstFailedGate({ ...GATES_ALL_PASS, shouldTrigger: false }), "shouldTrigger");
  assert.equal(firstFailedGate(GATES_ALL_PASS), null, "all gates pass = it fired, no near-miss");
});

test("per-symbol throttle: one row per window", () => {
  assert.equal(shouldRecordNearMiss(undefined, 1_000_000), true);
  assert.equal(shouldRecordNearMiss(0, 1_000_000), true);
  assert.equal(shouldRecordNearMiss(1_000_000, 1_000_000 + NEAR_MISS_THROTTLE_MS - 1), false);
  assert.equal(shouldRecordNearMiss(1_000_000, 1_000_000 + NEAR_MISS_THROTTLE_MS), true);
});

test("ring buffer: newest first, bounded", () => {
  const buf = [];
  for (let i = 0; i < NEAR_MISS_BUFFER_MAX + 10; i++) {
    recordNearMiss(buf, entry(`SYM${i}`, i));
  }
  assert.equal(buf.length, NEAR_MISS_BUFFER_MAX);
  assert.equal(buf[0].symbol, `SYM${NEAR_MISS_BUFFER_MAX + 9}`, "newest entry first");
});

test("nearMinuteBudget: defers at 90% of the minute cap, never with cap disabled", () => {
  assert.equal(nearMinuteBudget({ callsThisMinute: 251, minuteCap: 280 }), false);
  assert.equal(nearMinuteBudget({ callsThisMinute: 252, minuteCap: 280 }), true);
  assert.equal(nearMinuteBudget({ callsThisMinute: 280, minuteCap: 280 }), true);
  assert.equal(nearMinuteBudget({ callsThisMinute: 99999, minuteCap: 0 }), false, "cap 0 = disabled");
  assert.equal(nearMinuteBudget(null), false);
});

test("scanner loop wires near-miss + deferral without deferring trigger-path chains (source spec)", () => {
  const src = readFileSync(join(root, "lib/scanner-loop.ts"), "utf8");
  // observability wired
  assert.ok(src.includes("recordNearMiss"), "loop must record near-misses");
  assert.ok(src.includes("firstFailedGate"), "loop must classify the failed gate");
  assert.ok(src.includes("nearMisses: s.nearMisses.slice(0, 25)"), "loopState must expose nearMisses");
  // budget deferral wired for non-critical calls only
  assert.ok(src.includes("nearMinuteBudget(getCallStats(nowMs))"), "warm prefetch/news must consult the minute budget");
  // original gate path remains, with only the named core bullish impulse exception.
  assert.ok(src.includes("(persistOk && accelOk && tapeMoving && shouldTriggerOk)"),
    "fire condition must keep the original persist/accel/tape/trigger path");
  assert.ok(src.includes("|| coreBullishImpulse"),
    "only the named core bullish impulse path may bypass shouldTriggerOk");
  // trigger-path chain fetch is not budget-gated
  const handleTrigger = src.slice(src.indexOf("async function handleTrigger"), src.indexOf("/** Refresh live option quotes"));
  assert.ok(!handleTrigger.includes("nearMinuteBudget"), "trigger-path chain fetch must never be deferred");
});

test("/api/scanner/live returns loopState (nearMisses ride along)", () => {
  const src = readFileSync(join(root, "app/api/scanner/live/route.ts"), "utf8");
  assert.ok(src.includes("loopState"), "live route must serve loopState()");
});
