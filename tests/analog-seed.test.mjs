import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { identifyCandidateMoments, seedEpisodesPure, seedSymbolOnDb, runReplaySeed } from "../lib/research/episode/seed.ts";
import { validateEpisodeNoLookahead } from "../lib/research/episode/leakage.ts";

const CFG = { velWindow: 3, baselineWindow: 5, volWindow: 3, rangeWindow: 5, warmup: 5, entryVelThresholdPct: 0.5, rvolThreshold: 1.5, refractoryMs: 120_000, targetPct: 5, stopPct: 3, configVersion: 1 };

// Flat warmup, one momentum+volume burst at index 6, then a slow rise (forward bars for labels).
function bars() {
  const b = [];
  for (let k = 0; k <= 5; k++) b.push({ t: k * 60_000, o: 100, h: 100, l: 100, c: 100, v: 100 });
  b.push({ t: 6 * 60_000, o: 100, h: 103, l: 100, c: 103, v: 300 }); // trigger: vel +3% over 3 bars, rvol 3x
  let prev = 103;
  for (let k = 7; k <= 30; k++) { const c = 103 + (k - 6) * 0.2; b.push({ t: k * 60_000, o: prev, h: c + 1, l: c - 1, c, v: 150 }); prev = c; }
  return b;
}

function memDb() {
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
  d.exec(ddl); d.exec(ddl);
  return d;
}

test("candidate identification: a momentum+volume burst produces exactly one candidate", () => {
  const c = identifyCandidateMoments(bars(), CFG);
  assert.equal(c.length, 1);
  assert.equal(c[0].i, 6);
  assert.equal(c[0].direction, "bullish");
});

test("no candidates on flat bars (no hindsight, no false triggers)", () => {
  const flat = Array.from({ length: 30 }, (_, k) => ({ t: k * 60_000, o: 100, h: 100, l: 100, c: 100, v: 100 }));
  assert.equal(identifyCandidateMoments(flat, CFG).length, 0);
});

test("refractory dedup: a second burst inside the window is collapsed", () => {
  const b = bars();
  b[8] = { t: 8 * 60_000, o: 103, h: 107, l: 103, c: 107, v: 400 }; // a burst 2 bars later (< refractory 120s from t0=360000? 480000-360000=120000 == refractory, so allowed) → tighten:
  b[7] = { t: 7 * 60_000, o: 103, h: 108, l: 103, c: 108, v: 500 }; // burst 1 bar later (60s < 120s) → must be dropped
  const c = identifyCandidateMoments(b, CFG);
  assert.ok(c.length >= 1);
  assert.equal(c[0].i, 6, "first candidate kept");
  assert.ok(!c.some((x) => x.i === 7), "the in-refractory burst at i=7 is dropped");
});

test("seed is deterministic: same bars + config ⇒ identical episodes + labels", () => {
  const a = JSON.stringify(seedEpisodesPure("NVDA", bars(), CFG));
  const b = JSON.stringify(seedEpisodesPure("nvda", bars(), CFG));
  assert.equal(a, b);
});

test("every seeded episode passes the leakage guard; labels are strictly forward", () => {
  for (const s of seedEpisodesPure("NVDA", bars(), CFG)) {
    assert.equal(validateEpisodeNoLookahead(s.episode).ok, true);
    for (const l of s.labels) assert.ok(l.labelAsOfMs > s.episode.t0Ms, "label uses only forward data");
  }
});

test("features that need unavailable historical data are missing, not fabricated", () => {
  const [s] = seedEpisodesPure("NVDA", bars(), CFG);
  assert.equal(s.episode.blocks.optionsContext, null);
  assert.equal(s.episode.blocks.regime, null);
  assert.ok(s.episode.missing.includes("optionsContext"));
  assert.ok(s.episode.missing.includes("regime"));
});

test("replay emits UNDERLYING labels only (no fabricated MODELED_OPTION); a mix of horizons resolve", () => {
  const [s] = seedEpisodesPure("NVDA", bars(), CFG);
  assert.ok(s.labels.length >= 2);
  assert.ok(s.labels.every((l) => l.outcomeKind === "REAL_UNDERLYING"));
  const horizons = new Set(s.labels.map((l) => l.horizon));
  assert.ok(horizons.has("15m"));
  assert.ok(!horizons.has("1h"), "1h needs 60 forward bars → correctly skipped, not fabricated");
});

test("seedSymbolOnDb persists episodes + labels, refuses none, and is restart-idempotent", () => {
  const d = memDb();
  const r1 = seedSymbolOnDb(d, "NVDA", bars(), CFG, 1);
  assert.equal(r1.episodesRefused, 0);
  assert.equal(r1.episodesCaptured, 1);
  assert.ok(r1.labels >= 2);
  const r2 = seedSymbolOnDb(d, "NVDA", bars(), CFG, 2);
  assert.equal(r2.episodesCaptured, 0, "re-run creates no duplicate episodes");
  assert.equal(r2.labels, 0, "re-run creates no duplicate labels");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM setup_episodes").get().n, 1);
});

test("SAFETY: live replay seeding is a hard no-op unless both flags are enabled + a universe is supplied", async () => {
  const off = await runReplaySeed({ symbols: ["NVDA"], from: "a", to: "b" }, {});
  assert.equal(off.ran, false);
  assert.match(off.skippedReason, /HISTORICAL_REPLAY_ENABLED.*EPISODE_CAPTURE_ENABLED/);
  const noUniverse = await runReplaySeed({ symbols: [], from: "a", to: "b" }, { HISTORICAL_REPLAY_ENABLED: "1", EPISODE_CAPTURE_ENABLED: "1" });
  assert.equal(noUniverse.ran, false);
  assert.match(noUniverse.skippedReason, /survivorship-free universe/);
});
