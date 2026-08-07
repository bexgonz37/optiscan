import test from "node:test";
import assert from "node:assert/strict";
import { formatPrivateLiveAlert } from "../lib/research/options/format.ts";

const base = {
  symbol: "SPY", side: "call", strike: 772, expiration: "2026-08-11",
  entryMid: 3.44, t1: 4.99, t2: 6.54, stop: 2.06, strategyKey: "breakout_forming",
  underlyingPrice: 770, dte: 5, optionSymbol: "O:SPY260811C00772000",
  lane: "OWNER_ONLY", readinessState: "RESEARCH_ONLY", strategyVersion: "UNKNOWN_LEGACY_VERSION",
  opportunityCaseId: "oc_1a50klb",
};

// Owner alerting stays ON while the strategy is unapproved. The opening must say it is a
// tracked owner validation, name the exact OCC, and name the position tracking it.
test("owner opening is labelled OWNER VALIDATION - PAPER TRACKED and names the exact contract", () => {
  const msg = formatPrivateLiveAlert({ ...base, paperTradeId: 789 });
  assert.match(msg, /OWNER VALIDATION — PAPER TRACKED/);
  assert.match(msg, /Contract: O:SPY260811C00772000/);
  assert.match(msg, /Paper: tracking THIS contract from \$3\.44 · position #789/);
  assert.match(msg, /Lane: OWNER_ONLY · Readiness: RESEARCH_ONLY/);
  assert.doesNotMatch(msg, /🟢 SPY CALL ALERT/, "must never read as a subscriber call");
});

test("an unmirrored opening says so rather than implying tracking", () => {
  const msg = formatPrivateLiveAlert({ ...base, paperTradeId: null });
  assert.match(msg, /OWNER WATCH/);
  assert.match(msg, /Paper: NOT yet mirrored/);
});

test("rank and evidence strength surface when known", () => {
  const msg = formatPrivateLiveAlert({ ...base, paperTradeId: 12, rankLabel: "2 of 7", evidenceStrength: "INSUFFICIENT_EVIDENCE" });
  assert.match(msg, /Rank: 2 of 7 · Evidence: INSUFFICIENT_EVIDENCE/);
});
