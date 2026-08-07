import test from "node:test";
import assert from "node:assert/strict";
import { buildCohort } from "../lib/research/options/lower-high-cohort.ts";
import { auc, compareWinnersToLosers } from "../lib/research/options/pre-entry-comparison.ts";
import { splitByDate } from "../lib/research/options/selection-experiment.ts";

const T0 = Date.UTC(2026, 6, 29, 13, 35, 0);
const DAY = 86_400_000;

function src(over = {}) {
  return {
    paperTradeId: 1, alertId: "a1", opportunityCaseId: "oc_1", discordMessageId: "d1",
    symbol: "AAPL", optionSymbol: "O:AAPL260803P00330000", side: "put", expiration: "2026-08-03",
    status: "EXITED", exitReason: "stop_hit", enteredAtMs: T0, exitAtMs: T0 + 3_600_000,
    returnPct: -40, sameContractMarks: 100, peakPct: 1, troughPct: -40,
    msToPct: { p5: null, p10: null, p25: null, p50: null, p100: null },
    strike: 330, dte: 1, entryFill: 2.0, spreadPct: 2, volume: 5000, openInterest: 4000,
    iv: 0.35, delta: -0.45, underlyingPrice: 331,
    evidence: { underlying: { dollarVolume: 3e10 }, chain: {} },
    firstDetectedAtMs: T0, optionAtFirstDetection: 2.0,
    strategyVersion: null, exitPolicyVersion: null, deploymentSha: null,
    ...over,
  };
}

test("AUC is rank-based, so one extreme outlier cannot manufacture separation", () => {
  assert.equal(auc([3, 4, 5], [0, 1, 2]), 1);
  assert.equal(auc([0, 1, 2], [3, 4, 5]), 0);
  assert.equal(auc([1, 2, 3], [1, 2, 3]), 0.5);
  // Replacing a winner's value with something enormous does not change the ranking.
  assert.equal(auc([3, 4, 1e9], [0, 1, 2]), auc([3, 4, 5], [0, 1, 2]));
  assert.equal(auc([], [1]), null);
});

test("a feature that separates in one block and reverses in the next is not a discriminator", () => {
  const rows = buildCohort([
    // development: winners have HIGH spread
    ...[1, 2, 3].map((i) => src({ paperTradeId: i, returnPct: 45, spreadPct: 8, enteredAtMs: T0 })),
    ...[4, 5, 6].map((i) => src({ paperTradeId: i, returnPct: -40, spreadPct: 1, enteredAtMs: T0 })),
    // validation: winners have LOW spread — the sign flips
    ...[7, 8, 9].map((i) => src({ paperTradeId: i, returnPct: 45, spreadPct: 1, enteredAtMs: T0 + DAY })),
    ...[10, 11, 12].map((i) => src({ paperTradeId: i, returnPct: -40, spreadPct: 8, enteredAtMs: T0 + DAY })),
  ]).rows;
  const { development, validation } = splitByDate(rows, [rows[0].sessionDate]);
  const rep = compareWinnersToLosers(rows, development, validation);
  const spread = rep.features.find((f) => f.feature === "spreadPct");
  assert.equal(spread.repetitionTestable, true);
  assert.equal(spread.repeatsAcrossDates, false, "opposite directions must not count as repetition");
  assert.ok(!rep.repeatedDiscriminators.includes("spreadPct"));
});

test("a feature separating the same way in both blocks is reported as repeated", () => {
  const rows = buildCohort([
    ...[1, 2, 3].map((i) => src({ paperTradeId: i, returnPct: 45, iv: 0.2, enteredAtMs: T0 })),
    ...[4, 5, 6].map((i) => src({ paperTradeId: i, returnPct: -40, iv: 0.9, enteredAtMs: T0 })),
    ...[7, 8, 9].map((i) => src({ paperTradeId: i, returnPct: 45, iv: 0.25, enteredAtMs: T0 + DAY })),
    ...[10, 11, 12].map((i) => src({ paperTradeId: i, returnPct: -40, iv: 0.85, enteredAtMs: T0 + DAY })),
  ]).rows;
  const { development, validation } = splitByDate(rows, [rows[0].sessionDate]);
  const rep = compareWinnersToLosers(rows, development, validation);
  const iv = rep.features.find((f) => f.feature === "iv");
  assert.equal(iv.auc, 0, "winners consistently below losers");
  assert.equal(iv.repeatsAcrossDates, true);
  assert.ok(rep.repeatedDiscriminators.includes("iv"));
});

test("repetition is not claimed when a block is too small to test", () => {
  const rows = buildCohort([
    ...[1, 2, 3].map((i) => src({ paperTradeId: i, returnPct: 45, iv: 0.2, enteredAtMs: T0 })),
    ...[4, 5, 6].map((i) => src({ paperTradeId: i, returnPct: -40, iv: 0.9, enteredAtMs: T0 })),
    src({ paperTradeId: 7, returnPct: 45, iv: 0.2, enteredAtMs: T0 + DAY }),
  ]).rows;
  const { development, validation } = splitByDate(rows, [rows[0].sessionDate]);
  const rep = compareWinnersToLosers(rows, development, validation);
  const iv = rep.features.find((f) => f.feature === "iv");
  assert.equal(iv.repetitionTestable, false);
  assert.equal(iv.repeatsAcrossDates, false, "untestable is not the same as confirmed");
});

test("missing data is counted rather than silently dropped", () => {
  const rows = buildCohort([
    src({ paperTradeId: 1, returnPct: 45, iv: null }),
    src({ paperTradeId: 2, returnPct: -40, iv: 0.9 }),
    src({ paperTradeId: 3, returnPct: -40, iv: null }),
  ]).rows;
  const rep = compareWinnersToLosers(rows, rows, []);
  const iv = rep.features.find((f) => f.feature === "iv");
  assert.equal(iv.missingWinners, 1);
  assert.equal(iv.missingLosers, 1);
  assert.equal(iv.winnerN, 0);
  assert.equal(iv.auc, null, "no AUC can be computed from an empty group");
});

test("the report carries the small-sample caveat it cannot be quoted without", () => {
  const rows = buildCohort([src({ returnPct: 45 }), src({ paperTradeId: 2, returnPct: -40 })]).rows;
  const rep = compareWinnersToLosers(rows, rows, []);
  assert.match(rep.caveat, /never a reason to change a live threshold/);
});
