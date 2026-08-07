import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  runWeeklyResearchOnDb, buildAiBudgetReportOnDb, buildAiResearchContext,
  BUDGET_EXEMPT_SUBSYSTEMS, BUDGET_OPTIONAL_JOBS,
} from "../lib/research/options/weekly-research.ts";
import {
  registerExperimentOnDb, recordShadowDecisionOnDb, recordStatusOnDb, linkPaperTradeOnDb,
  currentStatusOnDb, statusHistoryOnDb,
} from "../lib/research/options/shadow-arm-store.ts";
import { buildShadowRecord, SHADOW_STRATEGY } from "../lib/research/options/prospective-shadow.ts";
import { LHC_SELECT_V1 } from "../lib/research/options/experiment-registry.ts";
import { seedLhcFindingsOnDb } from "../lib/research/options/findings-store.ts";

const T0 = Date.UTC(2026, 7, 7, 14, 35, 0);
const WEEK = "2026-W32";

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
    CREATE TABLE ai_job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL, model TEXT, status TEXT NOT NULL,
      error_category TEXT, error TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
      diagnostic_json TEXT, month_key TEXT NOT NULL, created_at_ms INTEGER NOT NULL
    );
  `);
  return d;
}

let nextTrade = 1;
function sub(over = {}) {
  return {
    symbol: "AAPL", strategy: SHADOW_STRATEGY, side: "put", direction: "bearish",
    optionSymbol: "O:AAPL260807P00230000", strike: 229.5, expiration: "2026-08-07", dte: 0,
    bid: 1.98, ask: 2.02, spreadPct: 2, volume: 5400, openInterest: 4000,
    iv: 0.35, delta: -0.45, underlyingPrice: 230,
    baselineOutcome: "DELIVER_TO_DISCORD", baselineAdmitted: true,
    baselineReason: "subscriber_worthy", baselineQuality: 0.78,
    opportunityCaseId: null, alertId: null, sessionState: "REGULAR",
    nowMs: T0, decisionMs: T0, firstDetectedAtMs: T0 - 600_000, firstReadyAtMs: T0 - 300_000,
    underlyingAtFirstDetection: 231, optionAtFirstDetection: 1.7,
    featureSnapshot: { underlying: { dollarVolume: 2.02e10, vwapDistPct: -0.24 }, chain: {} },
    ...over,
  };
}
const CTX = { deploymentSha: "abc1234", population: "DELIVERED_ALERT_PAPER" };

/** Record one decision and close it at `returnPct`. */
function closedDecision(d, { returnPct, dayOffset = 0, reject = false, baselineAdmitted = true }) {
  const id = nextTrade++;
  const occ = `O:AAPL2608${String(id).padStart(4, "0")}`;
  const ms = T0 + dayOffset * 86_400_000 + id * 600_000;
  const over = reject
    ? { optionSymbol: occ, strike: 200, iv: 0.9, dte: 9, featureSnapshot: { underlying: { dollarVolume: 1e8 }, chain: {} } }
    : { optionSymbol: occ };
  const rec = buildShadowRecord(sub({ ...over, nowMs: ms, decisionMs: ms, baselineAdmitted }), CTX);
  const { decisionKey: key } = recordShadowDecisionOnDb(d, rec, ms);
  d.prepare(
    `INSERT INTO options_paper_trades (id, option_symbol, result_class, strategy, status, return_pct, exit_reason, entered_at_ms, exit_at_ms, alert_id, paper_kind, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, occ, "X", SHADOW_STRATEGY, "EXITED", returnPct, "x", ms, ms + 3_600_000, `oa_${id}`, "DELIVERED_ALERT_PAPER", ms, ms);
  for (let i = 0; i < 25; i++) {
    d.prepare("INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, created_at_ms) VALUES (?,?,?,?,?)")
      .run(id, occ, ms + i * 60_000, returnPct, ms);
  }
  linkPaperTradeOnDb(d, key, id, ms);
  return rec;
}

/** Walk an experiment to PAPER_VALIDATION so weekly transitions are legal. */
function toPaperValidation(d) {
  for (const s of ["PROPOSED", "HISTORICAL_TESTED", "VALIDATION_TESTED", "PROSPECTIVE_SHADOW", "PAPER_VALIDATION"]) {
    recordStatusOnDb(d, { experimentId: "LHC_SELECT_V1", experimentVersion: 1, status: s, reason: "setup", actor: "deterministic" }, T0);
  }
}

