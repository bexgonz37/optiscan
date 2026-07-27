/**
 * Weekly AI structured-output + evidence-packet isolation tests.
 * Covers thinking-only / empty / malformed / retry / advisory-only guarantees.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runStructuredAiJob } from "../lib/ai/provider.ts";
import { validateWeeklyProposals, WEEKLY_PROPOSALS_TOOL_SCHEMA } from "../lib/ai/schemas.ts";
import { screenProposalSafety } from "../lib/ai/safety.ts";
import { runWeeklyProposals, retryWeeklyProposals } from "../lib/ai/weekly.ts";
import { aiConfig } from "../lib/ai/config.ts";
import { getReportOnDb, listProposalsOnDb } from "../lib/ai/store.ts";
import { loadEvidencePacketOnDb } from "../lib/ai/evidence-packet.ts";
import { buildCursorExportPrompt, enrichProposalRow } from "../lib/ai/recommendations.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }
const skip = Database ? false : "better-sqlite3 unavailable";

const KEY_ENV = { ANTHROPIC_API_KEY: "test-key" };
const TOOL = {
  model: "claude-sonnet-5",
  system: "s",
  user: "u",
  maxOutputTokens: 800,
  timeoutMs: 5000,
  maxRetries: 2,
  toolName: "submit_weekly_proposals",
  toolInputSchema: WEEKLY_PROPOSALS_TOOL_SCHEMA,
  validatorName: "validateWeeklyProposals",
  promptVersion: "weekly-proposals-v1",
};

const VALID_PROPOSAL = {
  title: "Tighten late-session VWAP distance",
  problem: "Late-session winners show wider VWAP drift in the evidence packet.",
  evidence: "Lane sample shows elevated late-session MAE in the packet.",
  sampleSize: 12,
  affectedStrategy: "swing",
  affectedSession: "regular",
  affectedConfig: "ENTRY_MAX_VWAP_DIST_PCT",
  proposedChange: "Lower ENTRY_MAX_VWAP_DIST_PCT from 1.5 to 1.2 after shadow soak.",
  relevantFiles: ["lib/entry-window.ts"],
  changeLevel: "config-only",
  expectedBenefit: "Fewer extended late entries",
  downsideRisk: "Miss some valid late setups",
  overfittingRisk: "LOW — config-only with rollback",
  requiredTests: "Shadow soak + paper chain",
  backtestPlan: "Replay last 20 trading days",
  shadowTestPlan: "Run SUBSCRIBER_SHADOW_MODE=1 for one week",
  paperTestPlan: "Grade DELIVERED_ALERT_PAPER only",
  rollbackPlan: "Restore ENTRY_MAX_VWAP_DIST_PCT=1.5",
  suggestedPatch: "",
  confidence: "MEDIUM",
};

function anthropicBody(content, usage = { input_tokens: 100, output_tokens: 40 }) {
  return JSON.stringify({ content, usage });
}

function toolFetch(input, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => anthropicBody([{ type: "tool_use", name: "submit_weekly_proposals", input }]),
  });
}

function sequenceFetch(bodies) {
  let i = 0;
  return async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    if (typeof body === "function") return body();
    return { ok: true, status: 200, text: async () => anthropicBody(body) };
  };
}

const DDL = `
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
  decision_notes TEXT, source_report_id INTEGER, model TEXT, workflow_json TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE ai_job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL, model TEXT, status TEXT NOT NULL,
  error_category TEXT, error TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
  diagnostic_json TEXT, month_key TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE ai_evidence_packets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, packet_id TEXT NOT NULL UNIQUE,
  period_start_ms INTEGER, period_end_ms INTEGER, packet_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE paper_trade_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy TEXT, direction TEXT, dte_at_entry INTEGER,
  entry_session TEXT, entry_time_ms INTEGER, terminal_kind TEXT, grade TEXT NOT NULL, grading_status TEXT NOT NULL,
  return_pct REAL, opportunity_grade TEXT, peak_favorable_pct REAL, portfolio TEXT);
CREATE TABLE paper_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, reject_reason TEXT, entry_state TEXT,
  confidence_tier TEXT, direction TEXT, created_at_ms INTEGER);
CREATE TABLE strategy_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, version TEXT);
`;

function freshDb() {
  const db = new Database(":memory:");
  db.exec(DDL);
  return db;
}

const ENABLED = aiConfig({
  AI_ENABLED: "1",
  ANTHROPIC_API_KEY: "k",
  AI_WEEKLY_PROPOSALS_ENABLED: "1",
  AI_MONTHLY_HARD_LIMIT_USD: "20",
  AI_MAX_RETRIES: "2",
});

const NOW = Date.parse("2026-07-26T20:00:00Z");

// --- Provider-level structured output ---

test("valid tool-use response with proposals succeeds", async () => {
  const res = await runStructuredAiJob(
    TOOL,
    (json) => validateWeeklyProposals(json),
    { fetchImpl: toolFetch({ proposals: [VALID_PROPOSAL] }), env: KEY_ENV },
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].title, VALID_PROPOSAL.title);
  assert.equal(res.diagnostics.responseType, "tool_use");
});

test("valid empty proposal response { proposals: [] } is success", async () => {
  const res = await runStructuredAiJob(
    TOOL,
    (json) => validateWeeklyProposals(json),
    { fetchImpl: toolFetch({ proposals: [] }), env: KEY_ENV },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, []);
});

test("thinking-only response is rejected with precise reason and retried once", async () => {
  let calls = 0;
  const res = await runStructuredAiJob(TOOL, (json) => validateWeeklyProposals(json), {
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => anthropicBody([{ type: "thinking", thinking: "hidden reasoning" }]),
      };
    },
    env: KEY_ENV,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "validation");
  assert.match(res.error, /thinking-only/i);
  assert.equal(res.diagnostics.responseType, "thinking_only");
  assert.equal(calls, 2, "one paid validation retry");
  assert.ok(res.diagnostics.contentTypes.includes("thinking"));
});

test("empty response is rejected", async () => {
  const res = await runStructuredAiJob(TOOL, (json) => validateWeeklyProposals(json), {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => anthropicBody([]),
    }),
    env: KEY_ENV,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "validation");
  assert.match(res.error, /empty response/i);
  assert.equal(res.diagnostics.responseType, "empty");
});

test("malformed tool payload is rejected", async () => {
  const res = await runStructuredAiJob(TOOL, (json) => validateWeeklyProposals(json), {
    fetchImpl: toolFetch({ notProposals: true }),
    env: KEY_ENV,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "validation");
  assert.match(res.error, /proposals/i);
});

test("stringified proposals field inside tool_use is coerced and accepted", async () => {
  const nested = JSON.stringify({ proposals: [VALID_PROPOSAL] });
  const res = await runStructuredAiJob(TOOL, (json) => validateWeeklyProposals(json), {
    fetchImpl: toolFetch({ proposals: nested }),
    env: KEY_ENV,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].title, VALID_PROPOSAL.title);
});

test("stringified bare proposals array inside tool_use is coerced and accepted", async () => {
  const res = await runStructuredAiJob(TOOL, (json) => validateWeeklyProposals(json), {
    fetchImpl: toolFetch({ proposals: JSON.stringify([VALID_PROPOSAL]) }),
    env: KEY_ENV,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.length, 1);
});

test("schema-invalid proposal is rejected", async () => {
  const res = await runStructuredAiJob(TOOL, (json) => validateWeeklyProposals(json), {
    fetchImpl: toolFetch({
      proposals: [{ title: "x", problem: "y" /* missing required fields */ }],
    }),
    env: KEY_ENV,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "validation");
  assert.match(res.error, /must be a non-empty string|proposedChange|evidence/i);
});

