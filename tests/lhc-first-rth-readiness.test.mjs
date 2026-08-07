/**
 * First-RTH readiness: what tomorrow's session must PROVE, checked against persisted rows.
 *
 * The board's most important property is that it does not go green on an empty table. Zero
 * prospective decisions exist right now, and a readiness view that reported PASS for "every
 * opportunity receives a baseline decision" when no opportunity has been evaluated would be the
 * same class of error as reporting `PF 0` for a lane that has closed nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { buildFirstRthReadiness } from "../lib/research/options/first-rth-readiness.ts";
import { registerExperimentOnDb, recordShadowDecisionOnDb, listShadowDecisionsOnDb } from "../lib/research/options/shadow-arm-store.ts";
import { buildShadowRecord, SHADOW_STRATEGY, captureConfirmation } from "../lib/research/options/prospective-shadow.ts";
import { LHC_SELECT_V1, checkFrozen } from "../lib/research/options/experiment-registry.ts";
import { HINDSIGHT_DENYLIST } from "../lib/research/options/pre-entry-features.ts";
import { POLICY_VERSIONS, RUNTIME_SHA_UNAVAILABLE } from "../lib/research/options/policy-attribution.ts";

const T0 = Date.UTC(2026, 7, 7, 14, 35, 0);
const FROZEN = checkFrozen();
const SHA_OK = { state: "OBSERVED", degraded: false, message: "commit identity observed from RAILWAY_GIT_COMMIT_SHA" };
const SHA_BAD = { state: "RUNTIME_SHA_UNAVAILABLE", degraded: true, message: "this process cannot name its own commit" };

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_experiment_registry (
      experiment_id TEXT NOT NULL, experiment_version INTEGER NOT NULL, mode TEXT NOT NULL,
      hypothesis TEXT NOT NULL, gates_json TEXT NOT NULL, definition_hash TEXT NOT NULL,
      creation_sha TEXT NOT NULL, prospective_start_date TEXT NOT NULL, activation_at_ms INTEGER NOT NULL,
      source_cohort_id TEXT NOT NULL, development_sessions_json TEXT NOT NULL,
      validation_sessions_json TEXT NOT NULL, historical_result_json TEXT NOT NULL,
      robustness_caveats_json TEXT NOT NULL, would_be_disproven_by TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL, PRIMARY KEY (experiment_id, experiment_version)
    );
    CREATE TABLE options_experiment_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, decision_key TEXT NOT NULL,
      experiment_id TEXT NOT NULL, experiment_version INTEGER NOT NULL,
      session_date TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL,
      symbol TEXT NOT NULL, strategy TEXT NOT NULL, side TEXT, direction TEXT,
      option_symbol TEXT NOT NULL, opportunity_case_id TEXT, alert_id TEXT,
      baseline_admitted INTEGER NOT NULL, baseline_outcome TEXT, baseline_reason TEXT, baseline_quality REAL,
      experiment_admitted INTEGER NOT NULL, experiment_blocked_by_json TEXT,
      experiment_unavailable_json TEXT, experiment_score REAL, experiment_components_json TEXT,
      experiment_reason TEXT, arm TEXT NOT NULL,
      features_json TEXT, confirmation_json TEXT, attribution_json TEXT,
      paper_trade_id INTEGER, outcome_status TEXT, return_pct REAL, exit_reason TEXT,
      closed_at_ms INTEGER, same_contract_marks INTEGER, peak_pct REAL, trough_pct REAL,
      created_at_ms INTEGER NOT NULL, UNIQUE(decision_key)
    );
  `);
  return d;
}

let seq = 0;
function sub(over = {}) {
  return {
    symbol: "AAPL", strategy: SHADOW_STRATEGY, side: "put", direction: "bearish",
    optionSymbol: `O:AAPL260807P0023${String(seq++).padStart(4, "0")}`, strike: 229.5,
    expiration: "2026-08-07", dte: 0,
    bid: 1.98, ask: 2.02, spreadPct: 2, volume: 5400, openInterest: 4000,
    iv: 0.35, delta: -0.45, underlyingPrice: 230,
    baselineOutcome: "DELIVER_TO_DISCORD", baselineAdmitted: true,
    baselineReason: "subscriber_worthy", baselineQuality: 0.78,
    opportunityCaseId: null, alertId: null, sessionState: "REGULAR",
    nowMs: T0, decisionMs: T0, firstDetectedAtMs: T0 - 600_000, firstReadyAtMs: T0 - 300_000,
    underlyingAtFirstDetection: 231, optionAtFirstDetection: 1.7,
    featureSnapshot: { underlying: { dollarVolume: 2.02e10, vwapDistPct: -0.24, nearestSupportDistPct: -1.2 }, chain: {} },
    ...over,
  };
}
const CTX = { deploymentSha: "62d1c80af371550d310c6c75f6d7b5154e251c7f", population: "DELIVERED_ALERT_PAPER" };

function record(d, over = {}, ctx = CTX) {
  const ms = T0 + seq * 600_000;
  recordShadowDecisionOnDb(d, buildShadowRecord(sub({ ...over, nowMs: ms, decisionMs: ms }), ctx), ms);
  return listShadowDecisionsOnDb(d, { experimentId: LHC_SELECT_V1.experimentId });
}
const byId = (r, id) => r.checks.find((c) => c.id === id);

test("an empty table is NOT_YET_OBSERVED everywhere, never PASS", () => {
  const r = buildFirstRthReadiness([], { frozen: FROZEN, shaAttribution: SHA_OK, sessionDate: null });
  assert.equal(r.awaitingFirstSession, true);
  assert.equal(r.allProven, false);
  assert.equal(r.decisionsInspected, 0);
  for (const id of [
    "baseline_decision_recorded", "experiment_decision_recorded", "pre_entry_inputs_only",
    "exact_occ_frozen", "experiment_version_frozen", "confirmation_fields_populate",
    "unavailable_is_never_zero", "policy_attribution_populated", "deployment_sha_recorded",
    "owner_baseline_alerts_continue", "experiment_cannot_influence_baseline",
  ]) assert.equal(byId(r, id).state, "NOT_YET_OBSERVED", `${id} claimed something from no rows`);
  assert.match(r.summary, /does not go green on an empty table/);
});

test("a real decision proves the decision, OCC, version, confirmation and attribution invariants", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const rows = record(d);
  const r = buildFirstRthReadiness(rows, { frozen: FROZEN, shaAttribution: SHA_OK, sessionDate: "2026-08-07" });

  assert.equal(r.awaitingFirstSession, false);
  for (const id of [
    "baseline_decision_recorded", "experiment_decision_recorded", "pre_entry_inputs_only",
    "exact_occ_frozen", "experiment_version_frozen", "confirmation_fields_populate",
    "unavailable_is_never_zero", "policy_attribution_populated", "deployment_sha_recorded",
    "owner_baseline_alerts_continue", "experiment_definition_unchanged", "deployment_sha_resolvable_now",
  ]) assert.equal(byId(r, id).state, "PASS", `${id}: ${byId(r, id).detail}`);
  d.close();
});

test("the exact OCC the decision was made about is what is stored", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const rows = record(d, { optionSymbol: "O:AAPL260807P00272500" });
  assert.equal(rows[0].optionSymbol, "O:AAPL260807P00272500");
  assert.equal(byId(buildFirstRthReadiness(rows, { frozen: FROZEN, shaAttribution: SHA_OK, sessionDate: null }), "exact_occ_frozen").state, "PASS");
  d.close();
});

test("a malformed contract symbol FAILS rather than passing unnoticed", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const rows = record(d, { optionSymbol: "AAPL-PUT-230" });
  const c = byId(buildFirstRthReadiness(rows, { frozen: FROZEN, shaAttribution: SHA_OK, sessionDate: null }), "exact_occ_frozen");
  assert.equal(c.state, "FAIL");
  assert.equal(c.offenders.length, 1);
  d.close();
});

test("every persisted decision carries the full policy attribution the packet requires", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const a = record(d)[0].attribution;
  assert.equal(a.strategyVersion, POLICY_VERSIONS.strategyVersion);
  assert.equal(a.selectionEngineVersion, POLICY_VERSIONS.selectionEngineVersion);
  assert.equal(a.contractRankingVersion, POLICY_VERSIONS.contractRankingVersion);
  assert.equal(a.dtePlannerVersion, POLICY_VERSIONS.dtePlannerVersion);
  assert.equal(a.confirmationPolicyVersion, POLICY_VERSIONS.confirmationPolicyVersion);
  assert.equal(a.stopPolicyVersion, POLICY_VERSIONS.stopPolicyVersion);
  assert.equal(a.exitPolicyVersion, POLICY_VERSIONS.exitPolicyVersion);
  assert.equal(a.experimentId, LHC_SELECT_V1.experimentId);
  assert.equal(a.deploymentSha, CTX.deploymentSha);
  d.close();
});

test("a deploy that could not name its commit is reported, not hidden", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const rows = record(d, {}, { ...CTX, deploymentSha: null });
  const r = buildFirstRthReadiness(rows, { frozen: FROZEN, shaAttribution: SHA_BAD, sessionDate: null });
  assert.equal(rows[0].attribution.deploymentSha, RUNTIME_SHA_UNAVAILABLE);
  assert.equal(byId(r, "deployment_sha_recorded").state, "FAIL");
  assert.equal(byId(r, "deployment_sha_resolvable_now").state, "FAIL");
  assert.match(r.summary, /FAILED/);
  // The versions are still known — only the commit is missing.
  assert.equal(byId(r, "policy_attribution_populated").state, "PASS");
  d.close();
});

test("every confirmation field is present with an OBSERVED/DERIVED/UNAVAILABLE basis", () => {
  const c = captureConfirmation(sub());
  const required = [
    "firstEligibleAtMs", "candidateCreatedAtMs", "confirmationStartedAtMs", "confirmationCompletedAtMs",
    "contractSelectedAtMs", "ownerNotifiedAtMs", "paperEnteredAtMs",
    "firstEligibleAsk", "frozenEntryAsk", "underlyingAtFirstEligibility", "underlyingAtEntry",
    "premiumExpansionPct", "underlyingMoveBeforeEntryPct", "rewardRemainingAtEntry",
    "confirmationDelayMs", "queueDelayMs", "deliveryDelayMs",
  ];
  for (const k of required) {
    assert.ok(k in c, `${k} missing from the capture`);
    assert.ok(["OBSERVED", "DERIVED", "UNAVAILABLE"].includes(c.fieldQuality[k]), `${k} has no basis`);
  }
  // The one field that genuinely cannot be known at this point is UNAVAILABLE and null — not 0.
  assert.equal(c.fieldQuality.paperEnteredAtMs, "UNAVAILABLE");
  assert.equal(c.paperEnteredAtMs, null);
});

test("an unobserved timing is null and never coerced to zero", () => {
  const c = captureConfirmation(sub({ firstDetectedAtMs: null, firstReadyAtMs: null, optionAtFirstDetection: null, underlyingAtFirstDetection: null }));
  for (const k of ["firstEligibleAtMs", "candidateCreatedAtMs", "confirmationDelayMs", "queueDelayMs", "premiumExpansionPct", "underlyingMoveBeforeEntryPct"]) {
    assert.equal(c[k], null, `${k} was coerced`);
    assert.equal(c.fieldQuality[k], "UNAVAILABLE");
  }
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const rows = record(d, { firstDetectedAtMs: null, firstReadyAtMs: null, optionAtFirstDetection: null, underlyingAtFirstDetection: null });
  const r = buildFirstRthReadiness(rows, { frozen: FROZEN, shaAttribution: SHA_OK, sessionDate: null });
  assert.equal(byId(r, "unavailable_is_never_zero").state, "PASS");
  assert.equal(byId(r, "confirmation_fields_populate").state, "PASS");
  d.close();
});

test("a capture that wrote a value under an UNAVAILABLE basis FAILS the board", () => {
  const forged = [{
    decisionKey: "k", experimentId: LHC_SELECT_V1.experimentId, experimentVersion: LHC_SELECT_V1.experimentVersion,
    sessionDate: "2026-08-07", recordedAtMs: T0, symbol: "AAPL", strategy: SHADOW_STRATEGY,
    side: "put", direction: "bearish", optionSymbol: "O:AAPL260807P00230000",
    opportunityCaseId: null, alertId: null,
    baselineAdmitted: true, baselineOutcome: "DELIVER_TO_DISCORD", baselineReason: "r", baselineQuality: 0.7,
    experimentAdmitted: true, experimentBlockedBy: [], experimentUnavailable: [], experimentScore: 1,
    experimentReason: "admitted", arm: "BOTH_ADMIT", features: {},
    // The exact substitution the capture exists to prevent.
    confirmation: { confirmationDelayMs: 0, fieldQuality: { confirmationDelayMs: "UNAVAILABLE" } },
    attribution: { ...POLICY_VERSIONS, deploymentSha: "62d1c80" },
    paperTradeId: null, outcomeStatus: null, returnPct: null, exitReason: null, closedAtMs: null,
    sameContractMarks: null, peakPct: null, troughPct: null,
  }];
  const c = byId(buildFirstRthReadiness(forged, { frozen: FROZEN, shaAttribution: SHA_OK, sessionDate: null }), "unavailable_is_never_zero");
  assert.equal(c.state, "FAIL");
});

test("a denylisted hindsight field in the feature vector FAILS the board", () => {
  const forged = [{
    decisionKey: "k", experimentId: LHC_SELECT_V1.experimentId, experimentVersion: LHC_SELECT_V1.experimentVersion,
    sessionDate: "2026-08-07", recordedAtMs: T0, symbol: "AAPL", strategy: SHADOW_STRATEGY,
    side: "put", direction: "bearish", optionSymbol: "O:AAPL260807P00230000",
    opportunityCaseId: null, alertId: null,
    baselineAdmitted: true, baselineOutcome: "DELIVER_TO_DISCORD", baselineReason: "r", baselineQuality: 0.7,
    experimentAdmitted: true, experimentBlockedBy: [], experimentUnavailable: [], experimentScore: 1,
    experimentReason: "admitted", arm: "BOTH_ADMIT",
    features: { dte: 0, contractUpdateCount: 12 },
    confirmation: { fieldQuality: { confirmationDelayMs: "DERIVED" } },
    attribution: { ...POLICY_VERSIONS, deploymentSha: "62d1c80" },
    paperTradeId: null, outcomeStatus: null, returnPct: null, exitReason: null, closedAtMs: null,
    sameContractMarks: null, peakPct: null, troughPct: null,
  }];
  const c = byId(buildFirstRthReadiness(forged, { frozen: FROZEN, shaAttribution: SHA_OK, sessionDate: null }), "pre_entry_inputs_only");
  assert.equal(c.state, "FAIL");
  assert.match(c.detail, new RegExp(`${HINDSIGHT_DENYLIST.length} denylisted`));
});

test("non-influence is untested until the arms actually disagree, and PASSES when they do", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  // Both admit: nothing about authority is proven yet.
  let rows = record(d);
  assert.equal(
    byId(buildFirstRthReadiness(rows, { frozen: FROZEN, shaAttribution: SHA_OK, sessionDate: null }), "experiment_cannot_influence_baseline").state,
    "NOT_YET_OBSERVED",
  );
  // A baseline delivery V1 rejects: the baseline still delivered, which is the evidence.
  rows = record(d, { strike: 200, iv: 0.9, dte: 9, featureSnapshot: { underlying: { dollarVolume: 1e8 }, chain: {} } });
  const c = byId(buildFirstRthReadiness(rows, { frozen: FROZEN, shaAttribution: SHA_OK, sessionDate: null }), "experiment_cannot_influence_baseline");
  assert.equal(c.state, "PASS");
  assert.ok(c.observed >= 1);
  assert.match(c.detail, /every admitted baseline row still delivered/);
  d.close();
});

test("a changed rule definition FAILS the board outright", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const rows = record(d);
  const r = buildFirstRthReadiness(rows, {
    frozen: { frozen: false, message: "LHC_SELECT_V1 gate definitions CHANGED since freeze." },
    shaAttribution: SHA_OK, sessionDate: null,
  });
  assert.equal(byId(r, "experiment_definition_unchanged").state, "FAIL");
  assert.equal(r.allProven, false);
  assert.match(r.summary, /cannot be trusted/);
  d.close();
});

test("a session where the baseline admitted nothing is reported as such, not as a pass", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const rows = record(d, { baselineAdmitted: false, baselineOutcome: "SUPPRESSED_LOW_QUALITY" });
  const c = byId(buildFirstRthReadiness(rows, { frozen: FROZEN, shaAttribution: SHA_OK, sessionDate: null }), "owner_baseline_alerts_continue");
  assert.equal(c.state, "NOT_YET_OBSERVED");
  assert.match(c.detail, /produced no owner alert/);
  d.close();
});
