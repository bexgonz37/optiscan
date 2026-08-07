import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  buildShadowRecord, liveFeaturesFromSubmission, captureConfirmation,
  classifyArm, isShadowEligible, SHADOW_STRATEGY,
} from "../lib/research/options/prospective-shadow.ts";
import {
  LHC_SELECT_V1, definitionHash, checkFrozen, assertFrozen, describeExperiment,
  canTransition, assertTransition, EXPERIMENT_STATUSES, findExperiment,
  LHC_SELECT_V1_DEFINITION_HASH,
} from "../lib/research/options/experiment-registry.ts";
import {
  registerExperimentOnDb, recordShadowDecisionOnDb, recordStatusOnDb, currentStatusOnDb,
  statusHistoryOnDb, listShadowDecisionsOnDb, linkPaperTradeOnDb, linkOutcomeOnDb,
  decisionKey, refreshShadowOutcomesOnDb,
} from "../lib/research/options/shadow-arm-store.ts";
import {
  buildProspectiveScoreboard, weeklyVerdict,
} from "../lib/research/options/prospective-scoreboard.ts";
import {
  freezeAttribution, legacyAttribution, isLegacyAttribution, attributionKey,
  POLICY_VERSIONS, UNKNOWN_LEGACY_VERSION,
} from "../lib/research/options/policy-attribution.ts";
import { LHC_FINDINGS, assertFindingsWellFormed } from "../lib/research/options/lhc-findings.ts";
import {
  upsertFindingOnDb, seedLhcFindingsOnDb, listFindingsOnDb, findingsForPrompt,
} from "../lib/research/options/findings-store.ts";
import { HINDSIGHT_DENYLIST, assertNoLeakage } from "../lib/research/options/pre-entry-features.ts";

const T0 = Date.UTC(2026, 7, 7, 14, 35, 0); // 2026-08-07 10:35 ET

