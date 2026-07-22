import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { startOptionsMonitor, stopOptionsMonitor, runOptionsMonitorCycle, optionsMonitorMetrics, __resetOptionsMonitorForTest } from "../lib/research/options/monitor.ts";
import { decideOptionExit, gradeOpenOptionPositionsOnDb, readGradingBacklogOnDb, startOptionsGrader, optionsGraderState, __resetOptionsGraderForTest, defaultGradeConfig } from "../lib/research/options/grade.ts";
import { runOptionsSelfCheck, persistHeartbeatOnDb, readRuntimeStatusOnDb } from "../lib/research/options/runtime.ts";
import { buildDailySummaryOnDb, formatDailySummaryMessage, maybeSendDailySummary } from "../lib/research/options/daily-summary.ts";
import { deliverOptionsCallout } from "../lib/research/options/delivery.ts";
import { canOpenRealOptionPaper } from "../lib/research/options/paper.ts";
import { optionsTier1 } from "../lib/research/options/discovery.ts";
import { marketSession, isMarketHoliday } from "../lib/trading-session.ts";

const NOW = 1_700_000_000_000;
function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT, feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT, experiment_id TEXT, experiment_variant TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE VIEW IF NOT EXISTS options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
          CREATE VIEW IF NOT EXISTS options_paper_research AS SELECT * FROM options_paper_trades WHERE paper_kind='RESEARCH_ONLY_PAPER';
          CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT, delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0, discord_status INTEGER, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT, attempted_at_ms INTEGER, sent_at_ms INTEGER, session_state TEXT, entry_mid REAL, delivered_spread_pct REAL, quote_ts_ms INTEGER, target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE TABLE options_runtime (key TEXT PRIMARY KEY, value TEXT, updated_at_ms INTEGER NOT NULL);`);
  return d;
}
function makeBars(n, lastAgeMs) {
  const out = [];
  for (let i = 0; i < n; i++) { const t = NOW - lastAgeMs - (n - 1 - i) * 60_000; const base = 100 + (i > n - 6 ? (i - (n - 6)) * 0.2 : 0); out.push({ t, o: base, h: base + 0.05, l: base - 0.05, c: base, v: i > n - 6 ? 6000 : 1000 }); }
  return out;
}
const ON = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1" };
const monDeps = (d, getBars, session = "regular") => ({ now: () => NOW, session: () => session, getDb: () => d, getUnderlyingBatch: async (syms) => new Map(syms.map((s) => [s, { price: 100, dayDollarVolume: 60_000_000, relVolume: null, velPct: null, accelPct: null, gapPct: null, aboveVwap: null, hodBreak: null, nearResistancePct: null, compressionPct: null, realizedVolExpanding: null, openingRange: null, premarketLevelTest: null }])), getBars, getChain: async () => [] });
function openPos(d, over = {}) {
  const p = { option_symbol: "O:NVDA260117C00100000", side: "call", strike: 100, expiration: "2026-01-17", dte: 5, result_class: "REAL_OPTION_PAPER", entry_fill: 2.0, status: "ENTERED", strategy: "momentum_acceleration", entered_at_ms: NOW, ...over };
  d.prepare("INSERT INTO options_paper_trades (option_symbol, side, strike, expiration, dte, result_class, entry_fill, strategy, status, entered_at_ms, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(p.option_symbol, p.side, p.strike, p.expiration, p.dte, p.result_class, p.entry_fill, p.strategy, p.status, p.entered_at_ms, NOW, NOW);
  return d.prepare("SELECT id FROM options_paper_trades ORDER BY id DESC LIMIT 1").get().id;
}

// ── 1. service boot starts the monitor automatically (gated) ──
test("1. boot starts the monitor automatically when the flag is ON (singleton)", () => {
  __resetOptionsMonitorForTest();
  const r1 = startOptionsMonitor(monDeps(db(), async () => makeBars(40, 60_000)), ON);
  assert.equal(r1.started, true);
  const r2 = startOptionsMonitor(monDeps(db(), async () => makeBars(40, 60_000)), ON);
  assert.match(r2.reason, /already running/, "only one instance runs");
  stopOptionsMonitor();
});

// ── 2. no manual endpoint call needed: a cycle scans + a grader tick grades, both in-process ──
test("2. scanning and grading run in-process — no HTTP/endpoint call required", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  await runOptionsMonitorCycle(1, ["NVDA", "TSLA"], monDeps(d, async () => makeBars(40, 60_000)), ON);
  assert.ok(optionsMonitorMetrics().symbolsScanned >= 2, "cycle scanned without any endpoint call");
  const id = openPos(d);
  const res = await gradeOpenOptionPositionsOnDb(d, { now: () => NOW + 10 * 60_000, getQuote: async () => ({ bid: 5.0, ask: 5.2, quoteAgeMs: 1000 }) }, ON);
  assert.equal(res.graded, 1, "grader closed the winner with no endpoint call");
  assert.equal(d.prepare("SELECT status FROM options_paper_trades WHERE id=?").get(id).status, "EXITED");
});

// ── 3. market-open transition resumes fresh evaluation automatically ──
test("3. stale (closed) → fresh (open) transition changes evaluation automatically", async () => {
  __resetOptionsMonitorForTest();
  await runOptionsMonitorCycle(1, ["NVDA"], monDeps(db(), async () => makeBars(40, 30 * 60_000), "afterhours"), ON);
  assert.equal(optionsMonitorMetrics().distributions.vwapDistPct.n, 0, "closed/stale ⇒ no evaluation");
  __resetOptionsMonitorForTest();
  await runOptionsMonitorCycle(1, ["NVDA"], monDeps(db(), async () => makeBars(40, 60_000), "regular"), ON);
  assert.ok(optionsMonitorMetrics().distributions.vwapDistPct.n >= 1, "fresh bars ⇒ live evaluation resumes automatically");
});

// ── 4. weekend/holiday behavior is safe ──
test("4. weekend + holiday are 'closed' and a cycle in a closed session is a safe no-candidate no-op", async () => {
  const sat = Date.parse("2026-07-18T15:00:00Z"); // Saturday
  assert.equal(marketSession(sat), "closed");
  assert.equal(isMarketHoliday("2026-01-01"), true);
  __resetOptionsMonitorForTest();
  const d = db();
  await assert.doesNotReject(runOptionsMonitorCycle(1, ["NVDA"], monDeps(d, async () => makeBars(40, 30 * 60_000), "closed"), ON));
  assert.equal(optionsMonitorMetrics().candidatesCreated, 0);
});

// ── 5. restart preserves dedup and avoids duplicate alerts/trades ──
test("5. dedup is DB-based → survives a restart (no duplicate alert, no duplicate paper trade)", async () => {
  const d = db();
  let sends = 0;
  const send = async () => { sends += 1; return { ok: true, status: 204, messageId: "m1", latencyMs: 5, ambiguous: false, error: null }; };
  const input = { candidateSymbol: "NVDA", strategy: "momentum_acceleration", researchOnly: false, contract: { optionSymbol: "O:NVDA260117C00100000", side: "call", strike: 100, expiration: "2026-01-17", bid: 1.0, ask: 1.1, spreadPct: 5, quoteAgeMs: 1000 }, message: "buy", observedUnderlyingPrice: 100, currentUnderlyingPrice: 100, chaseLimitPct: 5, underlyingPrice: 100 };
  const env = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", EARLY_OPTIONS_CALLOUTS_ENABLED: "1" };
  const first = await deliverOptionsCallout(input, { getDb: () => d, send, now: () => NOW }, env);
  assert.equal(first.state, "SENT");
  // simulate a RESTART: the delivery module holds no in-memory state; a fresh call hits the same DB.
  const second = await deliverOptionsCallout(input, { getDb: () => d, send, now: () => NOW }, env);
  assert.equal(second.sent, false);
  assert.match(second.reason, /duplicate/);
  assert.equal(sends, 1, "webhook was called exactly once across the 'restart'");
  assert.equal(Number(d.prepare("SELECT COUNT(*) n FROM options_alerts").get().n), 1);
  // paper dedup is likewise DB-based
  openPos(d, { entered_at_ms: NOW });
  const gate = canOpenRealOptionPaper(d, { optionSymbol: "O:NVDA260117C00100000", strategy: "momentum_acceleration", nowMs: NOW }, { bucketMs: 60_000, maxConcurrent: 20, maxPerSymbol: 2 });
  assert.equal(gate.ok, false, "same contract+strategy in the bucket is not re-opened after restart");
});

// ── 6. open paper positions continue grading after a restart ──
test("6. grading resumes from the DB after a grader restart (no in-memory dependency)", async () => {
  __resetOptionsGraderForTest(); // simulate a fresh process with empty grader memory
  const d = db();
  const id = openPos(d, { entered_at_ms: NOW - 3 * 24 * 3_600_000, expiration: "2026-01-17" }); // old, past a 2-day time-stop
  const res = await gradeOpenOptionPositionsOnDb(d, { now: () => NOW, getQuote: async () => ({ bid: 2.5, ask: 2.6, quoteAgeMs: 1000 }) }, ON);
  assert.equal(res.graded, 1);
  const row = d.prepare("SELECT status, exit_reason FROM options_paper_trades WHERE id=?").get(id);
  assert.equal(row.status, "EXITED");
  assert.ok(["time_stop", "target_hit"].includes(row.exit_reason));
});

// ── 7. temporary provider failure recovers automatically ──
test("7a. a provider failure on the batch is isolated; the next cycle recovers", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  let calls = 0;
  const flaky = { ...monDeps(d, async () => makeBars(40, 60_000)), getUnderlyingBatch: async (syms) => { calls += 1; if (calls === 1) throw new Error("provider 503"); return new Map(syms.map((s) => [s, { price: 100, dayDollarVolume: 60_000_000, relVolume: null, velPct: null, accelPct: null, gapPct: null, aboveVwap: null, hodBreak: null, nearResistancePct: null, compressionPct: null, realizedVolExpanding: null, openingRange: null, premarketLevelTest: null }])); } };
  await assert.doesNotReject(runOptionsMonitorCycle(1, ["NVDA"], flaky, ON));
  assert.ok(optionsMonitorMetrics().providerFailures >= 1);
  await runOptionsMonitorCycle(1, ["NVDA"], flaky, ON); // recovers
  assert.ok(optionsMonitorMetrics().symbolsScanned >= 1);
});
test("7b. a per-contract quote failure is isolated; other positions still grade", async () => {
  const d = db();
  const good = openPos(d, { option_symbol: "O:AAPL260117C00200000", expiration: "2026-01-17", entered_at_ms: NOW });
  openPos(d, { option_symbol: "O:TSLA260117C00300000", expiration: "2026-01-17", entered_at_ms: NOW });
  const res = await gradeOpenOptionPositionsOnDb(d, { now: () => NOW + 60_000, getQuote: async (sym) => { if (sym.includes("TSLA")) throw new Error("quote 500"); return { bid: 5.0, ask: 5.2, quoteAgeMs: 1000 }; } }, ON);
  assert.equal(res.errors, 1, "one contract errored");
  assert.equal(res.graded, 1, "the healthy contract still graded");
  assert.equal(d.prepare("SELECT status FROM options_paper_trades WHERE id=?").get(good).status, "EXITED");
});

// ── 8. Discord failure does not stop monitoring ──
test("8. a Discord send failure never throws into the monitor", async () => {
  const d = db();
  const input = { candidateSymbol: "NVDA", strategy: "momentum_acceleration", researchOnly: false, contract: { optionSymbol: "O:NVDA260117C00100000", side: "call", strike: 100, expiration: "2026-01-17", bid: 1.0, ask: 1.1, spreadPct: 5, quoteAgeMs: 1000 }, message: "buy", observedUnderlyingPrice: 100, currentUnderlyingPrice: 100, chaseLimitPct: 5, underlyingPrice: 100 };
  const env = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", EARLY_OPTIONS_CALLOUTS_ENABLED: "1" };
  const out = await deliverOptionsCallout(input, { getDb: () => d, send: async () => ({ ok: false, status: 500, messageId: null, latencyMs: 5, ambiguous: false, error: "discord 500" }), now: () => NOW, maxRetries: 0 }, env);
  assert.equal(out.state, "SEND_FAILED");
  assert.equal(out.sent, false);
  __resetOptionsMonitorForTest();
  await assert.doesNotReject(runOptionsMonitorCycle(1, ["NVDA"], monDeps(d, async () => makeBars(40, 60_000)), ON), "monitor keeps running after a delivery failure");
});

// ── 9. disabled flags cause a clean no-op ──
test("9. every autonomous piece is a clean no-op when flags are OFF", async () => {
  __resetOptionsMonitorForTest(); __resetOptionsGraderForTest();
  assert.equal(startOptionsMonitor(monDeps(db(), async () => []), {}).started, false);
  assert.equal(startOptionsGrader({ getDb: () => db(), getQuote: async () => null }, {}).started, false);
  assert.equal((await maybeSendDailySummary({ getDb: () => db() }, {})).reason, "disabled");
  assert.equal(buildDailySummaryOnDb(db(), NOW, {}), null, "disabled + no activity ⇒ null (no summary)");
});

// ── 10. GET-endpoint read helpers are inspection-only (no writes, no work) ──
test("10. runtime/grading/read helpers do not mutate the DB or trigger work", () => {
  const d = db();
  openPos(d);
  persistHeartbeatOnDb(d, { session: "regular", running: true, breaker: "closed", lastTier1CycleMs: NOW, lastTier2CycleMs: null, symbolsScanned: 5, stage15Stale: 0, candidatesCreated: 1, stage2Chain: 1, providerFailures: 0, latestCandidateMs: NOW }, NOW);
  const before = d.prepare("SELECT COUNT(*) n FROM options_paper_trades").get().n;
  const rt = readRuntimeStatusOnDb(d, ON, NOW + 1000);
  const bl = readGradingBacklogOnDb(d);
  const after = d.prepare("SELECT COUNT(*) n FROM options_paper_trades").get().n;
  assert.equal(before, after, "reads never insert/exit a position");
  assert.equal(bl.openPositions, 1);
  assert.equal(rt.heartbeatFresh, true);
  assert.ok(rt.heartbeat && rt.heartbeat.running === true);
});

// ── grading exit-rule unit coverage ──
test("decideOptionExit: target / stop / expiration / time-stop / hold", () => {
  const cfg = defaultGradeConfig({});
  const base = { id: 1, option_symbol: "O:NVDA260117C00100000", side: "call", strike: 100, expiration: "2026-01-17", dte: 5, entry_fill: 2.0, result_class: "REAL_OPTION_PAPER", strategy: "x", underlying_price: 100, target: null, invalidation: null, entered_at_ms: NOW, status: "ENTERED" };
  assert.equal(decideOptionExit(base, { bid: 4.0, ask: 4.2, quoteAgeMs: 1000 }, NOW, cfg).reason, "target_hit");
  assert.equal(decideOptionExit(base, { bid: 1.0, ask: 1.1, quoteAgeMs: 1000 }, NOW, cfg).reason, "stop_hit");
  assert.equal(decideOptionExit(base, { bid: 2.1, ask: 2.2, quoteAgeMs: 1000 }, NOW, cfg).action, "hold");
  const expired = decideOptionExit({ ...base, expiration: "2026-01-16" }, null, Date.parse("2026-01-16T21:00:00Z"), cfg);
  assert.equal(expired.reason, "expiration_no_quote");
  assert.equal(expired.pnl, null, "expired with no quote is closed unpriced, not fabricated");
  const timed = decideOptionExit({ ...base, entered_at_ms: NOW - 3 * 24 * 3_600_000 }, { bid: 2.1, ask: 2.2, quoteAgeMs: 1000 }, NOW, cfg);
  assert.equal(timed.reason, "time_stop");
});

// ── self-check: fail-closed, secrets never exposed ──
test("self-check: required deps fail closed when enabled; secret values are never included", () => {
  const d = db();
  const missing = runOptionsSelfCheck({ INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1" }, d, NOW);
  assert.equal(missing.healthy, false);
  assert.ok(missing.blockers.includes("polygonApiKey"), "missing provider key is a blocker when enabled");
  const ok = runOptionsSelfCheck({ INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", POLYGON_API_KEY: "secret-abc" }, d, NOW);
  assert.equal(ok.healthy, true);
  assert.equal(JSON.stringify(ok).includes("secret-abc"), false, "the raw secret value is never surfaced");
  // disabled ⇒ clean, healthy no-op (no blockers)
  assert.equal(runOptionsSelfCheck({}, d, NOW).healthy, true);
});

// ── daily summary: built from DB, gated, deduped, not sent when disabled ──
test("daily summary: content from DB, sent once/day, suppressed when the system was disabled", async () => {
  const d = db();
  // some activity for the ET day of NOW
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(NOW));
  const dayStart = Date.parse(`${day}T04:00:00Z`) + 3_600_000;
  d.prepare("INSERT INTO options_candidates (symbol, side, selected_strategy, state, why, earliness_phase, created_at_ms) VALUES (?,?,?,?,?,?,?)").run("NVDA", "call", "momentum_acceleration", "READY", "ok", "early", dayStart);
  const s = buildDailySummaryOnDb(d, NOW, ON);
  assert.ok(s && s.candidatesFound === 1 && s.callsEvaluated === 1);
  assert.match(formatDailySummaryMessage(s), /daily summary/);
  let sends = 0;
  const send = async () => { sends += 1; return { ok: true, error: null }; };
  const now = () => Date.parse(`${day}T21:00:00Z`); // after 16:00 ET
  const first = await maybeSendDailySummary({ getDb: () => d, send, now }, { ...ON, OPTIONS_SUMMARY_HOUR_ET: "16" });
  assert.equal(first.sent, true);
  const second = await maybeSendDailySummary({ getDb: () => d, send, now }, { ...ON, OPTIONS_SUMMARY_HOUR_ET: "16" });
  assert.equal(second.reason, "already_sent_today");
  assert.equal(sends, 1, "exactly one summary per day");
  // disabled system with no activity ⇒ never sends
  assert.equal((await maybeSendDailySummary({ getDb: () => db(), send, now }, {})).reason, "disabled");
});
