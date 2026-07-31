/**
 * tests/high-asymmetry-ai-budget.test.mjs
 *
 * Cost controls on the ONE AI call the High-Asymmetry system makes.
 *
 * The spend shape being protected: one advisory call per trading session,
 * cached by date and review version, bounded by daily and monthly limits, and
 * completely severable — every deterministic stage runs to completion whether
 * AI is enabled, disabled, cached, over budget, or broken.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  checkAiBudget, recordAiCallOnDb, readAiBudgetUsage, readAiCache, writeAiCache,
  ensureAiBudgetSchema, resolveAiBudgetConfig, estimateTokens, monthKey, DEFAULT_AI_BUDGET,
} from "../lib/ai/asymmetry-budget.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const SESSION = "2026-07-30";
const VERSION = "HIGH_ASYMMETRY_PAPER_V1";

function db() {
  const d = new Database(":memory:");
  ensureAiBudgetSchema(d);
  return d;
}

// ── Defaults ────────────────────────────────────────────────────────────────

test("the default budget is one call per session", () => {
  assert.equal(DEFAULT_AI_BUDGET.dailyLimit, 1, "one advisory review per trading session");
  assert.ok(DEFAULT_AI_BUDGET.monthlyLimit > 0 && DEFAULT_AI_BUDGET.monthlyLimit <= 500);
});

test("limits are configurable and clamped", () => {
  const cfg = resolveAiBudgetConfig({ HIGH_ASYMMETRY_AI_DAILY_LIMIT: "3", HIGH_ASYMMETRY_AI_MONTHLY_LIMIT: "40" });
  assert.equal(cfg.dailyLimit, 3);
  assert.equal(cfg.monthlyLimit, 40);
  // Nonsense falls back rather than throwing or disabling the cap.
  const bad = resolveAiBudgetConfig({ HIGH_ASYMMETRY_AI_DAILY_LIMIT: "not-a-number" });
  assert.equal(bad.dailyLimit, DEFAULT_AI_BUDGET.dailyLimit);
  // And a caller cannot raise the ceiling without bound.
  const huge = resolveAiBudgetConfig({ HIGH_ASYMMETRY_AI_MONTHLY_LIMIT: "999999" });
  assert.ok(huge.monthlyLimit <= 500);
});

test("AI can be switched off entirely", () => {
  const d = db();
  const cfg = resolveAiBudgetConfig({ HIGH_ASYMMETRY_AI_ENABLED: "0" });
  assert.equal(cfg.enabled, false);
  const decision = checkAiBudget(d, SESSION, VERSION, cfg);
  assert.equal(decision.status, "AI_DISABLED");
  d.close();
});

// ── One call per session ────────────────────────────────────────────────────

test("exactly one call per session is allowed, then AI_BUDGET_BLOCKED", () => {
  const d = db();
  const cfg = resolveAiBudgetConfig({});
  assert.equal(checkAiBudget(d, SESSION, VERSION, cfg).status, "ALLOWED");

  recordAiCallOnDb(d, { sessionDate: SESSION, reviewVersion: VERSION, nowMs: 1, status: "CALLED", cfg, estInputTokens: 1000, estOutputTokens: 200 });

  // A DIFFERENT review version on the same day: still blocked, because the cap
  // is on the session, not on the version.
  const second = checkAiBudget(d, SESSION, "SOME_OTHER_VERSION", cfg);
  assert.equal(second.status, "AI_BUDGET_BLOCKED");
  assert.match(second.reason, /daily limit reached \(1\/1\)/);
  d.close();
});

test("a new session gets its own allowance", () => {
  const d = db();
  const cfg = resolveAiBudgetConfig({});
  recordAiCallOnDb(d, { sessionDate: SESSION, reviewVersion: VERSION, nowMs: 1, status: "CALLED", cfg });
  assert.equal(checkAiBudget(d, "2026-07-31", VERSION, cfg).status, "ALLOWED");
  d.close();
});

test("the monthly limit blocks even when a fresh day has allowance", () => {
  const d = db();
  const cfg = resolveAiBudgetConfig({ HIGH_ASYMMETRY_AI_MONTHLY_LIMIT: "2" });
  recordAiCallOnDb(d, { sessionDate: "2026-07-01", reviewVersion: VERSION, nowMs: 1, status: "CALLED", cfg });
  recordAiCallOnDb(d, { sessionDate: "2026-07-02", reviewVersion: VERSION, nowMs: 2, status: "CALLED", cfg });
  const blocked = checkAiBudget(d, "2026-07-03", VERSION, cfg);
  assert.equal(blocked.status, "AI_BUDGET_BLOCKED");
  assert.match(blocked.reason, /monthly limit reached \(2\/2\)/);
  // A new month resets.
  assert.equal(checkAiBudget(d, "2026-08-01", VERSION, cfg).status, "ALLOWED");
  d.close();
});

test("only CALLED consumes budget — blocked, cached, and failed do not", () => {
  const d = db();
  const cfg = resolveAiBudgetConfig({});
  for (const status of ["BLOCKED", "CACHED", "FAILED", "DISABLED"]) {
    recordAiCallOnDb(d, { sessionDate: SESSION, reviewVersion: VERSION, nowMs: 1, status, cfg });
  }
  const usage = readAiBudgetUsage(d, SESSION, cfg);
  assert.equal(usage.callsToday, 0, "a failed call must not burn the session's one allowance");
  assert.equal(checkAiBudget(d, SESSION, VERSION, cfg).status, "ALLOWED");
  d.close();
});

// ── Caching ─────────────────────────────────────────────────────────────────

test("a duplicate run reuses the stored result and spends nothing", () => {
  const d = db();
  const cfg = resolveAiBudgetConfig({});
  writeAiCache(d, { sessionDate: SESSION, reviewVersion: VERSION, summary: "already explained", nowMs: 1 });
  const decision = checkAiBudget(d, SESSION, VERSION, cfg);
  assert.equal(decision.status, "CACHED");
  assert.equal(decision.cachedSummary, "already explained");
  assert.equal(readAiBudgetUsage(d, SESSION, cfg).callsToday, 0, "reuse costs nothing");
  d.close();
});

test("the cache is keyed by BOTH trading date and review version", () => {
  const d = db();
  writeAiCache(d, { sessionDate: SESSION, reviewVersion: VERSION, summary: "v1 text", nowMs: 1 });
  assert.equal(readAiCache(d, SESSION, VERSION), "v1 text");
  assert.equal(readAiCache(d, SESSION, "V2"), null, "a new rules version is a different review");
  assert.equal(readAiCache(d, "2026-07-31", VERSION), null, "a new day is a different review");
  d.close();
});

test("the cache is served even when the budget is exhausted", () => {
  const d = db();
  const cfg = resolveAiBudgetConfig({});
  recordAiCallOnDb(d, { sessionDate: SESSION, reviewVersion: VERSION, nowMs: 1, status: "CALLED", cfg });
  writeAiCache(d, { sessionDate: SESSION, reviewVersion: VERSION, summary: "paid for already", nowMs: 1 });
  const decision = checkAiBudget(d, SESSION, VERSION, cfg);
  assert.equal(decision.status, "CACHED", "an answer already paid for should still be returnable");
  assert.equal(decision.cachedSummary, "paid for already");
  d.close();
});

// ── Reporting ───────────────────────────────────────────────────────────────

test("calls, estimated tokens, estimated cost, and remaining budget are all exposed", () => {
  const d = db();
  const cfg = resolveAiBudgetConfig({ HIGH_ASYMMETRY_AI_DAILY_LIMIT: "2", HIGH_ASYMMETRY_AI_MONTHLY_LIMIT: "10" });
  recordAiCallOnDb(d, {
    sessionDate: SESSION, reviewVersion: VERSION, nowMs: 1, status: "CALLED", cfg,
    estInputTokens: 1_000_000, estOutputTokens: 1_000_000,
  });
  const usage = readAiBudgetUsage(d, SESSION, cfg);
  assert.equal(usage.callsToday, 1);
  assert.equal(usage.callsThisMonth, 1);
  assert.equal(usage.estTokensThisMonth, 2_000_000);
  // 1M in @ $3 + 1M out @ $15.
  assert.equal(usage.estCostUsdThisMonth, 18);
  assert.equal(usage.remainingToday, 1);
  assert.equal(usage.remainingThisMonth, 9);
  d.close();
});

test("token estimation is approximate and openly so", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  const src = readFileSync("lib/ai/asymmetry-budget.ts", "utf8");
  assert.match(src, /ESTIMATED/, "the estimate must be labelled rather than presented as measured");
});

test("the month bucket comes from the trading date", () => {
  assert.equal(monthKey("2026-07-30"), "2026-07");
  assert.equal(monthKey("2026-12-01"), "2026-12");
});

// ── Failure containment ─────────────────────────────────────────────────────

test("a budget-check fault blocks the spend without throwing", () => {
  const broken = { prepare() { throw new Error("db gone"); }, exec() { throw new Error("db gone"); } };
  const decision = checkAiBudget(broken, SESSION, VERSION, resolveAiBudgetConfig({}));
  assert.equal(decision.status, "AI_BUDGET_BLOCKED", "an unreadable ledger must not authorize spending");
  assert.match(decision.reason, /budget check unavailable/);
});

test("every ledger and cache write survives a broken database", () => {
  const broken = { prepare() { throw new Error("db gone"); }, exec() { throw new Error("db gone"); } };
  assert.equal(recordAiCallOnDb(broken, { sessionDate: SESSION, reviewVersion: VERSION, nowMs: 1, status: "CALLED" }), false);
  assert.equal(writeAiCache(broken, { sessionDate: SESSION, reviewVersion: VERSION, summary: "x", nowMs: 1 }), false);
  assert.equal(readAiCache(broken, SESSION, VERSION), null);
  const usage = readAiBudgetUsage(broken, SESSION, resolveAiBudgetConfig({}));
  assert.equal(usage.callsToday, 0, "an unreadable ledger reads as no usage, not as a crash");
});

// ── Structural guarantees ───────────────────────────────────────────────────

test("nothing buys credits or enables auto-reload", () => {
  for (const file of ["lib/ai/asymmetry-budget.ts", "lib/ai/asymmetry-explain.ts"]) {
    // Identifiers and endpoints, not prose: the source says "never billing" in
    // a comment, and a bare word match would flag the very statement of intent.
    const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const forbidden of [
      /\bautoReload\b/i, /\bauto_reload\b/i, /\bbuyCredits\b/i, /\btopUp\b/i, /\btop_up\b/i,
      /\bpurchase\w*\(/i, /\bbilling\w*\(/i, /\/v1\/(billing|credits|payments)/i,
    ]) {
      assert.equal(forbidden.test(src), false, `${file} must not reference ${forbidden}`);
    }
    // And there is no outbound call anywhere in the budget layer at all.
    if (file.endsWith("asymmetry-budget.ts")) {
      assert.equal(/\bfetch\s*\(|axios|https?\.request/.test(src), false, "the budget layer makes no network call");
    }
  }
});

test("the budget layer cannot raise its own limit", () => {
  const src = readFileSync("lib/ai/asymmetry-budget.ts", "utf8");
  // Limits are only ever READ from configuration; there is no write path.
  assert.equal(/dailyLimit\s*=\s*(?!.*resolveAiBudget)/.test(src.replace(/dailyLimit: /g, "")), false);
  assert.equal(/UPDATE\s+.*limit/i.test(src), false, "no statement writes a limit back");
});

test("the deterministic radar never imports the budget or advisory modules", () => {
  // If a research module imported these, an AI outage could propagate into
  // capture, paper trading, or grading.
  for (const file of [
    "lib/research/asymmetry/eod-review.ts",
    "lib/research/asymmetry/transition-runner.ts",
    "lib/research/asymmetry/mark-runner.ts",
    "lib/research/asymmetry/paper/runner.ts",
    "lib/research/asymmetry/paper/entry.ts",
    "lib/research/asymmetry/paper/quant.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.equal(/asymmetry-budget|asymmetry-explain/.test(src), false, `${file} must not import an AI module`);
    assert.equal(/from\s+["'].*\/ai\//.test(src), false, `${file} must not import from lib/ai`);
  }
});

test("the scheduler injects the BUDGETED advisory, not the raw one", () => {
  const src = readFileSync("lib/scheduler.ts", "utf8");
  assert.match(src, /explainAsymmetryReviewWithBudget/, "the uncapped call must not be wired directly");
  const eodJob = src.slice(src.indexOf("async function asymmetryEodJob"), src.indexOf("async function beat"));
  assert.equal(/require\("@\/lib\/ai\/asymmetry-explain"\)[\s\S]{0,80}explainAsymmetryReview\b(?!With)/.test(eodJob), false,
    "the EOD job must not fall back to the unbudgeted export");
});

test("AI runs only AFTER a persisted deterministic review", () => {
  const src = readFileSync("lib/research/asymmetry/eod-review.ts", "utf8");
  const persistIdx = src.indexOf("out.persisted = true");
  const explainIdx = src.indexOf("await deps.explain(review)");
  assert.ok(persistIdx > 0 && explainIdx > 0);
  assert.ok(persistIdx < explainIdx, "persistence must come first in source order");
  assert.match(src, /if \(!out\.persisted\) \{[\s\S]{0,200}aiStatus = "SKIPPED"/,
    "an unpersisted review must skip AI rather than pay to describe a result that does not exist");
});
