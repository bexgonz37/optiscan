/**
 * After the close, OptiScan must answer the operator's questions WITHOUT a Claude session.
 *
 * The chain is: market close → deterministic aggregation → Evidence Learning → AI research
 * context → AI analysis → persisted findings → owner recap. Every link is exercised here from
 * the scheduler's own entry point, because the product requirement is not "the functions exist"
 * — it is that nobody has to open a terminal to run them.
 *
 * The second half of the file is the budget contract: exhaustion may skip the two optional AI
 * calls and NOTHING else. The deterministic aggregation, the findings and the experiment
 * lifecycle have to survive a month with no dollars left.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { runAiScheduledJobs, __resetAiHandledGuard } from "../lib/ai/runtime.ts";
import { runNightlyDiagnosis } from "../lib/ai/nightly.ts";
import { nightlyNarrationPrompt } from "../lib/ai/prompts.ts";
import { validateNightlyNarrative } from "../lib/ai/schemas.ts";
import { recordAiJobRunOnDb, getReportOnDb } from "../lib/ai/store.ts";
import { aiConfig } from "../lib/ai/config.ts";
import { listFindingsOnDb } from "../lib/research/options/findings-store.ts";
import { currentStatusOnDb } from "../lib/research/options/shadow-arm-store.ts";
import { LHC_SELECT_V1 } from "../lib/research/options/experiment-registry.ts";
import { NIGHTLY_ANALYSIS_QUESTIONS } from "../lib/research/options/ai-research-context.ts";

const DAY = "2026-08-07";                                  // a Friday
const NOW = Date.parse("2026-08-08T00:30:00Z");            // 20:30 ET on DAY
const ENTRY = Date.parse("2026-08-07T14:00:00Z");          // 10:00 ET on DAY

const DDL = `
CREATE TABLE ai_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, report_type TEXT NOT NULL, period_key TEXT NOT NULL,
  period_start_ms INTEGER, period_end_ms INTEGER, summary_json TEXT NOT NULL, narrative_json TEXT,
  narrative_status TEXT NOT NULL DEFAULT 'PENDING', model TEXT, ai_job_run_id INTEGER, diagnostic_json TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, UNIQUE(report_type, period_key));
CREATE TABLE ai_lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, dedup_key TEXT NOT NULL UNIQUE, finding_type TEXT NOT NULL,
  title TEXT NOT NULL, summary TEXT NOT NULL, evidence_json TEXT NOT NULL, sample_size INTEGER NOT NULL DEFAULT 0,
  affected_ticker TEXT, affected_strategy TEXT, affected_session TEXT, affected_duration TEXT, date_range_start TEXT,
  date_range_end TEXT, source_report_id INTEGER, status TEXT NOT NULL DEFAULT 'OPEN', confidence TEXT NOT NULL DEFAULT 'LOW',
  decision_state TEXT NOT NULL DEFAULT 'NEEDS_MORE_DATA', decision_notes TEXT, linked_proposal_id INTEGER,
  strategy_version TEXT, result_after_implementation TEXT, occurrences INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE ai_job_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL, model TEXT, status TEXT NOT NULL,
  error_category TEXT, error TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
  diagnostic_json TEXT, month_key TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE paper_trade_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy TEXT, direction TEXT, dte_at_entry INTEGER,
  entry_session TEXT, entry_time_ms INTEGER, terminal_kind TEXT, grade TEXT NOT NULL, grading_status TEXT NOT NULL,
  return_pct REAL, opportunity_grade TEXT, peak_favorable_pct REAL);
CREATE TABLE paper_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, reject_reason TEXT, entry_state TEXT,
  confidence_tier TEXT, direction TEXT, created_at_ms INTEGER);
CREATE TABLE options_experiment_registry (experiment_id TEXT NOT NULL, experiment_version INTEGER NOT NULL, mode TEXT NOT NULL,
  hypothesis TEXT NOT NULL, gates_json TEXT NOT NULL, definition_hash TEXT NOT NULL, creation_sha TEXT NOT NULL,
  prospective_start_date TEXT NOT NULL, activation_at_ms INTEGER NOT NULL, source_cohort_id TEXT NOT NULL,
  development_sessions_json TEXT NOT NULL, validation_sessions_json TEXT NOT NULL, historical_result_json TEXT NOT NULL,
  robustness_caveats_json TEXT NOT NULL, would_be_disproven_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (experiment_id, experiment_version));
CREATE TABLE options_experiment_status (id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL,
  experiment_version INTEGER NOT NULL, status TEXT NOT NULL, previous_status TEXT, reason TEXT NOT NULL,
  evidence_json TEXT, actor TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE options_experiment_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, decision_key TEXT NOT NULL,
  experiment_id TEXT NOT NULL, experiment_version INTEGER NOT NULL, session_date TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL,
  symbol TEXT NOT NULL, strategy TEXT NOT NULL, side TEXT, direction TEXT, option_symbol TEXT NOT NULL,
  opportunity_case_id TEXT, alert_id TEXT, baseline_admitted INTEGER NOT NULL, baseline_outcome TEXT, baseline_reason TEXT,
  baseline_quality REAL, experiment_admitted INTEGER NOT NULL, experiment_blocked_by_json TEXT,
  experiment_unavailable_json TEXT, experiment_score REAL, experiment_components_json TEXT, experiment_reason TEXT,
  arm TEXT NOT NULL, features_json TEXT, confirmation_json TEXT, attribution_json TEXT, paper_trade_id INTEGER,
  outcome_status TEXT, return_pct REAL, exit_reason TEXT, closed_at_ms INTEGER, same_contract_marks INTEGER,
  peak_pct REAL, trough_pct REAL, created_at_ms INTEGER NOT NULL, UNIQUE(decision_key));
CREATE TABLE options_learning_findings (finding_id TEXT PRIMARY KEY, strategy TEXT, strategy_version TEXT, population TEXT,
  evidence_cohort_id TEXT, sessions_json TEXT NOT NULL, sample_size INTEGER NOT NULL, title TEXT NOT NULL,
  statement TEXT NOT NULL, baseline_metric_json TEXT, experimental_metric_json TEXT, evidence_strength TEXT NOT NULL,
  limitations_json TEXT NOT NULL, affected_opportunity_ids_json TEXT, recommended_experiment TEXT, experiment_id TEXT,
  experiment_status TEXT, must_not_be_summarized_as TEXT, deployment_sha TEXT, created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL);
CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, result_class TEXT NOT NULL,
  side TEXT, strike REAL, expiration TEXT, dte INTEGER, entry_fill REAL, exit_fill REAL, session TEXT,
  feature_snapshot_json TEXT,
  strategy TEXT, status TEXT NOT NULL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER,
  alert_id TEXT, paper_kind TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE opportunity_cases (opportunity_id TEXT PRIMARY KEY, underlying_symbol TEXT NOT NULL, direction TEXT,
  setup_family TEXT, detected_at_ms INTEGER NOT NULL, market_session TEXT, source_path TEXT NOT NULL,
  acceptance_decision TEXT NOT NULL, delivery_decision TEXT NOT NULL, rejection_reason_codes_json TEXT,
  alert_id TEXT, case_json TEXT NOT NULL, session_date TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE options_paper_marks (id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL, option_symbol TEXT NOT NULL,
  mark_at_ms INTEGER NOT NULL, return_pct REAL, created_at_ms INTEGER NOT NULL, UNIQUE(trade_id, mark_at_ms));
CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, paper_trade_id INTEGER);
`;

/**
 * One OWNER callout that won, with enough same-contract marks to support a path claim.
 *
 * The owner lane is `OWNER_VALIDATION_PAPER` and it carries NO alert id — an owner callout
 * never writes an `options_alerts` row. This fixture previously seeded a
 * DELIVERED_ALERT_PAPER row with `alert_id='oa_1'` and called it an owner alert, which is
 * the subscriber lane's shape; the whole after-close chain was therefore proven against a
 * population the owner never received. Identity is the opportunity case the mirror records
 * on its own feature snapshot, matched to the exact contract the case froze.
 */
