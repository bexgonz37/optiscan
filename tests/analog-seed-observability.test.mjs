import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runReplaySeed } from "../lib/research/episode/seed.ts";

// ── in-memory schema (setup_episodes + episode_labels + replay_runs incl. new observability cols) ──
function db() {
  const d = new Database(":memory:");
  const ddl = `
    CREATE TABLE IF NOT EXISTS setup_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, episode_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL, symbol TEXT NOT NULL,
      t0_ms INTEGER NOT NULL, trading_day TEXT NOT NULL, session TEXT NOT NULL, tod_bucket TEXT, asset_class TEXT NOT NULL DEFAULT 'stock',
      direction TEXT, regime_label TEXT, regime_model_version INTEGER, liquidity_tier TEXT, validity_tier TEXT,
      price_structure_json TEXT, momentum_json TEXT, volume_json TEXT, volatility_json TEXT, regime_json TEXT, sector_json TEXT,
      breadth_json TEXT, options_context_json TEXT, catalyst_json TEXT, liquidity_json TEXT, data_quality_json TEXT, missing_json TEXT,
      gate_results_json TEXT, feature_schema_version INTEGER NOT NULL, max_feature_as_of_ms INTEGER NOT NULL, provenance_json TEXT, created_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS episode_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT, episode_key TEXT NOT NULL, horizon TEXT NOT NULL, target_kind TEXT NOT NULL, outcome_kind TEXT NOT NULL,
      return_pct REAL, mfe_pct REAL, mae_pct REAL, target_before_stop TEXT, time_to_target_ms INTEGER, time_to_invalidation_ms INTEGER,
      realized_vol REAL, gap_pct REAL, gap_filled INTEGER, model_assumptions_json TEXT, label_as_of_ms INTEGER NOT NULL, computed_at_ms INTEGER NOT NULL,
      UNIQUE(episode_key, horizon, target_kind));
    CREATE TABLE IF NOT EXISTS replay_runs (
      run_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, asset_class TEXT NOT NULL, symbols_json TEXT NOT NULL,
      date_from TEXT NOT NULL, date_to TEXT NOT NULL, timespan TEXT NOT NULL, strategy_version INTEGER NOT NULL, config_json TEXT,
      status TEXT NOT NULL, checkpoint_json TEXT, provider_calls INTEGER NOT NULL DEFAULT 0, provider_call_budget INTEGER NOT NULL DEFAULT 0,
      provider_limitations TEXT, error TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      provider_calls_attempted INTEGER NOT NULL DEFAULT 0, symbols_with_data INTEGER NOT NULL DEFAULT 0, per_symbol_json TEXT);`;
  d.exec(ddl); d.exec(ddl); // repeat-safe
  return d;
}

const ENABLED = { HISTORICAL_REPLAY_ENABLED: "1", EPISODE_CAPTURE_ENABLED: "1" };
const BASE = { symbols: ["AAA", "BBB", "CCC"], from: "2024-01-02", to: "2024-01-31", dryRun: false, rateLimitMs: 0, universeSource: "current_symbols", survivorshipBias: true };

// fake providers
const noProvider = async () => ({ bars: [], providerCalls: 0, succeeded: false, note: "stock replay INACTIVE — no provider key; no request issued" });
const providerError = async () => ({ bars: [], providerCalls: 1, succeeded: false, note: "provider error (no fabrication): polygon 403: NOT_AUTHORIZED" });
const emptyOk = async () => ({ bars: [], providerCalls: 1, succeeded: true, note: "provider OK but returned no bars for the requested range/timespan" });
const withBars = (bars) => async () => ({ bars, providerCalls: 1, succeeded: true, note: "real /v2/aggs OHLCV" });

function flatBars() {
  const base = Date.UTC(2024, 0, 2, 14, 30, 0), out = [];
  for (let i = 0; i < 180; i++) out.push({ t: base + i * 60_000, o: 100, h: 100, l: 100, c: 100, v: 1000 });
  return out;
}
function spikeBars() {
  const base = Date.UTC(2024, 0, 2, 14, 30, 0), out = [];
  for (let i = 0; i < 180; i++) {
    let c = 100, v = 1000;
    if (i >= 95 && i <= 115) { c = 100 + (i - 94) * 0.25; v = 6000; }
    else if (i > 115) { c = 100 + (115 - 94) * 0.25; }
    out.push({ t: base + i * 60_000, o: c, h: c, l: c, c, v });
  }
  return out;
}

// ── THE EXACT BUG: zero provider calls used to report ran:true / symbolsDone:3 / COMPLETED ──
test("EXACT BUG: zero provider calls is now a visible FAILED, not a misleading success", async () => {
  const d = db();
  const res = await runReplaySeed({ ...BASE }, ENABLED, { db: d, fetchBars: noProvider });
  assert.equal(res.ran, true, "the loop ran");
  assert.equal(res.ok, false, "but it did NOT succeed");
  assert.equal(res.status, "FAILED");
  assert.equal(res.providerCallsAttempted, 0);
  assert.equal(res.providerCallsSucceeded, 0);
  assert.equal(res.symbolsDone, 0, "symbolsDone no longer counts symbols with no fetched data");
  assert.equal(res.symbolsWithData, 0);
  assert.ok(res.perSymbol.every((s) => s.status === "NO_PROVIDER"), "every symbol flagged NO_PROVIDER");
  assert.match(res.error, /no provider calls/i);
  const row = d.prepare("SELECT status, provider_calls, provider_calls_attempted, symbols_with_data, error FROM replay_runs").get();
  assert.equal(row.status, "FAILED");
  assert.equal(row.provider_calls_attempted, 0);
  assert.equal(row.symbols_with_data, 0);
  assert.match(row.error, /no provider calls/i);
});

