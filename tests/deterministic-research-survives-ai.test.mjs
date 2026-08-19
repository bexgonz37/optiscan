/**
 * tests/deterministic-research-survives-ai.test.mjs
 *
 * PHASE 5, the two "PROVE IT" cases the other tests could not cover:
 *
 *     BUDGET EXHAUSTED  → deterministic research still persists
 *     AI OUTAGE         → deterministic research still persists
 *
 * The ordering inside `runNightlyDiagnosis` is what makes this true — the summary, the
 * lessons and the deterministic research aggregation all run and commit BEFORE the
 * first provider byte is sent — and ordering is exactly the kind of property that
 * survives review and then quietly inverts when someone moves a block. So it is
 * asserted against a real database with a provider that cannot succeed.
 *
 * The failure this prevents is not an outage. It is an outage that takes the night's
 * evidence with it, leaving a gap indistinguishable from a quiet session.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

const { applyProductionSchemaOnDb } = await import("@/lib/db");
const { runNightlyDiagnosis } = await import("@/lib/ai/nightly");
const { AI_MONTHLY_HARD_CAP_USD, aiConfig } = await import("@/lib/ai/config");
const { combinedCostGateOnDb } = await import("@/lib/ai/monthly-budget");

const DAY = "2026-08-19";
/** Everything the provider path requires. A key ALONE never attempts a call. */
const AI_ON = {
  ANTHROPIC_API_KEY: "test-key",
  AI_ENABLED: "1",
  AI_NIGHTLY_DIAGNOSIS_ENABLED: "1",
};
const NOW = Date.parse("2026-08-19T23:00:00.000Z");

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

/** Burn the whole month's cap through the ledger the gate actually reads. */
function exhaustBudget(d) {
  d.prepare(
    `INSERT INTO ai_job_runs (job_type, model, status, estimated_cost_usd, input_tokens, output_tokens, month_key, created_at_ms)
     VALUES ('nightly_diagnosis','claude-haiku-4-5','SUCCESS',?,0,0,?,?)`,
  ).run(AI_MONTHLY_HARD_CAP_USD + 5, "2026-08", NOW);
}

const reportRow = (d) =>
  d.prepare("SELECT * FROM ai_reports WHERE report_type='nightly' AND period_key=?").get(DAY);

test("the $20 hard cap is a CONSTANT that env cannot raise", () => {
  assert.equal(AI_MONTHLY_HARD_CAP_USD, 20);
  const raised = aiConfig({ AI_MONTHLY_HARD_LIMIT_USD: "100000", ANTHROPIC_API_KEY: "k" });
  assert.equal(raised.monthlyHardLimitUsd, 20, "one mistyped Railway variable must not raise the ceiling");
  const lowered = aiConfig({ AI_MONTHLY_HARD_LIMIT_USD: "5", ANTHROPIC_API_KEY: "k" });
  assert.equal(lowered.monthlyHardLimitUsd, 5, "env may still LOWER it");
});

test("PROVE IT — budget exhausted: the deterministic report still persists", async () => {
  const d = db();
  exhaustBudget(d);

  let providerCalls = 0;
  const res = await runNightlyDiagnosis({
    db: d, day: DAY, nowMs: NOW,
    env: AI_ON,
    provider: { env: AI_ON, fetchImpl: async () => { providerCalls += 1; throw new Error("must not be called"); } },
  });

  assert.equal(res.ran, true, "the nightly must still run");
  assert.ok(res.summary, "the deterministic summary must exist");
  assert.ok(res.reportId, "the report must be persisted");
  assert.ok(reportRow(d), "the row must be readable from the database, not just from the return value");
  assert.equal(providerCalls, 0, "an exhausted budget must not reach the provider at all");

  const gate = combinedCostGateOnDb(d, aiConfig(AI_ON), NOW);
  assert.equal(gate.allowed, false, "the gate must actually be closed for this fixture");
});

test("PROVE IT — AI outage: the deterministic report still persists", async () => {
  const d = db();
  let providerCalls = 0;
  const res = await runNightlyDiagnosis({
    db: d, day: DAY, nowMs: NOW,
    // AI_ENABLED and the nightly flag are required for the provider to be reached at
    // all -- a key alone can never attempt a call. Both are set here so the OUTAGE is
    // what the test exercises, rather than the disabled path.
    env: AI_ON,
    // `env` belongs on the provider deps too: runStructuredAiJob reads the API key from
    // `deps.env ?? process.env`, so a fixture that sets it only on the job options reaches
    // the DISABLED path and never exercises the outage it means to test.
    provider: {
      env: AI_ON,
      fetchImpl: async () => { providerCalls += 1; throw Object.assign(new Error("ECONNREFUSED"), { category: "network" }); },
    },
  });

  assert.equal(res.ran, true);
  assert.ok(res.summary);
  assert.ok(reportRow(d), "an unreachable provider must not take the night's evidence with it");
  assert.ok(providerCalls > 0, "the outage fixture must actually have been exercised");
  assert.notEqual(res.narrativeStatus, "OK", "the narration itself must be recorded as failed");
});

test("PROVE IT — no API key at all: the deterministic report still persists", async () => {
  const d = db();
  const res = await runNightlyDiagnosis({
    db: d, day: DAY, nowMs: NOW, env: {},
    provider: { fetchImpl: async () => { throw new Error("must not be called without a key"); } },
  });
  assert.equal(res.ran, true);
  assert.ok(res.summary);
  assert.ok(reportRow(d));
});

test("a failed AI call is still CHARGED — a month of retries cannot become invisible", async () => {
  const d = db();
  await runNightlyDiagnosis({
    db: d, day: DAY, nowMs: NOW,
    env: AI_ON,
    provider: {
      env: AI_ON,
      fetchImpl: async () => ({
        ok: true, status: 200,
        // Parses fine, fails validation. The shape that produced 11 of 31 August runs.
        text: async () => JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ headline: "x" }) }],
          usage: { input_tokens: 1000, output_tokens: 200 },
        }),
      }),
    },
  });
  const rows = d.prepare("SELECT status FROM ai_job_runs").all();
  assert.ok(rows.length > 0, "a failed call must leave a ledger row");
  assert.ok(
    rows.every((r) => r.status !== "PENDING"),
    "every recorded run must reach a terminal status",
  );
});

test("the deterministic research aggregation is reachable without any provider", async () => {
  const d = db();
  const { runNightlyResearchOnDb } = await import("@/lib/research/options/nightly-research");
  // No provider, no key, no network. This is the object the nightly commits before the
  // first byte is sent, and it must stand entirely on its own.
  const research = runNightlyResearchOnDb(d, { sessionDate: DAY, deploymentSha: "testsha", nowMs: NOW });
  assert.ok(research, "deterministic research must not require the model");
});
