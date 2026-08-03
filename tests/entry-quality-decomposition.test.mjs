/**
 * Checkpoint 1 — measurement integrity.
 *
 * These tests pin the distinction between "the number is bad" and "the way we
 * compute the number is bad". Every assertion here exists because conflating
 * the two would have led to changing production for the wrong reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  spreadPct, entryFillFor, exitFillFor, immediateDragPct, returnPctFor,
  compareConventions, analyzeBracket, auditMarkSeries, assessSampleIntegrity,
  decideHypothesis, OFFICIAL_CONVENTION, EXIT_BID_LEAN, DECOMPOSITION_VERSION,
} from "../lib/research/options/entry-quality-decomposition.ts";

// ── fill conventions ───────────────────────────────────────────────────────

test("the official convention is mid-in, 60% toward the bid out", () => {
  assert.equal(OFFICIAL_CONVENTION, "OFFICIAL_MID_TO_60PCT_BID");
  assert.equal(EXIT_BID_LEAN, 0.6);
  const q = { bid: 3.0, ask: 3.4 }; // mid 3.2, half-spread 0.2
  assert.equal(entryFillFor("OFFICIAL_MID_TO_60PCT_BID", q), 3.2, "entry is the MID, not the ask");
  assert.equal(exitFillFor("OFFICIAL_MID_TO_60PCT_BID", q), 3.2 - 0.2 * 0.6, "exit sits 60% of a half-spread below mid");
});

test("spreadPct uses mid as the denominator, matching paper.ts", () => {
  assert.ok(Math.abs(spreadPct({ bid: 3.0, ask: 3.4 }) - (0.4 / 3.2) * 100) < 1e-9);
  assert.equal(spreadPct({ bid: 0, ask: 0 }), null);
});

test("immediate drag under the official convention is exactly -0.3 x spreadPct", () => {
  // This is the arithmetic that kills the "it is all spread" hypothesis.
  for (const [bid, ask] of [[3.0, 3.4], [1.0, 1.2], [0.5, 0.7], [10, 11]]) {
    const q = { bid, ask };
    const sp = spreadPct(q);
    const drag = immediateDragPct("OFFICIAL_MID_TO_60PCT_BID", q);
    assert.ok(Math.abs(drag - -0.3 * sp) < 1e-3,
      `spread ${sp.toFixed(2)}% should cost ${(-0.3 * sp).toFixed(4)}%, got ${drag}`);
  }
});

test("a 10% spread costs 3%, not 10% — the difference the whole checkpoint turns on", () => {
  const q = { bid: 0.95, ask: 1.05 }; // mid 1.00, spread 10%
  assert.ok(Math.abs(spreadPct(q) - 10) < 1e-9);
  assert.ok(Math.abs(immediateDragPct("OFFICIAL_MID_TO_60PCT_BID", q) - -3) < 1e-9);
  // Ask-to-bid, which the plan originally assumed, is over 3x more punitive.
  assert.ok(Math.abs(immediateDragPct("ASK_TO_BID", q) - -9.5238) < 1e-3);
});

test("explaining a -24.6% MFE by spread alone would need an impossible spread", () => {
  // -0.3 * spreadPct = -24.6  =>  spreadPct = 82%. No gate permits that.
  const needed = 24.6 / 0.3;
  assert.ok(needed > 80, `would require a ${needed.toFixed(0)}% spread`);
});

test("ask-to-ask removes the spread crossing entirely", () => {
  const q = { bid: 3.0, ask: 3.4 };
  assert.equal(immediateDragPct("ASK_TO_ASK", q), 0, "same quote in and out costs nothing");
  assert.equal(immediateDragPct("MID_TO_MID", q), 0);
});

test("a crossed or empty quote yields null, never a fabricated fill", () => {
  assert.equal(entryFillFor("OFFICIAL_MID_TO_60PCT_BID", { bid: 3, ask: 2 }), null, "crossed");
  assert.equal(exitFillFor("OFFICIAL_MID_TO_60PCT_BID", { bid: 3, ask: 0 }), null, "no ask");
  assert.equal(immediateDragPct("OFFICIAL_MID_TO_60PCT_BID", { bid: 3, ask: 2 }), null);
  assert.equal(returnPctFor("OFFICIAL_MID_TO_60PCT_BID", { bid: 3, ask: 2 }, { bid: 1, ask: 2 }), null);
});

test("compareConventions reports the official result first and never replaces it", () => {
  const entry = { bid: 3.0, ask: 3.4 };
  const exit = { bid: 4.0, ask: 4.4 };
  const c = compareConventions(entry, exit);
  assert.equal(c.official, returnPctFor("OFFICIAL_MID_TO_60PCT_BID", entry, exit));
  assert.ok(c.midToMid > c.official, "midpoint flatters the result — diagnostic only");
  assert.ok(c.askToBid < c.official, "ask-to-bid is more punitive than the official convention");
  assert.equal(c.version, DECOMPOSITION_VERSION);
  assert.equal(c.spreadAttributablePts, +(c.official - c.askToAsk).toFixed(4));
});

test("midpoint performance is never substituted into the official field", () => {
  const entry = { bid: 1.0, ask: 1.4 };
  const exit = { bid: 1.0, ask: 1.4 };
  const c = compareConventions(entry, exit);
  assert.equal(c.midToMid, 0, "flat on midpoint");
  assert.ok(c.official < 0, "the official convention still charges the spread lean");
  assert.notEqual(c.official, c.midToMid);
});

// ── bracket arithmetic ─────────────────────────────────────────────────────

test("the production bracket is arithmetically unsurvivable", () => {
  // Measured: median target +44.94%, median stop -44.94%, win rate 18.29%.
  const b = analyzeBracket(0.1829, 44.94, -44.94);
  assert.equal(b.riskRewardRatio, 1, "a symmetric bracket is 1:1");
  assert.equal(b.survivable, false);
  assert.ok(Math.abs(b.impliedExpectancyPct - -28.5) < 0.1,
    `implied expectancy ${b.impliedExpectancyPct}% should be about -28.5%`);
  assert.ok(Math.abs(b.breakevenWinRate - 0.5) < 1e-6, "1:1 needs >50% to break even");
  assert.ok(Math.abs(b.breakevenTargetPct - 200.7) < 1.0,
    `at an 18.29% win rate the target would need to be ~201%, got ${b.breakevenTargetPct}`);
});

test("bracket implied expectancy tracks the observed average return", () => {
  // Observed average under current policy: -25.88%. Implied: -28.5%.
  const b = analyzeBracket(0.1829, 44.94, -44.94);
  assert.ok(Math.abs(b.impliedExpectancyPct - -25.88) < 5,
    "the bracket alone explains the observed loss to within a few points");
});

test("a survivable bracket is reported as such", () => {
  const b = analyzeBracket(0.30, 100, -25); // 4:1 at 30%
  assert.equal(b.survivable, true);
  assert.ok(b.impliedExpectancyPct > 0);
  assert.match(b.note, /survivable/);
});

test("bracket analysis clamps a nonsense win rate rather than throwing", () => {
  assert.equal(analyzeBracket(1.7, 50, -50).winRate, 1);
  assert.equal(analyzeBracket(-3, 50, -50).winRate, 0);
});

// ── mark-series integrity ──────────────────────────────────────────────────

test("one mark repeated across horizons is DEGENERATE, not a flat time series", () => {
  const a = auditMarkSeries([-11.63, -11.63, -11.63, -11.63, -11.63, -11.63, -11.63]);
  assert.equal(a.integrity, "DEGENERATE_SINGLE_MARK");
  assert.equal(a.horizonsUnreliable, true);
  assert.match(a.note, /one mark reused/);
});

test("two distinct values across seven horizons is still too sparse", () => {
  const a = auditMarkSeries([-11.6, -11.6, -11.6, -13.9, -13.9, -13.9, -13.9]);
  assert.equal(a.integrity, "SPARSE");
  assert.equal(a.horizonsUnreliable, true);
});

test("a genuinely varying series is usable", () => {
  const a = auditMarkSeries([-11.6, -7.0, -11.6, -13.9, -15.2, -16.3, -9.3]);
  assert.equal(a.integrity, "USABLE");
  assert.equal(a.horizonsUnreliable, false);
});

test("an empty series is EMPTY and unreliable, never zero", () => {
  const a = auditMarkSeries([null, undefined, NaN]);
  assert.equal(a.integrity, "EMPTY");
  assert.equal(a.distinctValues, 0);
  assert.equal(a.horizonsUnreliable, true);
});

// ── sample integrity ───────────────────────────────────────────────────────

test("the production sample is majority-unverified and not quotable", () => {
  // Measured: 82 verified of 553.
  const s = assessSampleIntegrity(553, 82);
  assert.equal(s.excluded, 471);
  assert.equal(s.majorityUnverified, true);
  assert.equal(s.quotable, false);
  assert.match(s.note, /must NOT be quoted/);
});

test("a verified majority is quotable with the sample size stated", () => {
  const s = assessSampleIntegrity(100, 85);
  assert.equal(s.quotable, true);
  assert.equal(s.majorityUnverified, false);
});

test("an empty sample reports null rather than 0%", () => {
  const s = assessSampleIntegrity(0, 0);
  assert.equal(s.verifiedFraction, null);
  assert.equal(s.quotable, false);
});

// ── verdict ────────────────────────────────────────────────────────────────

test("production evidence yields H3 — both materially contribute", () => {
  const v = decideHypothesis({
    medianImmediateDragPct: -3.0,   // 10% median spread under the official convention
    medianRealizedPct: -42.73,      // verified sample median
    neverProfitableFraction: 0.561, // 46/82 never had a positive mark
    bracketSurvivable: false,       // +44.94 / -44.94 at 18.29%
    verifiedCount: 82,
    degenerateMarkFraction: 0.841,  // 69/82 carry one mark reused across horizons
    majorityUnverified: true,       // 471 of 553 failed verification
  });
  assert.equal(v.hypothesis, "H3_BOTH_MATERIALLY_CONTRIBUTE");
  assert.match(v.rationale, /unsurvivable bracket/);
  assert.match(v.rationale, /degenerate/);
});

test("a dominant convention drag with a survivable bracket yields H1", () => {
  const v = decideHypothesis({
    medianImmediateDragPct: -20, medianRealizedPct: -25,
    neverProfitableFraction: 0.2, bracketSurvivable: true, verifiedCount: 90,
    degenerateMarkFraction: 0.05, majorityUnverified: false,
  });
  assert.equal(v.hypothesis, "H1_MEASUREMENT_ARTIFACT_DOMINATES");
});

test("a negligible drag with an unsurvivable bracket yields H2", () => {
  const v = decideHypothesis({
    medianImmediateDragPct: -1, medianRealizedPct: -40,
    neverProfitableFraction: 0.7, bracketSurvivable: false, verifiedCount: 90,
    degenerateMarkFraction: 0.05, majorityUnverified: false,
  });
  assert.equal(v.hypothesis, "H2_SIGNAL_FAILURE_DOMINATES");
});

test("too few VERIFIED trades yields INSUFFICIENT_EVIDENCE, never a guess", () => {
  const v = decideHypothesis({
    medianImmediateDragPct: -3, medianRealizedPct: -40,
    neverProfitableFraction: 0.6, bracketSurvivable: false, verifiedCount: 8,
  });
  assert.equal(v.hypothesis, "INSUFFICIENT_EVIDENCE");
});

test("missing inputs yield INSUFFICIENT_EVIDENCE rather than a default", () => {
  assert.equal(decideHypothesis({
    medianImmediateDragPct: null, medianRealizedPct: null,
    neverProfitableFraction: null, bracketSurvivable: null, verifiedCount: null,
  }).hypothesis, "INSUFFICIENT_EVIDENCE");
});

// ── boundaries ─────────────────────────────────────────────────────────────

test("this module is pure — no DB, network, AI, or subscriber authority", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("lib/research/options/entry-quality-decomposition.ts", "utf8");
  for (const banned of ["require(", "fetch(", "prepare(", "process.env", "openai", "anthropic"]) {
    assert.equal(src.includes(banned), false, `${banned} must not appear in a pure decomposition module`);
  }
});

test("degenerate marks alone make measurement material, even with tiny spread drag", () => {
  // The trap this guards: modelling only spread as "measurement" would report a
  // confident signal verdict while 84% of the evidence is one repeated mark.
  const base = {
    medianImmediateDragPct: -3, medianRealizedPct: -42.73,
    neverProfitableFraction: 0.561, bracketSurvivable: false, verifiedCount: 82,
  };
  assert.equal(decideHypothesis({ ...base, degenerateMarkFraction: 0.05, majorityUnverified: false }).hypothesis,
    "H2_SIGNAL_FAILURE_DOMINATES", "sound evidence => signal verdict");
  assert.equal(decideHypothesis({ ...base, degenerateMarkFraction: 0.841, majorityUnverified: false }).hypothesis,
    "H3_BOTH_MATERIALLY_CONTRIBUTE", "impaired evidence => both contribute");
});

test("an unverified population alone makes measurement material", () => {
  const v = decideHypothesis({
    medianImmediateDragPct: -3, medianRealizedPct: -42.73,
    neverProfitableFraction: 0.561, bracketSurvivable: false, verifiedCount: 82,
    degenerateMarkFraction: 0.05, majorityUnverified: true,
  });
  assert.equal(v.hypothesis, "H3_BOTH_MATERIALLY_CONTRIBUTE");
  assert.match(v.rationale, /majority-unverified/);
});