// ── budget ─────────────────────────────────────────────────────────────────

test("the budget report reads the existing ledger and never invents a gate", () => {
  const d = db();
  const mk = new Date(T0).toISOString().slice(0, 7);
  const ins = d.prepare(
    "INSERT INTO ai_job_runs (job_type, model, status, error_category, input_tokens, output_tokens, estimated_cost_usd, month_key, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  ins.run("nightly_diagnosis", "m", "SUCCESS", "none", 5000, 800, 0.42, mk, T0);
  ins.run("nightly_diagnosis", "m", "SKIPPED_HARD_LIMIT", "budget", 0, 0, 0, mk, T0);
  ins.run("weekly_proposals", "m", "SUCCESS", "none", 9000, 1500, 1.10, mk, T0);

  const b = buildAiBudgetReportOnDb(d, { nowMs: T0, monthlyBudgetUsd: 20 });
  assert.equal(b.nightlyRequests, 2);
  assert.equal(b.weeklyRequests, 1);
  assert.equal(b.monthlyInputTokens, 14000);
  assert.equal(b.monthlyOutputTokens, 2300);
  assert.equal(b.estimatedMonthlySpendUsd, 1.52);
  assert.equal(b.monthlyBudgetUsd, 20);
  assert.equal(b.budgetRemainingUsd, 18.48);
  assert.equal(b.skippedForBudget, 1);
  d.close();
});

test("budget exhaustion may never stop the deterministic subsystems", () => {
  for (const s of ["scanner", "owner_discord", "paper_mirror", "marks", "lifecycle", "grading", "readiness", "deterministic_experiment_tracking", "evidence_learning_capture"]) {
    assert.ok(BUDGET_EXEMPT_SUBSYSTEMS.includes(s), `${s} must be budget-exempt`);
    assert.ok(!BUDGET_OPTIONAL_JOBS.includes(s), `${s} must not be skippable`);
  }
  // And the optional set is only AI reasoning.
  for (const j of BUDGET_OPTIONAL_JOBS) {
    assert.ok(!BUDGET_EXEMPT_SUBSYSTEMS.includes(j));
  }
});

test("the budget report tolerates a database with no AI ledger", () => {
  const d = new Database(":memory:");
  const b = buildAiBudgetReportOnDb(d, { nowMs: T0, monthlyBudgetUsd: 20 });
  assert.equal(b.nightlyRequests, 0);
  assert.equal(b.estimatedMonthlySpendUsd, 0);
  assert.equal(b.budgetRemainingUsd, 20);
  d.close();
});

// ── weekly review ──────────────────────────────────────────────────────────

test("an empty week concludes nothing and advances nothing", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const r = runWeeklyResearchOnDb(d, { weekKey: WEEK, nowMs: T0, monthlyBudgetUsd: 20 });
  assert.equal(r.ran, true);
  assert.equal(r.productionBehaviorChanged, false);
  assert.equal(r.verdict.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(r.statusChanged, false);
  assert.match(r.report.join("\n"), /INSUFFICIENT_EVIDENCE/);
  d.close();
});

test("the weekly report names winner rejections before anything flattering", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  toPaperValidation(d);
  closedDecision(d, { returnPct: 120, reject: true });   // baseline winner V1 threw away
  closedDecision(d, { returnPct: 60 });                  // V1 kept a winner
  closedDecision(d, { returnPct: -40 });
  const r = runWeeklyResearchOnDb(d, { weekKey: WEEK, nowMs: T0, monthlyBudgetUsd: 20 });
  const text = r.report.join("\n");
  const wrIdx = text.indexOf("Winner rejection");
  const laIdx = text.indexOf("Losses avoided");
  assert.ok(wrIdx > -1 && laIdx > -1);
  assert.ok(wrIdx < laIdx, "winner rejection must be reported before losses avoided");
  assert.match(text, /AAPL \+120\.00%/);
  assert.equal(r.scoreboard.winnersRejected.length, 1);
  d.close();
});

