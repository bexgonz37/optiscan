import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { validateProposal, createProposalOnDb, reviewProposalOnDb, applyProposal, ALLOWED_PROPOSAL_TYPES } from "../lib/research/proposals.ts";
import { runResearchPipelineOnDb, runResearchPipeline, runStages, buildTrainingRowsOnDb, researchModelState } from "../lib/research/ai-pipeline.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function db() {
  const d = new Database(":memory:");
  const ddl = `
    CREATE TABLE IF NOT EXISTS ai_research_runs (run_id TEXT PRIMARY KEY, pipeline TEXT NOT NULL, started_at_ms INTEGER NOT NULL, finished_at_ms INTEGER, status TEXT NOT NULL, stages_json TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS ai_research_findings (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, stage TEXT NOT NULL, finding_type TEXT NOT NULL, subject TEXT, strategy_agent TEXT, strategy_version INTEGER, lane TEXT, tier TEXT, regime TEXT, session TEXT, horizon TEXT, metrics_json TEXT, sample_size INTEGER NOT NULL DEFAULT 0, sufficiency TEXT NOT NULL, confidence TEXT, observation_only INTEGER NOT NULL DEFAULT 0, evidence_refs_json TEXT, created_at_ms INTEGER NOT NULL, UNIQUE(run_id, stage, subject));
    CREATE TABLE IF NOT EXISTS research_proposals (proposal_id TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL, created_by_pipeline TEXT, proposal_type TEXT NOT NULL, hypothesis TEXT NOT NULL, affected_strategy TEXT, affected_strategy_version INTEGER, affected_lane TEXT, affected_tier TEXT, evidence_summary TEXT NOT NULL, evidence_refs_json TEXT, sample_size INTEGER NOT NULL, wins INTEGER, losses INTEGER, expectancy REAL, confidence TEXT, expected_effect TEXT NOT NULL, risks TEXT NOT NULL, rollback_plan TEXT NOT NULL, validation_plan TEXT NOT NULL, minimum_validation_sample INTEGER NOT NULL, model_version INTEGER, observation_only INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'PENDING_REVIEW', reviewed_by TEXT, reviewed_at_ms INTEGER, review_notes TEXT);
    CREATE TABLE IF NOT EXISTS ai_training_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT NOT NULL, source_kind TEXT NOT NULL, executed INTEGER NOT NULL, experiment_id TEXT, experiment_version INTEGER, lane TEXT, portfolio TEXT, strategy_agent TEXT, strategy_version INTEGER, strategy_family TEXT, setup_tier TEXT, direction TEXT, asset_class TEXT, horizon TEXT, ticker TEXT, option_symbol TEXT, expiration TEXT, strike REAL, call_put TEXT, feature_snapshot_json TEXT, gate_results_json TEXT, data_quality TEXT, market_session TEXT, regime TEXT, fill_status TEXT, label TEXT, return_pct REAL, mfe_pct REAL, mae_pct REAL, entry_ts_ms INTEGER, exit_ts_ms INTEGER, provider_limitations TEXT, source_table TEXT, model_eligibility TEXT NOT NULL, created_at_ms INTEGER NOT NULL, UNIQUE(setup_id, source_kind));
    CREATE TABLE IF NOT EXISTS paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT, status TEXT, entry_price REAL, exit_price REAL, option_symbol TEXT, option_type TEXT, strategy_agent TEXT, lane TEXT, portfolio TEXT, setup_tier TEXT, mfe_pct REAL, mae_pct REAL, entry_at_ms INTEGER, exit_at_ms INTEGER, strategy_version INTEGER);
    CREATE TABLE IF NOT EXISTS counterfactual_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT, kind TEXT, setup_tier TEXT, strategy_agent TEXT, lane TEXT, ticker TEXT, horizon TEXT, session TEXT, regime TEXT, entry_price REAL, exit_price REAL, return_pct REAL, win INTEGER, reached_target INTEGER, underlying_move_pct REAL, contract_move_pct REAL, observation_note TEXT, defensible_entry INTEGER NOT NULL, gate_results_json TEXT, created_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS research_enrollments (id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT, experiment_version INTEGER, setup_id TEXT, lane TEXT, portfolio TEXT, strategy_agent TEXT, strategy_version INTEGER, strategy_family TEXT, setup_tier TEXT, ticker TEXT, asset_class TEXT, direction TEXT, horizon TEXT, option_symbol TEXT, expiration TEXT, strike REAL, call_put TEXT, market_session TEXT, regime TEXT, fill_status TEXT, non_fill_reason TEXT, paper_trade_id INTEGER, entry_quote_source TEXT, quote_ts_ms INTEGER, data_quality TEXT, gate_results_json TEXT, feature_snapshot_json TEXT, provider_limitations TEXT, created_at_ms INTEGER);
    CREATE TABLE IF NOT EXISTS setup_gate_results (id INTEGER PRIMARY KEY AUTOINCREMENT, setup_id TEXT, gate_name TEXT, passed INTEGER);`;
  d.exec(ddl); d.exec(ddl); // repeat-safe
  return d;
}