/** The slice of the production schema these modules touch, verbatim from lib/db.ts. */
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
    CREATE TABLE options_experiment_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL, experiment_version INTEGER NOT NULL,
      status TEXT NOT NULL, previous_status TEXT, reason TEXT NOT NULL, evidence_json TEXT,
      actor TEXT NOT NULL, created_at_ms INTEGER NOT NULL
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
    CREATE TABLE options_learning_findings (
      finding_id TEXT PRIMARY KEY, strategy TEXT, strategy_version TEXT, population TEXT,
      evidence_cohort_id TEXT, sessions_json TEXT NOT NULL, sample_size INTEGER NOT NULL,
      title TEXT NOT NULL, statement TEXT NOT NULL, baseline_metric_json TEXT,
      experimental_metric_json TEXT, evidence_strength TEXT NOT NULL, limitations_json TEXT NOT NULL,
      affected_opportunity_ids_json TEXT, recommended_experiment TEXT, experiment_id TEXT,
      experiment_status TEXT, must_not_be_summarized_as TEXT, deployment_sha TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, result_class TEXT NOT NULL,
      strategy TEXT, status TEXT NOT NULL, return_pct REAL, exit_reason TEXT,
      entered_at_ms INTEGER, exit_at_ms INTEGER, alert_id TEXT, paper_kind TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL, option_symbol TEXT NOT NULL,
      mark_at_ms INTEGER NOT NULL, return_pct REAL, created_at_ms INTEGER NOT NULL,
      UNIQUE(trade_id, mark_at_ms)
    );
  `);
  return d;
}

/** A submission that PASSES every V1 gate. */
function sub(over = {}) {
  return {
    symbol: "AAPL", strategy: SHADOW_STRATEGY, side: "put", direction: "bearish",
    optionSymbol: "O:AAPL260807P00230000", strike: 229.5, expiration: "2026-08-07", dte: 0,
    bid: 1.98, ask: 2.02, spreadPct: 2, volume: 5400, openInterest: 4000,
    iv: 0.35, delta: -0.45, underlyingPrice: 230,
    baselineOutcome: "DELIVER_TO_DISCORD", baselineAdmitted: true,
    baselineReason: "subscriber_worthy", baselineQuality: 0.78,
    opportunityCaseId: "oc_1", alertId: "oa_1", sessionState: "REGULAR",
    nowMs: T0, decisionMs: T0,
    firstDetectedAtMs: T0 - 600_000,
    firstReadyAtMs: T0 - 300_000,
    underlyingAtFirstDetection: 231,
    optionAtFirstDetection: 1.7,
    featureSnapshot: {
      underlying: { dollarVolume: 2.02e10, vwapDistPct: -0.24, nearestSupportDistPct: -1.4 },
      chain: { ivLevel: 1.1, callPutVolRatio: 0.9 },
    },
    ...over,
  };
}
const CTX = { deploymentSha: "abc1234", population: "DELIVERED_ALERT_PAPER" };
const rec = (over = {}) => buildShadowRecord(sub(over), CTX);

// â”€â”€ immutability / freeze â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("the recorded definition hash matches the live gates", () => {
  assert.equal(definitionHash(), LHC_SELECT_V1_DEFINITION_HASH);
  assert.equal(checkFrozen().frozen, true);
  assert.doesNotThrow(() => assertFrozen());
});

test("the frozen experiment records creation SHA, cohort, split and prospective start", () => {
  assert.equal(LHC_SELECT_V1.experimentId, "LHC_SELECT_V1");
  assert.equal(LHC_SELECT_V1.experimentVersion, 1);
  assert.equal(LHC_SELECT_V1.mode, "SHADOW_PAPER_ONLY");
  assert.equal(LHC_SELECT_V1.creationSha, "ad947f6");
  assert.equal(LHC_SELECT_V1.sourceCohortId, "LHC_DELIVERED_V1");
  assert.equal(LHC_SELECT_V1.prospectiveStartDate, "2026-08-07");
  assert.equal(LHC_SELECT_V1.developmentSessions.length, 4);
  assert.equal(LHC_SELECT_V1.validationSessions.length, 3);
  // Development and validation must not overlap, or the split proves nothing.
  const dev = new Set(LHC_SELECT_V1.developmentSessions);
  assert.ok(!LHC_SELECT_V1.validationSessions.some((s) => dev.has(s)));
  assert.equal(LHC_SELECT_V1.gates.length, 4);
});

test("the historical record carries the framings that break it", () => {
  const h = LHC_SELECT_V1.historicalResult;
  assert.equal(h.experimentProfitFactor, 1.24);
  assert.equal(h.exTopWinnerProfitFactor, 0.611);
  assert.equal(h.cappedAt60ProfitFactor, 0.721);
  assert.ok(h.exTopWinnerProfitFactor < 1, "ex-top-winner PF must be recorded as below break-even");
  assert.ok(LHC_SELECT_V1.robustnessCaveats.length >= 3);
});

test("describeExperiment refuses to render the headline without its caveats", () => {
  const d = describeExperiment();
  assert.match(d.headline, /Ex-top-winner PF 0\.611/);
  assert.match(d.headline, /capped-at-60% PF 0\.721/);
  assert.ok(d.caveats.length > 0);
  assert.match(d.mustNotBeSummarizedAs, /PROMISING and UNVALIDATED/);
});

test("SUBSCRIBER_APPROVED is not a reachable experiment status", () => {
  assert.ok(!EXPERIMENT_STATUSES.includes("SUBSCRIBER_APPROVED"));
  for (const from of EXPERIMENT_STATUSES) {
    assert.ok(!canTransition(from, "SUBSCRIBER_APPROVED"));
  }
});

test("the lifecycle enforces its transition table", () => {
  assert.ok(canTransition("PROPOSED", "HISTORICAL_TESTED"));
  assert.ok(canTransition("PAPER_VALIDATION", "PROMISING"));
  assert.ok(canTransition("PROMISING", "READY_FOR_HUMAN_REVIEW"));
  // An experiment must always be able to lose.
  assert.ok(canTransition("PROMISING", "DEMOTED"));
  assert.ok(canTransition("PAPER_VALIDATION", "FAILED"));
  // But it cannot skip the evidence.
  assert.ok(!canTransition("PROSPECTIVE_SHADOW", "PROMISING"));
  assert.ok(!canTransition("PROPOSED", "READY_FOR_HUMAN_REVIEW"));
  assert.ok(!canTransition("FAILED", "PROMISING"));
  assert.throws(() => assertTransition("PROPOSED", "PROMISING"), /illegal experiment transition/);
});

test("findExperiment resolves V1 and does not invent a V2", () => {
  assert.ok(findExperiment("LHC_SELECT_V1"));
  assert.ok(findExperiment("LHC_SELECT_V1", 1));
  assert.equal(findExperiment("LHC_SELECT_V1", 2), null);
  assert.equal(findExperiment("LHC_SELECT_V2"), null);
});

// â”€â”€ leakage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("no denylisted hindsight field can reach the live rule", () => {
  const f = liveFeaturesFromSubmission(sub());
  for (const k of HINDSIGHT_DENYLIST) assert.ok(!(k in f), `${k} leaked into live features`);
});

test("the leakage guard fires on a poisoned feature vector", () => {
  // The guard buildShadowRecord runs on every record, asserted directly on the fields that
  // scored AUC 0.892 / 0.875 and were pure hindsight.
  for (const k of ["contractUpdateCount", "contractCandidateCount", "returnPct", "mfePct"]) {
    assert.throws(() => assertNoLeakage({ [k]: 3 }, "test"), /hindsight field/, `${k} was not caught`);
  }
  // And a clean live vector passes it.
  assert.doesNotThrow(() => buildShadowRecord(sub(), CTX));
});

test("lifetime accumulators are on the denylist", () => {
  assert.ok(HINDSIGHT_DENYLIST.includes("contractUpdateCount"));
  assert.ok(HINDSIGHT_DENYLIST.includes("contractCandidateCount"));
});

// â”€â”€ arm classification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("classifyArm covers all four quadrants", () => {
  assert.equal(classifyArm(true, true), "BOTH_ADMIT");
  assert.equal(classifyArm(true, false), "BASELINE_ONLY");
  assert.equal(classifyArm(false, true), "EXPERIMENT_ONLY");
  assert.equal(classifyArm(false, false), "BOTH_REJECT");
});

test("a passing candidate lands BOTH_ADMIT and records every gate as clear", () => {
  const r = rec();
  assert.equal(r.arm, "BOTH_ADMIT");
  assert.equal(r.experimentAdmitted, true);
  assert.deepEqual(r.experimentBlockedBy, []);
  assert.deepEqual(r.experimentUnavailable, []);
  assert.equal(r.productionBehaviorChanged, false);
  assert.equal(r.mode, "SHADOW_PAPER_ONLY");
});

test("a far-OTM high-IV illiquid candidate is BASELINE_ONLY with named gates", () => {
  const r = rec({ strike: 220, iv: 0.9, dte: 9, featureSnapshot: { underlying: { dollarVolume: 1e8 }, chain: {} } });
  assert.equal(r.arm, "BASELINE_ONLY");
  assert.equal(r.experimentAdmitted, false);
  assert.deepEqual(
    [...r.experimentBlockedBy].sort(),
    ["ATM_BAND", "IV_CEILING", "SHORT_DTE", "UNDERLYING_LIQUIDITY"],
  );
  assert.match(r.experimentReason, /rejected by/);
});

test("V1 admitting what the baseline skipped is recorded as EXPERIMENT_ONLY", () => {
  const r = rec({ baselineAdmitted: false, baselineOutcome: "RESEARCH_ONLY", baselineReason: "below_subscriber_threshold" });
  assert.equal(r.arm, "EXPERIMENT_ONLY");
  assert.equal(r.baselineAdmitted, false);
  assert.equal(r.experimentAdmitted, true);
});

test("both rejecting is still recorded, so the denominator is real", () => {
  const r = rec({ baselineAdmitted: false, baselineOutcome: "REJECT", iv: 0.95 });
  assert.equal(r.arm, "BOTH_REJECT");
});

test("an unmeasurable gate fails closed and is reported as unavailable", () => {
  const r = rec({ featureSnapshot: { underlying: {}, chain: {} } });
  assert.equal(r.experimentAdmitted, false);
  assert.ok(r.experimentUnavailable.includes("UNDERLYING_LIQUIDITY"));
  assert.ok(r.experimentBlockedBy.includes("UNDERLYING_LIQUIDITY"));
  assert.match(r.experimentReason, /unmeasurable/);
});

test("the shadow arm is scoped to lower_high_continuation only", () => {
  assert.ok(isShadowEligible("lower_high_continuation"));
  assert.ok(!isShadowEligible("breakout_forming"));
  assert.ok(!isShadowEligible("vwap_rejection"));
});

// â”€â”€ confirmation cost â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("confirmation timing is captured with per-field provenance", () => {
  const c = captureConfirmation(sub());
  assert.equal(c.candidateCreatedAtMs, T0 - 600_000);
  assert.equal(c.confirmationStartedAtMs, T0 - 300_000);
  assert.equal(c.confirmationCompletedAtMs, T0);
  assert.equal(c.firstEligibleAtMs, T0 - 300_000);
  assert.equal(c.confirmationDelayMs, 300_000);
  assert.equal(c.queueDelayMs, 300_000);
  assert.equal(c.fieldQuality.confirmationDelayMs, "DERIVED");
  assert.equal(c.fieldQuality.candidateCreatedAtMs, "OBSERVED");
});

test("premium expansion measures what waiting cost", () => {
  const c = captureConfirmation(sub());
  // ask 2.02 against a first-eligible 1.70
  assert.ok(Math.abs(c.premiumExpansionPct - 18.8235) < 0.01);
  assert.equal(c.fieldQuality.premiumExpansionPct, "DERIVED");
});

test("underlying move before entry is signed in the thesis direction", () => {
  // Bearish: underlying fell 231 -> 230, so reward was consumed => positive.
  const bear = captureConfirmation(sub());
  assert.ok(bear.underlyingMoveBeforeEntryPct > 0);
  // Bullish with the same prices: the move went against the thesis => negative.
  const bull = captureConfirmation(sub({ direction: "bullish", side: "call" }));
  assert.ok(bull.underlyingMoveBeforeEntryPct < 0);
  assert.equal(
    Math.round(bear.underlyingMoveBeforeEntryPct * 1e6),
    -Math.round(bull.underlyingMoveBeforeEntryPct * 1e6),
  );
});

test("an unobserved timing field is null and UNAVAILABLE, never zero", () => {
  const c = captureConfirmation(sub({
    firstDetectedAtMs: null, firstReadyAtMs: null,
    optionAtFirstDetection: null, underlyingAtFirstDetection: null,
  }));
  assert.equal(c.candidateCreatedAtMs, null);
  assert.equal(c.confirmationDelayMs, null);
  assert.equal(c.premiumExpansionPct, null);
  assert.equal(c.underlyingMoveBeforeEntryPct, null);
  assert.equal(c.fieldQuality.candidateCreatedAtMs, "UNAVAILABLE");
  assert.equal(c.fieldQuality.premiumExpansionPct, "UNAVAILABLE");
  // The degenerate history is exactly what happens when these become 0.
  assert.notEqual(c.confirmationDelayMs, 0);
});

test("reward remaining reads the level on the thesis side", () => {
  const bear = captureConfirmation(sub());
  assert.equal(bear.rewardRemainingAtEntry, 1.4); // |nearestSupportDistPct|
  const bull = captureConfirmation(sub({
    direction: "bullish", side: "call",
    featureSnapshot: { underlying: { nearestResistanceDistPct: 0.8 }, chain: {} },
  }));
  assert.equal(bull.rewardRemainingAtEntry, 0.8);
});

// â”€â”€ attribution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("attribution is frozen from the live policy versions", () => {
  const a = freezeAttribution({ strategyId: "lower_high_continuation", population: "DELIVERED_ALERT_PAPER", deploymentSha: "abc1234" });
  assert.equal(a.strategyVersion, POLICY_VERSIONS.strategyVersion);
  assert.equal(a.exitPolicyVersion, POLICY_VERSIONS.exitPolicyVersion);
  assert.equal(a.deploymentSha, "abc1234");
  assert.equal(isLegacyAttribution(a), false);
});

test("legacy attribution is unknown everywhere and never inferred", () => {
  const a = legacyAttribution("lower_high_continuation", "DELIVERED_ALERT_PAPER");
  assert.equal(a.strategyVersion, UNKNOWN_LEGACY_VERSION);
  assert.equal(a.contractRankingVersion, UNKNOWN_LEGACY_VERSION);
  assert.equal(isLegacyAttribution(a), true);
  // A legacy row must never be equal to a live row under grouping.
  const live = freezeAttribution({ strategyId: "lower_high_continuation", population: "DELIVERED_ALERT_PAPER" });
  assert.notEqual(attributionKey(a), attributionKey(live));
});

test("every prospective record carries full attribution", () => {
  const r = rec();
  assert.equal(r.attribution.strategyId, "lower_high_continuation");
  assert.equal(r.attribution.population, "DELIVERED_ALERT_PAPER");
  assert.equal(r.attribution.experimentId, "LHC_SELECT_V1");
  assert.equal(r.attribution.cohortId, "LHC_DELIVERED_V1");
  assert.equal(r.attribution.deploymentSha, "abc1234");
  assert.equal(isLegacyAttribution(r.attribution), false);
});

// â”€â”€ store â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("the registry is write-once and refuses a changed definition", () => {
  const d = db();
  assert.equal(registerExperimentOnDb(d, LHC_SELECT_V1, T0).created, true);
  assert.equal(registerExperimentOnDb(d, LHC_SELECT_V1, T0).created, false);

  const tuned = { ...LHC_SELECT_V1, definitionHash: "0000000000000000deadbeefdeadbeef" };
  const r = registerExperimentOnDb(d, tuned, T0);
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.match(r.message, /prospective sample mixes two rules/);

  // And the stored row was NOT overwritten.
  const row = d.prepare("SELECT definition_hash FROM options_experiment_registry WHERE experiment_id=?").get("LHC_SELECT_V1");
  assert.equal(row.definition_hash, LHC_SELECT_V1_DEFINITION_HASH);
  d.close();
});

test("a shadow decision is idempotent within its bucket and never revised", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const r = rec();
  const first = recordShadowDecisionOnDb(d, r, T0);
  assert.equal(first.written, true);
  // Same opportunity, same 5-minute bucket => no second row.
  assert.equal(recordShadowDecisionOnDb(d, r, T0 + 1000).written, false);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_experiment_decisions").get().n, 1);

  // A later attempt with a DIFFERENT verdict must not overwrite the recorded one.
  const flipped = { ...r, experimentAdmitted: false, arm: "BASELINE_ONLY" };
  recordShadowDecisionOnDb(d, flipped, T0 + 2000);
  const stored = listShadowDecisionsOnDb(d)[0];
  assert.equal(stored.experimentAdmitted, true);
  assert.equal(stored.arm, "BOTH_ADMIT");
  d.close();
});

test("decision keys separate symbols, contracts and buckets", () => {
  const base = { experimentId: "E", experimentVersion: 1, symbol: "AAPL", optionSymbol: "O:A", recordedAtMs: T0 };
  assert.notEqual(decisionKey(base), decisionKey({ ...base, symbol: "TSLA" }));
  assert.notEqual(decisionKey(base), decisionKey({ ...base, optionSymbol: "O:B" }));
  assert.notEqual(decisionKey(base), decisionKey({ ...base, recordedAtMs: T0 + 400_000 }));
  assert.equal(decisionKey(base), decisionKey({ ...base, recordedAtMs: T0 + 1000 }));
});

test("the lifecycle is append-only and a demotion does not erase its promotion", () => {
  const d = db();
  const id = "LHC_SELECT_V1", v = 1;
  recordStatusOnDb(d, { experimentId: id, experimentVersion: v, status: "PROPOSED", reason: "r", actor: "deterministic" }, T0);
  recordStatusOnDb(d, { experimentId: id, experimentVersion: v, status: "HISTORICAL_TESTED", reason: "r", actor: "deterministic" }, T0 + 1);
  recordStatusOnDb(d, { experimentId: id, experimentVersion: v, status: "VALIDATION_TESTED", reason: "r", actor: "deterministic" }, T0 + 2);
  recordStatusOnDb(d, { experimentId: id, experimentVersion: v, status: "PROSPECTIVE_SHADOW", reason: "r", actor: "deterministic" }, T0 + 3);
  assert.equal(currentStatusOnDb(d, id, v), "PROSPECTIVE_SHADOW");
  assert.throws(
    () => recordStatusOnDb(d, { experimentId: id, experimentVersion: v, status: "PROMISING", reason: "r", actor: "deterministic" }, T0 + 4),
    /illegal experiment transition/,
  );
  const hist = statusHistoryOnDb(d, id, v);
  assert.equal(hist.length, 4);
  assert.equal(hist[0].status, "PROPOSED");
  assert.equal(hist[3].previousStatus, "VALIDATION_TESTED");
  d.close();
});

test("outcome linkage writes only outcome columns", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const r = rec();
  const { decisionKey: key } = recordShadowDecisionOnDb(d, r, T0);
  linkPaperTradeOnDb(d, key, 900, T0 + 5000);
  linkOutcomeOnDb(d, {
    paperTradeId: 900, outcomeStatus: "CLOSED", returnPct: 45.2, exitReason: "target_hit",
    closedAtMs: T0 + 3_600_000, sameContractMarks: 130, peakPct: 48, troughPct: -11,
  });
  const stored = listShadowDecisionsOnDb(d)[0];
  assert.equal(stored.paperTradeId, 900);
  assert.equal(stored.outcomeStatus, "CLOSED");
  assert.equal(stored.returnPct, 45.2);
  // The decision is untouched.
  assert.equal(stored.experimentAdmitted, true);
  assert.equal(stored.baselineAdmitted, true);
  assert.equal(stored.arm, "BOTH_ADMIT");
  // paperEnteredAtMs was the one confirmation field only knowable after reservation.
  assert.equal(stored.confirmation.paperEnteredAtMs, T0 + 5000);
  assert.equal(stored.confirmation.fieldQuality.paperEnteredAtMs, "OBSERVED");
  d.close();
});

test("refreshShadowOutcomes reads the paper store without provider calls", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const r = rec();
  const { decisionKey: key } = recordShadowDecisionOnDb(d, r, T0);
  d.prepare(
    `INSERT INTO options_paper_trades (id, option_symbol, result_class, status, strategy, return_pct, exit_reason, exit_at_ms, entered_at_ms, paper_kind, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(900, r.optionSymbol, "WIN", "EXITED", SHADOW_STRATEGY, 45.2, "target_hit", T0 + 3_600_000, T0, "DELIVERED_ALERT_PAPER", T0, T0);
  for (let i = 0; i < 25; i++) {
    d.prepare("INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, created_at_ms) VALUES (?,?,?,?,?)")
      .run(900, r.optionSymbol, T0 + i * 60_000, i * 2, T0);
  }
  linkPaperTradeOnDb(d, key, 900, T0 + 5000);
  const res = refreshShadowOutcomesOnDb(d);
  assert.equal(res.refreshed, 1);
  const stored = listShadowDecisionsOnDb(d)[0];
  assert.equal(stored.outcomeStatus, "CLOSED");
  assert.equal(stored.returnPct, 45.2);
  assert.equal(stored.sameContractMarks, 25);
  assert.equal(stored.peakPct, 48);
  d.close();
});

