/**
 * The structured research context handed to the nightly and weekly AI.
 *
 * The failure this file exists to prevent is a model rendering `null` as `0`. The prospective
 * arm currently has ZERO decisions: an unguarded payload invites "profit factor 0", which reads
 * as a catastrophic result rather than the truth, which is that nothing has been measured. Every
 * section therefore has to say which of its metrics are unavailable, and a count of zero has to
 * remain distinguishable from a metric that could not be computed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  buildAiResearchContextOnDb, buildConfirmationCostContext, buildOwnerLaneContext,
  READING_RULES, NIGHTLY_ANALYSIS_QUESTIONS, AI_RESEARCH_CONTEXT_VERSION,
} from "../lib/research/options/ai-research-context.ts";
import { registerExperimentOnDb, recordShadowDecisionOnDb, listShadowDecisionsOnDb } from "../lib/research/options/shadow-arm-store.ts";
import { buildShadowRecord, SHADOW_STRATEGY } from "../lib/research/options/prospective-shadow.ts";
import { LHC_SELECT_V1 } from "../lib/research/options/experiment-registry.ts";
import { seedLhcFindingsOnDb } from "../lib/research/options/findings-store.ts";
import { RUNTIME_SHA_UNAVAILABLE } from "../lib/research/options/policy-attribution.ts";

const T0 = Date.UTC(2026, 7, 7, 14, 35, 0);
const SESSION = "2026-08-07";

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
    CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, paper_trade_id INTEGER);
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
const CTX = { deploymentSha: "62d1c80", population: "DELIVERED_ALERT_PAPER" };

// ── the empty state, which is the state tomorrow morning ────────────────────────────────────

test("with nothing recorded the context reports UNAVAILABLE, never zero", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const ctx = buildAiResearchContextOnDb(d, { sessionDate: SESSION, nowMs: T0 });

  assert.equal(ctx.contextVersion, AI_RESEARCH_CONTEXT_VERSION);
  assert.equal(ctx.experiment.scoreboard.closedOutcomes, 0);
  // The metric is null, and the section NAMES it as unavailable so no reader has to infer it.
  assert.equal(ctx.experiment.scoreboard.experiment.profitFactor, null);
  assert.ok(ctx.experiment.unavailableMetrics.includes("experimentProfitFactor"));
  assert.ok(ctx.researchLane.unavailableMetrics.includes("baselineProfitFactor"));
  assert.ok(ctx.ownerDiscord.unavailableMetrics.includes("profitFactor"));
  assert.ok(ctx.confirmationCost.unavailableMetrics.includes("medianConfirmationDelayMs"));
  d.close();
});

test("the reading rules travel inside the payload, not only in the prompt", () => {
  const d = db();
  const ctx = buildAiResearchContextOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  const rules = ctx.readingRules.join(" ");
  assert.match(rules, /null means NOT MEASURED/);
  assert.match(rules, /never means zero/);
  assert.match(rules, /profit factor unavailable/);
  assert.match(rules, /CLOSED outcomes only/);
  assert.deepEqual(ctx.readingRules, [...READING_RULES]);
  d.close();
});

test("a measured zero is still reported as zero", () => {
  const d = db();
  const ctx = buildAiResearchContextOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  // No openings happened. That is a count, and counts of zero are real.
  assert.equal(ctx.ownerDiscord.openings, 0);
  assert.equal(ctx.ownerDiscord.wins, 0);
  assert.ok(!ctx.ownerDiscord.unavailableMetrics.includes("openings"));
  assert.match(ctx.ownerDiscord.note, /UNAVAILABLE, not zero/);
  d.close();
});

test("an empty confirmation capture never reads as 'confirmation was instant'", () => {
  const c = buildConfirmationCostContext([]);
  assert.equal(c.sampleSize, 0);
  assert.equal(c.medianConfirmationDelayMs, null);
  assert.equal(c.medianPremiumExpansionPct, null);
  assert.match(c.note, /not zero/);
  assert.match(c.note, /not 'confirmation was instant'/);
});

// ── with one live decision ──────────────────────────────────────────────────────────────────

test("a recorded decision populates confirmation cost with its provenance", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  recordShadowDecisionOnDb(d, buildShadowRecord(sub(), CTX), T0);
  const rows = listShadowDecisionsOnDb(d, { experimentId: LHC_SELECT_V1.experimentId });
  const c = buildConfirmationCostContext(rows);

  assert.equal(c.sampleSize, 1);
  // firstReady is 300s before the decision, so the delay is measurable and DERIVED.
  assert.equal(c.medianConfirmationDelayMs, 300_000);
  assert.equal(c.fieldQualityBasis.confirmationDelayMs.DERIVED, 1);
  // 1.70 -> 2.02 ask is a real premium expansion, not a zero.
  assert.ok(c.medianPremiumExpansionPct > 18 && c.medianPremiumExpansionPct < 19);
  assert.deepEqual(c.unavailableMetrics, []);
  d.close();
});

test("a field the producer never supplied stays out of the median entirely", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  // No first-detection price: premium expansion is unmeasurable for this row.
  recordShadowDecisionOnDb(d, buildShadowRecord(sub({ optionAtFirstDetection: null }), CTX), T0);
  const rows = listShadowDecisionsOnDb(d, { experimentId: LHC_SELECT_V1.experimentId });
  const c = buildConfirmationCostContext(rows);

  assert.equal(c.medianPremiumExpansionPct, null);
  assert.equal(c.fieldQualityBasis.premiumExpansionPct.UNAVAILABLE, 1);
  assert.ok(c.unavailableMetrics.includes("medianPremiumExpansionPct"));
  // A different field on the SAME row is still measured — absence is per-field, not per-row.
  assert.equal(c.medianConfirmationDelayMs, 300_000);
  d.close();
});

test("the experiment section carries the freeze, the caveats and the zero-outcome statement", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const ctx = buildAiResearchContextOnDb(d, { sessionDate: SESSION, nowMs: T0 });

  assert.equal(ctx.experiment.experimentId, "LHC_SELECT_V1");
  assert.equal(ctx.experiment.frozen, true);
  assert.equal(ctx.experiment.definitionHash, LHC_SELECT_V1.definitionHash);
  assert.ok(ctx.experiment.robustnessCaveats.length > 0);
  assert.match(
    ctx.experiment.evidenceLimitations.join(" "),
    /ZERO prospective outcomes have closed/,
  );
  // The historical result is present but is never presented as prospective.
  assert.equal(ctx.experiment.historicalResult.experimentProfitFactor, 1.24);
  d.close();
});

test("the instructions forbid every authority the packet reserves to humans", () => {
  const d = db();
  const instr = buildAiResearchContextOnDb(d, { sessionDate: SESSION, nowMs: T0 }).instructions.join(" ");
  for (const forbidden of [
    /change a live threshold/, /select a live trade/, /alter subscriber readiness/,
    /approve a subscriber strategy/, /send an alert/, /deploy code/, /rewrite a historical outcome/,
  ]) assert.match(instr, forbidden);
  assert.match(instr, /PROMISING and UNVALIDATED/);
  assert.match(instr, /never be rendered as 0/);
  d.close();
});

test("findings reach the context with their limitations attached", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  seedLhcFindingsOnDb(d, { deploymentSha: "62d1c80" }, T0);
  const ctx = buildAiResearchContextOnDb(d, { sessionDate: SESSION, nowMs: T0 });

  assert.equal(ctx.findings.length, 6);
  assert.ok(ctx.findings.every((f) => f.limitations.length > 0));
  assert.ok(ctx.findings.some((f) => /PROMISING and UNVALIDATED/.test(f.mustNotBeSummarizedAs ?? "")));
  d.close();
});

test("system quality separates a bad deploy from legacy history", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  recordShadowDecisionOnDb(d, buildShadowRecord(sub(), CTX), T0);
  recordShadowDecisionOnDb(d, buildShadowRecord(sub(), { ...CTX, deploymentSha: null }), T0 + 600_000);
  const ctx = buildAiResearchContextOnDb(d, { sessionDate: SESSION, nowMs: T0 });

  assert.equal(ctx.systemQuality.shaCensus.observed, 1);
  assert.equal(ctx.systemQuality.shaCensus.runtimeUnavailable, 1);
  assert.equal(ctx.systemQuality.shaCensus.legacy, 0);
  assert.equal(ctx.systemQuality.shaCensus.hasDegradedRows, true);
  assert.match(ctx.systemQuality.note, /distinct from `legacy`/);
  const row = listShadowDecisionsOnDb(d, { experimentId: LHC_SELECT_V1.experimentId })[1];
  assert.equal(row.attribution.deploymentSha, RUNTIME_SHA_UNAVAILABLE);
  d.close();
});

test("a missing table is reported absent, not empty", () => {
  const d = db();
  const ctx = buildAiResearchContextOnDb(d, { sessionDate: SESSION, nowMs: T0 });
  assert.equal(ctx.missedOpportunities.available, false);
  assert.match(ctx.missedOpportunities.note, /Absent, not empty/);
  assert.ok(ctx.systemQuality.schemaTablesMissing.length >= 0);
  d.close();
});

test("the weekly view is cumulative and carries no single session's owner lane", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const ctx = buildAiResearchContextOnDb(d, { sessionDate: null, nowMs: T0 });
  assert.equal(ctx.sessionDate, null);
  assert.equal(ctx.ownerDiscord, null);
  assert.equal(ctx.missedOpportunities, null);
  // The experiment is present either way — that is the whole point of sharing the builder.
  assert.equal(ctx.experiment.experimentId, "LHC_SELECT_V1");
  d.close();
});

test("the owner lane per-version breakdown is empty rather than guessed while nothing has closed", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  recordShadowDecisionOnDb(d, buildShadowRecord(sub(), CTX), T0);
  const rows = listShadowDecisionsOnDb(d, { experimentId: LHC_SELECT_V1.experimentId });
  const owner = buildOwnerLaneContext(d, SESSION, rows);
  assert.deepEqual(owner.byPolicyVersion, []);
  d.close();
});

test("the analysis question list covers the operator questions the packet names", () => {
  const all = NIGHTLY_ANALYSIS_QUESTIONS.join(" ").toLowerCase();
  for (const topic of [
    "worked", "never worked", "gave the profit back", "reject baseline losers",
    "reject any baseline winners", "recover", "confirmation delays", "contract-quality",
    "degrading", "too weak to act on", "shadow or paper experiment",
  ]) assert.ok(all.includes(topic), `questions do not cover: ${topic}`);
});
