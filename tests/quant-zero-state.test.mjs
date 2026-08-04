/**
 * quant-zero-state.test.mjs
 *
 * Pins the reconciliation measured against production on 2026-08-03 and the
 * defect it exposed.
 *
 * Production `/api/research/options/quant-lab` returned:
 *   lanes.delivered.sampleSize            = 92
 *   lanes.delivered_unverified.sampleSize = 364
 *   verification.deliveredTotal           = 364
 *   verification.deliveredVerified        = 92
 *   verification.deliveredExcluded        = 272
 *   verification.byStatus = { UNVERIFIED_DELIVERY: 270, VERIFIED_GRADED: 92, UNVERIFIED_EXIT: 2 }
 *
 * The page displayed "Sample size 0 · closed outcomes 0 · Not enough data".
 * The snapshot had failed to load and every tile rendered `?? 0`. These tests
 * make a fault and an empty lane structurally impossible to confuse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideQuantZeroState,
  exclusionReasons,
} from "../lib/research/options/quant-zero-state.ts";

/** The census production actually returned. */
const CENSUS = {
  officialLane: "delivered",
  officialStatus: "VERIFIED_GRADED",
  deliveredTotal: 364,
  deliveredVerified: 92,
  deliveredExcluded: 272,
  byStatus: { UNVERIFIED_DELIVERY: 270, VERIFIED_GRADED: 92, UNVERIFIED_EXIT: 2 },
  byLinkage: { DELIVERY_NOT_PROVEN: 270, LINKED: 94 },
};

test("a failed load is never a statistical zero", () => {
  const s = decideQuantZeroState({ loadError: "HTTP 401", report: null, lane: "delivered" });
  assert.equal(s.kind, "LOAD_FAILED");
  assert.equal(s.metricsRenderable, false);
  // The whole defect in one assertion: nothing was read, so no sample size exists.
  assert.equal(s.sampleSizeKnown, false);
  assert.match(s.detail, /UNKNOWN, not zero/);
  // "Not enough data" asserts the data was examined. It was not.
  assert.doesNotMatch(s.detail, /not enough data/i);
});

test("a null report with no error string is still a fault, not an empty lane", () => {
  const s = decideQuantZeroState({ report: null, verification: CENSUS, lane: "delivered" });
  assert.equal(s.kind, "LOAD_FAILED");
  assert.equal(s.sampleSizeKnown, false);
  assert.equal(s.metricsRenderable, false);
});

test("the production delivered lane renders as data, and explains its 272 exclusions", () => {
  const s = decideQuantZeroState({
    report: { sampleSize: 92 },
    verification: CENSUS,
    lane: "delivered",
  });
  assert.equal(s.kind, "DATA_PRESENT");
  assert.equal(s.metricsRenderable, true);
  assert.equal(s.sampleSizeKnown, true);
  // n=92 may never be shown bare — the other 272 rows must be accounted for.
  assert.match(s.detail, /92 of 364/);
  assert.match(s.detail, /272 are excluded/);
  assert.deepEqual(s.exclusions, [
    { reason: "UNVERIFIED_DELIVERY", n: 270 },
    { reason: "UNVERIFIED_EXIT", n: 2 },
  ]);
});

test("the included bucket is not reported as a reason for exclusion", () => {
  const reasons = exclusionReasons(CENSUS);
  assert.ok(
    !reasons.some((r) => r.reason === "VERIFIED_GRADED"),
    "VERIFIED_GRADED counts the rows that were INCLUDED; it cannot explain an exclusion",
  );
  assert.equal(reasons.reduce((a, r) => a + r.n, 0), CENSUS.deliveredExcluded);
});

test("an empty lane with a non-empty population reports exclusion, not absence", () => {
  const s = decideQuantZeroState({
    report: { sampleSize: 0 },
    verification: { ...CENSUS, deliveredVerified: 0, deliveredExcluded: 364, byStatus: { UNVERIFIED_DELIVERY: 364 } },
    lane: "delivered",
  });
  assert.equal(s.kind, "LANE_EMPTY_ALL_EXCLUDED");
  assert.equal(s.metricsRenderable, false);
  assert.match(s.headline, /All 364 records excluded/);
  assert.match(s.detail, /exclusion result, not an absence of data/);
  assert.deepEqual(s.exclusions, [{ reason: "UNVERIFIED_DELIVERY", n: 364 }]);
});

test("a genuinely empty lane says so without inventing an exclusion", () => {
  // This is the real state of `zero_dte_research`, measured at n=0 in production.
  const s = decideQuantZeroState({
    report: { sampleSize: 0 },
    verification: null,
    lane: "zero_dte_research",
  });
  assert.equal(s.kind, "LANE_GENUINELY_EMPTY");
  assert.equal(s.metricsRenderable, false);
  assert.equal(s.sampleSizeKnown, true);
  assert.deepEqual(s.exclusions, []);
  assert.match(s.detail, /genuinely empty/);
});

test("no kind other than DATA_PRESENT may render metric numbers", () => {
  const faults = [
    decideQuantZeroState({ loadError: "boom", report: null }),
    decideQuantZeroState({ report: { sampleSize: 0 }, verification: CENSUS }),
    decideQuantZeroState({ report: { sampleSize: 0 }, verification: null }),
  ];
  for (const s of faults) {
    assert.notEqual(s.kind, "DATA_PRESENT");
    assert.equal(s.metricsRenderable, false, `${s.kind} must not render metrics`);
  }
});