// â”€â”€ scoreboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function row(over = {}) {
  return {
    decisionKey: `k${Math.random()}`, experimentId: "LHC_SELECT_V1", experimentVersion: 1,
    sessionDate: "2026-08-07", recordedAtMs: T0, symbol: "AAPL", strategy: SHADOW_STRATEGY,
    side: "put", direction: "bearish", optionSymbol: "O:X", opportunityCaseId: null, alertId: null,
    baselineAdmitted: true, baselineOutcome: "DELIVER_TO_DISCORD", baselineReason: "", baselineQuality: 0.8,
    experimentAdmitted: true, experimentBlockedBy: [], experimentUnavailable: [],
    experimentScore: 80, experimentReason: "", arm: "BOTH_ADMIT",
    features: null, confirmation: null, attribution: null,
    paperTradeId: 1, outcomeStatus: "CLOSED", returnPct: 10, exitReason: "target_hit",
    closedAtMs: T0, sameContractMarks: 100, peakPct: 12, troughPct: -5,
    ...over,
  };
}

test("an empty prospective arm claims nothing", () => {
  const s = buildProspectiveScoreboard([]);
  assert.equal(s.opportunitiesEvaluated, 0);
  assert.equal(s.experiment.profitFactor, null);
  assert.equal(s.experiment.expectancyPct, null);
  assert.match(s.honestSummary, /no prospective decisions yet/);
  assert.equal(weeklyVerdict(s).verdict, "INSUFFICIENT_EVIDENCE");
});