test("provider timeout is categorized and fails closed", async () => {
  const res = await runStructuredAiJob({ ...TOOL, maxRetries: 0 }, (json) => validateWeeklyProposals(json), {
    fetchImpl: async () => {
      const e = new Error("aborted");
      e.name = "TimeoutError";
      throw e;
    },
    env: KEY_ENV,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "timeout");
  assert.equal(res.data, null);
});

test("retry success: thinking-only then valid tool-use", async () => {
  const fetchImpl = sequenceFetch([
    [{ type: "thinking", thinking: "..." }],
    [{ type: "tool_use", name: "submit_weekly_proposals", input: { proposals: [] } }],
  ]);
  const res = await runStructuredAiJob(TOOL, (json) => validateWeeklyProposals(json), {
    fetchImpl,
    env: KEY_ENV,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, []);
  assert.equal(res.retries, 1);
  assert.ok(res.diagnostics.validationErrors.some((e) => /thinking-only/i.test(e)));
});

test("retry failure: two thinking-only responses fail closed with diagnostics", async () => {
  const res = await runStructuredAiJob(TOOL, (json) => validateWeeklyProposals(json), {
    fetchImpl: sequenceFetch([
      [{ type: "thinking", thinking: "a" }],
      [{ type: "thinking", thinking: "b" }],
    ]),
    env: KEY_ENV,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "validation");
  assert.equal(res.diagnostics.retryCount, 1);
  assert.equal(res.diagnostics.responseType, "thinking_only");
  assert.ok(res.diagnostics.validationErrors.length >= 1);
  // Never convert thinking into a recommendation
  assert.equal(res.data, null);
  assert.equal(res.text, "");
});

test("empty tool input {} is rejected before schema validation", async () => {
  const res = await runStructuredAiJob(TOOL, (json) => validateWeeklyProposals(json), {
    fetchImpl: toolFetch({}),
    env: KEY_ENV,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /empty tool\/input object/i);
});

test("forced tool request never enables thinking:disabled field (avoids HTTP 400)", async () => {
  let captured = null;
  await runStructuredAiJob(TOOL, (json) => validateWeeklyProposals(json), {
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => anthropicBody([{ type: "tool_use", name: "submit_weekly_proposals", input: { proposals: [] } }]),
      };
    },
    env: KEY_ENV,
  });
  assert.equal(captured.tool_choice.type, "tool");
  assert.equal(captured.tool_choice.name, "submit_weekly_proposals");
  assert.equal(captured.thinking, undefined, "must not send thinking.disabled");
});

test("retry attempt appends structured-output instruction and bumps max_tokens", async () => {
  const bodies = [];
  await runStructuredAiJob(TOOL, (json) => validateWeeklyProposals(json), {
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        text: async () => anthropicBody([{ type: "thinking", thinking: "x" }]),
      };
    },
    env: KEY_ENV,
  });
  assert.equal(bodies.length, 2);
  assert.doesNotMatch(bodies[0].system, /CRITICAL RETRY/);
  assert.match(bodies[1].system, /CRITICAL RETRY/);
  assert.ok(bodies[1].max_tokens > bodies[0].max_tokens);
});

