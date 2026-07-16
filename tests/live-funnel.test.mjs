import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStockFunnel, buildOptionsFunnel, topRejectionReasons, classificationCounts,
} from "../lib/live-funnel.ts";

const READY = { ready: true, blockedBy: [] };
const BLOCKED = { ready: false, blockedBy: ["STOCK_CALLOUTS != 1"] };

test("stock funnel surfaces broad universe size and fast-mover pass count", () => {
  const tape = [
    { symbol: "A", stockPolicyOk: true, classification: "FRESH_ACCELERATION" },
    { symbol: "B", stockPolicyOk: false, classification: "SLOW_GRINDER", stockPolicyReason: "classification SLOW_GRINDER is suppressed" },
    { symbol: "C", stockPolicyOk: false, classification: "FRESH_ACCELERATION", stockPolicyReason: "spread 2.1% > 1.5%" },
  ];
  const discovery = { atMs: 111, curatedCount: 250, broadCount: 9800, broadPass: 42, universeSize: 260, promoted: 6, source: "broad+curated" };
  const f = buildStockFunnel(tape, discovery, READY, READY);
  assert.equal(f.universeSize, 260);
  assert.equal(f.broadCount, 9800);
  assert.equal(f.broadPass, 42);
  assert.equal(f.fastMoverPass, 1);
  assert.equal(f.classifications.FRESH_ACCELERATION, 2);
  assert.equal(f.classifications.SLOW_GRINDER, 1);
  assert.equal(f.lastCycleAtMs, 111);
});

test("top rejection reasons are compacted and ranked", () => {
  const tape = [
    { stockPolicyOk: false, stockPolicyReason: "spread 2.1% > 1.5%" },
    { stockPolicyOk: false, stockPolicyReason: "spread 3.0% > 1.5%" },
    { stockPolicyOk: false, stockPolicyReason: "classification SLOW_GRINDER is suppressed" },
    { stockPolicyOk: true, stockPolicyReason: null },
  ];
  const top = topRejectionReasons(tape);
  // Both spread failures aggregate into one "spread" bucket (numbers stripped).
  assert.equal(top[0].reason, "spread");
  assert.equal(top[0].count, 2);
  assert.equal(top[1].reason, "classification SLOW_GRINDER is suppressed");
});

test("empty tape yields an explainable (not crashing) stock funnel", () => {
  const f = buildStockFunnel([], null, BLOCKED, BLOCKED);
  assert.equal(f.universeSize, 0);
  assert.equal(f.fastMoverPass, 0);
  assert.deepEqual(f.topRejections, []);
  assert.equal(f.actionableReady, false);
  assert.deepEqual(f.blockedBy, ["STOCK_CALLOUTS != 1"]);
});

test("classificationCounts labels unclassified rows", () => {
  const c = classificationCounts([{ classification: null }, { classification: "LATE_EXHAUSTION" }]);
  assert.equal(c.UNCLASSIFIED, 1);
  assert.equal(c.LATE_EXHAUSTION, 1);
});

test("options funnel exposes the delivery gate reason (the 'zero alerts' cause)", () => {
  const telemetry = {
    lastCycleAtMs: 999,
    lastFunnel: {
      tickersConsidered: 14, chainsOk: 14, chainsFailed: 0, tickersWithCanonical: 3,
      canonical: 3, emitted: 2, delivered: 0, notActionableNow: 11,
      contractIncomplete: 0, contractMismatch: 0,
      topReason: "not actionable-now", deliveryGateReason: "AGENT_CALLOUT_DISCORD != 1 (supervisor Discord master switch is off)",
    },
  };
  const f = buildOptionsFunnel(telemetry, ["NVDA", "TSLA"], { ready: false, blockedBy: ["AGENT_CALLOUT_DISCORD != 1"] });
  assert.equal(f.underlyingsEvaluated, 14);
  assert.equal(f.canonical, 3);
  assert.equal(f.emitted, 2);
  assert.equal(f.delivered, 0);
  assert.deepEqual(f.selectedContracts, ["NVDA", "TSLA"]);
  assert.match(f.deliveryGateReason, /AGENT_CALLOUT_DISCORD/);
  assert.equal(f.ready, false);
});

test("options funnel tolerates a cold supervisor (no cycle yet)", () => {
  const f = buildOptionsFunnel({ lastCycleAtMs: null, lastFunnel: null }, [], READY);
  assert.equal(f.underlyingsEvaluated, 0);
  assert.equal(f.canonical, 0);
  assert.equal(f.deliveryGateReason, null);
});