test("open positions never enter expectancy or profit factor", () => {
  const s = buildProspectiveScoreboard([
    row({ outcomeStatus: "OPEN", returnPct: null }),
    row({ outcomeStatus: "OPEN", returnPct: null }),
  ]);
  assert.equal(s.openOutcomes, 2);
  assert.equal(s.closedOutcomes, 0);
  assert.equal(s.experiment.n, 0);
  assert.equal(s.experiment.expectancyPct, null);
  assert.equal(s.experiment.profitFactor, null);
  assert.match(s.honestSummary, /NO prospective\s+outcome has closed|NO prospective outcome has closed/);
  assert.match(s.honestSummary, /not zero, unavailable/);
});

test("a positive MFE on an open position is not counted as a win", () => {
  const s = buildProspectiveScoreboard([row({ outcomeStatus: "OPEN", returnPct: null, peakPct: 90 })]);
  assert.equal(s.experiment.winners, 0);
  assert.equal(s.experiment.n, 0);
});

test("the four arms are counted separately", () => {
  const s = buildProspectiveScoreboard([
    row({ arm: "BOTH_ADMIT" }),
    row({ arm: "BASELINE_ONLY", experimentAdmitted: false }),
    row({ arm: "EXPERIMENT_ONLY", baselineAdmitted: false }),
    row({ arm: "BOTH_REJECT", baselineAdmitted: false, experimentAdmitted: false }),
  ]);
  assert.equal(s.bothAdmit, 1);
  assert.equal(s.baselineOnly, 1);
  assert.equal(s.experimentOnly, 1);
  assert.equal(s.bothReject, 1);
  assert.equal(s.opportunitiesEvaluated, 4);
  assert.equal(s.baselineAdmits, 2);
  assert.equal(s.experimentAdmits, 2);
});