// --- Weekly job + evidence packet ---

test("evidence packet persists even when the model fails", { skip }, async () => {
  const db = freshDb();
  const boom = {
    env: KEY_ENV,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => anthropicBody([{ type: "thinking", thinking: "only" }]),
    }),
  };
  const res = await runWeeklyProposals({
    nowMs: NOW,
    weekKey: "2026-W30",
    db,
    config: ENABLED,
    provider: boom,
    env: {},
  });
  assert.equal(res.ran, true);
  assert.equal(res.narrativeStatus, "VALIDATION_FAILED");
  const packets = db.prepare("SELECT packet_id, packet_json FROM ai_evidence_packets").all();
  assert.equal(packets.length, 1, "evidence packet stored before provider failure");
  const packet = JSON.parse(packets[0].packet_json);
  assert.ok(packet.id);
  assert.ok(Array.isArray(packet.lanes));
  assert.ok(packet.config);
  assert.equal(listProposalsOnDb(db).length, 0, "no proposals stored on failure");
  db.close();
});

test("weekly success with empty proposals records intentional { proposals: [] }", { skip }, async () => {
  const db = freshDb();
  const res = await runWeeklyProposals({
    nowMs: NOW,
    weekKey: "2026-W30",
    db,
    config: ENABLED,
    provider: { env: KEY_ENV, fetchImpl: toolFetch({ proposals: [] }) },
    env: {},
  });
  assert.equal(res.narrativeStatus, "OK");
  assert.equal(res.proposalsCreated, 0);
  const report = getReportOnDb(db, "weekly", "2026-W30");
  assert.equal(report.narrativeStatus, "OK");
  assert.equal(report.narrative.proposals, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_evidence_packets").get().n, 1);
  db.close();
});

test("weekly success stores proposals as PENDING_APPROVAL only", { skip }, async () => {
  const db = freshDb();
  const res = await runWeeklyProposals({
    nowMs: NOW,
    weekKey: "2026-W30",
    db,
    config: ENABLED,
    provider: { env: KEY_ENV, fetchImpl: toolFetch({ proposals: [VALID_PROPOSAL] }) },
    env: {},
  });
  assert.equal(res.narrativeStatus, "OK");
  assert.equal(res.proposalsCreated, 1);
  const props = listProposalsOnDb(db);
  assert.equal(props.length, 1);
  assert.equal(props[0].status, "PENDING_APPROVAL");
  assert.match(JSON.stringify(props[0].evidence), /pkt_/);
  db.close();
});

test("retryWeeklyProposals re-runs AI on stored report after prior failure", { skip }, async () => {
  const db = freshDb();
  await runWeeklyProposals({
    nowMs: NOW,
    weekKey: "2026-W30",
    db,
    config: ENABLED,
    provider: {
      env: KEY_ENV,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => anthropicBody([{ type: "thinking", thinking: "fail" }]),
      }),
    },
    env: {},
  });
  assert.equal(getReportOnDb(db, "weekly", "2026-W30").narrativeStatus, "VALIDATION_FAILED");

  const retry = await retryWeeklyProposals({
    nowMs: NOW + 1000,
    periodKey: "2026-W30",
    db,
    config: ENABLED,
    provider: { env: KEY_ENV, fetchImpl: toolFetch({ proposals: [VALID_PROPOSAL] }) },
    env: {},
  });
  assert.equal(retry.ran, true);
  assert.equal(retry.narrativeStatus, "OK");
  assert.equal(retry.proposalsCreated, 1);
  assert.equal(getReportOnDb(db, "weekly", "2026-W30").narrativeStatus, "OK");
  db.close();
});