function seed(d) {
  d.prepare("INSERT INTO paper_trades (setup_id,status,entry_price,exit_price,option_symbol,option_type,strategy_agent,lane,portfolio,setup_tier) VALUES ('t1','EXITED',2,3,'O:X','call','call_0DTE','RESEARCH','RESEARCH','PRODUCTION_QUALITY')").run();
  d.prepare("INSERT INTO paper_trades (setup_id,status,entry_price,exit_price,option_symbol,option_type,strategy_agent,lane,portfolio,setup_tier) VALUES ('t2','EXITED',2,1,'O:Y','call','call_0DTE','RESEARCH','RESEARCH','PRODUCTION_QUALITY')").run();
  d.prepare("INSERT INTO counterfactual_outcomes (setup_id,kind,defensible_entry,entry_price,exit_price,return_pct,win,reached_target,created_at_ms) VALUES ('cf1','executable_counterfactual',1,2,3,50,1,1,1)").run();
  d.prepare("INSERT INTO counterfactual_outcomes (setup_id,kind,defensible_entry,reached_target,created_at_ms) VALUES ('ob1','market_movement_observation',0,1,1)").run();
  d.prepare("INSERT INTO research_enrollments (setup_id,strategy_agent,lane,portfolio,setup_tier,fill_status) VALUES ('rej1','put_research_0DTE','RESEARCH','RESEARCH','REJECTED_INVALID','NOT_FILLABLE_REJECTED')").run();
  d.prepare("INSERT INTO setup_gate_results (setup_id,gate_name,passed) VALUES ('cf1','freshness',0)").run(); // rejected setup that later reached target
}

// ── proposal validation + human-review boundary ──────────────────────────────
const validProposal = {
  proposalId: "p1", createdByPipeline: "deterministic_research_v1", proposalType: "threshold_experiment",
  hypothesis: "loosening X may help", evidenceSummary: "20 graded, 60% win", sampleSize: 20,
  expectedEffect: "+5% win rate", risks: "overfit", rollbackPlan: "revert flag", validationPlan: "run 50 more", minimumValidationSample: 50,
};

test("a proposal requires evidence, sample size, risks, rollback, and validation", () => {
  for (const drop of ["hypothesis", "evidenceSummary", "risks", "rollbackPlan", "validationPlan", "expectedEffect"]) {
    const bad = { ...validProposal, [drop]: "" };
    assert.equal(validateProposal(bad).ok, false, `missing ${drop} must fail`);
  }
  assert.equal(validateProposal({ ...validProposal, sampleSize: NaN }).ok, false);
  assert.equal(validateProposal({ ...validProposal, minimumValidationSample: 0 }).ok, false);
  assert.equal(validateProposal(validProposal).ok, true);
});

test("a proposal can never be created APPROVED and never defaults APPROVED", () => {
  const d = db();
  assert.equal(validateProposal({ ...validProposal, status: "APPROVED" }).ok, false);
  createProposalOnDb(d, validProposal, 1);
  assert.equal(d.prepare("SELECT status s FROM research_proposals WHERE proposal_id='p1'").get().s, "PENDING_REVIEW");
});

test("forbidden production-mutating proposal types are rejected (no bearish/puts/gates/Discord)", () => {
  for (const t of ["enable_bearish_actionability", "promote_puts_production", "disable_freshness_gate", "change_discord_delivery", "edit_env_var"]) {
    assert.equal(validateProposal({ ...validProposal, proposalType: t }).ok, false, `${t} must not be a permitted proposal type`);
  }
  assert.ok(ALLOWED_PROPOSAL_TYPES.length >= 8);
});