test("a rejected baseline WINNER is reported, not hidden", () => {
  const s = buildProspectiveScoreboard([
    row({ arm: "BASELINE_ONLY", experimentAdmitted: false, returnPct: 60, experimentBlockedBy: ["ATM_BAND"] }),
    row({ arm: "BASELINE_ONLY", experimentAdmitted: false, returnPct: -40 }),
  ]);
  assert.equal(s.winnersRejected.length, 1);
  assert.equal(s.winnersRejected[0].returnPct, 60);
  assert.deepEqual(s.winnersRejected[0].blockedBy, ["ATM_BAND"]);
  assert.equal(s.lossesAvoided.length, 1);
});

test("tail dependence is computed unconditionally", () => {
  // One huge winner carrying three losses.
  const s = buildProspectiveScoreboard([
    row({ returnPct: 300 }), row({ returnPct: -40 }), row({ returnPct: -40 }), row({ returnPct: -40 }),
  ]);
  assert.ok(s.experiment.profitFactor > 1);
  assert.ok(s.experimentExTopWinner.profitFactor < 1);
  assert.equal(s.tailDependence.carriedBySingleTrade, true);
  assert.equal(s.tailDependence.topWinnerReturnPct, 300);
  assert.ok(s.experimentCappedAt60.profitFactor < s.experiment.profitFactor);
  assert.match(s.honestSummary, /ONLY with its best trade/);
});

