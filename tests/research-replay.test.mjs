import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { replayStockPure, experimentIdFor, runStockReplayOnDb, recordInactiveOptionsReplayOnDb, runHistoricalReplay, defaultReplayConfig } from "../lib/research/historical-replay.ts";
import { replayCapabilities, stockReplayAvailable, optionsReplayBlocker } from "../lib/research/replay-provider.ts";

function db() {
  const d = new Database(":memory:");
  const ddl = `
    CREATE TABLE IF NOT EXISTS replay_runs (run_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, asset_class TEXT NOT NULL, symbols_json TEXT NOT NULL, date_from TEXT NOT NULL, date_to TEXT NOT NULL, timespan TEXT NOT NULL, strategy_version INTEGER NOT NULL, config_json TEXT, status TEXT NOT NULL, checkpoint_json TEXT, provider_calls INTEGER NOT NULL DEFAULT 0, provider_call_budget INTEGER NOT NULL DEFAULT 0, provider_limitations TEXT, error TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS replay_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, experiment_id TEXT NOT NULL, symbol TEXT NOT NULL, asset_class TEXT NOT NULL, strategy_version INTEGER, kind TEXT NOT NULL, entry_ts_ms INTEGER, exit_ts_ms INTEGER, entry_price REAL, exit_price REAL, return_pct REAL, mfe_pct REAL, mae_pct REAL, bars_used INTEGER, slippage_bps REAL, fees REAL, exit_reason TEXT, note TEXT, created_at_ms INTEGER NOT NULL, UNIQUE(run_id, symbol, entry_ts_ms));`;
  d.exec(ddl); d.exec(ddl); // repeat-safe
  return d;
}

// A signal at bar 1 (+2%), next-bar entry at bar 2, target hit at bar 3.
const bars = [
  { t: 0, o: 100, h: 100, l: 100, c: 100 },
  { t: 1, o: 100, h: 102, l: 100, c: 102 },
  { t: 2, o: 102, h: 103, l: 101, c: 102 },
  { t: 3, o: 102, h: 111, l: 102, c: 110 },
];

test("pure replay: next-bar entry, deterministic target exit", () => {
  const t = replayStockPure("X", bars);
  assert.equal(t.length, 1);
  assert.equal(t[0].exitReason, "target");
  assert.equal(t[0].entryTsMs, 2, "entry is the NEXT bar after the signal");
  assert.equal(t[0].exitTsMs, 3);
  assert.ok(t[0].returnPct > 7 && t[0].returnPct < 9);
});

test("NO LOOK-AHEAD: future bars after the exit never change a closed trade", () => {
  const base = replayStockPure("X", bars);
  const withFuture = replayStockPure("X", [...bars, { t: 4, o: 200, h: 999, l: 1, c: 250 }, { t: 5, o: 1, h: 1, l: 1, c: 1 }]);
  assert.deepEqual(withFuture[0], base[0], "the first trade is identical regardless of later bars");
  const truncated = replayStockPure("X", bars.slice(0, 4));
  assert.deepEqual(truncated[0], base[0], "truncating at the exit bar yields the same trade");
});

test("replay is deterministic (same input → same output)", () => {
  assert.deepEqual(replayStockPure("X", bars), replayStockPure("X", bars));
});

test("experiment ids are reproducible and symbol-order-independent; config changes the id", () => {
  const a = experimentIdFor({ symbols: ["A", "B"], from: "2026-01-01", to: "2026-01-02", timespan: "minute", strategyVersion: 1, config: defaultReplayConfig() });
  const b = experimentIdFor({ symbols: ["B", "A"], from: "2026-01-01", to: "2026-01-02", timespan: "minute", strategyVersion: 1, config: defaultReplayConfig() });
  assert.equal(a, b, "symbol order does not change the id");
  const c = experimentIdFor({ symbols: ["A", "B"], from: "2026-01-01", to: "2026-01-02", timespan: "minute", strategyVersion: 1, config: { ...defaultReplayConfig(), stopPct: 3 } });
  assert.notEqual(a, c, "a config change yields a new id");
});

test("checkpoint/resume: re-running a completed run produces NO duplicate outcomes", () => {
  const d = db();
  const opts = { runId: "r1", symbolBars: { X: bars }, from: "2026-01-01", to: "2026-01-02", timespan: "minute", strategyVersion: 1, nowMs: 1 };
  const a = runStockReplayOnDb(d, opts);
  assert.equal(a.outcomes, 1);
  const n1 = d.prepare("SELECT COUNT(*) n FROM replay_outcomes").get().n;
  const b = runStockReplayOnDb(d, { ...opts, nowMs: 2 });
  assert.equal(b.outcomes, 0, "already-done symbol is skipped on resume");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM replay_outcomes").get().n, n1, "no duplicate rows");
  assert.match(d.prepare("SELECT checkpoint_json c FROM replay_runs WHERE run_id='r1'").get().c, /"X"/);
  assert.equal(d.prepare("SELECT status s FROM replay_runs WHERE run_id='r1'").get().s, "COMPLETED");
});

test("stock outcomes are recorded as executable simulations", () => {
  const d = db();
  runStockReplayOnDb(d, { runId: "r1", symbolBars: { X: bars }, from: "a", to: "b", timespan: "minute", strategyVersion: 1, nowMs: 1 });
  assert.equal(d.prepare("SELECT kind k FROM replay_outcomes LIMIT 1").get().k, "executable_stock");
});

// ── options honesty ──────────────────────────────────────────────────────────
test("options replay is INACTIVE_MISSING_PROVIDER and fabricates nothing", () => {
  const d = db();
  const r = recordInactiveOptionsReplayOnDb(d, { runId: "o1", symbols: ["NVDA"], from: "a", to: "b", timespan: "minute", strategyVersion: 1, nowMs: 1 });
  assert.equal(r.status, "INACTIVE_MISSING_PROVIDER");
  const row = d.prepare("SELECT status, provider_limitations FROM replay_runs WHERE run_id='o1'").get();
  assert.equal(row.status, "INACTIVE_MISSING_PROVIDER");
  assert.match(row.provider_limitations, /historical option/i);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM replay_outcomes WHERE run_id='o1'").get().n, 0, "no fabricated option outcomes");
});

test("capability report: stock available with a key; options never entitled (no greeks/nbbo)", () => {
  const caps = replayCapabilities({ POLYGON_API_KEY: "k" });
  const stock = caps.find((c) => c.assetClass === "stock");
  const option = caps.find((c) => c.assetClass === "option");
  assert.equal(stock.status, "AVAILABLE");
  assert.equal(stockReplayAvailable({ POLYGON_API_KEY: "k" }), true);
  assert.equal(stockReplayAvailable({}), false, "no key → stock replay unavailable (never faked)");
  assert.equal(option.status, "INACTIVE_MISSING_PROVIDER");
  for (const f of ["historical_delta", "historical_open_interest", "historical_bid", "historical_iv"]) {
    assert.ok(option.missingFields.includes(f), `${f} must be listed as missing, never fabricated`);
  }
  assert.match(optionsReplayBlocker(), /historical option/i);
});

test("SAFETY: the replay driver is a hard no-op when HISTORICAL_REPLAY_ENABLED is off", async () => {
  const res = await runHistoricalReplay({ assetClass: "stock", symbols: ["NVDA"], from: "a", to: "b" }, {});
  assert.equal(res.status, "SKIPPED");
  assert.match(res.skippedReason, /HISTORICAL_REPLAY_ENABLED/);
});
