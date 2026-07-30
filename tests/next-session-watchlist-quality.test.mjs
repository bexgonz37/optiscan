import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildNextSessionPlan, persistOvernightPlan } from "../lib/research/overnight/next-session-plan.ts";
import { formatEodWatchlist } from "../lib/notifications/owner-research-notify.ts";

function db() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE alerts (
      ticker TEXT, direction TEXT, option_side TEXT, alert_type TEXT,
      price_at_alert REAL, vwap_at_alert REAL, signal_score REAL, capture_confidence REAL,
      relative_volume REAL, percent_move_at_alert REAL, catalyst_summary TEXT, catalyst_type TEXT,
      public_explanation TEXT, alert_time TEXT, trading_day TEXT, created_at TEXT, asset_class TEXT
    );
    CREATE TABLE market_context_snapshots (
      spy_trend TEXT, qqq_trend TEXT, freshness TEXT, created_at_ms INTEGER
    );
  `);
  return database;
}

function insertAlert(database, symbol, overrides = {}) {
  database.prepare(`INSERT INTO alerts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    symbol, "bullish", "call", "vwap_reclaim", 177.2, 176.1, 78, 76, 1.8, 1.4,
    null, null, `${symbol} reclaimed VWAP and closed near resistance with rising momentum.`,
    "2026-07-28T19:55:00.000Z", "2026-07-28", "2026-07-28T19:55:01.000Z", "options",
    ...[],
  );
  const fields = Object.entries(overrides);
  if (fields.length) database.prepare(`UPDATE alerts SET ${fields.map(([key]) => `${key}=?`).join(",")} WHERE ticker=?`).run(...fields.map(([, value]) => value), symbol);
}

test("generic delivery-history fallback is never published", () => {
  const database = db();
  database.exec(`CREATE TABLE options_delivery_decisions (symbol TEXT, side TEXT, strategy TEXT, quality REAL);`);
  database.prepare(`INSERT INTO options_delivery_decisions VALUES ('SPY','call','structure_watch',0.55)`).run();
  const plan = buildNextSessionPlan(database, Date.parse("2026-07-28T22:00:00.000Z"));
  assert.equal(plan.recommendations.length, 0);
  assert.doesNotMatch(formatEodWatchlist(plan), /VERIFY AT OPEN|structure_watch|confidence 55/i);
  database.exec(`CREATE TABLE overnight_watchlist (trading_day TEXT, symbol TEXT, payload_json TEXT, rank INTEGER, plan_version TEXT, built_at_ms INTEGER, PRIMARY KEY(trading_day, symbol));`);
  database.prepare(`INSERT INTO overnight_watchlist VALUES (?,'SPY','{}',1,'old',1)`).run(plan.tradingDay);
  persistOvernightPlan(database, plan);
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM overnight_watchlist WHERE trading_day=?`).get(plan.tradingDay).n, 0);
});

test("missing trigger or invalidation stays out of the published plan", () => {
  const database = db();
  database.prepare(`INSERT INTO market_context_snapshots VALUES ('bullish','bullish','fresh',1)`).run();
  insertAlert(database, "SPY", { price_at_alert: null });
  insertAlert(database, "QQQ", { vwap_at_alert: null });
  const plan = buildNextSessionPlan(database, Date.parse("2026-07-28T22:00:00.000Z"));
  assert.equal(plan.recommendations.length, 0);
  assert.equal(plan.needsMoreData.length, 2);
  assert.ok(plan.needsMoreData.every((row) => row.planStatus === "INSUFFICIENT_DATA"));
});

test("evidence-backed rows rank independently and render real levels", () => {
  const database = db();
  database.prepare(`INSERT INTO market_context_snapshots VALUES ('bullish','bullish','fresh',1)`).run();
  insertAlert(database, "NVDA", { signal_score: 91, price_at_alert: 177.2, vwap_at_alert: 175.8 });
  insertAlert(database, "META", { signal_score: 64, price_at_alert: 512.4, vwap_at_alert: 506.1 });
  const plan = buildNextSessionPlan(database, Date.parse("2026-07-28T22:00:00.000Z"));
  assert.equal(plan.recommendations.length, 2);
  assert.equal(plan.recommendations[0].symbol, "NVDA");
  assert.notEqual(plan.recommendations[0].thesisScore, plan.recommendations[1].thesisScore);
  const message = formatEodWatchlist(plan);
  assert.match(message, /Hold above \$177\.20/);
  assert.match(message, /Lose VWAP near \$175\.80/);
  assert.match(message, /No confirmed catalyst/);
  assert.doesNotMatch(message, /O:|exact contract/i);
});

test("no qualified rows produces one clean empty-state message", () => {
  const message = formatEodWatchlist({
    tradingDay: "2026-07-28", builtAtMs: 1, planVersion: "test", recommendations: [], needsMoreData: [], omitted: [],
    marketContext: { spyNote: "Market context unavailable", qqqNote: "Market context unavailable", newsNote: "No confirmed catalyst" },
  });
  assert.match(message, /No qualified setups yet/);
  assert.doesNotMatch(message, /VERIFY AT OPEN|structure_watch/i);
});

test("published Watchlist is capped at five qualified symbols", () => {
  const database = db();
  database.prepare(`INSERT INTO market_context_snapshots VALUES ('bullish','bullish','fresh',1)`).run();
  for (const [index, symbol] of ["SPY", "QQQ", "NVDA", "META", "AMD", "AVGO"].entries()) insertAlert(database, symbol, { signal_score: 70 + index });
  const plan = buildNextSessionPlan(database, Date.parse("2026-07-28T22:00:00.000Z"));
  assert.equal(plan.recommendations.length, 5);
  assert.equal((formatEodWatchlist(plan).match(/^#\d/gm) ?? []).length, 5);
});
