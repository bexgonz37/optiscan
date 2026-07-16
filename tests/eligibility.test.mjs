import test from "node:test";
import assert from "node:assert/strict";
import { buildCallout } from "../lib/callouts/callout.ts";
import { nowOnlyActionable, paperCandidateEligibility } from "../lib/callouts/eligibility.ts";
import { selectForDiscord } from "../lib/agents/portfolio.ts";
import { ownerSettings } from "../lib/owner-settings.ts";

const NOW = Date.parse("2026-07-13T15:00:00Z");
const PAPER_ON = { PAPER_TRADING_ENABLED: "1", PAPER_AUTO_ENTRY: "1", PAPER_ALLOW_ZERO_DTE: "1" };

/** AgentResult factory: a HIGH, valid-now NVDA call with an ACTIONABLE entry window. */
function ar(over = {}, ew = { state: "ACTIONABLE", waitFor: "enter now", validEntry: "valid now", doNotEnter: "loses VWAP", currently: "confirmed", alreadyHappened: null }) {
  return {
    agentId: "call_1_5", agentVersion: 1, strategy: "swing_momentum", strategyVersion: 1,
    ticker: "NVDA", direction: "bullish", horizon: "1-5", dteRange: [1, 5],
    candidateStatus: "ACTIONABLE_NOW", lifecycleStatus: null, score: 82,
    verifiedInputs: ew ? { spot: 182.4, entryWindow: ew } : { spot: 182.4 },
    requiredConditions: ["hold VWAP"], selectorProfile: "swing_momentum",
    selectedContract: { optionSymbol: "O:NVDA_C185", strike: 185, expiration: "2026-07-17", dte: 4, side: "call", bid: 2.10, ask: 2.18, mid: 2.14, spreadPct: 3, delta: 0.5, iv: 0.3, volume: 500, openInterest: 1000, breakevenPct: 0.5 },
    passedGates: ["spread"], failedGates: [], evidenceStatus: "NOT_TRACKED",
    statisticsSnapshot: { evidenceStatus: "NOT_TRACKED", evidenceSummary: "", gradedSampleSize: 0 },
    modelStatus: "INACTIVE_NO_TRAINABLE_DATA", probability: null,
    actionability: "ACTIONABLE", researchOnly: false, reasons: ["fresh momentum"],
    improvementConditions: [], invalidationConditions: ["loses VWAP"], freshness: { ok: true, reason: null },
    marketContext: null, riskVerdict: { allowed: true, failures: [], vetoed: false }, timestamp: NOW,
    ...over,
  };
}

test("HIGH + ACTIONABLE_NOW + valid now is eligible for Discord and paper", () => {
  const c = buildCallout(ar());
  assert.equal(nowOnlyActionable(c).ok, true);
  assert.equal(paperCandidateEligibility(c, PAPER_ON).ok, true);
});

// ── each excluded state is neither Discord- nor paper-eligible ────────────────
for (const [label, over, ew] of [
  ["WAIT_FOR_PULLBACK", { candidateStatus: "WAIT_FOR_PULLBACK", actionability: "WATCH" }, { state: "WAIT_FOR_PULLBACK", waitFor: "", validEntry: "", doNotEnter: "", currently: "", alreadyHappened: null }],
  ["WATCH", { candidateStatus: "WATCH", actionability: "WATCH" }, null],
  ["NEAR_TRIGGER", { candidateStatus: "NEAR_TRIGGER", actionability: "WATCH" }, { state: "NEAR_TRIGGER", waitFor: "", validEntry: "", doNotEnter: "", currently: "", alreadyHappened: null }],
  ["DEVELOPING", { candidateStatus: "DEVELOPING", actionability: "WATCH" }, { state: "EARLY", waitFor: "", validEntry: "", doNotEnter: "", currently: "", alreadyHappened: null }],
  ["MISSED", { candidateStatus: "MISSED", actionability: "WATCH" }, { state: "MISSED", waitFor: "", validEntry: "", doNotEnter: "", currently: "", alreadyHappened: null }],
  ["EXTENDED", { candidateStatus: "EXTENDED", actionability: "WATCH" }, { state: "EXTENDED", waitFor: "", validEntry: "", doNotEnter: "", currently: "", alreadyHappened: null }],
  ["INVALIDATED", { candidateStatus: "INVALIDATED", actionability: "BLOCKED" }, { state: "INVALIDATED", waitFor: "", validEntry: "", doNotEnter: "", currently: "", alreadyHappened: null }],
  ["DATA_STALE", { candidateStatus: "DATA_STALE", actionability: "BLOCKED", freshness: { ok: false, reason: "stale" } }, null],
  ["NO_VALID_CONTRACT", { candidateStatus: "NO_VALID_CONTRACT", actionability: "BLOCKED", selectedContract: null }, null],
  ["RESEARCH_ONLY", { candidateStatus: "RESEARCH_ONLY", actionability: "RESEARCH_ONLY", researchOnly: true }, null],
]) {
  test(`${label} is neither Discord- nor paper-eligible`, () => {
    const c = buildCallout(ar(over, ew));
    assert.equal(nowOnlyActionable(c).ok, false, `${label} not now-actionable`);
    assert.equal(paperCandidateEligibility(c, PAPER_ON).ok, false, `${label} not paper-eligible`);
    assert.equal(selectForDiscord([c], ownerSettings({})).eligibleKeys.size, 0, `${label} not sent to Discord`);
  });
}

