import test from "node:test";
import assert from "node:assert/strict";
import { buildCallout } from "../lib/callouts/callout.ts";
import { materialStateHash } from "../lib/callouts/material-hash.ts";

const NOW = Date.parse("2026-07-11T15:00:00Z");

function ar(over = {}) {
  return {
    agentId: "call_0DTE", agentVersion: 1, strategy: "zero_dte_momentum", strategyVersion: 1,
    ticker: "SPY", direction: "bullish", horizon: "0DTE", dteRange: [0, 1],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 78,
    verifiedInputs: {}, requiredConditions: ["hold VWAP"], selectorProfile: "zero_dte_momentum",
    selectedContract: { optionSymbol: "O:SPY_C500", strike: 500, expiration: "2026-07-11", dte: 0, side: "call", bid: 1.1, ask: 1.2, mid: 1.15, spreadPct: 4, delta: 0.5, iv: 0.3, volume: 500, openInterest: 1000, breakevenPct: 0.5 },
    passedGates: ["spread"], failedGates: [], evidenceStatus: "NOT_TRACKED",
    statisticsSnapshot: { evidenceStatus: "NOT_TRACKED", evidenceSummary: "", gradedSampleSize: 0 },
    modelStatus: "INACTIVE_NO_TRAINABLE_DATA", probability: null,
    actionability: "ACTIONABLE", researchOnly: false, reasons: ["fresh momentum"],
    improvementConditions: [], invalidationConditions: ["loses VWAP"], freshness: { ok: true, reason: null },
    marketContext: null, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: NOW,
    ...over,
  };
}

test("material hash is deterministic and ignores timestamp", () => {
  const a = materialStateHash(buildCallout(ar({ timestamp: 1 })));
  const b = materialStateHash(buildCallout(ar({ timestamp: 999999 })));
  assert.equal(a, b);
});

test("minor score jitter does not change the hash", () => {
  const a = materialStateHash(buildCallout(ar({ score: 78 })));
  const b = materialStateHash(buildCallout(ar({ score: 81 })));
  assert.equal(a, b);
});

test("status change changes the hash", () => {
  const a = materialStateHash(buildCallout(ar({ candidateStatus: "ACTIONABLE_NOW" })));
  const b = materialStateHash(buildCallout(ar({ candidateStatus: "NEAR_TRIGGER" })));
  assert.notEqual(a, b);
});

test("contract change changes the hash", () => {
  const base = ar();
  const a = materialStateHash(buildCallout(base));
  const b = materialStateHash(buildCallout(ar({ selectedContract: { ...base.selectedContract, strike: 505 } })));
  assert.notEqual(a, b);
});

test("model-state change changes the hash (inactive → experimental)", () => {
  const a = materialStateHash(buildCallout(ar({ modelStatus: "INACTIVE_NO_TRAINABLE_DATA", probability: null })));
  const b = materialStateHash(buildCallout(ar({ modelStatus: "ACTIVE_EXPERIMENTAL_RESEARCH_ONLY", probability: 0.6 })));
  assert.notEqual(a, b);
});