function seedOwnerLane(db) {
  db.prepare(
    `INSERT INTO opportunity_cases (opportunity_id, underlying_symbol, direction, setup_family,
       detected_at_ms, market_session, source_path, acceptance_decision, delivery_decision,
       alert_id, case_json, session_date, created_at_ms, updated_at_ms)
     VALUES ('oc_owner_1','AAPL','bearish','lower_high_continuation',?,'regular','options_live',
             'accepted','delivered',NULL,?,'2026-08-07',?,?)`,
  ).run(
    ENTRY,
    JSON.stringify({
      underlyingSymbol: "AAPL",
      opportunityFingerprint: "of_afterclose_1",
      selectedContract: { optionSymbol: "O:AAPL260807P00230000", side: "put", strike: 230, expiration: "2026-08-07", dte: 0 },
      frozenTrade: { entryMid: 2, targetT1: 3, targetT2: 4, stop: 1.4 },
    }),
    ENTRY, ENTRY,
  );
  db.prepare(
    `INSERT INTO options_paper_trades (id, option_symbol, result_class, side, strike, expiration, dte,
       entry_fill, exit_fill, session, feature_snapshot_json, strategy, status, return_pct, exit_reason,
       entered_at_ms, exit_at_ms, alert_id, paper_kind, created_at_ms, updated_at_ms)
     VALUES (1,'O:AAPL260807P00230000','WIN','put',230,'2026-08-07',0,2,2.69,'regular',?,
             'lower_high_continuation','EXITED',34.5,'target',?,?,NULL,'OWNER_VALIDATION_PAPER',?,?)`,
  ).run(
    JSON.stringify({ lane: "OWNER_ONLY", opportunityCaseId: "oc_owner_1", quality: 1 }),
    ENTRY, ENTRY + 3_600_000, ENTRY, ENTRY,
  );
  const m = db.prepare("INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, created_at_ms) VALUES (1,'O:AAPL260807P00230000',?,?,?)");
  for (let i = 0; i < 25; i++) m.run(ENTRY + i * 60_000, i, ENTRY + i * 60_000);
}