test("the scoreboard refuses the flattering one-liner", () => {
  const s = buildProspectiveScoreboard([row({ returnPct: 50 })]);
  assert.match(s.mustNotBeSummarizedAs, /PROMISING and UNVALIDATED/);
  assert.equal(s.productionBehaviorChanged, false);
});

test("weekly verdict fails an experiment that rejected winners without improving", () => {
  const rows = [
    // Baseline-only winner V1 threw away, plus a loss V1 kept.
    row({ arm: "BASELINE_ONLY", experimentAdmitted: false, returnPct: 100 }),
    row({ arm: "BOTH_ADMIT", returnPct: -40 }),
    row({ arm: "BOTH_ADMIT", returnPct: -40 }),
  ];
  const s = buildProspectiveScoreboard(rows);
  assert.equal(s.winnersRejected.length, 1);
  const v = weeklyVerdict(s);
  assert.equal(v.verdict, "FAILED");
  assert.match(v.reason, /rejected 1 baseline winner/);
});

test("weekly verdict will not call a tail-carried arm ready", () => {
  const rows = [];
  for (let i = 0; i < 24; i++) {
    rows.push(row({
      sessionDate: `2026-08-${String(7 + (i % 6)).padStart(2, "0")}`,
      returnPct: i === 0 ? 900 : -20,
    }));
  }
  const s = buildProspectiveScoreboard(rows);
  assert.equal(s.evidenceQuality.verdict, "SUFFICIENT_FOR_REVIEW");
  const v = weeklyVerdict(s);
  assert.equal(v.verdict, "PROMISING");
  assert.match(v.reason, /carried by one/);
});

