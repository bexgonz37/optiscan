import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { persistEpisodeOnDb, persistLabelOnDb, captureEpisodes } from "../lib/research/episode/store.ts";
import { episodeKeyOf } from "../lib/research/episode/schema.ts";

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
      UNIQUE(episode_key, horizon, target_kind));`;
  d.exec(ddl); d.exec(ddl); // repeat-safe
  return d;
}
const ep = (over = {}) => ({
  source: "replay", symbol: "nvda", t0Ms: 1000, tradingDay: "2026-07-10", session: "regular", todBucket: "open",
  assetClass: "stock", direction: "bullish", regimeLabel: "trend", regimeModelVersion: 1, liquidityTier: "high", validityTier: "PRODUCTION_QUALITY",
  blocks: { momentum: { asOfMs: 900, values: { v: 1 } } }, missing: [], gateResults: {}, featureSchemaVersion: 1, provenance: {}, ...over,
});
const label = (over = {}) => ({
  horizon: "1h", targetKind: "UNDERLYING", outcomeKind: "REAL_UNDERLYING", returnPct: 1.2, mfePct: 6, maePct: -2,
  targetBeforeStop: "TARGET", timeToTargetMs: 2000, timeToInvalidationMs: null, realizedVol: 0.01, gapPct: 0, gapFilled: true,
  modelAssumptions: null, labelAsOfMs: 4000, ...over,
});

test("episode persists and is idempotent", () => {
  const d = db();
  const r1 = persistEpisodeOnDb(d, ep(), 1);
  assert.equal(r1.ok, true); assert.equal(r1.inserted, true);
  const r2 = persistEpisodeOnDb(d, ep(), 2);
  assert.equal(r2.inserted, false, "same episode_key ignored (restart-safe)");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM setup_episodes").get().n, 1);
  const row = d.prepare("SELECT max_feature_as_of_ms, symbol FROM setup_episodes").get();
  assert.equal(row.max_feature_as_of_ms, 900);
  assert.equal(row.symbol, "NVDA");
});

test("a leaky episode is REFUSED and never written", () => {
  const d = db();
  const r = persistEpisodeOnDb(d, ep({ blocks: { momentum: { asOfMs: 1500, values: {} } } }), 1);
  assert.equal(r.ok, false);
  assert.ok(r.violations.length > 0);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM setup_episodes").get().n, 0, "leaky episode never entered the memory");
});

test("labels persist, are idempotent, and non-forward labels are refused", () => {
  const d = db();
  const key = episodeKeyOf("replay", "nvda", 1000, 1);
  assert.equal(persistLabelOnDb(d, key, 1000, label(), 1).inserted, true);
  assert.equal(persistLabelOnDb(d, key, 1000, label(), 2).inserted, false, "UNIQUE(episode,horizon,target) idempotent");
  const bad = persistLabelOnDb(d, key, 1000, label({ labelAsOfMs: 1000 }), 3); // not strictly forward
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /forward/);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM episode_labels").get().n, 1);
});

test("distinct horizons/targets coexist for one episode", () => {
  const d = db();
  const key = episodeKeyOf("replay", "nvda", 1000, 1);
  persistLabelOnDb(d, key, 1000, label({ horizon: "1h", targetKind: "UNDERLYING" }), 1);
  persistLabelOnDb(d, key, 1000, label({ horizon: "5d", targetKind: "UNDERLYING" }), 1);
  persistLabelOnDb(d, key, 1000, label({ horizon: "1h", targetKind: "OPTION_ATM_CALL", outcomeKind: "MODELED_OPTION", modelAssumptions: { m: 1 } }), 1);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM episode_labels").get().n, 3);
});

test("SAFETY: live episode capture is a hard no-op when EPISODE_CAPTURE_ENABLED is off", () => {
  const res = captureEpisodes([ep()], 1, {});
  assert.equal(res.captured, 0);
  assert.match(res.skippedReason, /EPISODE_CAPTURE_ENABLED/);
});
