/**
 * tests/extreme-premarket-discovery-experiment.test.mjs
 *
 * `EXTREME_PREMARKET_DISCOVERY_V1` was motivated by ONE example: MRNA on
 * 2026-08-19, whose 120C went from $8.13 at the first regular-hours mark to
 * $31.95. That is exactly the kind of story that gets a threshold quietly
 * widened until it fits, so the definition is frozen BEFORE any evidence exists
 * and these tests are the thing that notices if it moves.
 *
 * They also pin the two claims that make the registration honest rather than
 * decorative: it has NO historical result, and its EXECUTABLE measurement scope
 * is NOT STARTED with the reason recorded.
 *
 * And, because a session that edits discovery is exactly when the OTHER
 * experiments are most at risk of being disturbed, they assert those are
 * untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPERIMENT_ID,
  EXPERIMENT_MODE,
  MEASUREMENT_SCOPES,
  definitionHash,
  describeShadowAuthority,
  isMeasurable,
  scopeFor,
} from "../lib/research/options/extreme-premarket-discovery-experiment.ts";
import {
  EXPERIMENT_REGISTRY,
  EXTREME_PREMARKET_DISCOVERY_V1,
  EXTREME_PREMARKET_DISCOVERY_V1_DEFINITION_HASH,
  OWNER_SELECTION_STRENGTH_GATE_V1,
  OWNER_SELECTION_STRENGTH_GATE_V1_DEFINITION_HASH,
  checkExtremePremarketDiscoveryFrozen,
  checkOwnerSelectionStrengthFrozen,
  checkFrozen,
  findExperiment,
} from "../lib/research/options/experiment-registry.ts";

test("the discovery definition is frozen — eligibility floors AND ranking order", () => {
  const c = checkExtremePremarketDiscoveryFrozen();
  assert.equal(c.frozen, true, c.message);
  assert.equal(definitionHash(), EXTREME_PREMARKET_DISCOVERY_V1_DEFINITION_HASH);
  assert.equal(EXTREME_PREMARKET_DISCOVERY_V1.definitionHash, EXTREME_PREMARKET_DISCOVERY_V1_DEFINITION_HASH);
});

test("the hash is stable across calls and is not a coincidence of one probe", () => {
  assert.equal(definitionHash(), definitionHash());
  assert.equal(definitionHash().length, 32);
});

test("it claims NO historical evidence, and says so structurally", () => {
  assert.deepEqual(EXTREME_PREMARKET_DISCOVERY_V1.historicalResult, {});
  assert.deepEqual(EXTREME_PREMARKET_DISCOVERY_V1.developmentSessions, []);
  assert.deepEqual(EXTREME_PREMARKET_DISCOVERY_V1.validationSessions, []);
  assert.equal(EXTREME_PREMARKET_DISCOVERY_V1.sourceCohortId, "NONE_NO_HISTORICAL_COHORT");
  assert.ok(
    EXTREME_PREMARKET_DISCOVERY_V1.robustnessCaveats.some((c) => /NO HISTORICAL RESULT EXISTS/.test(c)),
    "the absence of evidence must be stated, not merely implied by empty fields",
  );
});

test("the EXECUTABLE scope is not started, and names its prerequisite", () => {
  const executable = scopeFor("EXECUTABLE");
  assert.equal(executable.started, false);
  assert.match(executable.blockedBy, /[Pp]rovider budget/);
  assert.match(executable.blockedBy, /PREREQUISITE/);

  const coverage = scopeFor("COVERAGE");
  assert.equal(coverage.started, true);
  assert.equal(coverage.blockedBy, null);

  // The fields that decide the hypothesis must NOT be reportable yet.
  for (const f of ["firstExecutableNbboAtMs", "attainableMfePct", "tooLateRate", "selectionStrength"]) {
    assert.equal(isMeasurable(f), false, `${f} must not be claimable under the current budget`);
  }
  // The fields that cost nothing must be.
  for (const f of ["firstIndependentObservationAtMs", "peakAbsMovePct", "admittedToOptiScanUniverse"]) {
    assert.equal(isMeasurable(f), true, `${f} is answerable from persisted rows`);
  }
});

test("it has zero live authority, by declaration and by mode", () => {
  const a = describeShadowAuthority();
  assert.equal(a.mode, "SHADOW_ONLY");
  assert.equal(EXPERIMENT_MODE, "SHADOW_ONLY");
  assert.equal(a.productionBehaviorChanged, false);
  assert.deepEqual(a.scopesStarted, ["COVERAGE"]);
  assert.deepEqual(a.scopesBlocked, ["EXECUTABLE"]);
  // The registry has no vocabulary for approval, and this must not introduce one.
  assert.ok(!JSON.stringify(EXTREME_PREMARKET_DISCOVERY_V1).includes("SUBSCRIBER_APPROVED"));
});

test("it is registered and findable, and the prospective arm starts 2026-08-19", () => {
  assert.equal(findExperiment(EXPERIMENT_ID)?.experimentId, EXPERIMENT_ID);
  assert.equal(EXTREME_PREMARKET_DISCOVERY_V1.prospectiveStartDate, "2026-08-19");
  assert.equal(EXPERIMENT_REGISTRY.length, 3);
});

test("the caveats refuse the flattering number MRNA invites", () => {
  const caveats = EXTREME_PREMARKET_DISCOVERY_V1.robustnessCaveats.join(" ");
  assert.match(caveats, /319,400%/, "the headline figure must be named");
  assert.match(caveats, /artifact of a \$0\.01 prior close/);
  assert.match(caveats, /\+293%/, "and the honest one recorded beside it");
  assert.ok(
    EXTREME_PREMARKET_DISCOVERY_V1.wouldBeDisprovenBy.length > 0,
    "an experiment that cannot lose is not an experiment",
  );
});

test("THE EXISTING EXPERIMENTS ARE UNTOUCHED", () => {
  // OWNER_SELECTION_STRENGTH_GATE_V1 — hash, mode, floor, prospective start.
  assert.equal(OWNER_SELECTION_STRENGTH_GATE_V1_DEFINITION_HASH, "9b4f77b3c6268bf9e94781dc849ad2ef");
  const owner = checkOwnerSelectionStrengthFrozen();
  assert.equal(owner.frozen, true, owner.message);
  assert.equal(OWNER_SELECTION_STRENGTH_GATE_V1.mode, "SHADOW_ONLY");
  assert.equal(OWNER_SELECTION_STRENGTH_GATE_V1.prospectiveStartDate, "2026-08-19");
  assert.equal(OWNER_SELECTION_STRENGTH_GATE_V1.historicalResult.shadowN, 41);

  // LHC_SELECT_V1 — its gate definitions must not have moved either.
  const lhc = checkFrozen();
  assert.equal(lhc.frozen, true, lhc.message);
});
