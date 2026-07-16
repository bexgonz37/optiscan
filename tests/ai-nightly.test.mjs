import test from "node:test";
import assert from "node:assert/strict";
import { retryNightlyNarrative, runNightlyDiagnosis } from "../lib/ai/nightly.ts";
import { aiConfig } from "../lib/ai/config.ts";
import { getReportOnDb, listLessonsOnDb, recordAiJobRunOnDb, monthKey } from "../lib/ai/store.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }
const skip = Database ? false : "better-sqlite3 unavailable";

const DAY = "2026-07-13";
const NOW = Date.parse("2026-07-14T00:30:00Z");           // 20:30 ET (after cutoff)
const ENTRY = Date.parse("2026-07-13T14:00:00Z");         // 10:00 ET on DAY

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
  diagnostic_json TEXT,
  month_key TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE paper_trade_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy TEXT, direction TEXT, dte_at_entry INTEGER,
  entry_session TEXT, entry_time_ms INTEGER, terminal_kind TEXT, grade TEXT NOT NULL, grading_status TEXT NOT NULL,
  return_pct REAL, opportunity_grade TEXT, peak_favorable_pct REAL);
CREATE TABLE paper_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, reject_reason TEXT, entry_state TEXT,
  confidence_tier TEXT, direction TEXT, created_at_ms INTEGER);
`;

function seed(db) {
  const o = db.prepare(`INSERT INTO paper_trade_outcomes (strategy,direction,dte_at_entry,entry_session,entry_time_ms,terminal_kind,grade,grading_status,return_pct,opportunity_grade,peak_favorable_pct) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  // Three trades where the signal was right (opportunity HIT) but exit management lost it.
  o.run("swing", "CALL", 4, "regular", ENTRY, "STOP", "LOSS", "GRADED", -30, "HIT", 40);
  o.run("swing", "CALL", 4, "regular", ENTRY, "STOP", "LOSS", "GRADED", -25, "HIT", 35);
  o.run("swing", "PUT", 0, "regular", ENTRY, "TARGET", "BREAKEVEN", "GRADED", 0, "HIT", 28);
  const c = db.prepare(`INSERT INTO paper_candidates (status,reject_reason,entry_state,confidence_tier,direction,created_at_ms) VALUES (?,?,?,?,?,?)`);
  c.run("REJECTED", "spread too wide", "ACTIONABLE", "HIGH", "CALL", ENTRY);
  c.run("CREATED", null, "ACTIONABLE", "HIGH", "CALL", ENTRY);
}

function freshDb() { const db = new Database(":memory:"); db.exec(DDL); seed(db); return db; }

const ENABLED = aiConfig({ AI_ENABLED: "1", ANTHROPIC_API_KEY: "k", AI_NIGHTLY_DIAGNOSIS_ENABLED: "1", AI_MONTHLY_HARD_LIMIT_USD: "20", AI_LESSON_MIN_SAMPLE: "2" });
const DISABLED = aiConfig({ AI_ENABLED: "1", ANTHROPIC_API_KEY: "k", AI_MONTHLY_HARD_LIMIT_USD: "20" });

/** Fake provider returning a valid, number-free narrative (never fabricates). */
function okProvider() {
  const narrative = {
    headline: "Exit management was the leak today",
    whatHappened: "Several setups reached a profit opportunity but were managed to a non-win.",
    repeatedPatterns: ["winning setups given back by exits"],
    successPatterns: [],
    bottlenecks: ["exit management"],
    supportedConclusions: ["exit management, not signal quality, is the leak"],
    needsMoreEvidence: ["more trading days"],
    prioritizedIssue: "exit_management",
  };
  return { env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: "text", text: JSON.stringify(narrative) }], usage: { input_tokens: 200, output_tokens: 80 } }) }) };
}

test("full nightly: deterministic summary stored, lessons created, narrative attached", { skip }, async () => {
  const db = freshDb();
  const res = await runNightlyDiagnosis({ nowMs: NOW, day: DAY, db, config: ENABLED, provider: okProvider(), env: { AI_LESSON_MIN_SAMPLE: "2" } });
  assert.equal(res.ran, true);
  assert.equal(res.narrativeStatus, "OK");
  const rep = getReportOnDb(db, "nightly", DAY);
  assert.ok(rep.summary, "deterministic summary stored");
  assert.equal(rep.summary.signalCorrectExitFailed, 3);
  assert.equal(rep.narrative.prioritizedIssue, "exit_management");
  assert.ok(res.lessonsCreated >= 1, "candidate lesson created from evidence");
  assert.ok(listLessonsOnDb(db).some((l) => l.findingType === "exit_management"));
  assert.ok(res.costUsd > 0);
  db.close();
});

