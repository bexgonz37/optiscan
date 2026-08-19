/**
 * tests/missed-opportunity-coverage.test.mjs
 *
 * THE CIRCULARITY UNDER TEST. The V1 classifier gates everything on
 * `hadQuoteEvidence` at step 1, and only reaches `OUTSIDE_DISCOVERY_UNIVERSE` at
 * step 2. So the verdict that exists to name "we never looked at it" is
 * unreachable for exactly the symbols it describes — reaching it requires a
 * quote the system never took.
 *
 * On 2026-08-19 the MRNA forensic returned `evidenceQuality: NONE` — "the system
 * never quoted one". True, and useless: the loop that exists to notice a giant
 * miss could not notice it, because noticing required having already looked.
 *
 * What must now hold:
 *   - a symbol OptiScan never observed becomes a durable, classified case;
 *   - that case NEVER quotes an executable return, because there is no fill to
 *     claim — the winner-verification rule is not weakened, it is kept separate;
 *   - "observed the underlying but never quoted a contract" is a THIRD outcome,
 *     distinct from both.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCoverage,
  runCoverageSweep,
} from "../lib/research/missed-opportunity/coverage.ts";
import { classifyCase } from "../lib/research/missed-opportunity/classify.ts";

const SESSION = "2026-08-19";
const FIRST_SEEN = Date.parse("2026-08-19T11:00:00Z"); // 07:00 ET, premarket
const PEAK_AT = Date.parse("2026-08-19T14:05:00Z");

/** MRNA as independent market-state discovery recorded it. */
const MRNA_MOVER = {
  sessionDate: SESSION,
  symbol: "MRNA",
  firstObservedAtMs: FIRST_SEEN,
  firstObservedPhase: "premarket",
  firstMovePct: 84.0,
  firstRank: 2,
  firstScore: 96.0,
  peakAbsMovePct: 133.37,
  peakObservedAtMs: PEAK_AT,
  lastObservedAtMs: PEAK_AT,
  observations: 40,
  everExtreme: true,
  dollarVolume: 2_300_000_000,
  spreadPct: 0.04,
  reason: "+84.0% from prior close · $2300M traded",
};

/** An empty lane — OptiScan recorded nothing. */
const emptyLane = () => ({
  firstSeenAtMs: null, firstCandidateAtMs: null, direction: null, setupFamily: null,
  selectedOcc: null, consideredOccs: [], terminalReason: null, state: null,
  observationCount: 0, candidateCount: 0, readyCount: 0, rejectedCount: 0,
});

const reconstruction = (over = {}) => ({
  symbol: "MRNA", sessionDate: SESSION,
  regularScanner: emptyLane(), highAsymmetry: emptyLane(),
  alerts: [], deliveryDecisions: [], observations: [], hasAnyEvidence: false,
  ...over,
});

test("V1 CANNOT reach the verdict that describes this failure — the gap being closed", () => {
  const v1 = classifyCase({
    hadQuoteEvidence: false,          // OptiScan never quoted an option on MRNA
    executableReturnPct: null,
    thresholdPct: 200,
    verdict: "INSUFFICIENT_EVIDENCE",
    reconstruction: reconstruction(),
    winnerDirection: "CALL",
    budgetPlausibleCause: false,
  });
  assert.equal(v1.rootCause, "INSUFFICIENT_EVIDENCE");
  assert.notEqual(
    v1.rootCause, "OUTSIDE_DISCOVERY_UNIVERSE",
    "the verdict naming this failure is unreachable without a quote — which is the circularity",
  );
});

test("a symbol OptiScan never observed becomes a durable, classified coverage case", () => {
  const a = classifyCoverage({ mover: MRNA_MOVER, reconstruction: reconstruction(), minPeakAbsMovePct: 25 });
  assert.equal(a.outcome, "NOT_ADMITTED_TO_UNIVERSE");
  assert.equal(a.evidence, "MARKET_STATE_ONLY");
  assert.equal(a.admittedToUniverse, false);
  assert.equal(a.everQuoted, false);
  assert.equal(a.admissionLagMinutes, null, "never admitted, so there is no lag to report");
  assert.equal(a.firstIndependentObservationAtMs, FIRST_SEEN);
  assert.equal(a.firstObservedPhase, "premarket");
  assert.ok(a.notes.some((n) => /recorded no observation of it in any lane/.test(n)));
});