test("a week that rejected a winner without improving is recorded FAILED", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  toPaperValidation(d);
  closedDecision(d, { returnPct: 200, reject: true });  // the winner V1 threw away
  closedDecision(d, { returnPct: -40 });                // and V1 kept losses
  closedDecision(d, { returnPct: -40 });
  const r = runWeeklyResearchOnDb(d, { weekKey: WEEK, nowMs: T0, monthlyBudgetUsd: 20 });
  assert.equal(r.verdict.verdict, "FAILED");
  assert.equal(r.statusAfter, "FAILED");
  assert.equal(r.statusChanged, true);
  // FAILED is terminal — the history keeps what came before it.
  const hist = statusHistoryOnDb(d, "LHC_SELECT_V1", 1).map((h) => h.status);
  assert.ok(hist.includes("PAPER_VALIDATION"));
  assert.equal(hist[hist.length - 1], "FAILED");
  d.close();
});

test("the weekly review can never reach subscriber approval", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  toPaperValidation(d);
  // A flawless prospective sample across six sessions.
  for (let i = 0; i < 24; i++) {
    closedDecision(d, { returnPct: i % 2 === 0 ? 60 : -20, dayOffset: i % 6 });
  }
  // Week 1: the verdict is READY, but the ladder only advances one step.
  const w1 = runWeeklyResearchOnDb(d, { weekKey: WEEK, nowMs: T0, monthlyBudgetUsd: 20 });
  assert.equal(w1.verdict.verdict, "READY_FOR_HUMAN_REVIEW");
  assert.equal(w1.statusAfter, "PROMISING", "one good week reaches PROMISING, not READY");
  assert.match(w1.verdict.reason, /this is not approval/);

  // Week 2: the verdict has held, so the request to a human is finally recorded.
  const w2 = runWeeklyResearchOnDb(d, { weekKey: "2026-W33", nowMs: T0 + 7 * 86_400_000, monthlyBudgetUsd: 20 });
  assert.equal(w2.statusAfter, "READY_FOR_HUMAN_REVIEW");

  // And that is the ceiling. Nothing automated goes further.
  const hist = statusHistoryOnDb(d, "LHC_SELECT_V1", 1).map((h) => h.status);
  assert.ok(!hist.includes("SUBSCRIBER_APPROVED"));
  const w3 = runWeeklyResearchOnDb(d, { weekKey: "2026-W34", nowMs: T0 + 14 * 86_400_000, monthlyBudgetUsd: 20 });
  assert.equal(w3.statusAfter, "READY_FOR_HUMAN_REVIEW");
  assert.equal(w3.statusChanged, false);
  d.close();
});

test("a repeatedly-held verdict does not oscillate the status backwards", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  toPaperValidation(d);
  for (let i = 0; i < 24; i++) closedDecision(d, { returnPct: i % 2 === 0 ? 60 : -20, dayOffset: i % 6 });

  // Five consecutive weeks of the same READY verdict must settle, not ping-pong between
  // PROMISING and READY_FOR_HUMAN_REVIEW.
  const seen = [];
  for (let w = 0; w < 5; w++) {
    seen.push(runWeeklyResearchOnDb(d, { weekKey: `W${w}`, nowMs: T0 + w * 7 * 86_400_000, monthlyBudgetUsd: 20 }).statusAfter);
  }
  assert.deepEqual(seen, [
    "PROMISING", "READY_FOR_HUMAN_REVIEW", "READY_FOR_HUMAN_REVIEW",
    "READY_FOR_HUMAN_REVIEW", "READY_FOR_HUMAN_REVIEW",
  ]);
  // Exactly two promotion rows, not one per week.
  const hist = statusHistoryOnDb(d, "LHC_SELECT_V1", 1).map((h) => h.status);
  assert.equal(hist.filter((s) => s === "PROMISING").length, 1);
  assert.equal(hist.filter((s) => s === "READY_FOR_HUMAN_REVIEW").length, 1);
  d.close();
});

test("an experiment still in PROSPECTIVE_SHADOW is not promoted by a verdict", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  for (const s of ["PROPOSED", "HISTORICAL_TESTED", "VALIDATION_TESTED", "PROSPECTIVE_SHADOW"]) {
    recordStatusOnDb(d, { experimentId: "LHC_SELECT_V1", experimentVersion: 1, status: s, reason: "setup", actor: "deterministic" }, T0);
  }
  for (let i = 0; i < 24; i++) closedDecision(d, { returnPct: i % 2 === 0 ? 60 : -20, dayOffset: i % 6 });
  const r = runWeeklyResearchOnDb(d, { weekKey: WEEK, nowMs: T0, monthlyBudgetUsd: 20 });
  assert.equal(r.verdict.verdict, "READY_FOR_HUMAN_REVIEW");
  // The verdict is evidence, not permission to skip the ladder.
  assert.equal(r.statusAfter, "PROSPECTIVE_SHADOW");
  assert.equal(r.statusChanged, false);
  d.close();
});