test("weekly verdict never returns an approval", () => {
  const rows = [];
  for (let i = 0; i < 24; i++) {
    rows.push(row({
      sessionDate: `2026-08-${String(7 + (i % 6)).padStart(2, "0")}`,
      returnPct: i % 2 === 0 ? 60 : -20,
    }));
  }
  const v = weeklyVerdict(buildProspectiveScoreboard(rows));
  assert.equal(v.verdict, "READY_FOR_HUMAN_REVIEW");
  assert.match(v.reason, /this is not approval/);
});

test("evidence quality reports unavailable gates", () => {
  const s = buildProspectiveScoreboard([
    row({ experimentUnavailable: ["UNDERLYING_LIQUIDITY"], experimentAdmitted: false, arm: "BASELINE_ONLY" }),
    row({ experimentUnavailable: ["UNDERLYING_LIQUIDITY", "IV_CEILING"], experimentAdmitted: false, arm: "BASELINE_ONLY" }),
  ]);
  assert.equal(s.evidenceQuality.decisionsWithUnavailableGates, 2);
  assert.equal(s.evidenceQuality.unavailableGateCounts.UNDERLYING_LIQUIDITY, 2);
  assert.equal(s.evidenceQuality.unavailableGateCounts.IV_CEILING, 1);
});

