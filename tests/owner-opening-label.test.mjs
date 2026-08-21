import test from "node:test";
import assert from "node:assert/strict";
import { formatPrivateLiveAlert } from "../lib/research/options/format.ts";
import { computeOptionTargets } from "../lib/research/options/targets.ts";

const base = {
  symbol: "SPY", side: "call", strike: 772, expiration: "2026-08-11",
  entryMid: 3.44, t1: 4.99, t2: 6.54, stop: 2.06, strategyKey: "breakout_forming",
  underlyingPrice: 770, dte: 5, optionSymbol: "O:SPY260811C00772000",
  lane: "OWNER_ONLY", readinessState: "RESEARCH_ONLY", strategyVersion: "UNKNOWN_LEGACY_VERSION",
  opportunityCaseId: "oc_1a50klb",
};

/**
 * OWNER DECISION 2026-08-21: the owner opening is minimal.
 *
 * It had accreted every internal field the pipeline knew — lane, readiness,
 * strategy@version, rank, evidence strength, case id, raw OCC, a two-target
 * plan, a stop, and a line describing transient mirror state. It is read by one
 * person who has the dashboard open.
 *
 * These tests pin BOTH halves of that decision: the noise is gone, AND the one
 * property that must survive shortening — an owner opening can never be
 * mistaken for a subscriber-approved call.
 */

test("21. the owner opening carries no target, no stop and no T2", () => {
  const msg = formatPrivateLiveAlert({ ...base, paperTradeId: 789 });
  assert.doesNotMatch(msg, /Target 1/);
  assert.doesNotMatch(msg, /Target 2/);
  assert.doesNotMatch(msg, /Stop:/);
  assert.doesNotMatch(msg, /4\.99|6\.54|2\.06/, "no target or stop value leaks as a bare number");
  assert.doesNotMatch(msg, /frozen entry|measured from the frozen entry/);
});

test("21b. the owner opening drops raw OCC, case id, lane, readiness and legacy version", () => {
  const msg = formatPrivateLiveAlert({ ...base, paperTradeId: 789, rankLabel: "2 of 7", evidenceStrength: "INSUFFICIENT_EVIDENCE" });
  assert.doesNotMatch(msg, /O:SPY260811C00772000/, "no raw OCC");
  assert.doesNotMatch(msg, /oc_1a50klb/, "no case id");
  assert.doesNotMatch(msg, /OWNER_ONLY/);
  assert.doesNotMatch(msg, /OWNER WATCH/);
  assert.doesNotMatch(msg, /UNKNOWN_LEGACY_VERSION/);
  assert.doesNotMatch(msg, /Readiness:/);
  assert.doesNotMatch(msg, /Rank:/);
  assert.doesNotMatch(msg, /Paper:/, "no transient mirror state");
  assert.doesNotMatch(msg, /NOT yet mirrored/);
});

test("21c. the owner opening is the simple shape the owner asked for", () => {
  const msg = formatPrivateLiveAlert({
    symbol: "AMZN", side: "put", strike: 260, expiration: "2026-08-24",
    entryMid: 1.755, bid: 1.72, ask: 1.79, strategyKey: "lower_high_continuation",
    underlyingPrice: 262, dte: 3, lane: "OWNER_ONLY", readinessState: "RESEARCH_ONLY",
  });
  assert.equal(msg, [
    "🔬 AMZN PUT · PRIVATE RESEARCH",
    "",
    "AMZN 08/24 $260P",
    "Observed: $1.72–$1.79",
    "",
    "Lower-high continuation",
    "",
    "Research-only · not subscriber approved.",
    "",
    "Educational purposes only. Options are high risk.",
  ].join("\n"));
});

test("the setup is still named, so a shorter message is not a less informative one", () => {
  assert.match(formatPrivateLiveAlert({ ...base }), /Breakout forming/);
  // An unrecognised key degrades to a readable name, never to "unknown".
  assert.match(formatPrivateLiveAlert({ ...base, strategyKey: "some_new_setup" }), /Some new setup/);
  assert.match(formatPrivateLiveAlert({ ...base, strategyKey: null }), /Research setup/);
});

test("SAFETY, UNCHANGED: an owner opening can never read as a subscriber call", () => {
  for (const over of [
    { paperTradeId: 789 },
    { paperTradeId: null },
    { lane: "OWNER_ONLY", readinessState: "RESEARCH_ONLY" },
    { lane: "RESEARCH", readinessState: "INSUFFICIENT_EVIDENCE" },
    { side: "put", lane: "OWNER_ONLY", readinessState: "DEMOTED" },
  ]) {
    const msg = formatPrivateLiveAlert({ ...base, ...over });
    assert.match(msg, /Research-only · not subscriber approved\./, "the disclaimer is unconditional");
    assert.match(msg, /🔬/, "and it is visually marked as research");
    assert.doesNotMatch(msg, /🟢 SPY CALL ALERT|🔴 SPY PUT ALERT/,
      "the 2026-08-06 defect — an unlabelled subscriber-looking alert — stays fixed");
  }
});

test("22. BACKEND target/stop logic is untouched — only the message stopped printing it", () => {
  // The plan the grading, paper and exit paths consume is computed exactly as
  // before. Phase 14 was presentation-only, and this is the proof.
  const plan = computeOptionTargets(3.44, "breakout_forming", {});
  assert.equal(plan.t1, 4.99);
  assert.equal(plan.t2, 6.54);
  assert.equal(plan.stop, 1.89);
  assert.equal(plan.rMultiple, 1.55);
  assert.equal(plan.methodology, "mid=3.44; stop=-45% (1.89); R=1.55; T1=+1R (4.99); T2=+2R (6.54)");
});
