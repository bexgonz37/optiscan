/**
 * tests/high-asymmetry-outcomes.test.mjs — the grading contract.
 *
 * Proves that outcome labels are deterministic, conservative (ask entry / bid
 * marks), exact-OCC bound, and that an ordinary win can never be reported as an
 * outsized move.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  gradeAsymmetryOutcome,
  outcomeLabelCounts,
  isOutsized,
  ASYMMETRY_HORIZONS_MINUTES,
} from "../lib/research/asymmetry/outcomes.ts";
import { analyzePremiumChase, premiumChaseBucket } from "../lib/research/asymmetry/premium-chase.ts";

const T = Date.parse("2026-07-30T14:00:00Z"); // 10:00 ET
const OCC = "AAPL260731C00150000";

const mark = (minutes, bid, over = {}) => ({
  occSymbol: OCC,
  atMs: T + minutes * 60_000,
  bid,
  ask: bid + 0.05,
  quoteTimestampMs: T + minutes * 60_000 - 1_000,
  source: "test",
  ...over,
});

const grade = (marks, over = {}) => gradeAsymmetryOutcome({
  candidateId: "c1", occSymbol: OCC, entryAtMs: T, entryAsk: 1.00, marks, ...over,
}, { evaluationAtMs: T + 120 * 60_000 });

test("entries use the ask and marks use the bid — never the mid", () => {
  // Entry ask 1.00, bid mark 1.20. A mid-based grade would read higher.
  const out = grade([mark(5, 1.20)]);
  assert.equal(out.entryAsk, 1.00);
  assert.equal(out.returnsByHorizon["5m"], 20, "((1.20 - 1.00) / 1.00) * 100 from the BID");
  assert.ok(out.returnsByHorizon["5m"] < 22.5, "a mid-based grade (1.225) would be more generous and is not used");
});

test("the +50 / +100 / +200 / +500 thresholds are deterministic", () => {
  const cases = [
    { peak: 1.49, label: "ORDINARY_WIN", threshold: null },
    { peak: 1.50, label: "OUTSIZED_50", threshold: 50 },
    { peak: 1.99, label: "OUTSIZED_50", threshold: 50 },
    { peak: 2.00, label: "OUTSIZED_100", threshold: 100 },
    { peak: 2.99, label: "OUTSIZED_100", threshold: 100 },
    { peak: 3.00, label: "OUTSIZED_200", threshold: 200 },
    { peak: 5.99, label: "OUTSIZED_200", threshold: 200 },
    { peak: 6.00, label: "OUTSIZED_500", threshold: 500 },
  ];
  for (const { peak, label, threshold } of cases) {
    const out = grade([mark(5, peak), mark(10, peak)]);
    assert.equal(out.label, label, `peak bid ${peak} must label ${label}`);
    assert.equal(out.outsizedThresholdPct, threshold);
    // Running it again must produce exactly the same answer.
    assert.deepEqual(grade([mark(5, peak), mark(10, peak)]), out);
  }
});

test("an ordinary win is never mislabeled as outsized", () => {
  // Peaks at +30%, ends at +18%. Real win, ordinary size.
  const out = grade([mark(3, 1.15), mark(5, 1.30), mark(30, 1.18)]);
  assert.equal(out.mfePct, 30);
  assert.equal(out.finalVerifiedReturnPct, 18);
  assert.equal(out.label, "ORDINARY_WIN");
  assert.equal(isOutsized(out.label), false);
  assert.equal(out.outsizedThresholdPct, null);
});

test("flat and failed are separated by the verified final mark", () => {
  assert.equal(grade([mark(5, 1.05), mark(30, 1.02)]).label, "FLAT");
  assert.equal(grade([mark(5, 0.95), mark(30, 0.92)]).label, "FLAT");
  assert.equal(grade([mark(5, 0.80), mark(30, 0.60)]).label, "FAILED");
});

test("a mark for a different OCC contract cannot grade the outcome", () => {
  const wrong = grade([mark(5, 5.00, { occSymbol: "AAPL260731P00150000" })]);
  assert.equal(wrong.label, "INSUFFICIENT_EVIDENCE");
  assert.equal(wrong.usableMarkCount, 0);
  assert.equal(wrong.mfePct, null, "a 400% move on the WRONG contract must not become an MFE");
  assert.ok(wrong.rejectedMarks.some((r) => r.reason === "QUOTE_WRONG_OCC"));
});

test("stale marks cannot create an outcome", () => {
  const stale = grade([mark(5, 4.00, { quoteTimestampMs: T + 5 * 60_000 - 10 * 60_000 })]);
  assert.equal(stale.label, "INSUFFICIENT_EVIDENCE");
  assert.equal(stale.usableMarkCount, 0);
  assert.ok(stale.rejectedMarks.some((r) => r.reason === "QUOTE_STALE"));
});

test("marks after the evaluation time cannot influence the label", () => {
  const marks = [mark(5, 1.10), mark(90, 6.00)];
  const bounded = gradeAsymmetryOutcome(
    { candidateId: "c1", occSymbol: OCC, entryAtMs: T, entryAsk: 1.00, marks },
    { evaluationAtMs: T + 30 * 60_000 },
  );
  assert.equal(bounded.label, "ORDINARY_WIN", "the future +500% mark is not yet knowable");
  assert.equal(bounded.mfePct, 10);
  assert.equal(bounded.usableMarkCount, 1);

  const later = gradeAsymmetryOutcome(
    { candidateId: "c1", occSymbol: OCC, entryAtMs: T, entryAsk: 1.00, marks },
    { evaluationAtMs: T + 120 * 60_000 },
  );
  assert.equal(later.label, "OUTSIZED_500", "once it is in the past, the same mark grades normally");
});

test("marks before entry are refused", () => {
  const out = grade([mark(-5, 9.00), mark(5, 1.05)]);
  assert.equal(out.usableMarkCount, 1);
  assert.equal(out.mfePct, 5);
});

test("a horizon with no qualifying mark is null, not zero", () => {
  const out = grade([mark(2, 1.30)]);
  assert.equal(out.returnsByHorizon["1m"], 30, "the 2m mark satisfies the 1m horizon");
  for (const minutes of [5, 10, 15, 30, 60]) {
    assert.equal(out.returnsByHorizon[`${minutes}m`], null, `${minutes}m has no mark and must be null`);
    assert.notEqual(out.returnsByHorizon[`${minutes}m`], 0);
  }
  assert.equal(Object.keys(out.returnsByHorizon).length, ASYMMETRY_HORIZONS_MINUTES.length);
});

test("MFE, MAE, and time-to-milestone come from verified marks only", () => {
  const out = grade([mark(1, 0.80), mark(5, 1.60), mark(10, 3.10), mark(20, 1.20)]);
  assert.equal(out.maePct, -20);
  assert.equal(out.mfePct, 210);
  assert.equal(out.finalVerifiedReturnPct, 20);
  assert.equal(out.timeToMilestoneMs["25"], 5 * 60_000);
  assert.equal(out.timeToMilestoneMs["50"], 5 * 60_000);
  assert.equal(out.timeToMilestoneMs["100"], 10 * 60_000);
  assert.equal(out.timeToMilestoneMs["200"], 10 * 60_000);
  assert.equal(out.timeToMilestoneMs["500"], null, "never reached — null, not a fabricated time");
  assert.equal(out.freshExecutableExitQuote, true);
});

test("no entry ask means no grade at all", () => {
  const out = grade([mark(5, 3.00)], { entryAsk: null });
  assert.equal(out.label, "INSUFFICIENT_EVIDENCE");
  assert.equal(out.mfePct, null);
  assert.match(out.limitation, /executable ask/i);
});

test("no verified OCC means no grade at all", () => {
  const out = grade([mark(5, 3.00)], { occSymbol: null });
  assert.equal(out.label, "INSUFFICIENT_EVIDENCE");
  assert.match(out.limitation, /OCC/);
});

test("premium chase measures from the earliest VALID executable quote", () => {
  const quote = (minutesBefore, ask, over = {}) => ({
    occSymbol: OCC,
    atMs: T - minutesBefore * 60_000,
    bid: ask - 0.05,
    ask,
    quoteTimestampMs: T - minutesBefore * 60_000 - 1_000,
    source: "test",
    ...over,
  });

  const chase = analyzePremiumChase({
    occSymbol: OCC, candidateAtMs: T, candidateAsk: 1.20,
    priorQuotes: [quote(10, 1.00), quote(5, 1.10)],
  });
  assert.equal(chase.earliestAsk, 1.00, "the EARLIEST valid quote is the baseline, not the most recent");
  assert.equal(chase.chasePct, 20);
  assert.equal(chase.bucket, "PCT_20_25");

  // A cheaper but STALE earlier quote must not be allowed to inflate the chase.
  const withStale = analyzePremiumChase({
    occSymbol: OCC, candidateAtMs: T, candidateAsk: 1.20,
    // Observed at 09:40 ET but carrying a 09:35 ET provider timestamp: in
    // session, still 5 minutes stale, so it cannot anchor the chase.
    priorQuotes: [quote(20, 0.50, { quoteTimestampMs: T - 25 * 60_000 }), quote(10, 1.00)],
  });
  assert.equal(withStale.earliestAsk, 1.00);
  assert.equal(withStale.chasePct, 20);
  assert.ok(withStale.rejected.some((r) => r.reason === "QUOTE_STALE"));

  // A quote for a different contract cannot become the baseline either.
  const withWrongOcc = analyzePremiumChase({
    occSymbol: OCC, candidateAtMs: T, candidateAsk: 1.20,
    priorQuotes: [quote(20, 0.40, { occSymbol: "AAPL260731P00150000" }), quote(10, 1.00)],
  });
  assert.equal(withWrongOcc.earliestAsk, 1.00);
  assert.ok(withWrongOcc.rejected.some((r) => r.reason === "QUOTE_WRONG_OCC"));

  const noBaseline = analyzePremiumChase({ occSymbol: OCC, candidateAtMs: T, candidateAsk: 1.20, priorQuotes: [] });
  assert.equal(noBaseline.bucket, "UNKNOWN");
  assert.equal(noBaseline.chasePct, null);
  assert.notEqual(noBaseline.chasePct, 0, "an unmeasurable chase is unknown, not zero");
});

test("premium-chase buckets are fixed and exhaustive", () => {
  assert.equal(premiumChaseBucket(0), "UNDER_10");
  assert.equal(premiumChaseBucket(9.99), "UNDER_10");
  assert.equal(premiumChaseBucket(10), "PCT_10_15");
  assert.equal(premiumChaseBucket(14.99), "PCT_10_15");
  assert.equal(premiumChaseBucket(15), "PCT_15_20");
  assert.equal(premiumChaseBucket(20), "PCT_20_25");
  assert.equal(premiumChaseBucket(25), "OVER_25");
  assert.equal(premiumChaseBucket(1000), "OVER_25");
  assert.equal(premiumChaseBucket(null), "UNKNOWN");
});

test("an outsized move consumed by the chase is reported as such", () => {
  // Earliest valid ask 0.50; by detection the ask is 1.20 (+140% chase).
  // Peak bid 1.60 is +220% from 0.50 but only +33% from the price we paid.
  const chase = analyzePremiumChase({
    occSymbol: OCC, candidateAtMs: T, candidateAsk: 1.20,
    priorQuotes: [{ occSymbol: OCC, atMs: T - 60_000, bid: 0.45, ask: 0.50, quoteTimestampMs: T - 61_000, source: "test" }],
  });
  const out = gradeAsymmetryOutcome({
    candidateId: "c1", occSymbol: OCC, entryAtMs: T, entryAsk: 1.20,
    marks: [mark(5, 1.60)], premiumChase: chase,
  }, { evaluationAtMs: T + 60 * 60_000 });

  assert.equal(out.label, "ORDINARY_WIN");
  assert.equal(out.outsizedMoveTiming, "CONSUMED_BY_PREMIUM_CHASE");
  assert.equal(isOutsized(out.label), false, "the move existed, but not for anyone entering here");
});

test("label counts always list every label, including the zeroes", () => {
  const counts = outcomeLabelCounts([grade([mark(5, 2.50)])]);
  assert.equal(counts.OUTSIZED_100, 1);
  assert.equal(counts.OUTSIZED_500, 0);
  assert.equal(counts.FAILED, 0);
  assert.equal(counts.INSUFFICIENT_EVIDENCE, 0);
  assert.equal(Object.keys(counts).length, 8);
});
