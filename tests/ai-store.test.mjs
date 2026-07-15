import test from "node:test";
import assert from "node:assert/strict";
import {
  recordAiJobRunOnDb, monthlySpendUsdOnDb, costGateOnDb, monthKey,
  insertReportOnDb, setReportNarrativeOnDb, getReportOnDb,
  upsertLessonOnDb, decideLessonOnDb, listLessonsOnDb,
  insertProposalOnDb, decideProposalOnDb, listProposalsOnDb, aiUsageOnDb,
} from "../lib/ai/store.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }

const AI_DDL = `
CREATE TABLE ai_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, report_type TEXT NOT NULL, period_key TEXT NOT NULL,
  period_start_ms INTEGER, period_end_ms INTEGER, summary_json TEXT NOT NULL, narrative_json TEXT,
  narrative_status TEXT NOT NULL DEFAULT 'PENDING', model TEXT, ai_job_run_id INTEGER, diagnostic_json TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, UNIQUE(report_type, period_key));
CREATE TABLE ai_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dedup_key TEXT NOT NULL UNIQUE, finding_type TEXT NOT NULL,
  title TEXT NOT NULL, summary TEXT NOT NULL, evidence_json TEXT NOT NULL, sample_size INTEGER NOT NULL DEFAULT 0,
  affected_ticker TEXT, affected_strategy TEXT, affected_session TEXT, affected_duration TEXT,
  date_range_start TEXT, date_range_end TEXT, source_report_id INTEGER, status TEXT NOT NULL DEFAULT 'OPEN',
  confidence TEXT NOT NULL DEFAULT 'LOW', decision_state TEXT NOT NULL DEFAULT 'NEEDS_MORE_DATA',
  decision_notes TEXT, linked_proposal_id INTEGER, strategy_version TEXT, result_after_implementation TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE ai_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dedup_key TEXT NOT NULL UNIQUE, period_key TEXT NOT NULL,
  title TEXT NOT NULL, problem TEXT NOT NULL, evidence_json TEXT NOT NULL, sample_size INTEGER NOT NULL DEFAULT 0,
  affected_strategy TEXT, affected_session TEXT, affected_config TEXT, proposed_change TEXT NOT NULL,
  relevant_files_json TEXT, change_level TEXT, expected_benefit TEXT, downside_risk TEXT, overfitting_risk TEXT,
  required_tests TEXT, backtest_plan TEXT, shadow_test_plan TEXT, paper_test_plan TEXT, rollback_plan TEXT,
  suggested_patch TEXT, confidence TEXT NOT NULL DEFAULT 'LOW', status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  decision_notes TEXT, source_report_id INTEGER, model TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE ai_job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL, model TEXT, status TEXT NOT NULL,
  error_category TEXT, error TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
  diagnostic_json TEXT,
  month_key TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
`;

const NOW = Date.parse("2026-07-13T18:00:00Z");
const CFG = { monthlySoftLimitUsd: 5, monthlyHardLimitUsd: 20 };
const skip = Database ? false : "better-sqlite3 unavailable";

function freshDb() { const db = new Database(":memory:"); db.exec(AI_DDL); return db; }

test("report insert is idempotent per (type, period) — deterministic summary never overwritten", { skip }, () => {
  const db = freshDb();
  const first = insertReportOnDb(db, { reportType: "nightly", periodKey: "2026-07-13", periodStartMs: null, periodEndMs: NOW, summary: { a: 1 }, nowMs: NOW });
  assert.equal(first.created, true);
  const again = insertReportOnDb(db, { reportType: "nightly", periodKey: "2026-07-13", periodStartMs: null, periodEndMs: NOW, summary: { a: 999 }, nowMs: NOW + 1000 });
  assert.equal(again.created, false, "second run for the same day is a no-op");
  assert.equal(getReportOnDb(db, "nightly", "2026-07-13").summary.a, 1, "original summary preserved");
  db.close();
});