test("proposals may not target Production Discord directly", () => {
  assert.equal(validateProposal({ ...validProposal, affectedLane: "PRODUCTION_DISCORD" }).ok, false);
});

test("human review required to approve; approved proposals still do NOT auto-apply", () => {
  const d = db();
  createProposalOnDb(d, validProposal, 1);
  assert.equal(reviewProposalOnDb(d, "p1", "APPROVED", "", null, 2).ok, false, "no reviewer → rejected");
  assert.equal(reviewProposalOnDb(d, "p1", "APPROVED", "owner", "ok", 3).ok, true);
  assert.equal(d.prepare("SELECT status s FROM research_proposals WHERE proposal_id='p1'").get().s, "APPROVED");
  assert.equal(applyProposal("p1").applied, false, "APPROVED never auto-applies");
});

// ── pipeline runs + findings ─────────────────────────────────────────────────
test("SAFETY: the pipeline is a HARD no-op when AI_RESEARCH_PIPELINE_ENABLED is off", () => {
  const res = runResearchPipeline(1, {});
  assert.equal(res.ran, false);
  assert.match(res.skippedReason, /AI_RESEARCH_PIPELINE_ENABLED/);
});

test("pipeline emits findings for every stage; strategy eval preserves version attribution", () => {
  const d = db(); seed(d);
  d.prepare("UPDATE paper_trades SET strategy_version=3").run();
  d.prepare("INSERT INTO research_enrollments (setup_id,strategy_agent,strategy_version,lane,fill_status) VALUES ('t1','call_0DTE',3,'RESEARCH','FILLED')").run();
  const s = runResearchPipelineOnDb(d, { runId: "r1", nowMs: 1, minSample: 20 });
  assert.equal(s.stages.every((x) => x.status === "COMPLETED"), true);
  const stages = d.prepare("SELECT DISTINCT stage FROM ai_research_findings WHERE run_id='r1'").all().map((r) => r.stage).sort();
  assert.deepEqual(stages, ["counterfactual_review", "pattern_discovery", "portfolio_allocation", "strategy_evaluation", "trade_review"]);
  const se = d.prepare("SELECT strategy_version FROM ai_research_findings WHERE stage='strategy_evaluation' LIMIT 1").get();
  assert.equal(se.strategy_version, 3, "version attribution preserved in findings");
});

test("counterfactual-review findings are marked observation-only; small samples insufficient", () => {
  const d = db(); seed(d);
  runResearchPipelineOnDb(d, { runId: "r1", nowMs: 1, minSample: 20 });
  const f = d.prepare("SELECT observation_only, sufficiency FROM ai_research_findings WHERE stage='counterfactual_review' LIMIT 1").get();
  assert.equal(f.observation_only, 1, "gate effectiveness rests on market observations, not filled P&L");
  assert.equal(f.sufficiency, "INSUFFICIENT");
});

test("pattern discovery marks small cohorts EXPLORATORY (not causal)", () => {
  const d = db(); seed(d);
  runResearchPipelineOnDb(d, { runId: "r1", nowMs: 1, minSample: 20 });
  const p = d.prepare("SELECT sufficiency, metrics_json FROM ai_research_findings WHERE stage='pattern_discovery' LIMIT 1").get();
  assert.equal(p.sufficiency, "EXPLORATORY");
  assert.match(p.metrics_json, /correlation only/);
});

test("one failed stage does not stop the others (failure isolation)", () => {
  const d = db(); seed(d);
  const boom = { name: "boom", run: () => { throw new Error("kaboom"); } };
  const good = { name: "good", run: (db2, runId, nowMs) => { db2.prepare("INSERT INTO ai_research_findings (run_id,stage,finding_type,subject,sample_size,sufficiency,created_at_ms) VALUES (?,?,?,?,?,?,?)").run(runId, "good", "t", "s", 1, "EXPLORATORY", nowMs); return 1; } };
  const res = runStages(d, "r1", [boom, good], 1, 20);
  assert.equal(res.find((r) => r.name === "boom").status, "ERROR");
  assert.equal(res.find((r) => r.name === "good").status, "COMPLETED");
});

