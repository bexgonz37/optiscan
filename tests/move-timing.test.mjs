import test from "node:test";
import assert from "node:assert/strict";

import { classifyMoveTiming } from "../lib/move-timing.ts";

const nowMs = Date.UTC(2026, 6, 10, 17, 0, 0);

test("daily bearish context without live speed is not a fresh short", () => {
  const r = classifyMoveTiming({
    direction: "bearish",
    movePct: -6.2,
    shortRate: -0.02,
    instantRate: -0.01,
    surge: 1.8,
    relVol: 2.1,
    lodBreak: false,
    nowMs,
  });
  assert.equal(r.classification, "NO_CURRENT_MOMENTUM");
  assert.equal(r.actionable, false);
});

test("recent breakdown with speed volume and LOD break is fresh", () => {
  const r = classifyMoveTiming({
    direction: "bearish",
    movePct: -2.2,
    shortRate: -0.24,
    instantRate: -0.29,
    surge: 1.7,
    relVol: 2.4,
    lodBreak: true,
    lastConfirmedAtMs: nowMs - 20_000,
    moveBeganAtMs: nowMs - 45_000,
    nowMs,
  });
  assert.equal(r.classification, "FRESH_MOVE");
  assert.equal(r.actionable, true);
});

test("old confirmation is blocked as old move", () => {
  const r = classifyMoveTiming({
    direction: "bullish",
    movePct: 3.1,
    shortRate: 0.22,
    instantRate: 0.24,
    surge: 1.5,
    relVol: 2.0,
    hodBreak: false,
    lastConfirmedAtMs: nowMs - 8 * 60_000,
    moveBeganAtMs: nowMs - 9 * 60_000,
    nowMs,
    recencyWindowMs: 5 * 60_000,
  });
  assert.equal(r.classification, "OLD_MOVE");
  assert.equal(r.actionable, false);
});

test("stale provider data blocks without weakening stale-data checks", () => {
  const r = classifyMoveTiming({
    direction: "bullish",
    movePct: 1.4,
    shortRate: 0.3,
    instantRate: 0.32,
    surge: 2,
    hodBreak: true,
    dataTimestampMs: nowMs - 120_000,
    nowMs,
  });
  assert.equal(r.classification, "STALE_SIGNAL");
  assert.equal(r.actionable, false);
});

test("large day move without fresh level break is extended", () => {
  const r = classifyMoveTiming({
    direction: "bullish",
    movePct: 10.4,
    shortRate: 0.18,
    instantRate: 0.21,
    surge: 1.8,
    relVol: 2,
    hodBreak: false,
    lastConfirmedAtMs: nowMs - 30_000,
    moveBeganAtMs: nowMs - 4 * 60_000,
    nowMs,
  });
  assert.equal(r.classification, "EXTENDED");
  assert.equal(r.actionable, false);
});

test("live speed and volume without level break is continuation", () => {
  const r = classifyMoveTiming({
    direction: "bullish",
    movePct: 2.1,
    shortRate: 0.19,
    instantRate: 0.18,
    surge: 1.6,
    relVol: 1.8,
    hodBreak: false,
    lastConfirmedAtMs: nowMs - 25_000,
    moveBeganAtMs: nowMs - 80_000,
    nowMs,
  });
  assert.equal(r.classification, "CONTINUATION");
  assert.equal(r.actionable, true);
});
