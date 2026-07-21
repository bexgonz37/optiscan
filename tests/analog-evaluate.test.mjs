import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runPhaseDEvalOnDb, readEpisodesForEvalOnDb, episodeRowToLabeled } from "../lib/research/analog/evaluate.ts";

function mulberry32(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE setup_episodes (episode_key TEXT PRIMARY KEY, source TEXT, symbol TEXT, t0_ms INTEGER, trading_day TEXT, session TEXT, direction TEXT, liquidity_tier TEXT, price_structure_json TEXT, momentum_json TEXT, volume_json TEXT, volatility_json TEXT, missing_json TEXT, feature_schema_version INTEGER, max_feature_as_of_ms INTEGER, created_at_ms INTEGER);
    CREATE TABLE episode_labels (id INTEGER PRIMARY KEY AUTOINCREMENT, episode_key TEXT, horizon TEXT, target_kind TEXT, outcome_kind TEXT, return_pct REAL, label_as_of_ms INTEGER);
    CREATE TABLE replay_runs (run_id TEXT, asset_class TEXT, provider_limitations TEXT, date_from TEXT, date_to TEXT, created_at_ms INTEGER);
    CREATE TABLE analog_eval_reports (report_id TEXT PRIMARY KEY, report_version INTEGER NOT NULL, dataset_kind TEXT NOT NULL, verdict TEXT NOT NULL, verdict_reason TEXT, universe_source TEXT, survivorship_bias INTEGER NOT NULL DEFAULT 1, date_from TEXT, date_to TEXT, episode_count INTEGER, report_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);`);
  return d;
}
// Nonlinear band edge in velPct → analog engine can capture it; linear baselines cannot.
function seed(d, n, { survivorshipBias, seed = 4 } = {}) {
  const r = mulberry32(seed);
  const ins = d.prepare(`INSERT INTO setup_episodes (episode_key, source, symbol, t0_ms, trading_day, session, direction, liquidity_tier, price_structure_json, momentum_json, volume_json, volatility_json, missing_json, feature_schema_version, max_feature_as_of_ms, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const lab = d.prepare(`INSERT INTO episode_labels (episode_key, horizon, target_kind, outcome_kind, return_pct, label_as_of_ms) VALUES (?,?,?,?,?,?)`);
  for (let i = 0; i < n; i++) {
    const vel = r() * 6 - 3, win = Math.abs(vel - 1) < 0.5, ret = (win ? 5 : -5) + (r() * 1 - 0.5);
    const t0 = 1000 + i * 1000, key = `ep${i}`;
    ins.run(key, "replay", "SYM" + (i % 40), t0, "2024-01-01", "regular", "bullish", "high",
      JSON.stringify({ asOfMs: t0, values: { posInRange: 0.5, gapPct: 0 } }),
      JSON.stringify({ asOfMs: t0, values: { velPct: vel, accelPct: 0 } }),
      JSON.stringify({ asOfMs: t0, values: { rvol: 2 } }),
      JSON.stringify({ asOfMs: t0, values: { realizedVol: 0.01, atrPct: 1 } }),
      JSON.stringify([]), 1, t0, t0);
    lab.run(key, "5d", "UNDERLYING", "REAL_UNDERLYING", ret, t0 + 500_000);
  }
  d.prepare(`INSERT INTO replay_runs (run_id, asset_class, provider_limitations, date_from, date_to, created_at_ms) VALUES (?,?,?,?,?,?)`)
    .run("seed1", "stock", JSON.stringify({ universeSource: survivorshipBias ? "current_symbols" : "user_dated_file", survivorshipBias }), "2021-01-01", "2026-01-01", 1);
}

test("episodeRowToLabeled maps Zone-A JSON blocks into numeric features + cmp keys", () => {
  const d = db(); seed(d, 20, { survivorshipBias: false });
  const eps = readEpisodesForEvalOnDb(d, "5d");
  assert.equal(eps.length, 20);
  const f = eps[0].input.features;
  assert.ok("velPct" in f && "rvol" in f && "cmp_liquidity" in f && "cmp_direction" in f);
  assert.equal(f.cmp_liquidity, 2); // high
});

test("PLUMBING (synthetic, NOT real-market evidence): survivorship-free library flows to a verdict", () => {
  const d = db(); seed(d, 800, { survivorshipBias: false });
  const rep = runPhaseDEvalOnDb(d, { horizon: "5d", minEpisodes: 100, folds: 4, iters: 1000 });
  assert.equal(rep.datasetKind, "real_seeded");
  assert.equal(rep.provenance.survivorshipBias, false);
  assert.ok(["GO", "REMEDIATE"].includes(rep.verdict), `pipeline detected the synthetic edge (verdict ${rep.verdict})`);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM analog_eval_reports").get().n, 1, "report persisted");
});

test("survivorship-biased provenance can NEVER GO (EXPLORATORY_ONLY)", () => {
  const d = db(); seed(d, 800, { survivorshipBias: true });
  const rep = runPhaseDEvalOnDb(d, { horizon: "5d", minEpisodes: 100, folds: 4, iters: 500 });
  assert.equal(rep.verdict, "EXPLORATORY_ONLY");
});

test("insufficient episodes → a report is still produced (not GO)", () => {
  const d = db(); seed(d, 50, { survivorshipBias: false });
  const rep = runPhaseDEvalOnDb(d, { horizon: "5d", minEpisodes: 500 });
  assert.notEqual(rep.verdict, "GO");
  assert.equal(rep.episodeCount, 50);
});