test("per-session detail shows the rule is not carried by one session", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  closedDecision(d, { returnPct: 50, dayOffset: 0 });
  closedDecision(d, { returnPct: -40, dayOffset: 1 });
  closedDecision(d, { returnPct: 30, dayOffset: 2 });
  const r = runWeeklyResearchOnDb(d, { weekKey: WEEK, nowMs: T0, monthlyBudgetUsd: 20 });
  assert.equal(r.perSession.length, 3);
  assert.ok(r.perSession.every((p) => p.evaluated >= 1));
  assert.match(r.report.join("\n"), /Per session:/);
  d.close();
});

test("the weekly report always states the tail framings", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  closedDecision(d, { returnPct: 300 });
  closedDecision(d, { returnPct: -40 });
  closedDecision(d, { returnPct: -40 });
  const r = runWeeklyResearchOnDb(d, { weekKey: WEEK, nowMs: T0, monthlyBudgetUsd: 20 });
  const text = r.report.join("\n");
  assert.match(text, /PF without it/);
  assert.match(text, /capped at \+60%/);
  assert.equal(r.scoreboard.tailDependence.carriedBySingleTrade, true);
  d.close();
});

test("the weekly report states what the budget may never stop", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const r = runWeeklyResearchOnDb(d, { weekKey: WEEK, nowMs: T0, monthlyBudgetUsd: 20 });
  const text = r.report.join("\n");
  assert.match(text, /Budget exhaustion stops optional AI reasoning only/);
  assert.match(text, /owner Discord/);
  d.close();
});

// ── AI context ─────────────────────────────────────────────────────────────

test("the weekly review seeds findings itself, not only via the nightly", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  // No nightly has ever run against this database.
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_learning_findings").get().n, 0);
  const r = runWeeklyResearchOnDb(d, { weekKey: WEEK, nowMs: T0, monthlyBudgetUsd: 20, deploymentSha: "abc1234" });
  assert.equal(r.findings, 6);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_learning_findings").get().n, 6);
  // Still idempotent when both jobs run.
  runWeeklyResearchOnDb(d, { weekKey: WEEK, nowMs: T0 + 1000, monthlyBudgetUsd: 20 });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_learning_findings").get().n, 6);
  d.close();
});

test("the AI context carries limitations and forbids inventing numbers", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  seedLhcFindingsOnDb(d, {}, T0);
  const ctx = buildAiResearchContext(d, { nowMs: T0 });
  assert.equal(ctx.findings.length, 6);
  assert.ok(ctx.findings.every((f) => f.limitations.length > 0));
  const instr = ctx.instructions.join(" ");
  assert.match(instr, /Do not produce a number that is not in this payload/);
  assert.match(instr, /PROMISING and UNVALIDATED/);
  assert.match(instr, /CLOSED outcomes only/);
  assert.match(instr, /Report winners rejected before losses avoided/);
  d.close();
});

test("the AI context forbids every write authority the packet reserves to humans", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  const instr = buildAiResearchContext(d, { nowMs: T0 }).instructions.join(" ");
  for (const forbidden of [
    /change a live threshold/, /select a live trade/, /alter subscriber readiness/,
    /approve a subscriber strategy/, /send an alert/, /deploy code/, /rewrite a historical outcome/,
  ]) {
    assert.match(instr, forbidden);
  }
  d.close();
});

test("the AI context says so when nothing has closed, rather than reusing the historical result", () => {
  const d = db();
  registerExperimentOnDb(d, LHC_SELECT_V1, T0);
  recordShadowDecisionOnDb(d, buildShadowRecord(sub(), CTX), T0);
  const ctx = buildAiResearchContext(d, { nowMs: T0 });
  assert.equal(ctx.experiment.scoreboard.closedOutcomes, 0);
  assert.match(String(ctx.experiment.scoreboard.honestSummary), /NO prospective/);
  assert.match(ctx.instructions.join(" "), /If closedOutcomes is 0/);
  // The historical result is present but explicitly separated from the prospective one.
  assert.equal(ctx.experiment.historicalResult.experimentProfitFactor, 1.24);
  assert.ok(ctx.experiment.robustnessCaveats.length > 0);
  d.close();
});
