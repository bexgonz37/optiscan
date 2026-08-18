/**
 * Profit-protection and overnight-risk OBSERVATION.
 *
 * The two load-bearing tests here are the ones that make the studies falsifiable:
 *
 *  1. Appending marks AFTER a milestone must not change that milestone's observation by one
 *     digit. A feature set that can see the future separates perfectly and predicts nothing.
 *  2. The overnight report must report the winners a flat close-before-the-bell rule would
 *     destroy, unconditionally, before any gap statistic is readable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  observeMilestones,
  buildProtectionObservation,
  PROTECTION_MILESTONES,
  MIN_PER_GROUP_FOR_CONTRAST,
  CONTRASTED_FEATURES,
} from "../lib/research/options/profit-protection-observation.ts";
import {
  observeOvernight,
  buildOvernightObservation,
} from "../lib/research/options/overnight-risk-observation.ts";

const T0 = Date.UTC(2026, 7, 20, 14, 0, 0); // 10:00 ET
const MIN = 60_000;

const sameDay = (a, b) => day(a) === day(b);
const day = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const minuteOfSession = (ms) => {
  const s = new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

function marks(pairs) {
  return pairs.map(([mins, returnPct, exitFill = null]) => ({ atMs: T0 + mins * MIN, returnPct, exitFill }));
}

function pcase(over = {}) {
  return {
    opportunityCaseId: "oc_a", symbol: "IWM", optionSymbol: "O:IWM260821P00301000",
    side: "PUT", strategyKey: "lower_high_continuation", sessionDate: "2026-08-20",
    dte: 1, delta: -0.45, selectionStrength: 100, rewardRemainingFraction: 1,
    moveConsumedFraction: 0.2, entryAtMs: T0, realizedReturnPct: 44,
    outcome: "EVENTUAL_T1_WINNER", marks: marks([[1, 5], [5, 12], [10, 21], [15, 31], [20, 44]]),
    occExact: true, ...over,
  };
}

// ── no hindsight ─────────────────────────────────────────────────────────────

test("marks AFTER a milestone cannot change that milestone's observation", () => {
  const before = observeMilestones(pcase(), sameDay);
  // The same trade, then a violent collapse and a moonshot afterwards. If any observation
  // moves, some field is reading past the touch instant.
  const after = observeMilestones(
    pcase({ marks: marks([[1, 5], [5, 12], [10, 21], [15, 31], [20, 44], [25, -90], [30, 900]]) }),
    sameDay,
  );
  const pick = (c) => c.observations.map((o) => ({ ...o }));
  assert.deepEqual(pick(before), pick(after));
});

test("the path SHAPE before the touch is captured: heat, deepest give-back, pullback count", () => {
  // Down to -8, up to +14, back to +6, then +21. The +20 touch is the last mark.
  const c = observeMilestones(pcase({ marks: marks([[1, -8], [4, 14], [7, 6], [10, 21]]) }), sameDay);
  const at20 = c.observations.find((o) => o.milestonePct === 20);
  assert.equal(at20.maePctBeforeTouch, -8, "the heat taken on the way is knowable at the touch");
  assert.equal(at20.maxDrawdownBeforeTouchPct, 8, "14 down to 6 is the deepest give-back");
  assert.equal(at20.pullbacksBeforeTouch, 1);
});

test("no observed feature is structurally constant — the degenerate-column guard", () => {
  // Two trades that reach +20 by completely different paths. If a feature reports the same
  // value for both, it cannot separate anything and must not be in the contrast set.
  const smooth = observeMilestones(pcase({ marks: marks([[1, 8], [2, 15], [3, 22]]) }), sameDay);
  const violent = observeMilestones(
    pcase({ opportunityCaseId: "oc_v", marks: marks([[1, -20], [30, 18], [45, 4], [60, 21]]) }),
    sameDay,
  );
  const a = smooth.observations.find((o) => o.milestonePct === 20);
  const b = violent.observations.find((o) => o.milestonePct === 20);
  const identical = CONTRASTED_FEATURES.filter((f) => a[f] === b[f]);
  assert.deepEqual(
    identical, [],
    `these contrasted features did not vary between two very different paths: ${identical.join(", ")}`,
  );
});

test("the outcome label is never reachable from an observation", () => {
  const c = observeMilestones(pcase(), sameDay);
  for (const o of c.observations) {
    assert.ok(!("outcome" in o), "the answer must not sit in the feature object");
    assert.ok(!("realizedReturnPct" in o));
    assert.ok(!("mfePct" in o));
    assert.ok(!("peakSoFarPct" in o), "the running peak equals the touch value at a first touch");
  }
  assert.equal(c.outcome, "EVENTUAL_T1_WINNER", "the label lives on the case, separately");
});

test("milestones never reached produce no observation", () => {
  const c = observeMilestones(pcase({ marks: marks([[1, 5], [5, 12]]) }), sameDay);
  assert.deepEqual(c.observations.map((o) => o.milestonePct), [10]);
});

test("a wrong-contract mirror is excluded entirely", () => {
  const c = observeMilestones(pcase({ occExact: false }), sameDay);
  assert.equal(c.observations.length, 0);
  assert.match(c.limitations[0], /froze/);
});

test("marks before entry are not observed", () => {
  const c = observeMilestones(
    pcase({ marks: [{ atMs: T0 - 5 * MIN, returnPct: 99 }, ...marks([[5, 12]])] }),
    sameDay,
  );
  const at10 = c.observations.find((o) => o.milestonePct === 10);
  assert.equal(at10.returnPctAtTouch, 12, "a pre-entry mark must not become the touch");
});

test("crossing a session boundary before the milestone is recorded at that instant", () => {
  const nextDay = T0 + 24 * 60 * MIN;
  const c = observeMilestones(
    pcase({ marks: [{ atMs: T0 + MIN, returnPct: 2 }, { atMs: nextDay, returnPct: 30 }] }),
    sameDay,
  );
  assert.equal(c.observations.find((o) => o.milestonePct === 10).crossedSessionBoundaryByNow, true);
});

// ── aggregation ──────────────────────────────────────────────────────────────

test("the contrast is UNSUPPORTED on a thin group and says so", () => {
  const cases = [
    observeMilestones(pcase({ outcome: "EVENTUAL_T1_WINNER" }), sameDay),
    observeMilestones(pcase({ opportunityCaseId: "oc_b", outcome: "GOOD_MOVE_THEN_REVERSED", realizedReturnPct: -40 }), sameDay),
  ];
  const r = buildProtectionObservation(cases);
  const at10 = r.milestones.find((m) => m.milestonePct === 10);
  assert.equal(at10.reached, 2);
  assert.ok(at10.featureContrast.every((f) => !f.supported), "one trade per group is not evidence");
  assert.equal(at10.anySupportedContrast, false);
});

test("a supported contrast needs both groups at the floor", () => {
  const mk = (i, outcome, realized, ms) =>
    observeMilestones(pcase({ opportunityCaseId: `oc_${i}`, outcome, realizedReturnPct: realized, marks: ms }), sameDay);
  const cases = [];
  for (let i = 0; i < MIN_PER_GROUP_FOR_CONTRAST; i++) {
    cases.push(mk(`w${i}`, "EVENTUAL_T1_WINNER", 44, marks([[1, 5], [3, 12]])));
    cases.push(mk(`r${i}`, "GOOD_MOVE_THEN_REVERSED", -40, marks([[1, 5], [30, 12]])));
  }
  const r = buildProtectionObservation(cases);
  const at10 = r.milestones.find((m) => m.milestonePct === 10);
  const elapsed = at10.featureContrast.find((f) => f.feature === "msFromEntry");
  assert.equal(elapsed.supported, true);
  assert.equal(elapsed.winnerMedian, 3 * MIN);
  assert.equal(elapsed.reversedMedian, 30 * MIN);
  assert.equal(at10.anySupportedContrast, true);
});

test("no rule is ever proposed, and the module says so explicitly", () => {
  const r = buildProtectionObservation([observeMilestones(pcase(), sameDay)]);
  assert.equal(r.readiness.ruleProposed, false);
  assert.equal(r.productionBehaviorChanged, false);
  assert.match(r.readiness.note, /No trailing stop, break-even stop, profit lock or sell-at-level/);
  assert.ok(r.readiness.requirements.some((x) => /PROSPECTIVELY|prospectively/.test(x)));
});

test("PATH_UNKNOWN-style cases are UNGRADED and are not counted as reversals", () => {
  const cases = [
    observeMilestones(pcase({ outcome: "UNGRADED", realizedReturnPct: null }), sameDay),
    observeMilestones(pcase({ opportunityCaseId: "oc_b", outcome: "GOOD_MOVE_THEN_REVERSED", realizedReturnPct: -40 }), sameDay),
  ];
  const at10 = buildProtectionObservation(cases).milestones.find((m) => m.milestonePct === 10);
  assert.equal(at10.ungraded, 1);
  assert.equal(at10.goodMoveThenReversed, 1);
});

test("the milestone set is the six the brief named", () => {
  assert.deepEqual([...PROTECTION_MILESTONES], [10, 15, 20, 25, 30, 35]);
});

// ── overnight ────────────────────────────────────────────────────────────────

const NEXT_OPEN = Date.UTC(2026, 7, 21, 13, 35, 0); // 09:35 ET next day

function ocase(over = {}) {
  return {
    opportunityCaseId: "oc_n", symbol: "NFLX", optionSymbol: "O:NFLX260821P00074000",
    side: "PUT", strategyKey: "lower_high_continuation", sessionDate: "2026-08-20",
    exitSessionDate: "2026-08-21", dte: 1, selectionStrength: 100,
    stopLevel: 0.43, entryAtMs: T0, closedAtMs: NEXT_OPEN + MIN, exitFill: 0.104,
    realizedReturnPct: -85.67, outcome: "GOOD_MOVE_THEN_REVERSED",
    marks: [
      { atMs: T0 + MIN, returnPct: 5, exitFill: 0.76 },
      { atMs: T0 + 300 * MIN, returnPct: 20, exitFill: 0.87 },
      { atMs: NEXT_OPEN, returnPct: -42, exitFill: 0.42 },
    ],
    occExact: true, ...over,
  };
}

test("a same-day trade reports no gap rather than a zero one", () => {
  const c = observeOvernight(
    ocase({ marks: [{ atMs: T0 + MIN, returnPct: 5, exitFill: 0.76 }], exitSessionDate: "2026-08-20" }),
    day, minuteOfSession,
  );
  assert.equal(c.heldOvernight, false);
  assert.equal(c.overnightGapPct, null, "an unmeasured gap must never be 0");
  assert.equal(c.sessionsSpanned, 1);
});

test("the boundary is the last mark of the entry session against the first after it", () => {
  const c = observeOvernight(ocase(), day, minuteOfSession);
  assert.equal(c.heldOvernight, true);
  assert.equal(c.returnPctBeforeFirstClose, 20);
  assert.equal(c.peakPctBeforeFirstClose, 20);
  assert.equal(c.returnPctAtNextOpen, -42);
  assert.equal(c.overnightGapPct, -62);
  assert.equal(c.gappedThroughStop, true, "0.42 is below the frozen 0.43 stop");
});

test("stop slippage is measured against the FROZEN stop, never a recomputed one", () => {
  const c = observeOvernight(ocase(), day, minuteOfSession);
  // (0.104 − 0.43) / 0.43 = −75.81%
  assert.equal(Math.round(c.stopSlippagePct * 100) / 100, -75.81);
});

test("a trade with no frozen stop reports null slippage and says why", () => {
  const c = observeOvernight(ocase({ stopLevel: null }), day, minuteOfSession);
  assert.equal(c.stopSlippagePct, null);
  assert.ok(c.limitations.some((l) => /froze no stop/.test(l)));
});

test("requiredTheHold is true only for a winner not yet at its result by the close", () => {
  const winner = observeOvernight(ocase({
    realizedReturnPct: 44, outcome: "EVENTUAL_T1_WINNER",
    marks: [
      { atMs: T0 + MIN, returnPct: 5, exitFill: 0.76 },
      { atMs: T0 + 300 * MIN, returnPct: 12, exitFill: 0.82 },
      { atMs: NEXT_OPEN, returnPct: 44, exitFill: 1.42 },
    ],
  }), day, minuteOfSession);
  assert.equal(winner.requiredTheHold, true);

  // Already past its realized return at the close: holding was not what made it a winner.
  const notRequired = observeOvernight(ocase({
    realizedReturnPct: 10, outcome: "EVENTUAL_T1_WINNER",
    marks: [
      { atMs: T0 + 300 * MIN, returnPct: 30, exitFill: 1.2 },
      { atMs: NEXT_OPEN, returnPct: 10, exitFill: 0.8 },
    ],
  }), day, minuteOfSession);
  assert.equal(notRequired.requiredTheHold, false);

  const loser = observeOvernight(ocase(), day, minuteOfSession);
  assert.equal(loser.requiredTheHold, false, "a loser never required the hold");
});

test("the report refuses the flat conclusion and names what it would destroy", () => {
  const winner = observeOvernight(ocase({
    opportunityCaseId: "oc_w", realizedReturnPct: 44, outcome: "EVENTUAL_T1_WINNER",
    marks: [
      { atMs: T0 + 300 * MIN, returnPct: 12, exitFill: 0.82 },
      { atMs: NEXT_OPEN, returnPct: 44, exitFill: 1.42 },
    ],
  }), day, minuteOfSession);
  const r = buildOvernightObservation([winner, observeOvernight(ocase(), day, minuteOfSession)]);
  assert.equal(r.winnersThatRequiredTheHold, 1);
  assert.equal(r.winnerReturnPointsThatRequiredTheHold, 44);
  assert.match(r.conditionalPolicy.mustNotConcludeThat, /CLOSE EVERYTHING BEFORE THE BELL/);
  assert.equal(r.conditionalPolicy.policyProposed, false);
  assert.equal(r.productionBehaviorChanged, false);
});

test("same-day and overnight arms are separate populations, never summed", () => {
  const sd = observeOvernight(ocase({
    opportunityCaseId: "oc_s", realizedReturnPct: 30, exitSessionDate: "2026-08-20",
    marks: [{ atMs: T0 + MIN, returnPct: 30, exitFill: 1.2 }],
  }), day, minuteOfSession);
  const on = observeOvernight(ocase(), day, minuteOfSession);
  const r = buildOvernightObservation([sd, on]);
  assert.equal(r.sameDay.n, 1);
  assert.equal(r.overnight.n, 1);
  assert.equal(r.sameDay.meanReturnPct, 30);
  assert.equal(r.overnight.meanReturnPct, -85.67);
});

test("gap counts split adverse from favourable rather than reporting a magnitude", () => {
  const bad = observeOvernight(ocase(), day, minuteOfSession);
  const good = observeOvernight(ocase({
    opportunityCaseId: "oc_g", realizedReturnPct: 50, outcome: "EVENTUAL_T1_WINNER",
    marks: [
      { atMs: T0 + 300 * MIN, returnPct: 10, exitFill: 0.8 },
      { atMs: NEXT_OPEN, returnPct: 50, exitFill: 1.5 },
    ],
  }), day, minuteOfSession);
  const r = buildOvernightObservation([bad, good]);
  assert.equal(r.gaps.adverseGaps, 1);
  assert.equal(r.gaps.favourableGaps, 1);
  assert.equal(r.gaps.worstGapPct, -62);
  assert.equal(r.gaps.bestGapPct, 40);
});

// ── authority boundary ───────────────────────────────────────────────────────

test("no observation module writes to the database or calls a provider", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const f of [
    "lib/research/options/profit-protection-observation.ts",
    "lib/research/options/overnight-risk-observation.ts",
    "lib/research/options/exit-risk-loader.ts",
  ]) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), "utf8");
    for (const forbidden of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bfetch\s*\(/]) {
      assert.ok(!forbidden.test(src), `${f} must not contain ${forbidden}`);
    }
  }
});
