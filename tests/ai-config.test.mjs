import test from "node:test";
import assert from "node:assert/strict";
import { aiConfig } from "../lib/ai/config.ts";

test("AI is OFF by default and requires BOTH a flag and an API key", () => {
  assert.equal(aiConfig({}).enabled, false);
  assert.equal(aiConfig({ AI_ENABLED: "1" }).enabled, false, "flag alone is not enough (no key)");
  assert.equal(aiConfig({ ANTHROPIC_API_KEY: "k" }).enabled, false, "key alone is not enough (flag off)");
  assert.equal(aiConfig({ AI_ENABLED: "1", ANTHROPIC_API_KEY: "k" }).enabled, true);
});

test("per-job flags require the master switch to be enabled", () => {
  const off = aiConfig({ AI_NIGHTLY_DIAGNOSIS_ENABLED: "1", AI_WEEKLY_PROPOSALS_ENABLED: "1" });
  assert.equal(off.nightlyDiagnosisEnabled, false);
  assert.equal(off.weeklyProposalsEnabled, false);
  const on = aiConfig({ AI_ENABLED: "1", ANTHROPIC_API_KEY: "k", AI_NIGHTLY_DIAGNOSIS_ENABLED: "1", AI_WEEKLY_PROPOSALS_ENABLED: "1" });
  assert.equal(on.nightlyDiagnosisEnabled, true);
  assert.equal(on.weeklyProposalsEnabled, true);
});

test("model routing: lower-cost nightly default, stronger weekly default; both overridable", () => {
  const d = aiConfig({});
  assert.equal(d.nightlyModel, "claude-haiku-4-5");
  assert.equal(d.weeklyModel, "claude-sonnet-5");
  const o = aiConfig({ AI_NIGHTLY_MODEL: "claude-haiku-4-5", AI_WEEKLY_MODEL: "claude-opus-4-8" });
  assert.equal(o.weeklyModel, "claude-opus-4-8");
});

test("cost + token + timeout limits parse with safe clamps", () => {
  const c = aiConfig({ AI_MONTHLY_SOFT_LIMIT_USD: "3", AI_MONTHLY_HARD_LIMIT_USD: "12", AI_MAX_OUTPUT_TOKENS_PER_JOB: "2000", AI_JOB_TIMEOUT_MS: "30000", AI_MAX_RETRIES: "1" });
  assert.equal(c.monthlySoftLimitUsd, 3);
  assert.equal(c.monthlyHardLimitUsd, 12);
  assert.equal(c.maxOutputTokensPerJob, 2000);
  assert.equal(c.jobTimeoutMs, 30000);
  assert.equal(c.maxRetries, 1);
  // Clamps: absurd values are bounded, never applied raw.
  assert.equal(aiConfig({ AI_MAX_RETRIES: "99" }).maxRetries, 5);
  assert.equal(aiConfig({ AI_JOB_TIMEOUT_MS: "1" }).jobTimeoutMs, 5000);
  assert.equal(aiConfig({ AI_MAX_OUTPUT_TOKENS_PER_JOB: "9" }).maxOutputTokensPerJob, 256);
});

test("the API key is never echoed back in the config (only its presence)", () => {
  const c = aiConfig({ AI_ENABLED: "1", ANTHROPIC_API_KEY: "secret-key" });
  assert.equal(c.hasApiKey, true);
  assert.ok(!JSON.stringify(c).includes("secret-key"), "key value must not appear in config");
});
