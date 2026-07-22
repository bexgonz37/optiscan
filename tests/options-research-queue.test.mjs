import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  enqueueResearchTaskOnDb, claimNextTaskOnDb, completeTaskOnDb, failTaskOnDb,
  harvestResearchTasksOnDb, runResearchWorkerTick, startAiResearchWorker,
  researchQueueMetricsOnDb, __resetAiResearchWorkerForTest,
} from "../lib/research/options/research-queue.ts";

const NOW = 1_700_000_000_000;
function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE ai_research_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, priority INTEGER NOT NULL, ref_id TEXT NOT NULL, payload_json TEXT, status TEXT NOT NULL DEFAULT 'QUEUED', attempts INTEGER NOT NULL DEFAULT 0, result_json TEXT, error TEXT, lease_until_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, UNIQUE(kind, ref_id));
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, entry_fill REAL, strategy TEXT, status TEXT NOT NULL, exit_fill REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, paper_kind TEXT, alert_id TEXT, entry_source TEXT, experiment_id TEXT, experiment_variant TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE VIEW options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
          CREATE VIEW options_paper_research AS SELECT * FROM options_paper_trades WHERE paper_kind='RESEARCH_ONLY_PAPER';
          CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, side TEXT, state TEXT NOT NULL, failure_reason TEXT, entry_mid REAL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);`);
  return d;
}
function paper(d, over = {}) {
  const p = { option_symbol: "O:SPY260724C00640000", side: "call", result_class: "REAL_OPTION_PAPER", strategy: "sr_reclaim", status: "EXITED", entry_fill: 1.21, exit_fill: 1.5, return_pct: 24, exit_reason: "target_hit", entered_at_ms: NOW, exit_at_ms: NOW + 60_000, paper_kind: "DELIVERED_ALERT_PAPER", alert_id: "oa_1", ...over };
  d.prepare("INSERT INTO options_paper_trades (option_symbol, side, result_class, strategy, status, entry_fill, exit_fill, return_pct, exit_reason, entered_at_ms, exit_at_ms, paper_kind, alert_id, experiment_id, experiment_variant, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(p.option_symbol, p.side, p.result_class, p.strategy, p.status, p.entry_fill, p.exit_fill, p.return_pct, p.exit_reason, p.entered_at_ms, p.exit_at_ms, p.paper_kind, p.alert_id, p.experiment_id ?? null, p.experiment_variant ?? null, NOW, NOW);
}
const okAnalyze = async () => ({ ok: true, result: { qualityScore: 7 } });

// ── priority scheduling ──
test("claim order: P1 delivered analysis beats P5 research experiment regardless of insert order", () => {
  const d = db();
  enqueueResearchTaskOnDb(d, "research_experiment", "paper:9", {}, NOW - 5000);   // older but P5
  enqueueResearchTaskOnDb(d, "delivered_trade_analysis", "paper:1", {}, NOW);     // newer but P1
  const first = claimNextTaskOnDb(d, NOW);
  assert.equal(first.kind, "delivered_trade_analysis");
  const second = claimNextTaskOnDb(d, NOW);
  assert.equal(second.kind, "research_experiment");
});

test("enqueue is idempotent by (kind, ref) — re-harvest never duplicates", () => {
  const d = db();
  assert.equal(enqueueResearchTaskOnDb(d, "delivered_trade_analysis", "paper:1", {}, NOW).enqueued, true);
  assert.equal(enqueueResearchTaskOnDb(d, "delivered_trade_analysis", "paper:1", {}, NOW).enqueued, false);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM ai_research_queue").get().n, 1);
});

// ── harvest: only completed high-value work, never every scanned symbol ──
test("harvest: closed delivered → P1, closed research (mirror exists) → P2, TOO_LATE alert → P3", () => {
  const d = db();
  paper(d); // closed delivered mirror (sr_reclaim)
  paper(d, { paper_kind: "RESEARCH_ONLY_PAPER", alert_id: null, option_symbol: "O:SPY260724C00641000", experiment_id: "e1", experiment_variant: "wider_stop" }); // research, same strategy → P2
  paper(d, { paper_kind: "RESEARCH_ONLY_PAPER", alert_id: null, strategy: "never_delivered_strat", option_symbol: "O:QQQ260724C00500000" }); // research, no mirror → P5
  d.prepare("INSERT INTO options_alerts (alert_id, candidate_symbol, strategy, side, state, failure_reason, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?,?)").run("oa_late", "NVDA", "momentum_acceleration", "call", "TOO_LATE", "chase_exceeded", NOW, NOW);
  // an OPEN trade and a plain SENT alert must NOT be harvested (only completed work)
  paper(d, { status: "ENTERED", alert_id: "oa_open", option_symbol: "O:IWM260724C00220000" });
  const r = harvestResearchTasksOnDb(d, NOW);
  assert.equal(r.enqueued, 4);
  const kinds = d.prepare("SELECT kind, priority FROM ai_research_queue ORDER BY priority").all();
  assert.deepEqual(kinds.map((k) => k.kind), ["delivered_trade_analysis", "experiment_vs_mirror", "missed_opportunity", "research_experiment"]);
  // second harvest: nothing new
  assert.equal(harvestResearchTasksOnDb(d, NOW).enqueued, 0);
});

test("P4 recommendation task enqueues after every N completed P1/P2 analyses", () => {
  const d = db();
  for (let i = 0; i < 10; i++) {
    enqueueResearchTaskOnDb(d, "delivered_trade_analysis", `paper:${i}`, {}, NOW);
    const t = claimNextTaskOnDb(d, NOW);
    completeTaskOnDb(d, t.id, { qualityScore: 5 }, NOW);
  }
  harvestResearchTasksOnDb(d, NOW, { recommendationEvery: 10 });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM ai_research_queue WHERE kind='strategy_recommendation'").get().n, 1);
});

// ── retries + graceful failure ──
test("bounded retries: fail → re-queued; at the ceiling → FAILED closed", () => {
  const d = db();
  enqueueResearchTaskOnDb(d, "delivered_trade_analysis", "paper:1", {}, NOW);
  const t = claimNextTaskOnDb(d, NOW);
  failTaskOnDb(d, t.id, "provider 500", NOW, 3);
  assert.equal(d.prepare("SELECT status, attempts FROM ai_research_queue").get().status, "QUEUED");
  const t2 = claimNextTaskOnDb(d, NOW);
  failTaskOnDb(d, t2.id, "provider 500", NOW, 3);
  const t3 = claimNextTaskOnDb(d, NOW);
  failTaskOnDb(d, t3.id, "provider 500", NOW, 3);
  assert.equal(d.prepare("SELECT status, attempts FROM ai_research_queue").get().status, "FAILED");
});

// ── budget awareness: pause at the hard limit, tasks stay QUEUED ──
test("budget exhausted → worker PAUSES; tasks remain QUEUED; zero analyze calls; harvest continues", async () => {
  __resetAiResearchWorkerForTest();
  const d = db();
  paper(d); // harvestable completed work
  let analyzeCalls = 0;
  const r = await runResearchWorkerTick({
    getDb: () => d, now: () => NOW,
    analyze: async () => { analyzeCalls += 1; return { ok: true }; },
    budget: () => ({ allowed: false, spendUsd: 25, reason: "monthly_hard_limit" }),
  }, { AI_RESEARCH_QUEUE_ENABLED: "1" });
  assert.equal(r.paused, true);
  assert.equal(analyzeCalls, 0, "no AI spend past the hard limit");
  assert.ok(r.harvested >= 1, "harvesting is free and continues");
  assert.equal(d.prepare("SELECT status FROM ai_research_queue LIMIT 1").get().status, "QUEUED", "tasks wait, not lost");
  const m = researchQueueMetricsOnDb(d, { AI_RESEARCH_QUEUE_ENABLED: "1" });
  assert.equal(m.paused, true);
  assert.equal(m.pausedReason, "monthly_hard_limit");
});

test("APPROACHING the budget (soft limit): only P1/P2 process; P3/P5 wait; hard limit still pauses all", async () => {
  __resetAiResearchWorkerForTest();
  const d = db();
  enqueueResearchTaskOnDb(d, "delivered_trade_analysis", "paper:1", {}, NOW);   // P1
  enqueueResearchTaskOnDb(d, "missed_opportunity", "alert:x", {}, NOW);         // P3
  enqueueResearchTaskOnDb(d, "research_experiment", "paper:9", {}, NOW);        // P5
  const analyzed = [];
  const r = await runResearchWorkerTick({
    getDb: () => d, now: () => NOW,
    analyze: async (t) => { analyzed.push(t.kind); return { ok: true, result: {} }; },
    budget: () => ({ allowed: true, atSoftLimit: true, spendUsd: 6, reason: null }),
  }, { AI_RESEARCH_QUEUE_ENABLED: "1", AI_RESEARCH_TASKS_PER_TICK: "10" });
  assert.equal(r.paused, false);
  assert.deepEqual(analyzed, ["delivered_trade_analysis"], "only high-value P1/P2 spend budget near the limit");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM ai_research_queue WHERE status='QUEUED'").get().n, 2, "P3/P5 wait, not lost");
  const m = researchQueueMetricsOnDb(d, { AI_RESEARCH_QUEUE_ENABLED: "1" });
  assert.equal(m.softLimited, true);
});

test("a healthy tick processes highest-priority tasks and records results", async () => {
  __resetAiResearchWorkerForTest();
  const d = db();
  paper(d);
  const r = await runResearchWorkerTick({
    getDb: () => d, now: () => NOW,
    analyze: okAnalyze,
    budget: () => ({ allowed: true, spendUsd: 1, reason: null }),
  }, { AI_RESEARCH_QUEUE_ENABLED: "1", AI_RESEARCH_TASKS_PER_TICK: "5" });
  assert.equal(r.paused, false);
  assert.ok(r.processed >= 1);
  const row = d.prepare("SELECT status, result_json FROM ai_research_queue WHERE status='DONE' LIMIT 1").get();
  assert.ok(row && JSON.parse(row.result_json).qualityScore === 7);
});

// ── graceful degradation: analyzer throwing never kills the worker ──
test("an analyzer exception marks the task for retry and the tick completes normally", async () => {
  __resetAiResearchWorkerForTest();
  const d = db();
  enqueueResearchTaskOnDb(d, "delivered_trade_analysis", "paper:1", {}, NOW);
  const r = await runResearchWorkerTick({
    getDb: () => d, now: () => NOW,
    analyze: async () => { throw new Error("network down"); },
    budget: () => ({ allowed: true, spendUsd: 0, reason: null }),
  }, { AI_RESEARCH_QUEUE_ENABLED: "1" });
  assert.equal(r.processed, 0);
  const row = d.prepare("SELECT status, attempts, error FROM ai_research_queue").get();
  assert.equal(row.status, "QUEUED", "retryable, not lost");
  assert.match(row.error, /network down/);
});

// ── AI never required for live alerts ──
test("worker is a HARD no-op when the flag is off; live modules have no queue imports", async () => {
  __resetAiResearchWorkerForTest();
  assert.equal(startAiResearchWorker({ getDb: () => db() }, {}).started, false);
  // structural proof: the live alert path (monitor/loop/delivery/callout/paper) never imports the queue
  const fs = await import("node:fs");
  for (const f of ["monitor.ts", "loop.ts", "delivery.ts", "callout.ts", "paper.ts", "grade.ts"]) {
    const src = fs.readFileSync(`lib/research/options/${f}`, "utf8");
    assert.ok(!src.includes("research-queue"), `${f} must not depend on the AI queue`);
  }
});

test("ai_disabled: analyze skips cleanly; task is retried later, never fabricated", async () => {
  __resetAiResearchWorkerForTest();
  const d = db();
  enqueueResearchTaskOnDb(d, "missed_opportunity", "alert:x", {}, NOW);
  const r = await runResearchWorkerTick({
    getDb: () => d, now: () => NOW,
    analyze: async () => ({ ok: false, skipped: true, error: "ai_disabled" }),
    budget: () => ({ allowed: true, spendUsd: 0, reason: null }),
  }, { AI_RESEARCH_QUEUE_ENABLED: "1" });
  assert.equal(r.processed, 0);
  assert.equal(d.prepare("SELECT result_json FROM ai_research_queue").get().result_json, null, "no fabricated analysis");
});
