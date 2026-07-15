import test from "node:test";
import assert from "node:assert/strict";
import { gradeEarliness, summarizeEarliness, earlinessConfig } from "../lib/alert-earliness.ts";

const cfg = earlinessConfig({});

test("EARLY: low extension, small day-move, momentum still building", () => {
  const r = gradeEarliness({ movePct: 1.5, firstSeenMovePct: 1.2, ret10sPct: 0.2, ret30sPct: 0.4, velocityPctMin: 0.3, vwapDistPct: 0.6, acceleration: 0.05 }, cfg);
  assert.equal(r.grade, "EARLY");
});

test("LATE: extended from VWAP / most of the move already done", () => {
  const r = gradeEarliness({ movePct: 7.0, firstSeenMovePct: 1.0, ret10sPct: 0.1, ret30sPct: 0.2, velocityPctMin: 0.25, vwapDistPct: 3.2, acceleration: 0.01 }, cfg);
  assert.equal(r.grade, "LATE");
});

test("EXHAUSTED: recent returns rolling over", () => {
  const r = gradeEarliness({ movePct: 5.0, firstSeenMovePct: 1.0, ret10sPct: -0.2, ret30sPct: -0.1, velocityPctMin: 0.1, vwapDistPct: 2.0, acceleration: -0.06 }, cfg);
  assert.equal(r.grade, "EXHAUSTED");
});

test("DEVELOPING: mid-move, neither clearly early nor extended", () => {
  // Velocity above the late-grind floor and extension above the early band → mid-move.
  const r = gradeEarliness({ movePct: 3.5, firstSeenMovePct: 2.0, ret10sPct: 0.05, ret30sPct: 0.1, velocityPctMin: 0.2, vwapDistPct: 1.6, acceleration: 0.01 }, cfg);
  assert.equal(r.grade, "DEVELOPING");
});

test("UNGRADABLE when the day-move is missing", () => {
  const r = gradeEarliness({ movePct: null, ret10sPct: 0.2 }, cfg);
  assert.equal(r.grade, "UNGRADABLE");
});

test("pre-alert move and onset-to-alert latency are computed", () => {
  const r = gradeEarliness({ movePct: 4.0, firstSeenMovePct: 1.5, firstDetectedMs: 1000, firstActionableMs: 6000, vwapDistPct: 1.0, ret10sPct: 0.2, velocityPctMin: 0.3 }, cfg);
  assert.equal(r.preAlertMovePct, 2.5);
  assert.equal(r.onsetToAlertMs, 5000);
});

test("bearish alignment: reversal returns read as rolling over", () => {
  // Bearish move (negative), recent returns positive = a bounce against the move = exhausting.
  const r = gradeEarliness({ movePct: -5.0, firstSeenMovePct: -1.0, ret10sPct: 0.3, ret30sPct: 0.2, vwapDistPct: 2.0, acceleration: 0.06, velocityPctMin: -0.05 }, cfg);
  assert.equal(r.grade, "EXHAUSTED");
});

test("summary computes % early, % late/exhausted, median onset, runner/grinder counts", () => {
  const s = summarizeEarliness([
    { movePct: 1.5, firstSeenMovePct: 1.2, ret10sPct: 0.2, velocityPctMin: 0.3, vwapDistPct: 0.5, classification: "FRESH_ACCELERATION", firstDetectedMs: 0, firstActionableMs: 4000 },
    { movePct: 7.0, ret10sPct: 0.1, velocityPctMin: 0.25, vwapDistPct: 3.2, classification: "SLOW_GRINDER", firstDetectedMs: 0, firstActionableMs: 12000 },
    { movePct: 5.0, ret10sPct: -0.2, ret30sPct: -0.1, vwapDistPct: 2.0, acceleration: -0.06 },
  ], cfg);
  assert.equal(s.graded, 3);
  assert.equal(s.counts.EARLY, 1);
  assert.equal(s.counts.LATE + s.counts.EXHAUSTED, 2);
  assert.equal(s.fastRunnerAlerts, 1);
  assert.equal(s.slowGrinderAlerts, 1);
  assert.equal(s.medianOnsetToAlertMs, 8000); // median of [4000, 12000]
  assert.ok(s.pctEarly > 30 && s.pctEarly < 34);
});
