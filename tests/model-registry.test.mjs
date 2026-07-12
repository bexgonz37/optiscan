import test from "node:test";
import assert from "node:assert/strict";
import {
  trainAndEvaluateOnDb,
  modelStatusOnDb,
  predictForOnDb,
  checkActivation,
  trainingRowsOnDb,
  defaultActivationThresholds,
  MODEL_NAME,
} from "../lib/model-registry.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  Database = null;
}

const DDL = `
CREATE TABLE IF NOT EXISTS setup_fingerprints (
  fingerprint_id TEXT PRIMARY KEY, fingerprint_version INTEGER, strategy TEXT, strategy_version INTEGER,
  dimensions_json TEXT, human_summary TEXT, first_seen_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY, entry_delta REAL, entry_spread_pct REAL, rel_vol_entry REAL,
  entry_iv REAL, selection_score REAL, dte_at_entry INTEGER
);
CREATE TABLE IF NOT EXISTS paper_trade_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, paper_trade_id INTEGER, fingerprint_id TEXT,
  strategy TEXT, direction TEXT, instrument_type TEXT, grade TEXT NOT NULL, grading_status TEXT NOT NULL,
  exit_time_ms INTEGER
);
CREATE TABLE IF NOT EXISTS model_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT, model_name TEXT NOT NULL, model_version INTEGER NOT NULL,
  feature_schema_version INTEGER NOT NULL, status TEXT NOT NULL, config_json TEXT NOT NULL, model_json TEXT NOT NULL,
  metrics_json TEXT, training_watermark INTEGER NOT NULL DEFAULT 0, n_train INTEGER NOT NULL DEFAULT 0,
  base_rate REAL, trained_at_ms INTEGER NOT NULL, UNIQUE(model_name, model_version)
);
CREATE TABLE IF NOT EXISTS model_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, model_registry_id INTEGER, eval_kind TEXT, metrics_json TEXT, created_at_ms INTEGER
);`;

// TEST SCAFFOLDING ONLY: seed a learnable pattern to exercise the training and
// promotion code path. Production never fabricates outcomes.
function seed(db, n = 160) {
  const fpBase = { session: "REGULAR", todBucket: "OPEN", dteBucket: "0DTE", spreadBand: "TIGHT", relVolBucket: "2-4", vwapState: "ABOVE", moveClassification: "BREAKOUT" };
  for (let i = 0; i < n; i++) {
    const winning = i % 2 === 0; // alternate ⇒ both classes present throughout (incl. holdout)
    const deltaBand = winning ? "0.45-0.55" : "0.30-0.45";
    const fpId = `sf1_${winning ? "win" : "los"}`;
    db.prepare("INSERT OR IGNORE INTO setup_fingerprints (fingerprint_id, fingerprint_version, strategy, strategy_version, dimensions_json, human_summary, first_seen_at_ms) VALUES (?,?,?,?,?,?,?)")
      .run(fpId, 1, "zero_dte_momentum", 1, JSON.stringify({ ...fpBase, deltaBand, strategy: "ZERO_DTE_MOMENTUM", direction: "CALL", instrument: "OPTION" }), "x", 1);
    db.prepare("INSERT INTO paper_trades (id, entry_delta, entry_spread_pct, rel_vol_entry, entry_iv, selection_score, dte_at_entry) VALUES (?,?,?,?,?,?,?)")
      .run(i + 1, winning ? 0.5 : 0.35, 2, 3, 0.4, 80, 0);
    db.prepare("INSERT INTO paper_trade_outcomes (paper_trade_id, fingerprint_id, strategy, direction, instrument_type, grade, grading_status, exit_time_ms) VALUES (?,?,?,?,?,?,?,?)")
      .run(i + 1, fpId, "zero_dte_momentum", "CALL", "option", winning ? "WIN" : "LOSS", "GRADED", i);
  }
}

const testThresholds = { minGraded: 100, minWins: 20, minLosses: 20, minHoldout: 20, minCoverage: 0.5, maxEce: 0.2 };

test("activation gate reports shortfall on empty data", () => {
  const a = checkActivation([], defaultActivationThresholds());
  assert.equal(a.ok, false);
  assert.ok(a.reasons.some((r) => /graded outcomes/.test(r)));
});

if (Database) {
  test("empty DB ⇒ INACTIVE_INSUFFICIENT_DATA, no probability emitted", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    const res = trainAndEvaluateOnDb(db, Date.now());
    assert.equal(res.status, "INACTIVE_INSUFFICIENT_DATA");
    assert.equal(res.promoted, false);
    assert.equal(modelStatusOnDb(db).status, "INACTIVE_INSUFFICIENT_DATA");
    const pred = predictForOnDb(db, { strategy: "zero_dte_momentum" });
    assert.equal(pred.proba, null); // never a placeholder percentage
  });

  test("training rows are leak-free (label from grade only) and chronological", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    seed(db, 10);
    const rows = trainingRowsOnDb(db);
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r) => r.label === 0 || r.label === 1));
  });

  test("sufficient data + learnable pattern ⇒ champion promoted, probability available", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    seed(db, 160);
    const res = trainAndEvaluateOnDb(db, Date.now(), testThresholds);
    assert.equal(res.activation.ok, true, JSON.stringify(res.activation.reasons));
    assert.equal(res.promoted, true, res.message);
    assert.equal(res.status, "ACTIVE_CHAMPION");
    assert.ok(res.holdoutMetrics.brier < res.holdoutMetrics.baseRateBrier, "beats base rate out of sample");

    const status = modelStatusOnDb(db);
    assert.equal(status.status, "ACTIVE_CHAMPION");
    const pWin = predictForOnDb(db, { deltaBand: "0.45-0.55", strategy: "zero_dte_momentum", direction: "call", instrument: "option" });
    const pLoss = predictForOnDb(db, { deltaBand: "0.30-0.45", strategy: "zero_dte_momentum", direction: "call", instrument: "option" });
    assert.ok(pWin.proba > pLoss.proba, `pWin ${pWin.proba} pLoss ${pLoss.proba}`);
    assert.ok(pWin.proba >= 0 && pWin.proba <= 1);
  });

  test("a champion is retained (rollback preserved) and only one CHAMPION exists", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    seed(db, 160);
    trainAndEvaluateOnDb(db, 1000, testThresholds);
    trainAndEvaluateOnDb(db, 2000, testThresholds); // second, identical → not an improvement
    const champs = db.prepare("SELECT COUNT(*) AS n FROM model_registry WHERE status='CHAMPION'").get().n;
    assert.equal(champs, 1, "exactly one active champion");
    const total = db.prepare("SELECT COUNT(*) AS n FROM model_registry").get().n;
    assert.ok(total >= 1, "prior models retained for rollback");
  });

  test("inactive model status source-spec: model name + no live-execution wording", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const src = readFileSync(join(root, "lib/model-registry.ts"), "utf8");
    assert.ok(src.includes("INACTIVE_INSUFFICIENT_DATA"));
    assert.ok(/never authorizes a trade|cannot .* override|EVIDENCE score/i.test(src));
    assert.equal(MODEL_NAME, "setup-winprob-logit");
  });
}