test("no proposal can auto-modify code, env, delivery rules, or deploy", () => {
  const forbidden = [
    { ...VALID_PROPOSAL, proposedChange: "Set IMPROVEMENT_AUTO_MERGE=1 and auto-deploy tonight" },
    { ...VALID_PROPOSAL, proposedChange: "Enable real-money live broker execution" },
    { ...VALID_PROPOSAL, proposedChange: "Bypass entry quality gate and freshness checks" },
    { ...VALID_PROPOSAL, proposedChange: "Change Discord actionable criteria automatically" },
    { ...VALID_PROPOSAL, proposedChange: "Enable bearish actionable alerts with BEARISH_ACTIONABLE=1" },
  ];
  for (const p of forbidden) {
    const screen = screenProposalSafety(p);
    assert.equal(screen.ok, false, `should block: ${p.proposedChange}`);
    assert.ok(screen.violations.length >= 1);
  }
  // Safe config-only proposal still passes
  assert.equal(screenProposalSafety(VALID_PROPOSAL).ok, true);
});

test("Export Cursor Prompt is advisory text only — no apply/deploy hooks", { skip }, async () => {
  const db = freshDb();
  await runWeeklyProposals({
    nowMs: NOW,
    weekKey: "2026-W30",
    db,
    config: ENABLED,
    provider: { env: KEY_ENV, fetchImpl: toolFetch({ proposals: [VALID_PROPOSAL] }) },
    env: {},
  });
  const row = listProposalsOnDb(db)[0];
  const rec = enrichProposalRow(db, row);
  const packet = loadEvidencePacketOnDb(db, `pkt_${NOW}`);
  const prompt = buildCursorExportPrompt(rec, packet);
  assert.match(prompt, /Advisory only/i);
  assert.match(prompt, /human approval/i);
  assert.doesNotMatch(prompt, /auto-deploy|AUTO_MERGE|apply now/i);
  assert.equal(row.status, "PENDING_APPROVAL");
  db.close();
});
