import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { refreshEvidenceLearningOnDb, evidenceLearningSnapshotOnDb, qualityBand, timeBucket } from "../lib/ai/evidence-learning.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const NOW = Date.parse("2026-07-21T15:00:00Z");

function db() {
  const d = new Database(":memory:");
  d.exec(`
CREATE TABLE evidence_learning_examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_kind TEXT NOT NULL, source_table TEXT NOT NULL,
  source_id TEXT NOT NULL, source_ref TEXT, audience TEXT NOT NULL, symbol TEXT, sector TEXT,
  strategy TEXT, side TEXT, time_bucket TEXT, market_regime TEXT, spy_direction TEXT, qqq_direction TEXT,
  relative_volume REAL, vwap_distance_pct REAL, level_interactions_json TEXT, quality_score REAL,
  quality_band TEXT, trigger_reason TEXT, trigger_components_json TEXT, feature_json TEXT,
  option_spread_pct REAL, liquidity REAL, contract_symbol TEXT, entry_price REAL, target_price REAL,
  stop_price REAL, mfe_pct REAL, mae_pct REAL, final_return_pct REAL, final_outcome TEXT,
  time_to_outcome_ms INTEGER, grading_basis TEXT NOT NULL, missing_fields_json TEXT,
  completed_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  UNIQUE(source_kind, source_id));
CREATE TABLE evidence_learning_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pattern_key TEXT NOT NULL UNIQUE, pattern_kind TEXT NOT NULL,
  label TEXT NOT NULL, sample_size INTEGER NOT NULL DEFAULT 0, delivered_sample_size INTEGER NOT NULL DEFAULT 0,
  research_sample_size INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
  win_rate REAL, avg_return_pct REAL, expectancy_pct REAL, delivered_win_rate REAL, research_win_rate REAL,
  delivered_vs_research_lift REAL, confidence TEXT NOT NULL DEFAULT 'LOW', statistical_support_json TEXT,
  overfitting_risk TEXT NOT NULL DEFAULT 'HIGH', recommendation TEXT, recommendation_type TEXT NOT NULL DEFAULT 'OBSERVE',
  evidence_refs_json TEXT, source_watermark INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL);
CREATE TABLE evidence_learning_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, examples_materialized INTEGER NOT NULL DEFAULT 0,
  patterns_materialized INTEGER NOT NULL DEFAULT 0, skipped_reason TEXT, source_watermark INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL);
CREATE TABLE options_paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT,
  dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL,
  volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL,
  invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL,
  mfe_pct REAL, mae_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT,
  core_broad TEXT, feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE options_delivery_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, symbol TEXT NOT NULL, strategy TEXT,
  side TEXT, tier INTEGER, outcome TEXT NOT NULL, reason TEXT, quality REAL, rank INTEGER, batch_size INTEGER,
  components_json TEXT, cluster_key TEXT, threshold REAL, session_state TEXT, alert_id TEXT,
  would_deliver_solo INTEGER, competing_json TEXT, delivery_attempted INTEGER, delivery_sent INTEGER,
  delivery_state TEXT, final_delivery_outcome TEXT, delivery_failure_category TEXT, final_delivery_reason TEXT,
  delivery_attempted_at_ms INTEGER, delivery_completed_at_ms INTEGER, created_at_ms INTEGER NOT NULL);
CREATE TABLE options_replay_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, t_ms INTEGER NOT NULL, symbol TEXT NOT NULL,
  strategy TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, quality REAL, strategy_score REAL,
  matched_signals INTEGER, required_signals INTEGER, fraction_move REAL, hour_et INTEGER,
  fwd30_pct REAL, fwd60_pct REAL, fwd_eod_pct REAL, grading_basis TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE market_context_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, as_of_ms INTEGER NOT NULL, regime TEXT,
  spy_trend TEXT, qqq_trend TEXT, sector TEXT, created_at_ms INTEGER NOT NULL);
`);
  return d;
}