test("a coverage case NEVER quotes an executable return", () => {
  for (const rc of [reconstruction(), reconstruction({ hasAnyEvidence: true })]) {
    const a = classifyCoverage({ mover: MRNA_MOVER, reconstruction: rc, minPeakAbsMovePct: 25 });
    assert.equal(a.executableReturnPct, null, "no NBBO, no fill, no claim");
    assert.ok(
      a.notes.some((n) => /never claims what a fill would have paid/.test(n)),
      "and the case says so in its own words",
    );
    assert.ok(!("claimedReturnPct" in a));
    assert.ok(!("returnBasis" in a));
  }
});

test("observed-the-underlying-but-never-quoted is its own outcome", () => {
  const seenAt = FIRST_SEEN + 30 * 60_000;
  const a = classifyCoverage({
    mover: MRNA_MOVER,
    reconstruction: reconstruction({
      regularScanner: { ...emptyLane(), observationCount: 12, firstSeenAtMs: seenAt },
      hasAnyEvidence: true,
    }),
    minPeakAbsMovePct: 25,
  });
  assert.equal(a.outcome, "ADMITTED_NOT_QUOTED");
  assert.equal(a.admittedToUniverse, true);
  assert.equal(a.everQuoted, false);
  assert.equal(a.admissionLagMinutes, 30, "how long independent discovery led OptiScan by");
  assert.equal(a.executableReturnPct, null);
});

test("a symbol OptiScan did quote is handed back to the V1 forensic, not graded here", () => {
  const a = classifyCoverage({
    mover: MRNA_MOVER,
    reconstruction: reconstruction({
      regularScanner: {
        ...emptyLane(), observationCount: 40, firstSeenAtMs: FIRST_SEEN,
        selectedOcc: "O:MRNA260821C00120000",
      },
      hasAnyEvidence: true,
    }),
    minPeakAbsMovePct: 25,
  });
  assert.equal(a.outcome, "OBSERVED_BY_OPTISCAN");
  assert.equal(a.evidence, "MARKET_STATE_AND_SCANNER");
  assert.ok(a.notes.some((n) => /V1 forensic can grade it on NBBO/.test(n)));
});

test("a small mover is not inflated into a coverage gap", () => {
  const a = classifyCoverage({
    mover: { ...MRNA_MOVER, symbol: "MILD", peakAbsMovePct: 12 },
    reconstruction: reconstruction(),
    minPeakAbsMovePct: 25,
  });
  assert.equal(a.outcome, "INSUFFICIENT_EVIDENCE");
  assert.equal(a.evidence, "NONE");
});

test("the sweep tallies outcomes and survives a symbol that throws", () => {
  const movers = [
    MRNA_MOVER,
    { ...MRNA_MOVER, symbol: "MRNX", peakAbsMovePct: 264 },
    { ...MRNA_MOVER, symbol: "BOOM", peakAbsMovePct: 90 },
  ];
  const res = runCoverageSweep({
    sessionDate: SESSION,
    listMovers: () => movers,
    reconstruct: (symbol) => {
      if (symbol === "BOOM") throw new Error("reconstruction blew up");
      return reconstruction();
    },
    minPeakAbsMovePct: 25,
  });
  assert.equal(res.moversConsidered, 3);
  assert.equal(res.assessments.length, 2, "the failing symbol is dropped, the sweep completes");
  assert.equal(res.tally.NOT_ADMITTED_TO_UNIVERSE, 2);
  assert.equal(res.tally.OBSERVED_BY_OPTISCAN, 0);
});

test("the sweep needs no provider call — every input is an injected read", () => {
  // If this ever needed the network it could not run while the minute cap is
  // saturated, which is precisely when a budget-caused miss must be investigable.
  let listCalls = 0, reconstructCalls = 0;
  runCoverageSweep({
    sessionDate: SESSION,
    listMovers: () => { listCalls += 1; return [MRNA_MOVER]; },
    reconstruct: () => { reconstructCalls += 1; return reconstruction(); },
  });
  assert.equal(listCalls, 1);
  assert.equal(reconstructCalls, 1);
});