test("untrustworthy trajectories are counted, and peak is withheld", () => {
  const s = buildProspectiveScoreboard([
    row({ sameContractMarks: 3, peakPct: 80 }),
    row({ sameContractMarks: 100, peakPct: 12 }),
  ]);
  assert.equal(s.evidenceQuality.trajectoryTrustworthy, 1);
  assert.equal(s.evidenceQuality.trajectoryUntrustworthy, 1);
});

// â”€â”€ findings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("every LHC finding is well formed and carries limitations", () => {
  assert.doesNotThrow(() => assertFindingsWellFormed());
  assert.equal(LHC_FINDINGS.length, 6);
  for (const f of LHC_FINDINGS) {
    assert.ok(f.limitations.length > 0, `${f.findingId} has no limitations`);
    assert.ok(f.sessions.length > 0);
    assert.ok(f.sampleSize > 0);
  }
});

test("the findings name the wrong summaries they invite", () => {
  const byId = Object.fromEntries(LHC_FINDINGS.map((f) => [f.findingId, f]));
  assert.match(byId.LHC_SELECT_V1_HISTORICAL_IMPROVEMENT.mustNotBeSummarizedAs, /PROMISING and UNVALIDATED/);
  assert.match(byId.LHC_WINNER_LOSER_PRE_ENTRY_SEPARATION.mustNotBeSummarizedAs, /Closer strikes always win/);
  assert.match(byId.LHC_SELECT_V1_TAIL_DEPENDENCE.mustNotBeSummarizedAs, /One trade is not evidence/);
});

test("the tail-dependence finding is rated stronger than the improvement finding", () => {
  const byId = Object.fromEntries(LHC_FINDINGS.map((f) => [f.findingId, f]));
  assert.equal(byId.LHC_SELECT_V1_HISTORICAL_IMPROVEMENT.evidenceStrength, "WEAK");
  assert.equal(byId.LHC_SELECT_V1_TAIL_DEPENDENCE.evidenceStrength, "STRONG");
});

test("a finding without limitations is refused by the store", () => {
  const d = db();
  assert.throws(
    () => upsertFindingOnDb(d, { ...LHC_FINDINGS[0], limitations: [] }, {}, T0),
    /refusing to persist an unqualified claim/,
  );
  d.close();
});

test("seeding findings is idempotent and updates in place", () => {
  const d = db();
  const first = seedLhcFindingsOnDb(d, { deploymentSha: "abc1234" }, T0);
  assert.equal(first.written, 6);
  assert.equal(first.created, 6);
  const second = seedLhcFindingsOnDb(d, { deploymentSha: "def5678" }, T0 + 1000);
  assert.equal(second.created, 0);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_learning_findings").get().n, 6);
  const stored = listFindingsOnDb(d, { strategy: "lower_high_continuation" });
  assert.equal(stored.length, 6);
  assert.equal(stored[0].deploymentSha, "def5678");
  assert.ok(stored.every((f) => f.limitations.length > 0));
  d.close();
});

test("the AI prompt rendering carries limitations and the banned summary", () => {
  const text = findingsForPrompt(LHC_FINDINGS);
  assert.match(text, /LIMITATIONS:/);
  assert.match(text, /MUST NOT BE SUMMARIZED AS:/);
  assert.match(text, /PROMISING and UNVALIDATED/);
  // The flattering number never appears without its qualification in the same block.
  const improvement = text.split("\n\n").find((b) => b.includes("LHC_SELECT_V1_HISTORICAL_IMPROVEMENT"));
  assert.ok(improvement.includes("LIMITATIONS:"));
  assert.match(improvement, /cohort the rule was READ FROM/);
});
