import test from "node:test";
import assert from "node:assert/strict";
import { chainDteCoverage, horizonSupported, relevantOptionAgents } from "../lib/agents/relevance.ts";

test("chainDteCoverage returns null with no dated contracts", () => {
  assert.equal(chainDteCoverage([]), null);
  assert.equal(chainDteCoverage([{ dte: null }, { dte: undefined }, {}]), null);
});

test("chainDteCoverage reports real min/max/count", () => {
  const cov = chainDteCoverage([{ dte: 0 }, { dte: 5 }, { dte: 30 }, { dte: null }]);
  assert.deepEqual(cov, { minDte: 0, maxDte: 30, count: 3 });
});

test("horizonSupported requires a real overlap with the chain coverage", () => {
  const cov = { minDte: 0, maxDte: 7, count: 20 };
  assert.equal(horizonSupported([0, 1], cov), true);   // 0DTE covered
  assert.equal(horizonSupported([1, 5], cov), true);   // 1-5 covered
  assert.equal(horizonSupported([6, 10], cov), true);  // overlaps at 6-7
  assert.equal(horizonSupported([11, 35], cov), false); // not covered
  assert.equal(horizonSupported([36, 90], cov), false); // not covered
});

test("no chain coverage ⇒ nothing supported", () => {
  assert.equal(horizonSupported([0, 1], null), false);
  assert.equal(horizonSupported(null, { minDte: 0, maxDte: 90, count: 5 }), false);
});

test("relevantOptionAgents drops unsupported longer-dated horizons (no silent widening)", () => {
  const agents = [
    { agentId: "call_0DTE", dteRange: [0, 1] },
    { agentId: "call_1-5", dteRange: [1, 5] },
    { agentId: "call_6-10", dteRange: [6, 10] },
    { agentId: "call_11-35", dteRange: [11, 35] },
    { agentId: "call_36-90", dteRange: [36, 90] },
  ];
  const only0dte = relevantOptionAgents(agents, { minDte: 0, maxDte: 2, count: 10 });
  assert.deepEqual(only0dte.map((a) => a.agentId), ["call_0DTE", "call_1-5"]);

  const wide = relevantOptionAgents(agents, { minDte: 0, maxDte: 90, count: 200 });
  assert.equal(wide.length, 5);

  const none = relevantOptionAgents(agents, null);
  assert.equal(none.length, 0);
});