test("narrative can be attached after the summary is stored", { skip }, () => {
  const db = freshDb();
  const { row } = insertReportOnDb(db, { reportType: "nightly", periodKey: "d", periodStartMs: null, periodEndMs: NOW, summary: {}, nowMs: NOW });
  setReportNarrativeOnDb(db, row.id, { narrative: { headline: "ok" }, status: "OK", model: "claude-haiku-4-5", nowMs: NOW });
  const r = getReportOnDb(db, "nightly", "d");
  assert.equal(r.narrativeStatus, "OK");
  assert.equal(r.narrative.headline, "ok");
  db.close();
});

test("lesson upsert suppresses duplicates and never clobbers a human decision", { skip }, () => {
  const db = freshDb();
  const base = { dedupKey: "exit_management|all|all|all", findingType: "exit_management", title: "t", summary: "s", evidence: { n: 3 }, sampleSize: 3, nowMs: NOW };
  assert.equal(upsertLessonOnDb(db, base).created, true);
  const second = upsertLessonOnDb(db, { ...base, sampleSize: 5, nowMs: NOW + 1000 });
  assert.equal(second.created, false, "same dedup key ⇒ update, not a new row");
  assert.equal(listLessonsOnDb(db).length, 1);
  assert.equal(second.row.occurrences, 2);
  assert.equal(second.row.sampleSize, 5);
  // Human rejects it; a later nightly recurrence must not silently reopen it.
  decideLessonOnDb(db, second.row.id, { status: "REJECTED", decisionState: "rejected", nowMs: NOW + 2000 });
  upsertLessonOnDb(db, { ...base, nowMs: NOW + 3000 });
  assert.equal(listLessonsOnDb(db)[0].status, "REJECTED", "decision preserved across recurrence");
  db.close();
});

test("proposal insert is write-once per dedup key; humans accept/reject", { skip }, () => {
  const db = freshDb();
  const p = { dedupKey: "2026-W29|swing|tighten-spread", periodKey: "2026-W29", title: "Tighten", problem: "wide", evidence: {}, sampleSize: 9, proposedChange: "lower cap", nowMs: NOW };
  assert.equal(insertProposalOnDb(db, p).created, true);
  assert.equal(insertProposalOnDb(db, { ...p, title: "changed" }).created, false);
  const row = listProposalsOnDb(db)[0];
  assert.equal(row.status, "PENDING_APPROVAL");
  decideProposalOnDb(db, row.id, { status: "ACCEPTED", notes: "trying it", nowMs: NOW + 1 });
  assert.equal(listProposalsOnDb(db)[0].status, "ACCEPTED");
  db.close();
});

test("cost gate: hard limit blocks optional jobs; audit rows drive monthly spend", { skip }, () => {
  const db = freshDb();
  assert.equal(costGateOnDb(db, CFG, NOW).allowed, true);
  recordAiJobRunOnDb(db, { jobType: "nightly_diagnosis", model: "claude-haiku-4-5", status: "SUCCESS", estimatedCostUsd: 4, inputTokens: 100, outputTokens: 40, nowMs: NOW });
  let gate = costGateOnDb(db, CFG, NOW);
  assert.equal(gate.atSoftLimit, false);
  assert.equal(gate.allowed, true);
  recordAiJobRunOnDb(db, { jobType: "weekly_proposals", model: "claude-sonnet-5", status: "SUCCESS", estimatedCostUsd: 18, nowMs: NOW });
  gate = costGateOnDb(db, CFG, NOW);
  assert.ok(gate.spendUsd >= 20);
  assert.equal(gate.atHardLimit, true);
  assert.equal(gate.allowed, false, "optional AI jobs must stop at the hard limit");
  assert.equal(monthlySpendUsdOnDb(db, monthKey(NOW)), 22);
  const usage = aiUsageOnDb(db, monthKey(NOW));
  assert.equal(usage.totalRuns, 2);
  assert.equal(usage.byJobType.nightly_diagnosis.runs, 1);
  db.close();
});