test("provider errors are SURFACED (not swallowed) → COMPLETED_NO_DATA with per-symbol reason", async () => {
  const d = db();
  const res = await runReplaySeed({ ...BASE }, ENABLED, { db: d, fetchBars: providerError });
  assert.equal(res.status, "COMPLETED_NO_DATA");
  assert.equal(res.providerCallsAttempted, 3);
  assert.equal(res.providerCallsSucceeded, 0);
  assert.equal(res.symbolsDone, 0);
  assert.ok(res.perSymbol.every((s) => s.status === "PROVIDER_ERROR"));
  assert.match(res.perSymbol[0].note, /403/);
  assert.match(res.error, /no bars/i);
});

test("successful fetch with NO candidates is COMPLETED (data arrived, just no setups)", async () => {
  const d = db();
  const res = await runReplaySeed({ ...BASE }, ENABLED, { db: d, fetchBars: withBars(flatBars()) });
  assert.equal(res.status, "COMPLETED");
  assert.equal(res.ok, true);
  assert.equal(res.symbolsWithData, 3);
  assert.equal(res.providerCallsSucceeded, 3);
  assert.equal(res.episodes, 0, "flat bars trigger no candidate moments — but that is still a real, complete fetch");
  assert.ok(res.perSymbol.every((s) => s.status === "OK"));
});

test("PARTIAL when some symbols return data and others do not", async () => {
  const d = db();
  const data = flatBars();
  const perSymbol = (sym) => (sym === "AAA" ? withBars(data)() : sym === "BBB" ? emptyOk() : providerError());
  const res = await runReplaySeed({ ...BASE }, ENABLED, { db: d, fetchBars: (sym) => perSymbol(sym) });
  assert.equal(res.status, "PARTIAL");
  assert.equal(res.symbolsWithData, 1);
  assert.equal(res.symbolsProcessed, 3);
  const byStatus = Object.fromEntries(res.perSymbol.map((s) => [s.symbol, s.status]));
  assert.deepEqual(byStatus, { AAA: "OK", BBB: "NO_DATA", CCC: "PROVIDER_ERROR" });
});

test("captures episodes on a real spike series and is idempotent", async () => {
  const d = db();
  const first = await runReplaySeed({ ...BASE, symbols: ["AAA"] }, ENABLED, { db: d, fetchBars: withBars(spikeBars()) });
  assert.equal(first.status, "COMPLETED");
  assert.ok(first.episodes > 0, "spike series produces at least one episode");
  const n1 = d.prepare("SELECT COUNT(*) n FROM setup_episodes").get().n;
  const second = await runReplaySeed({ ...BASE, symbols: ["AAA"] }, ENABLED, { db: d, fetchBars: withBars(spikeBars()) });
  assert.equal(second.episodes, 0, "re-run inserts no new episodes (idempotent)");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM setup_episodes").get().n, n1, "episode count is stable across re-runs");
});

test("diagnostic mode probes one symbol and writes NOTHING", async () => {
  const d = db();
  const res = await runReplaySeed({ ...BASE, diagnostic: true }, ENABLED, { db: d, fetchBars: withBars(spikeBars()) });
  assert.equal(res.status, "DIAGNOSTIC");
  assert.equal(res.diagnostic.symbol, "AAA");
  assert.equal(res.diagnostic.attempted, true);
  assert.equal(res.diagnostic.succeeded, true);
  assert.ok(res.diagnostic.barCount > 0);
  assert.ok(res.diagnostic.firstBarMs != null && res.diagnostic.lastBarMs != null);
  assert.equal(res.diagnostic.multiplier, 1, "diagnostic fetches 1-minute bars");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM replay_runs").get().n, 0, "no run row written");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM setup_episodes").get().n, 0, "no episodes written");
});

test("providerCallBudget caps attempts", async () => {
  const d = db();
  const res = await runReplaySeed({ ...BASE, providerCallBudget: 1 }, ENABLED, { db: d, fetchBars: withBars(flatBars()) });
  assert.equal(res.providerCallsAttempted, 1);
  assert.equal(res.symbolsProcessed, 1);
});

test("safety guards preserved: flags off and kill switch → SKIPPED, ok false", async () => {
  const off = await runReplaySeed({ ...BASE }, {}, { db: db(), fetchBars: withBars(flatBars()) });
  assert.equal(off.ran, false); assert.equal(off.ok, false); assert.equal(off.status, "SKIPPED");
  assert.match(off.skippedReason, /HISTORICAL_REPLAY_ENABLED.*EPISODE_CAPTURE_ENABLED/);
  const killed = await runReplaySeed({ ...BASE }, { ...ENABLED, EPISODE_SEED_KILL: "1" }, { db: db(), fetchBars: withBars(flatBars()) });
  assert.equal(killed.status, "SKIPPED");
  assert.match(killed.skippedReason, /kill switch/i);
});

test("dry-run writes nothing and reports DRY_RUN with an estimate", async () => {
  const d = db();
  const res = await runReplaySeed({ ...BASE, dryRun: true }, ENABLED, { db: d, fetchBars: withBars(flatBars()) });
  assert.equal(res.status, "DRY_RUN"); assert.equal(res.ran, false); assert.equal(res.ok, false);
  assert.ok(res.estimate && res.estimate.estProviderCalls >= 1);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM replay_runs").get().n, 0, "dry-run writes no run row");
});
