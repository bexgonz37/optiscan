import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  gradeShadowOutcomesOnDb,
  upsertShadowOutcomeFromDecision,
  assertShadowGraderIsolation,
} from "../lib/research/options/shadow-outcomes.ts";
import { evaluateShadowDecision, persistShadowDecision } from "../lib/research/options/shadow-runner.ts";

const BASE = `
CREATE TABLE options_shadow_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, trading_session_date TEXT, symbol TEXT, strategy TEXT, side TEXT,
  path TEXT, would_send INTEGER, entry_quality_verdict TEXT, session_guard_state TEXT, reasons_json TEXT,
  metrics_json TEXT, alert_fingerprint TEXT, created_at_ms INTEGER, actual_action TEXT, would_allow_session INTEGER,
  block_reasons_json TEXT, entry_quality_dimensions_json TEXT, candidate_id INTEGER, actually_delivered INTEGER DEFAULT 0
);
CREATE TABLE options_shadow_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, shadow_decision_id INTEGER, candidate_symbol TEXT, strategy TEXT, side TEXT,
  trading_session_date TEXT, path TEXT, would_send INTEGER, option_symbol TEXT, frozen_entry REAL, frozen_t1 REAL,
  frozen_t2 REAL, frozen_stop REAL, underlying_at_decision REAL, option_at_decision REAL,
  bid_at_decision REAL, ask_at_decision REAL, spread_pct_at_decision REAL, dte_at_decision INTEGER,
  strike_at_decision REAL, expiration_at_decision TEXT, quality_score REAL, block_reasons_json TEXT,
  entry_quality_verdict TEXT, entry_quality_dimensions_json TEXT, session_guard_state TEXT, decision_at_ms INTEGER,
  return_1m REAL, return_5m REAL, return_15m REAL, return_30m REAL, return_60m REAL,
  underlying_return_1m REAL, underlying_return_5m REAL, underlying_return_15m REAL, underlying_return_30m REAL, underlying_return_60m REAL,
  option_return_1m REAL, option_return_5m REAL, option_return_15m REAL, option_return_30m REAL, option_return_60m REAL,
  mfe_pct REAL, mae_pct REAL, mfe_at_ms INTEGER, mae_at_ms INTEGER, t1_hit INTEGER, t2_hit INTEGER, stop_hit INTEGER,
  underlying_direction_correct INTEGER, missing_data_reason TEXT, final_result TEXT, data_status TEXT,
  marks_json TEXT, created_at_ms INTEGER, updated_at_ms INTEGER
);
`;

const deliveryInput = {
  candidateSymbol: "NVDA",
  strategy: "sr_reclaim",
  researchOnly: false,
  contract: { optionSymbol: "O:NVDA260725C00100000", side: "call", strike: 100, expiration: "2026-07-27", dte: 1, bid: 1, ask: 1.1, spreadPct: 4, quoteAgeMs: 500 },
  message: "x",
  observedUnderlyingPrice: 100,
  currentUnderlyingPrice: 100,
  chaseLimitPct: 5,
  underlyingPrice: 100,
  entry: { mid: 1.05, t1: 1.2, t2: 1.3, stop: 0.9, methodology: "test" },
};

test("horizon freeze uses first valid mark at/after horizon — never late backfill", async () => {
  const d = new Database(":memory:");
  d.exec(BASE);
  const t0 = Date.UTC(2026, 6, 21, 14, 30);
  const input = { path: "proposed", symbol: "NVDA", strategy: "sr_reclaim", side: "call", deliveryInput, nowMs: t0 };
  const result = evaluateShadowDecision(input, { SUBSCRIBER_SHADOW_MODE: "1", MARKET_SESSION_GUARD: "shadow", ENTRY_QUALITY_GATE: "shadow" });
  const sid = persistShadowDecision(d, input, result, { SUBSCRIBER_SHADOW_MODE: "1" });
  assert.ok(sid);

  let mark = 1.05;
  let underlying = 100;
  const deps = {
    fetchOptionQuote: async () => ({ bid: mark - 0.02, ask: mark + 0.02, quoteAgeMs: 100 }),
    fetchUnderlying: async () => underlying,
    now: () => t0 + 5 * 60_000,
  };

  await gradeShadowOutcomesOnDb(d, deps, { MARKET_SESSION_GUARD: "shadow" }, t0 + 30_000);
  const row1 = d.prepare("SELECT return_5m, return_1m FROM options_shadow_outcomes").get();
  assert.equal(row1.return_5m, null, "5m not frozen before horizon");
  assert.equal(row1.return_1m, null, "1m not frozen before 1m age");

  await gradeShadowOutcomesOnDb(d, deps, { MARKET_SESSION_GUARD: "shadow" }, t0 + 65_000);
  const row2 = d.prepare("SELECT return_1m, option_return_1m FROM options_shadow_outcomes").get();
  assert.equal(row2.return_1m, 0);
  assert.equal(row2.option_return_1m, 0);

  await gradeShadowOutcomesOnDb(d, deps, { MARKET_SESSION_GUARD: "shadow" }, t0 + 5 * 60_000 + 1000);
  const row25 = d.prepare("SELECT return_5m FROM options_shadow_outcomes").get();
  assert.equal(row25.return_5m, 0, "5m frozen at first valid mark after horizon");

  mark = 1.26;
  underlying = 110;
  await gradeShadowOutcomesOnDb(d, deps, { MARKET_SESSION_GUARD: "shadow" }, t0 + 10 * 60_000);
  const row3 = d.prepare("SELECT return_1m, return_5m, underlying_return_5m FROM options_shadow_outcomes").get();
  assert.equal(row3.return_1m, 0, "1m frozen value must not be overwritten by later tick");
  assert.equal(row3.return_5m, 0, "5m frozen value must not be overwritten by later tick");
  assert.equal(row3.underlying_return_5m, 0);
});