function freshDb() {
  const db = new Database(":memory:");
  db.exec(DDL);
  const o = db.prepare(`INSERT INTO paper_trade_outcomes (strategy,direction,dte_at_entry,entry_session,entry_time_ms,terminal_kind,grade,grading_status,return_pct,opportunity_grade,peak_favorable_pct) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  o.run("swing", "CALL", 4, "regular", ENTRY, "STOP", "LOSS", "GRADED", -30, "HIT", 40);
  o.run("swing", "CALL", 4, "regular", ENTRY, "STOP", "LOSS", "GRADED", -25, "HIT", 35);
  o.run("swing", "PUT", 0, "regular", ENTRY, "TARGET", "BREAKEVEN", "GRADED", 0, "HIT", 28);
  db.prepare(`INSERT INTO paper_candidates (status,reject_reason,entry_state,confidence_tier,direction,created_at_ms) VALUES (?,?,?,?,?,?)`)
    .run("REJECTED", "spread too wide", "ACTIONABLE", "HIGH", "CALL", ENTRY);
  seedOwnerLane(db);
  return db;
}

const ENABLED = aiConfig({ AI_ENABLED: "1", ANTHROPIC_API_KEY: "k", AI_NIGHTLY_DIAGNOSIS_ENABLED: "1", AI_MONTHLY_HARD_LIMIT_USD: "20" });

const NARRATIVE = {
  headline: "Owner lane closed one winner",
  whatHappened: "The delivered lane closed a single opening; the prospective arm recorded nothing.",
  repeatedPatterns: [], successPatterns: [], bottlenecks: ["exit management"],
  supportedConclusions: [], needsMoreEvidence: ["more sessions"], prioritizedIssue: "exit_management",
};

const ANALYSIS = {
  findings: [{
    key: "OWNER_LANE_SINGLE_CLOSE",
    question: "Which owner alerts worked in this session?",
    title: "One owner opening closed positive",
    statement: "The delivered lane closed a single opening in this session, so no pattern can be separated yet.",
    evidenceStrength: "INSUFFICIENT",
    sampleSize: 1,
    limitations: ["One closed trade cannot distinguish a repeatable cause from noise."],
    mustNotBeSummarizedAs: "The lane is profitable. One session is not a trend.",
  }],
  openQuestions: ["Did LHC_SELECT_V1 reject any winners? No prospective decision exists yet."],
};

/** Routes the narration call and the analysis call to their own payloads. */
function provider(counter = { narration: 0, analysis: 0 }) {
  return {
    counter,
    deps: {
      env: { ANTHROPIC_API_KEY: "k" },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const toolName = body?.tools?.[0]?.name ?? "";
        const isAnalysis = toolName === "submit_research_analysis";
        if (isAnalysis) counter.analysis += 1; else counter.narration += 1;
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({
            content: [{ type: "tool_use", name: toolName || "nightly_narrative", input: isAnalysis ? ANALYSIS : NARRATIVE }],
            usage: { input_tokens: 900, output_tokens: 150 },
          }),
        };
      },
    },
  };
}

// ── the chain runs itself ───────────────────────────────────────────────────────────────────

test("the scheduler alone runs the whole after-close chain — no manual trigger anywhere", async () => {
  __resetAiHandledGuard();
  const db = freshDb();
  // AI fully OFF: no key, no flags, so no provider can be contacted from this test. The
  // deterministic half must still run — that is the product requirement, and gating the job on
  // AI_ENABLED used to make an unreachable model stop the evidence too.
  const res = await runAiScheduledJobs({ nowMs: NOW, db, env: {} });

  // The scheduler decided the nightly was due from the ET clock. No human argument anywhere.
  assert.equal(res.ranNightly, true);
  assert.equal(res.nightly?.tradingDay, DAY);
  assert.equal(res.nightly?.narrativeStatus, "SKIPPED");
  assert.equal(res.nightly?.costUsd, 0);

  // Owner aggregation, experiment scoreboard and Evidence Learning findings all landed.
  assert.equal(res.nightly?.research.owner.closed, 1);
  assert.equal(res.nightly?.research.owner.realizedWins, 1);
  assert.ok(res.nightly?.research.findingsWritten >= 6);
  assert.ok(listFindingsOnDb(db, { strategy: "lower_high_continuation" }).length >= 6);
  assert.ok(getReportOnDb(db, "nightly", DAY).summary);
  db.close();
});

test("a second scheduler beat for the same session is a no-op", async () => {
  __resetAiHandledGuard();
  const db = freshDb();
  await runAiScheduledJobs({ nowMs: NOW, db, env: {} });
  const second = await runAiScheduledJobs({ nowMs: NOW + 60_000, db, env: {} });
  assert.equal(second.ranNightly, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_reports WHERE report_type='nightly'").get().n, 1);
  db.close();
});

test("the nightly supplies the research context to the AI and persists what the AI concluded", async () => {
  const db = freshDb();
  const p = provider();
  const res = await runNightlyDiagnosis({ nowMs: NOW, day: DAY, db, config: ENABLED, provider: p.deps, env: {} });

  // 1. Deterministic aggregation ran and moved nothing it should not have.
  assert.equal(res.ran, true);
  assert.equal(res.research.productionBehaviorChanged, false);
  assert.equal(res.research.owner.closed, 1);
  assert.equal(res.research.owner.realizedWins, 1);
  assert.ok(res.research.findingsWritten >= 6, "deterministic findings seeded");

  // 2. The AI actually RECEIVED the evidence — the gap this packet closed.
  assert.equal(res.researchContextSupplied, true);
  assert.equal(res.narrativeStatus, "OK");
  assert.equal(p.counter.narration, 1);

  // 3. It reasoned, and the conclusion SURVIVED into the findings store.
  assert.equal(p.counter.analysis, 1);
  assert.equal(res.analysisStatus, "SUCCESS");
  assert.equal(res.analysisFindingsPersisted, 1);
  const ai = listFindingsOnDb(db, { strategy: "lower_high_continuation" })
    .filter((f) => f.findingId.startsWith("AI_NIGHTLY_"));
  assert.equal(ai.length, 1);
  assert.match(ai[0].statement, /single opening/);
  assert.ok(ai[0].limitations.length >= 2);

  // 4. The experiment lifecycle is where the deterministic rules put it — never further.
  const status = currentStatusOnDb(db, LHC_SELECT_V1.experimentId, LHC_SELECT_V1.experimentVersion);
  assert.ok(status === null || status === "PROPOSED", `unexpected status ${status}`);
  db.close();
});

test("the narrator's prompt carries the owner lane, the experiment and the reading rules", () => {
  const summary = { tradingDay: DAY, patterns: [], overall: { n: 1 } };
  const research = {
    contextVersion: "ai-research-context-v1",
    readingRules: ["null means NOT MEASURED. It never means zero."],
    ownerDiscord: { closed: 1, profitFactor: null, unavailableMetrics: ["profitFactor"] },
    experiment: { experimentId: "LHC_SELECT_V1", scoreboard: { closedOutcomes: 0 } },
    instructions: ["Report winners rejected before losses avoided."],
  };
  const { system, user } = nightlyNarrationPrompt(summary, research);
  assert.match(user, /LHC_SELECT_V1/);
  assert.match(user, /ownerDiscord/);
  assert.match(user, /readingRules/);
  assert.match(system, /null metric in the research context means UNAVAILABLE/);
  assert.match(system, /NOT zero/);

  // Without a context the prompt is exactly what it was before — additive, not a rewrite.
  const plain = nightlyNarrationPrompt(summary);
  assert.ok(!plain.user.includes("LHC_SELECT_V1"));
  assert.ok(!plain.system.includes("readingRules"));
});

test("the validator is shown what the model was shown, so a real research number is not called fabricated", () => {
  const summary = { tradingDay: DAY, patterns: [], overall: { n: 1 } };
  const research = { ownerDiscord: { closed: 1, bestWinnerPct: 34.5 } };
  const narrative = { ...NARRATIVE, whatHappened: "One owner opening closed at 34.5%." };

  // With the context, the claim is backed.
  assert.doesNotThrow(() => validateNightlyNarrative(narrative, summary, research));
  // Without it, the same sentence is correctly rejected as unsupported.
  assert.throws(() => validateNightlyNarrative(narrative, summary), /unsupported quantitative claim/);
});

// ── the budget contract ─────────────────────────────────────────────────────────────────────

test("a month with no budget left skips BOTH AI calls and nothing else", async () => {
  const db = freshDb();
  recordAiJobRunOnDb(db, { jobType: "weekly_proposals", model: "claude-sonnet-5", status: "SUCCESS", estimatedCostUsd: 25, nowMs: NOW });
  const p = provider();
  const res = await runNightlyDiagnosis({ nowMs: NOW, day: DAY, db, config: ENABLED, provider: p.deps, env: {} });

  assert.equal(p.counter.narration, 0);
  assert.equal(p.counter.analysis, 0);
  assert.equal(res.narrativeStatus, "SKIPPED");
  assert.equal(res.analysisFindingsPersisted, 0);

  // Everything deterministic still happened.
  assert.ok(getReportOnDb(db, "nightly", DAY).summary, "deterministic summary survived the budget");
  assert.equal(res.research.owner.closed, 1, "owner aggregation survived the budget");
  assert.ok(res.research.findingsWritten >= 6, "evidence capture survived the budget");
  assert.ok(listFindingsOnDb(db, { strategy: "lower_high_continuation" }).length >= 6);
  db.close();
});

test("a provider outage costs the session its narrative and nothing else", async () => {
  const db = freshDb();
  const res = await runNightlyDiagnosis({
    nowMs: NOW, day: DAY, db, config: ENABLED, env: {},
    provider: { env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async () => { throw new Error("network down"); } },
  });
  assert.equal(res.ran, true);
  assert.equal(res.narrativeStatus, "ERROR");
  assert.equal(res.analysisFindingsPersisted, 0);
  assert.equal(res.research.owner.closed, 1);
  assert.ok(listFindingsOnDb(db, { strategy: "lower_high_continuation" }).length >= 6);
  db.close();
});

test("the questions the operator would otherwise open Claude Code to ask are the ones the job asks", () => {
  const asked = NIGHTLY_ANALYSIS_QUESTIONS.join(" ").toLowerCase();
  assert.ok(asked.includes("which owner alerts worked"));
  assert.ok(asked.includes("never worked"));
  assert.ok(asked.includes("gave the profit back"));
  assert.ok(asked.includes("reject any baseline winners"));
  assert.ok(asked.includes("confirmation delays"));
  assert.ok(asked.includes("contract-quality"));
  assert.ok(asked.includes("degrading"));
  assert.ok(asked.includes("bounded shadow or paper experiment"));
});
