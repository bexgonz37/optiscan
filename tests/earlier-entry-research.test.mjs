import test from "node:test";
import assert from "node:assert/strict";
import { analyzeEarlierEntries } from "../lib/research/options/earlier-entry-research.ts";

const OPEN = Date.parse("2026-07-30T14:00:00.000Z"); // 10:00 ET
const OCC = "O:NVDA260730C00195000";
const fresh = (kind, minutes, ask, overrides = {}) => ({ kind, atMs: OPEN + minutes * 60_000, optionSymbol: OCC, bid: ask - 0.04, ask, quoteAgeMs: 500, source: "persisted_test", freshness: "FRESH", ...overrides });
const mark = (minutes, bid, overrides = {}) => ({ atMs: OPEN + minutes * 60_000, optionSymbol: OCC, bid, ask: bid + 0.04, quoteAgeMs: 500, source: "persisted_mark", ...overrides });

test("earlier-entry research uses only pre-send exact OCC fresh in-session evidence", () => {
  const original = {
    alertId: "oa_1", optionSymbol: OCC, canonicalSendAtMs: OPEN + 5 * 60_000, canonicalAsk: 1.32,
    observations: [
      fresh("FIRST_VALID_STRUCTURE", 0, 1),
      fresh("READY", 6, 0.8), // future evidence must not enter
      fresh("EXACT_OCC", 2, 1.12, { optionSymbol: "O:NVDA260730C00200000" }), // wrong contract
      fresh("VWAP_CONFIRMATION", 3, 1.2, { quoteAgeMs: 120_000 }), // stale
    ],
    marks: [mark(1, 1.08), mark(3, 1.2), mark(6, 1.3)],
  };
  const before = structuredClone(original);
  const report = analyzeEarlierEntries([original]);
  const trade = report.trades[0];
  assert.equal(trade.candidateEntries.length, 1);
  assert.equal(trade.classification, "PREMIUM_CHASE");
  assert.equal(trade.candidateEntries[0].premiumInflationPct, 32);
  assert.equal(trade.candidateEntries[0].returns["1m"], 8);
  assert.deepEqual(original, before, "shadow analysis is pure");
  assert.equal(report.productionBehaviorChanged, false);
});

test("after-hours and missing ask evidence cannot create an earlier shadow entry", () => {
  const afterHours = Date.parse("2026-07-30T20:15:00.000Z"); // 4:15 ET
  const report = analyzeEarlierEntries([{
    alertId: "oa_2", optionSymbol: OCC, canonicalSendAtMs: afterHours, canonicalAsk: 1.2,
    observations: [{ kind: "FIRST_VALID_STRUCTURE", atMs: afterHours - 60_000, optionSymbol: OCC, bid: 1, ask: 1.04, quoteAgeMs: 0, source: "test", freshness: "FRESH" }],
    marks: [],
  }]);
  assert.equal(report.trades[0].classification, "INSUFFICIENT_EVIDENCE");
  assert.equal(report.trades[0].candidateEntries.length, 0);
});
