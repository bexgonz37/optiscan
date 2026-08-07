/**
 * The nightly reasoning pass and what it is allowed to write down.
 *
 * The behaviour under test is the difference between an AI that narrates a session and one that
 * accumulates: a conclusion has to survive into `options_learning_findings`, where the NEXT
 * night's context is built from it. Everything else here is the price of that: a finding must
 * name its limitations, a conclusion resting on zero rows may not be called STRONG, an AI id can
 * never collide with a frozen deterministic finding, and none of it may run when the budget is
 * gone or cost the session its deterministic evidence when the provider is down.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  runNightlyResearchAnalysis, validateAnalysis, screenAnalysisFinding,
  researchAnalysisPrompt, RESEARCH_ANALYSIS_JOB_TYPE,
} from "../lib/ai/research-analysis.ts";
import { aiConfig } from "../lib/ai/config.ts";
import { recordAiJobRunOnDb } from "../lib/ai/store.ts";
import {
  upsertAiFindingOnDb, listFindingsOnDb, seedLhcFindingsOnDb, AI_FINDING_PREFIX,
} from "../lib/research/options/findings-store.ts";
import { BUDGET_OPTIONAL_JOBS, BUDGET_EXEMPT_SUBSYSTEMS } from "../lib/research/options/weekly-research.ts";

const NOW = Date.parse("2026-08-08T00:30:00Z");
const SESSION = "2026-08-07";

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_learning_findings (
      finding_id TEXT PRIMARY KEY, strategy TEXT, strategy_version TEXT, population TEXT,
      evidence_cohort_id TEXT, sessions_json TEXT NOT NULL, sample_size INTEGER NOT NULL,
      title TEXT NOT NULL, statement TEXT NOT NULL, baseline_metric_json TEXT,
      experimental_metric_json TEXT, evidence_strength TEXT NOT NULL, limitations_json TEXT NOT NULL,
      affected_opportunity_ids_json TEXT, recommended_experiment TEXT, experiment_id TEXT,
      experiment_status TEXT, must_not_be_summarized_as TEXT, deployment_sha TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
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

const ENABLED = aiConfig({ AI_ENABLED: "1", ANTHROPIC_API_KEY: "k", AI_NIGHTLY_DIAGNOSIS_ENABLED: "1", AI_MONTHLY_HARD_LIMIT_USD: "20" });
const DISABLED = aiConfig({ AI_ENABLED: "1", ANTHROPIC_API_KEY: "k", AI_MONTHLY_HARD_LIMIT_USD: "20" });

const RESEARCH = { contextVersion: "ai-research-context-v1", experiment: { experimentId: "LHC_SELECT_V1" } };

const GOOD_FINDING = {
  key: "confirmation delay cost",
  question: "Are confirmation delays consuming edge?",
  title: "Confirmation cost is not yet measurable",
  statement: "No prospective decision recorded a confirmation delay, so the cost of waiting is unmeasured.",
  evidenceStrength: "INSUFFICIENT",
  sampleSize: 0,
  limitations: ["No rows carried an OBSERVED or DERIVED confirmation delay."],
  mustNotBeSummarizedAs: "Confirmation is instant. It is unmeasured, which is not the same thing.",
  recommendedExperiment: null,
};

function provider(payload, counter = { n: 0 }) {
  return {
    counter,
    deps: {
      env: { ANTHROPIC_API_KEY: "k" },
      fetchImpl: async () => {
        counter.n += 1;
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({
            content: [{ type: "tool_use", name: "submit_research_analysis", input: payload }],
            usage: { input_tokens: 900, output_tokens: 200 },
          }),
        };
      },
    },
  };
}

// ── validation: what a finding costs to make ────────────────────────────────────────────────

test("a finding with no limitations is refused, not silently defaulted", () => {
  assert.throws(
    () => validateAnalysis({ findings: [{ ...GOOD_FINDING, limitations: [] }] }),
    /limitations must be a non-empty array/,
  );
  assert.throws(
    () => validateAnalysis({ findings: [{ ...GOOD_FINDING, limitations: undefined }] }),
    /limitations must be a non-empty array/,
  );
});

test("a conclusion resting on zero rows may not be called STRONG", () => {
  assert.throws(
    () => validateAnalysis({ findings: [{ ...GOOD_FINDING, sampleSize: 0, evidenceStrength: "STRONG" }] }),
    /sampleSize 0 and must be INSUFFICIENT/,
  );
  assert.throws(
    () => validateAnalysis({ findings: [{ ...GOOD_FINDING, sampleSize: 0, evidenceStrength: "MODERATE" }] }),
    /must be INSUFFICIENT/,
  );
  // The honest version of the same claim passes.
  assert.equal(validateAnalysis({ findings: [GOOD_FINDING] }).findings.length, 1);
});

test("an empty findings array is a SUCCESSFUL analysis, not a failure", () => {
  const a = validateAnalysis({ findings: [], openQuestions: ["nothing has closed yet"] });
  assert.deepEqual(a.findings, []);
  assert.equal(a.openQuestions.length, 1);
  assert.equal(a.proposedExperiment, null);
});

test("an unknown evidence strength is refused rather than coerced", () => {
  assert.throws(
    () => validateAnalysis({ findings: [{ ...GOOD_FINDING, evidenceStrength: "VERY_STRONG" }] }),
    /evidenceStrength must be one of/,
  );
});

test("the safety screen drops a finding that claims validation or asks for promotion", () => {
  for (const bad of [
    { ...GOOD_FINDING, statement: "LHC_SELECT_V1 is validated by tonight's results." },
    { ...GOOD_FINDING, statement: "The lane is ready for subscribers." },
    { ...GOOD_FINDING, recommendedExperiment: "Promote the experiment to production." },
    { ...GOOD_FINDING, statement: "Bypass the entry-quality gate for these setups." },
  ]) {
    const s = screenAnalysisFinding(bad);
    assert.equal(s.ok, false, `not screened: ${bad.statement}`);
    assert.ok(s.violations.length > 0);
  }
  assert.equal(screenAnalysisFinding(GOOD_FINDING).ok, true);
});

test("the prompt states the rules the payload depends on", () => {
  const { system, user } = researchAnalysisPrompt(SESSION, RESEARCH, ["Did it reject a winner?"]);
  assert.match(system, /null metric means UNAVAILABLE/);
  assert.match(system, /never render it as zero/i);
  assert.match(system, /MUST name its limitations/);
  assert.match(system, /INSUFFICIENT/);
  assert.match(system, /may NOT promote, approve/);
  assert.match(user, /Did it reject a winner\?/);
  assert.match(user, /LHC_SELECT_V1/);
});

// ── persistence ─────────────────────────────────────────────────────────────────────────────

test("an analysis finding is persisted where the next night's context will read it", async () => {
  const d = db();
  const p = provider({ findings: [GOOD_FINDING], openQuestions: ["did anything close?"] });
  const res = await runNightlyResearchAnalysis(d, ENABLED, {
    sessionDate: SESSION, research: RESEARCH, nowMs: NOW, provider: p.deps, deploymentSha: "62d1c80",
  });

  assert.equal(res.status, "SUCCESS");
  assert.equal(res.findingsPersisted, 1);
  const stored = listFindingsOnDb(d, { strategy: "lower_high_continuation" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].findingId, `${AI_FINDING_PREFIX}CONFIRMATION_DELAY_COST`);
  assert.equal(stored[0].deploymentSha, "62d1c80");
  assert.deepEqual(stored[0].sessions, [SESSION]);
  // The provenance is appended to the model's own limitations, never in place of them.
  assert.ok(stored[0].limitations.length >= 2);
  assert.match(stored[0].limitations.join(" "), /AI-authored interpretation/);
  assert.match(stored[0].limitations.join(" "), /not a deterministic measurement/);
  d.close();
});

test("a repeated conclusion updates one standing claim instead of minting a new one nightly", () => {
  const d = db();
  upsertAiFindingOnDb(d, { ...GOOD_FINDING, sessionDate: SESSION }, { deploymentSha: "62d1c80" }, NOW);
  upsertAiFindingOnDb(d, {
    ...GOOD_FINDING, sessionDate: "2026-08-10", statement: "Still unmeasured after three sessions.",
  }, { deploymentSha: "62d1c80" }, NOW + 3 * 86_400_000);

  const stored = listFindingsOnDb(d, { strategy: "lower_high_continuation" });
  assert.equal(stored.length, 1);
  assert.match(stored[0].statement, /three sessions/);
  d.close();
});

test("an AI finding can never overwrite a frozen deterministic one", () => {
  const d = db();
  seedLhcFindingsOnDb(d, { deploymentSha: "62d1c80" }, NOW);
  const before = listFindingsOnDb(d, { strategy: "lower_high_continuation" })
    .find((f) => f.findingId === "LHC_SELECT_V1_TAIL_DEPENDENCE");

  // Even an id crafted to collide is namespaced on write.
  const r = upsertAiFindingOnDb(d, {
    ...GOOD_FINDING, key: "LHC_SELECT_V1_TAIL_DEPENDENCE", sessionDate: SESSION,
    statement: "The tail is reproducible.",
  }, {}, NOW);
  assert.equal(r.findingId, `${AI_FINDING_PREFIX}LHC_SELECT_V1_TAIL_DEPENDENCE`);

  const after = listFindingsOnDb(d, { strategy: "lower_high_continuation" })
    .find((f) => f.findingId === "LHC_SELECT_V1_TAIL_DEPENDENCE");
  assert.equal(after.statement, before.statement);
  assert.equal(listFindingsOnDb(d, { strategy: "lower_high_continuation" }).length, 7);
  d.close();
});

test("a key that reduces to nothing is refused rather than written under the bare prefix", () => {
  const d = db();
  assert.throws(() => upsertAiFindingOnDb(d, { ...GOOD_FINDING, key: "!!!", sessionDate: SESSION }, {}, NOW), /no usable key/);
  d.close();
});

test("a finding that fails the safety screen is counted, not stored", async () => {
  const d = db();
  const p = provider({
    findings: [{ ...GOOD_FINDING, statement: "LHC_SELECT_V1 is validated and ready for subscribers." }],
    openQuestions: [],
  });
  const res = await runNightlyResearchAnalysis(d, ENABLED, {
    sessionDate: SESSION, research: RESEARCH, nowMs: NOW, provider: p.deps,
  });
  assert.equal(res.status, "SUCCESS");
  assert.equal(res.findingsPersisted, 0);
  assert.equal(res.findingsBlocked, 1);
  assert.equal(listFindingsOnDb(d, { strategy: "lower_high_continuation" }).length, 0);
  d.close();
});

// ── budget + isolation ──────────────────────────────────────────────────────────────────────

test("the analysis is skipped once the monthly hard limit is reached, with no provider call", async () => {
  const d = db();
  recordAiJobRunOnDb(d, { jobType: "weekly_proposals", model: "claude-sonnet-5", status: "SUCCESS", estimatedCostUsd: 25, nowMs: NOW });
  const p = provider({ findings: [], openQuestions: [] });
  const res = await runNightlyResearchAnalysis(d, ENABLED, {
    sessionDate: SESSION, research: RESEARCH, nowMs: NOW, provider: p.deps,
  });
  assert.equal(res.skippedReason, "budget exhausted");
  assert.equal(p.counter.n, 0);
  const run = d.prepare("SELECT status, error_category FROM ai_job_runs WHERE job_type=?").get(RESEARCH_ANALYSIS_JOB_TYPE);
  assert.equal(run.status, "SKIPPED_HARD_LIMIT");
  assert.equal(run.error_category, "budget");
  d.close();
});

test("the analysis is skipped when AI is disabled, with no provider call", async () => {
  const d = db();
  const p = provider({ findings: [], openQuestions: [] });
  const res = await runNightlyResearchAnalysis(d, DISABLED, {
    sessionDate: SESSION, research: RESEARCH, nowMs: NOW, provider: p.deps,
  });
  assert.equal(res.skippedReason, "ai disabled");
  assert.equal(p.counter.n, 0);
  d.close();
});

test("no research context means no call and no fabricated analysis", async () => {
  const d = db();
  const p = provider({ findings: [], openQuestions: [] });
  const res = await runNightlyResearchAnalysis(d, ENABLED, {
    sessionDate: SESSION, research: null, nowMs: NOW, provider: p.deps,
  });
  assert.match(res.skippedReason, /no research context/);
  assert.equal(p.counter.n, 0);
  assert.equal(res.findingsPersisted, 0);
  d.close();
});

test("a provider outage never throws and never persists a partial finding", async () => {
  const d = db();
  const res = await runNightlyResearchAnalysis(d, ENABLED, {
    sessionDate: SESSION, research: RESEARCH, nowMs: NOW,
    provider: { env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async () => { throw new Error("network down"); } },
  });
  assert.notEqual(res.status, "SUCCESS");
  assert.equal(res.findingsPersisted, 0);
  assert.equal(listFindingsOnDb(d, { strategy: "lower_high_continuation" }).length, 0);
  d.close();
});

test("a malformed model response fails validation without writing anything", async () => {
  const d = db();
  const p = provider({ findings: [{ ...GOOD_FINDING, limitations: [] }] });
  const res = await runNightlyResearchAnalysis(d, ENABLED, {
    sessionDate: SESSION, research: RESEARCH, nowMs: NOW, provider: p.deps,
  });
  assert.equal(res.status, "VALIDATION_FAILED");
  assert.equal(listFindingsOnDb(d, { strategy: "lower_high_continuation" }).length, 0);
  d.close();
});

test("the analysis is budget-optional and never joins the never-stop list", () => {
  assert.ok(BUDGET_OPTIONAL_JOBS.includes(RESEARCH_ANALYSIS_JOB_TYPE));
  assert.ok(!BUDGET_EXEMPT_SUBSYSTEMS.includes(RESEARCH_ANALYSIS_JOB_TYPE));
  for (const never of ["scanner", "owner_discord", "paper_mirror", "marks", "lifecycle", "grading", "evidence_learning_capture", "readiness", "deterministic_experiment_tracking"]) {
    assert.ok(BUDGET_EXEMPT_SUBSYSTEMS.includes(never), `${never} must never be gated on budget`);
    assert.ok(!BUDGET_OPTIONAL_JOBS.includes(never));
  }
});