function insertPaper(d, { id, kind, ret, alert, entered = NOW }) {
  const feature = {
    underlying: { relVolume: 3.1, vwapDistPct: 0.4, aboveVwap: true, hodBreak: true, nearResistancePct: 0.2, openingRange: true },
    fractionMove: 0.25,
    earlinessPhase: "early",
  };
  d.prepare(`INSERT INTO options_paper_trades
    (id, option_symbol, side, strike, expiration, dte, result_class, spread_pct, entry_fill, open_interest,
     strategy, target, invalidation, status, return_pct, mfe_pct, mae_pct, exit_reason, entered_at_ms,
     exit_at_ms, session, feature_snapshot_json, paper_kind, alert_id, created_at_ms, updated_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, `O:HOOD260724C00100000`, "call", 100, "2026-07-24", 3, "REAL_OPTION_PAPER", 5, 1.2, 2000,
      "opening_momentum", 1.9, 0.8, "EXITED", ret, Math.max(ret, 0), Math.min(ret, 0), ret > 0 ? "target_hit" : "stop_hit",
      entered, entered + 30 * 60_000, "regular", JSON.stringify(feature), kind, alert, entered, entered + 30 * 60_000);
}

test("evidence learning materializes completed delivered/research/replay evidence and aggregate comparisons", () => {
  const d = db();
  d.prepare("INSERT INTO market_context_shadow (symbol, as_of_ms, regime, spy_trend, qqq_trend, sector, created_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run("HOOD", NOW - 1000, "risk_on", "bullish", "bullish", "Financials", NOW);
  insertPaper(d, { id: 1, kind: "DELIVERED_ALERT_PAPER", ret: 62, alert: "oa_1" });
  insertPaper(d, { id: 2, kind: "RESEARCH_ONLY_PAPER", ret: -35, alert: null, entered: NOW + 60_000 });
  d.prepare(`INSERT INTO options_delivery_decisions
    (batch_id, symbol, strategy, side, outcome, reason, quality, components_json, alert_id, final_delivery_outcome, created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("b1", "HOOD", "opening_momentum", "call", "DELIVER_TO_DISCORD", "subscriber_worthy", 0.84, JSON.stringify({ signalCompleteness: 1 }), "oa_1", "DELIVERED", NOW);
  d.prepare(`INSERT INTO options_delivery_decisions
    (batch_id, symbol, strategy, side, outcome, reason, quality, components_json, final_delivery_outcome, created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("b1", "HOOD", "opening_momentum", "call", "RESEARCH_ONLY", "below_subscriber_threshold", 0.58, JSON.stringify({ signalCompleteness: 0.5 }), "SKIPPED", NOW + 60_000);
  d.prepare(`INSERT INTO options_replay_candidates
    (run_id, t_ms, symbol, strategy, side, quality, strategy_score, matched_signals, required_signals, fraction_move, hour_et, fwd60_pct, grading_basis, created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(7, NOW, "HOOD", "opening_momentum", "call", 0.8, 0.9, 3, 4, 0.3, 11, 1.2, "UNDERLYING_FORWARD", NOW);

  const r = refreshEvidenceLearningOnDb(d, { nowMs: NOW + 3600_000, minSample: 2 });
  assert.equal(r.status, "OK");
  assert.equal(r.examplesMaterialized, 3);
  const snap = evidenceLearningSnapshotOnDb(d);
  assert.equal(snap.available, true);
  assert.equal(snap.productionAuthority, "none");
  assert.equal(snap.examples.delivered, 1);
  assert.equal(snap.examples.researchOnly, 1);
  assert.equal(snap.examples.replayUnderlyingForward, 1);
  const delivered = d.prepare("SELECT * FROM evidence_learning_examples WHERE audience='DELIVERED'").get();
  assert.equal(delivered.sector, "Financials");
  assert.equal(delivered.quality_band, "0.80-0.90");
  assert.equal(delivered.final_outcome, "WIN");
  const audience = d.prepare("SELECT * FROM evidence_learning_patterns WHERE pattern_kind='audience_comparison'").get();
  assert.equal(audience.delivered_sample_size, 1);
  assert.equal(audience.research_sample_size, 1);
  assert.equal(audience.delivered_vs_research_lift, 1);
});

test("evidence helpers bucket time and quality deterministically", () => {
  assert.equal(timeBucket(Date.parse("2026-07-21T13:40:00Z")), "09:30-09:50");
  assert.equal(timeBucket(Date.parse("2026-07-21T19:30:00Z")), "15:00-16:00");
  assert.equal(qualityBand(0.84), "0.80-0.90");
  assert.equal(qualityBand(null), null);
});

test("evidence refresh advances through unmaterialized backlog instead of replaying oldest rows", () => {
  const d = db();
  insertPaper(d, { id: 1, kind: "DELIVERED_ALERT_PAPER", ret: 12, alert: "oa_1" });
  insertPaper(d, { id: 2, kind: "RESEARCH_ONLY_PAPER", ret: -8, alert: null, entered: NOW + 60_000 });
  insertPaper(d, { id: 3, kind: "DELIVERED_ALERT_PAPER", ret: 25, alert: "oa_3", entered: NOW + 120_000 });

  assert.equal(refreshEvidenceLearningOnDb(d, { nowMs: NOW, limit: 1 }).examplesMaterialized, 1);
  assert.equal(refreshEvidenceLearningOnDb(d, { nowMs: NOW + 1, limit: 1 }).examplesMaterialized, 1);
  assert.equal(refreshEvidenceLearningOnDb(d, { nowMs: NOW + 2, limit: 1 }).examplesMaterialized, 1);
  assert.equal(refreshEvidenceLearningOnDb(d, { nowMs: NOW + 3, limit: 1 }).examplesMaterialized, 0);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM evidence_learning_examples").get().n, 3);
});

test("evidence learning is not imported by live scanner or delivery paths", () => {
  for (const file of [
    "lib/research/options/monitor.ts",
    "lib/research/options/loop.ts",
    "lib/research/options/delivery.ts",
    "lib/research/options/delivery-decision.ts",
  ]) {
    assert.doesNotMatch(read(file), /evidence-learning/, `${file} must not read advisory learning in the live path`);
  }
  assert.match(read("lib/ai/weekly.ts"), /refreshEvidenceLearningOnDb/, "weekly advisory job may refresh evidence");
});
