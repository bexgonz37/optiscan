/**
 * The combined $20/month runtime AI budget.
 *
 * What these tests pin is not "a limit exists" — one did, and spend still escaped it three
 * different ways: an env var that could raise the cap to $100,000, a second ledger the
 * dollar figure never read, and two call sites that reached the provider with no ledger row
 * and no gate. Each test below names the escape it closes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { aiConfig, AI_MONTHLY_HARD_CAP_USD } from "../lib/ai/config.ts";
import {
  combinedMonthlySpendUsdOnDb,
  combinedCostGateOnDb,
  aiBudgetReportOnDb,
  BUDGET_EXHAUSTED,
} from "../lib/ai/monthly-budget.ts";
import { runStructuredAiJob } from "../lib/ai/provider.ts";
import { monthKey } from "../lib/ai/store.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }

const AI_JOB_RUNS_DDL = `
CREATE TABLE ai_job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL, model TEXT, status TEXT NOT NULL,
  error_category TEXT, error TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
  diagnostic_json TEXT, month_key TEXT NOT NULL, created_at_ms INTEGER NOT NULL);`;

const ASYM_DDL = `
CREATE TABLE asymmetry_ai_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_date TEXT NOT NULL, month_key TEXT NOT NULL,
  review_version TEXT NOT NULL, called_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
  est_input_tokens INTEGER NOT NULL DEFAULT 0, est_output_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0);`;

const NOW = Date.UTC(2026, 7, 18, 18, 0, 0);
const MK = monthKey(NOW);

function db({ jobRuns = true, asym = true } = {}) {
  const d = new Database(":memory:");
  if (jobRuns) d.exec(AI_JOB_RUNS_DDL);
  if (asym) d.exec(ASYM_DDL);
  return d;
}

function spendJobRuns(d, usd, jobType = "nightly_diagnosis") {
  d.prepare(
    "INSERT INTO ai_job_runs (job_type, model, status, estimated_cost_usd, month_key, created_at_ms) VALUES (?,?,?,?,?,?)",
  ).run(jobType, "claude-haiku-4-5", "SUCCESS", usd, MK, NOW);
}

function spendAsym(d, usd, status = "CALLED") {
  d.prepare(
    "INSERT INTO asymmetry_ai_ledger (session_date, month_key, review_version, called_at_ms, status, est_cost_usd) VALUES (?,?,?,?,?,?)",
  ).run("2026-08-18", MK, "v1", NOW, status, usd);
}

// ── The cap itself ───────────────────────────────────────────────────────────

test("the absolute cap is $20 and env cannot raise it", () => {
  assert.equal(AI_MONTHLY_HARD_CAP_USD, 20);
  // The escape this closes: AI_MONTHLY_HARD_LIMIT_USD used to clamp at 100_000, so one
  // mistyped Railway variable raised the ceiling by four orders of magnitude silently.
  const cfg = aiConfig({ AI_MONTHLY_HARD_LIMIT_USD: "5000" });
  assert.equal(cfg.monthlyHardLimitUsd, 20);
  assert.equal(cfg.monthlyHardCapUsd, 20);
});

test("env may LOWER the cap — an existing stricter limit is preserved", () => {
  const cfg = aiConfig({ AI_MONTHLY_HARD_LIMIT_USD: "3" });
  assert.equal(cfg.monthlyHardLimitUsd, 3);
});

test("a soft limit above the hard limit is clamped, never left to warn after the block", () => {
  const cfg = aiConfig({ AI_MONTHLY_HARD_LIMIT_USD: "4", AI_MONTHLY_SOFT_LIMIT_USD: "50" });
  assert.equal(cfg.monthlyHardLimitUsd, 4);
  assert.equal(cfg.monthlySoftLimitUsd, 4);
});

test("an absent hard-limit variable defaults to the cap, not to unlimited", () => {
  assert.equal(aiConfig({}).monthlyHardLimitUsd, 20);
});

// ── Combined spend across ledgers ────────────────────────────────────────────

test("spend sums EVERY ledger, not just ai_job_runs", { skip: !Database }, () => {
  const d = db();
  spendJobRuns(d, 1.0195);          // the figure ai_job_runs reported in production
  spendAsym(d, 0.2005);             // the figure the asymmetry ledger held at the same time
  const s = combinedMonthlySpendUsdOnDb(d, MK);
  assert.equal(s.totalUsd, 1.22);
  assert.equal(s.byLedger.ai_job_runs, 1.0195);
  assert.equal(s.byLedger.asymmetry_ai_ledger, 0.2005);
  assert.equal(s.complete, true);
  d.close();
});

test("failed attempts count — a call that burned tokens and failed validation still cost money", { skip: !Database }, () => {
  const d = db();
  d.prepare(
    "INSERT INTO ai_job_runs (job_type, model, status, estimated_cost_usd, month_key, created_at_ms) VALUES (?,?,?,?,?,?)",
  ).run("nightly_diagnosis", "claude-haiku-4-5", "VALIDATION_FAILED", 0.05, MK, NOW);
  assert.equal(combinedMonthlySpendUsdOnDb(d, MK).totalUsd, 0.05);
  d.close();
});

test("an asymmetry row that never reached the model is not charged", { skip: !Database }, () => {
  const d = db();
  spendAsym(d, 0.9, "BLOCKED");
  assert.equal(combinedMonthlySpendUsdOnDb(d, MK).totalUsd, 0);
  d.close();
});

test("an optional ledger that does not exist yet is an honest zero, and says so", { skip: !Database }, () => {
  const d = db({ asym: false });
  spendJobRuns(d, 2);
  const s = combinedMonthlySpendUsdOnDb(d, MK);
  assert.equal(s.totalUsd, 2);
  assert.equal(s.complete, true);
  assert.deepEqual(s.unavailable.map((u) => u.id), ["asymmetry_ai_ledger"]);
  d.close();
});

test("a REQUIRED ledger that cannot be read fails CLOSED — unproven is not zero", { skip: !Database }, () => {
  const d = db({ jobRuns: false });
  const s = combinedMonthlySpendUsdOnDb(d, MK);
  assert.equal(s.complete, false);
  const gate = combinedCostGateOnDb(d, aiConfig({}), NOW, 0.01);
  assert.equal(gate.allowed, false);
  assert.equal(gate.status, BUDGET_EXHAUSTED);
  assert.match(gate.reason, /cannot be proven|could not be read/);
  d.close();
});

// ── The gate ─────────────────────────────────────────────────────────────────

test("the gate is PRE-FLIGHT: the reservation, not the spend, is what blocks", { skip: !Database }, () => {
  const d = db();
  spendJobRuns(d, 19.5);
  const cfg = aiConfig({});
  // Already spent is under the cap, so a post-hoc check would permit one more call.
  assert.equal(combinedCostGateOnDb(d, cfg, NOW, 0).allowed, true);
  // The call about to run could cost $1, which would carry the month past $20. Refused.
  assert.equal(combinedCostGateOnDb(d, cfg, NOW, 1).allowed, false);
  d.close();
});

test("a combined total crosses the cap that neither ledger crosses alone", { skip: !Database }, () => {
  const d = db();
  spendJobRuns(d, 12);
  spendAsym(d, 9);
  // 12 and 9 are each comfortably under 20. Together they are not, and that is the
  // entire failure this module exists to prevent.
  const gate = combinedCostGateOnDb(d, aiConfig({}), NOW, 0);
  assert.equal(gate.spendUsd, 21);
  assert.equal(gate.allowed, false);
  assert.equal(gate.status, BUDGET_EXHAUSTED);
  d.close();
});

test("a hard limit of 0 permits no AI spend at all", { skip: !Database }, () => {
  const d = db();
  assert.equal(combinedCostGateOnDb(d, aiConfig({ AI_MONTHLY_HARD_LIMIT_USD: "0" }), NOW, 0).allowed, false);
  d.close();
});

test("the budget report names what keeps running once AI stops", { skip: !Database }, () => {
  const d = db();
  spendJobRuns(d, 20);
  const r = aiBudgetReportOnDb(d, aiConfig({}), NOW);
  assert.equal(r.allowed, false);
  for (const must of ["live options scanner", "paper + shadow tracking", "probabilities and statistics"]) {
    assert.ok(r.unaffectedByBudget.includes(must), `budget report must state that ${must} is unaffected`);
  }
  d.close();
});

// ── Enforcement at the provider chokepoint ───────────────────────────────────

function fetchThatMustNotRun() {
  return async () => {
    throw new Error("the provider was contacted after the budget refused the call");
  };
}

function okFetch(payload, usage = { input_tokens: 1000, output_tokens: 200 }) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      content: [{ type: "tool_use", name: "t", input: payload }],
      usage,
    }),
  });
}

const CALL = {
  model: "claude-sonnet-5",
  system: "s",
  user: "u",
  maxOutputTokens: 500,
  timeoutMs: 1000,
  maxRetries: 0,
  toolName: "t",
  validatorName: "v",
  jobType: "advisory_chat",
};

test("an exhausted budget stops the call BEFORE the provider is contacted", { skip: !Database }, async () => {
  const d = db();
  spendJobRuns(d, 20);
  const res = await runStructuredAiJob(CALL, (j) => j, {
    db: d,
    env: { ANTHROPIC_API_KEY: "test-key" },
    fetchImpl: fetchThatMustNotRun(),
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "budget_exhausted");
  assert.equal(res.inputTokens, 0);
  assert.equal(res.diagnostics.budgetState, "ENFORCED");
  d.close();
});

test("a refused call is recorded as BUDGET_EXHAUSTED, attributed to its job type", { skip: !Database }, async () => {
  const d = db();
  spendJobRuns(d, 20);
  await runStructuredAiJob(CALL, (j) => j, {
    db: d, env: { ANTHROPIC_API_KEY: "test-key" }, fetchImpl: fetchThatMustNotRun(),
  });
  const row = d.prepare("SELECT job_type, status, estimated_cost_usd FROM ai_job_runs WHERE status=?").get(BUDGET_EXHAUSTED);
  assert.equal(row.job_type, "advisory_chat");
  assert.equal(row.estimated_cost_usd, 0);
  // Recording the refusal must not itself become spend.
  assert.equal(combinedMonthlySpendUsdOnDb(d, MK).totalUsd, 20);
  d.close();
});

test("a metered call site writes its own spend row — the Ask OptiScan path used to write none", { skip: !Database }, async () => {
  const d = db();
  const res = await runStructuredAiJob(
    { ...CALL, meter: true },
    (j) => j,
    { db: d, env: { ANTHROPIC_API_KEY: "test-key" }, fetchImpl: okFetch({ answer: "x" }) },
  );
  assert.equal(res.ok, true);
  const row = d.prepare("SELECT job_type, status, input_tokens, estimated_cost_usd FROM ai_job_runs").get();
  assert.equal(row.job_type, "advisory_chat");
  assert.equal(row.status, "SUCCESS");
  assert.equal(row.input_tokens, 1000);
  assert.ok(row.estimated_cost_usd > 0, "a call that used tokens must cost more than zero");
  d.close();
});

test("a call site that records its own row is NOT metered here — one call, one charge", { skip: !Database }, async () => {
  const d = db();
  await runStructuredAiJob(
    { ...CALL, jobType: "nightly_diagnosis" }, // no `meter` — nightly writes its own row
    (j) => j,
    { db: d, env: { ANTHROPIC_API_KEY: "test-key" }, fetchImpl: okFetch({ answer: "x" }) },
  );
  assert.equal(d.prepare("SELECT COUNT(*) n FROM ai_job_runs").get().n, 0);
  d.close();
});

test("a metered call that fails validation is still charged", { skip: !Database }, async () => {
  const d = db();
  await runStructuredAiJob(
    { ...CALL, meter: true },
    () => { throw new Error("nope"); },
    { db: d, env: { ANTHROPIC_API_KEY: "test-key" }, fetchImpl: okFetch({ answer: "x" }) },
  );
  const row = d.prepare("SELECT status, estimated_cost_usd FROM ai_job_runs").get();
  assert.equal(row.status, "VALIDATION_FAILED");
  assert.ok(row.estimated_cost_usd > 0);
  d.close();
});

test("in production a missing ledger refuses the call rather than spending unmeasured", async () => {
  const res = await runStructuredAiJob(CALL, (j) => j, {
    // No db and none resolvable: in production that is a refusal, not a free pass.
    env: { ANTHROPIC_API_KEY: "test-key", NODE_ENV: "production" },
    fetchImpl: fetchThatMustNotRun(),
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCategory, "budget_exhausted");
});

test("an explicit test bypass is recorded as a bypass, never as enforcement", async () => {
  const res = await runStructuredAiJob(CALL, (j) => j, {
    budgetGate: null,
    env: { ANTHROPIC_API_KEY: "test-key" },
    fetchImpl: okFetch({ answer: "x" }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.diagnostics.budgetState, "BYPASSED_BY_CALLER");
});