test("retries/restarts do not duplicate runs, findings, or training rows", () => {
  const d = db(); seed(d);
  const a = runResearchPipelineOnDb(d, { runId: "r1", nowMs: 1, minSample: 20 });
  const b = runResearchPipelineOnDb(d, { runId: "r1", nowMs: 2, minSample: 20 });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM ai_research_runs").get().n, 1);
  const findings1 = d.prepare("SELECT COUNT(*) n FROM ai_research_findings").get().n;
  runResearchPipelineOnDb(d, { runId: "r1", nowMs: 3, minSample: 20 });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM ai_research_findings").get().n, findings1, "findings idempotent");
  assert.equal(a.trainingRows > 0, true);
  assert.equal(b.trainingRows, 0, "training rows idempotent on re-run");
});

// ── training rows: distinct source kinds ─────────────────────────────────────
test("training rows keep executed / executable-cf / observation / rejected DISTINCT and honestly labeled", () => {
  const d = db(); seed(d);
  buildTrainingRowsOnDb(d, 1);
  const byKind = Object.fromEntries(d.prepare("SELECT source_kind, executed, model_eligibility FROM ai_training_rows").all().map((r) => [r.source_kind, r]));
  assert.equal(byKind.EXECUTED_TRADE.executed, 1);
  assert.equal(byKind.EXECUTED_TRADE.model_eligibility, "ELIGIBLE_EXECUTED");
  assert.equal(byKind.EXECUTABLE_COUNTERFACTUAL.executed, 0);
  assert.equal(byKind.EXECUTABLE_COUNTERFACTUAL.model_eligibility, "RESEARCH_ONLY");
  assert.equal(byKind.MARKET_OBSERVATION.executed, 0);
  assert.equal(byKind.MARKET_OBSERVATION.model_eligibility, "ANALYSIS_ONLY");
  const obs = d.prepare("SELECT label, return_pct FROM ai_training_rows WHERE source_kind='MARKET_OBSERVATION'").get();
  assert.notEqual(obs.label, "WIN"); assert.equal(obs.return_pct, null, "observations are never executed-return examples");
  const rej = d.prepare("SELECT executed, label, model_eligibility FROM ai_training_rows WHERE source_kind='REJECTED_INVALID'").get();
  assert.equal(rej.executed, 0); assert.equal(rej.label, null); assert.equal(rej.model_eligibility, "ANALYSIS_ONLY");
});

test("executed training rows preserve lane/strategy/tier/setup attribution", () => {
  const d = db(); seed(d);
  buildTrainingRowsOnDb(d, 1);
  const r = d.prepare("SELECT setup_id, strategy_agent, lane, setup_tier FROM ai_training_rows WHERE source_kind='EXECUTED_TRADE' AND setup_id='t1'").get();
  assert.equal(r.strategy_agent, "call_0DTE");
  assert.equal(r.lane, "RESEARCH");
  assert.equal(r.setup_tier, "PRODUCTION_QUALITY");
});

// ── model states ─────────────────────────────────────────────────────────────
test("research-trained models never become PRODUCTION_ELIGIBLE from research alone", () => {
  assert.equal(researchModelState({ graded: 0, wins: 0, losses: 0 }), "INACTIVE_NO_DATA");
  assert.equal(researchModelState({ graded: 10, wins: 6, losses: 4 }), "INACTIVE_INSUFFICIENT_SAMPLE");
  assert.equal(researchModelState({ graded: 40, wins: 25, losses: 15 }), "VALIDATED_RESEARCH", "sufficient research ≠ production");
  assert.equal(researchModelState({ graded: 40, wins: 25, losses: 15, passedProductionValidation: true }), "PRODUCTION_ELIGIBLE");
});

// ── structural: AI has no production authority ───────────────────────────────
test("AI modules cannot mutate config/flags/thresholds or touch Discord/trades/router", () => {
  for (const p of ["lib/research/ai-pipeline.ts", "lib/research/proposals.ts"]) {
    const src = read(p);
    assert.doesNotMatch(src, /process\.env\.\w+\s*=[^=]/, `${p} must not mutate env`);
    assert.doesNotMatch(src, /from ["'][^"']*notifications|deliverCalloutDiscord\(/, `${p} must not touch Discord`);
    assert.doesNotMatch(src, /createLanePaperTrade\(|createPaperTrade\(/, `${p} must not create trades`);
    assert.doesNotMatch(src, /scanner_settings|owner-settings|routeAgentResults\(/, `${p} must not alter config or route`);
  }
});