test("5m horizon captures first high mark at horizon crossing", async () => {
  const d = new Database(":memory:");
  d.exec(BASE);
  const t0 = Date.UTC(2026, 6, 21, 14, 30);
  upsertShadowOutcomeFromDecision(d, 1, { path: "independent", symbol: "NVDA", strategy: "x", side: "call", deliveryInput, nowMs: t0 }, { wouldSend: true, sessionState: "regular", reasons: [], blockReasons: [], actualAction: "WOULD_SEND", wouldAllowSession: true }, {});
  d.prepare("UPDATE options_shadow_outcomes SET shadow_decision_id=1, path='independent' WHERE id=1").run();
  const deps = {
    fetchOptionQuote: async () => ({ bid: 1.24, ask: 1.28, quoteAgeMs: 100 }),
    fetchUnderlying: async () => 110,
  };
  await gradeShadowOutcomesOnDb(d, deps, { MARKET_SESSION_GUARD: "shadow" }, t0 + 5 * 60_000 + 1000);
  const row = d.prepare("SELECT return_5m, underlying_return_5m FROM options_shadow_outcomes").get();
  assert.ok(Math.abs(row.return_5m - 20) < 0.01);
  assert.ok(Math.abs(row.underlying_return_5m - 10) < 0.01);
});

test("closed session labels SESSION_CLOSED — never fabricates 0% returns", async () => {
  const d = new Database(":memory:");
  d.exec(BASE);
  const t0 = Date.UTC(2026, 6, 26, 14, 30); // Saturday — closed under enforce guard
  upsertShadowOutcomeFromDecision(d, 1, { path: "independent", symbol: "NVDA", strategy: "x", side: "call", deliveryInput, nowMs: t0 }, { wouldSend: true, sessionState: "regular", reasons: [], blockReasons: [], actualAction: "WOULD_SEND", wouldAllowSession: true }, {});
  d.prepare("UPDATE options_shadow_outcomes SET shadow_decision_id=1 WHERE id=1").run();

  await gradeShadowOutcomesOnDb(d, {
    fetchOptionQuote: async () => ({ bid: 1, ask: 1.1, quoteAgeMs: 100 }),
    fetchUnderlying: async () => 100,
    now: () => t0 + 70 * 60_000,
  }, { MARKET_SESSION_GUARD: "enforce" }, t0 + 70 * 60_000);

  const row = d.prepare("SELECT data_status, missing_data_reason, return_60m FROM options_shadow_outcomes").get();
  assert.equal(row.data_status, "SESSION_CLOSED");
  assert.equal(row.missing_data_reason, "SESSION_CLOSED");
  assert.equal(row.return_60m, null);
});

test("quota guard skips supervisor-only rows without option_symbol", async () => {
  const d = new Database(":memory:");
  d.exec(BASE);
  const t0 = Date.UTC(2026, 6, 21, 14, 30);
  d.prepare(`INSERT INTO options_shadow_outcomes (
    shadow_decision_id, candidate_symbol, trading_session_date, path, would_send, decision_at_ms, data_status, created_at_ms, updated_at_ms
  ) VALUES (1,'NVDA','2026-07-21','supervisor',0,?, 'PENDING', ?, ?)`).run(t0, t0, t0);

  const out = await gradeShadowOutcomesOnDb(d, {
    fetchOptionQuote: async () => ({ bid: 1, ask: 1.1, quoteAgeMs: 100 }),
    now: () => t0 + 70 * 60_000,
  }, { MARKET_SESSION_GUARD: "shadow", SHADOW_OUTCOME_GRADE_MAX_ROWS: "5" }, t0 + 70 * 60_000);
  assert.equal(out.updated, 0);
  assert.equal(out.skipped, 0);
});

test("shadow grader isolation — no live subscriber tables required", () => {
  const d = new Database(":memory:");
  d.exec(BASE);
  const iso = assertShadowGraderIsolation(d);
  assert.equal(iso.ok, true);
});

test("MFE/MAE monotonic and restart-safe", async () => {
  const d = new Database(":memory:");
  d.exec(BASE);
  const t0 = Date.UTC(2026, 6, 21, 14, 30);
  upsertShadowOutcomeFromDecision(d, 1, { path: "proposed", symbol: "NVDA", strategy: "x", side: "call", deliveryInput, nowMs: t0 }, { wouldSend: false, sessionState: "regular", reasons: [], blockReasons: ["late"], actualAction: "WOULD_BLOCK", wouldAllowSession: true }, {});
  d.prepare("UPDATE options_shadow_outcomes SET shadow_decision_id=1 WHERE id=1").run();

  let mark = 1.05;
  const deps = {
    fetchOptionQuote: async () => ({ bid: mark - 0.01, ask: mark + 0.01, quoteAgeMs: 50 }),
    fetchUnderlying: async () => 100,
  };

  await gradeShadowOutcomesOnDb(d, deps, { MARKET_SESSION_GUARD: "shadow" }, t0 + 2 * 60_000);
  mark = 1.2;
  await gradeShadowOutcomesOnDb(d, deps, { MARKET_SESSION_GUARD: "shadow" }, t0 + 3 * 60_000);
  mark = 0.95;
  await gradeShadowOutcomesOnDb(d, deps, { MARKET_SESSION_GUARD: "shadow" }, t0 + 4 * 60_000);

  const row = d.prepare("SELECT mfe_pct, mae_pct, mfe_at_ms, mae_at_ms FROM options_shadow_outcomes").get();
  assert.ok(row.mfe_pct > 10);
  assert.ok(row.mae_pct < 0);
  assert.ok(row.mfe_at_ms > t0);
  assert.ok(row.mae_at_ms > t0);
});
