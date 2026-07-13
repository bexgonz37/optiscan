import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runLearningCycleOnDb, learningStatusOnDb, recommendationsOnDb } from "../lib/learning-store.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  Database = null;
}

const DDL = `
CREATE TABLE IF NOT EXISTS setup_fingerprints (fingerprint_id TEXT PRIMARY KEY, dimensions_json TEXT);
CREATE TABLE IF NOT EXISTS paper_trades (id INTEGER PRIMARY KEY, entry_delta REAL, entry_spread_pct REAL, rel_vol_entry REAL, entry_iv REAL, selection_score REAL, dte_at_entry INTEGER);
CREATE TABLE IF NOT EXISTS paper_trade_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, paper_trade_id INTEGER, fingerprint_id TEXT, strategy TEXT, direction TEXT, instrument_type TEXT, grade TEXT NOT NULL, grading_status TEXT NOT NULL, exit_time_ms INTEGER);
CREATE TABLE IF NOT EXISTS paper_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, decision TEXT);
CREATE TABLE IF NOT EXISTS model_registry (id INTEGER PRIMARY KEY AUTOINCREMENT, model_name TEXT, model_version INTEGER, feature_schema_version INTEGER, status TEXT, config_json TEXT, model_json TEXT, metrics_json TEXT, training_watermark INTEGER DEFAULT 0, n_train INTEGER DEFAULT 0, base_rate REAL, health TEXT, trained_at_ms INTEGER, UNIQUE(model_name, model_version));
CREATE TABLE IF NOT EXISTS model_evaluations (id INTEGER PRIMARY KEY AUTOINCREMENT, model_registry_id INTEGER, eval_kind TEXT, metrics_json TEXT, created_at_ms INTEGER);
CREATE TABLE IF NOT EXISTS learning_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, watermark INTEGER DEFAULT 0, new_graded INTEGER DEFAULT 0, drift_state TEXT, decision_json TEXT, result_json TEXT, created_at_ms INTEGER);
CREATE TABLE IF NOT EXISTS drift_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, drift_state TEXT NOT NULL, metrics_json TEXT NOT NULL, reasons_json TEXT, created_at_ms INTEGER);`;

const NOW = Date.parse("2026-07-11T15:00:00Z");

test("learning store never mutates trading rules or source (source-spec)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(root, "lib/learning-store.ts"), "utf8");
  assert.ok(/NEVER changes source code/.test(src));
  // No writes to risk/threshold/settings; only learning_runs + drift_snapshots + model health.
  assert.ok(!/scanner_settings|maxRiskPerTrade|writeFileSync|ALTER TABLE/.test(src));
  const writes = (src.match(/INSERT INTO (\w+)|UPDATE (\w+)/g) ?? []);
  for (const w of writes) {
    assert.ok(/learning_runs|drift_snapshots|model_registry/.test(w), `unexpected write: ${w}`);
  }
});

if (Database) {
  test("empty data ⇒ SKIPPED retrain + INSUFFICIENT_DATA drift, both recorded", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    const res = runLearningCycleOnDb(db, NOW);
    assert.equal(res.retrained, false);
    assert.equal(res.driftState, "INSUFFICIENT_DATA");
    assert.equal(res.championHealth, null); // no champion
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learning_runs").get().n, 1);
    assert.equal(db.prepare("SELECT kind FROM learning_runs ORDER BY id DESC LIMIT 1").get().kind, "SKIPPED");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM drift_snapshots").get().n, 1);
  });

  test("cycle is repeatable and keeps an append-only audit trail", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    runLearningCycleOnDb(db, NOW);
    runLearningCycleOnDb(db, NOW + 1000);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learning_runs").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM drift_snapshots").get().n, 2);
  });

  test("status reports inactive model, drift, and human recommendations", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    runLearningCycleOnDb(db, NOW);
    const st = learningStatusOnDb(db);
    assert.equal(st.modelStatus.status, "INACTIVE_INSUFFICIENT_DATA");
    assert.ok(st.latestDrift);
    assert.ok(st.recommendations.length >= 1);
    assert.ok(recommendationsOnDb(db).some((r) => /Collect more graded outcomes/.test(r)));
  });
}