test("mixed-thesis WATCH is dashboard-only and non-paperable", () => {
  const c = buildCallout(ar({ candidateStatus: "WATCH", actionability: "WATCH" }, null));
  c.thesisNote = "Market mixed on NVDA: bullish and bearish theses disagree.";
  assert.equal(nowOnlyActionable(c).ok, false);
  assert.equal(paperCandidateEligibility(c, PAPER_ON).ok, false);
  assert.equal(selectForDiscord([c], ownerSettings({ EARLY_ALERTS_ENABLED: "1", BEARISH_ACTIONABLE: "1" })).eligibleKeys.size, 0);
});

test("stale underlying / option quote is not eligible", () => {
  const c = buildCallout(ar({ freshness: { ok: false, reason: "quote 40s old" } }));
  assert.equal(paperCandidateEligibility(c, PAPER_ON).ok, false);
});

test("wide spread is not eligible", () => {
  const c = buildCallout(ar({ selectedContract: { ...ar().selectedContract, spreadPct: 40 } }));
  assert.equal(paperCandidateEligibility(c, PAPER_ON).ok, false);
});

test("risk veto is not eligible", () => {
  const c = buildCallout(ar({ riskVerdict: { allowed: false, failures: ["daily loss cap"], vetoed: true }, candidateStatus: "WATCH", actionability: "BLOCKED" }));
  assert.equal(paperCandidateEligibility(c, PAPER_ON).ok, false);
});

// ── paper env gates ──────────────────────────────────────────────────────────
test("paper auto-entry off / trading disabled block paper eligibility", () => {
  const c = buildCallout(ar());
  assert.match(paperCandidateEligibility(c, { PAPER_TRADING_ENABLED: "1" }).reason, /auto-entry disabled/);
  assert.match(paperCandidateEligibility(c, { PAPER_TRADING_ENABLED: "0", PAPER_AUTO_ENTRY: "1" }).reason, /paper trading disabled/);
});

test("0DTE respects PAPER_ALLOW_ZERO_DTE", () => {
  const zeroDte = buildCallout(ar({ selectedContract: { ...ar().selectedContract, dte: 0 } }));
  assert.equal(paperCandidateEligibility(zeroDte, { PAPER_TRADING_ENABLED: "1", PAPER_AUTO_ENTRY: "1" }).ok, false);
  assert.match(paperCandidateEligibility(zeroDte, { PAPER_TRADING_ENABLED: "1", PAPER_AUTO_ENTRY: "1" }).reason, /0DTE/);
  assert.equal(paperCandidateEligibility(zeroDte, PAPER_ON).ok, true);
});

test("research-only put is not paper-eligible, verified actionable put is", () => {
  const put = buildCallout(ar({
    direction: "bearish", candidateStatus: "RESEARCH_ONLY", actionability: "RESEARCH_ONLY", researchOnly: true,
    selectedContract: { ...ar().selectedContract, side: "put" },
  }, null));
  assert.equal(paperCandidateEligibility(put, { ...PAPER_ON }).ok, false);

  const actionablePut = buildCallout(ar({
    direction: "bearish",
    selectedContract: { ...ar().selectedContract, side: "put" },
  }));
  assert.equal(paperCandidateEligibility(actionablePut, { ...PAPER_ON }).ok, true);
  assert.equal(paperCandidateEligibility(actionablePut, { ...PAPER_ON, OPTIONS_PUTS_ENABLED: "0" }).ok, false);
});