test("AI failure isolation: a provider outage still stores the summary + lessons", { skip }, async () => {
  const db = freshDb();
  const boom = { env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async () => { throw new Error("network down"); } };
  const res = await runNightlyDiagnosis({ nowMs: NOW, day: DAY, db, config: ENABLED, provider: boom, env: { AI_LESSON_MIN_SAMPLE: "2" } });
  assert.equal(res.ran, true, "job did not throw");
  assert.equal(res.narrativeStatus, "ERROR");
  assert.ok(getReportOnDb(db, "nightly", DAY).summary, "summary preserved despite AI failure");
  assert.ok(listLessonsOnDb(db).length >= 1, "lessons preserved despite AI failure");
  db.close();
});

test("disabled AI: summary is stored, narrative SKIPPED, no provider call", { skip }, async () => {
  const db = freshDb();
  let called = 0;
  const res = await runNightlyDiagnosis({ nowMs: NOW, day: DAY, db, config: DISABLED, provider: { env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async () => { called++; return {}; } }, env: { AI_LESSON_MIN_SAMPLE: "2" } });
  assert.equal(res.narrativeStatus, "SKIPPED");
  assert.equal(called, 0);
  assert.ok(getReportOnDb(db, "nightly", DAY).summary);
  db.close();
});

test("hard cost limit: narration skipped, summary still stored", { skip }, async () => {
  const db = freshDb();
  recordAiJobRunOnDb(db, { jobType: "weekly_proposals", model: "claude-sonnet-5", status: "SUCCESS", estimatedCostUsd: 25, nowMs: NOW });
  let called = 0;
  const res = await runNightlyDiagnosis({ nowMs: NOW, day: DAY, db, config: ENABLED, provider: { env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async () => { called++; return {}; } }, env: { AI_LESSON_MIN_SAMPLE: "2" } });
  assert.equal(res.narrativeStatus, "SKIPPED");
  assert.equal(called, 0, "no provider call once over the hard limit");
  assert.ok(getReportOnDb(db, "nightly", DAY).summary, "deterministic summary preserved at the hard limit");
  db.close();
});

test("idempotent: a second run for the same day is a no-op", { skip }, async () => {
  const db = freshDb();
  await runNightlyDiagnosis({ nowMs: NOW, day: DAY, db, config: ENABLED, provider: okProvider(), env: { AI_LESSON_MIN_SAMPLE: "2" } });
  const second = await runNightlyDiagnosis({ nowMs: NOW + 60000, day: DAY, db, config: ENABLED, provider: okProvider(), env: { AI_LESSON_MIN_SAMPLE: "2" } });
  assert.match(second.skippedReason ?? "", /already reported/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_reports").get().n, 1);
  db.close();
});

test("manual retry uses the stored deterministic summary and records diagnostics", { skip }, async () => {
  const db = freshDb();
  const badProvider = { env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ headline: "missing fields" }) }], usage: { input_tokens: 100, output_tokens: 20 } }) }) };
  const first = await runNightlyDiagnosis({ nowMs: NOW, day: DAY, db, config: ENABLED, provider: badProvider, env: { AI_LESSON_MIN_SAMPLE: "2" } });
  assert.equal(first.narrativeStatus, "VALIDATION_FAILED");
  const rep = getReportOnDb(db, "nightly", DAY);
  assert.ok(rep.diagnostic.validationErrors.length >= 1);
  assert.equal(rep.diagnostic.validatorName, "validateNightlyNarrative");
  assert.equal(rep.diagnostic.promptVersion, "nightly-narration-v1");
  assert.equal(rep.diagnostic.validationStage, "schema");
  assert.ok(rep.diagnostic.failingField, "failed field is persisted");
  assert.equal(typeof rep.diagnostic.aiResponseLength, "number");
  assert.ok(rep.diagnostic.parserOutput, "parser output is persisted");
  assert.ok(Array.isArray(rep.diagnostic.schemaViolations));

  const retry = await retryNightlyNarrative({ nowMs: NOW + 1000, periodKey: DAY, db, config: ENABLED, provider: okProvider() });
  assert.equal(retry.narrativeStatus, "OK");
  const after = getReportOnDb(db, "nightly", DAY);
  assert.equal(after.summary.signalCorrectExitFailed, 3, "stored summary preserved");
  assert.equal(after.narrative.prioritizedIssue, "exit_management");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_job_runs WHERE job_type='nightly_diagnosis_retry'").get().n, 1);
  db.close();
});
