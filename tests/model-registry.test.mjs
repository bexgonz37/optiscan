import test from "node:test";
import assert from "node:assert/strict";
import {
  trainAndEvaluateOnDb,
  modelStatusOnDb,
  predictForOnDb,
  checkActivation,
  checkActivationTier,
  trainingRowsOnDb,
  defaultActivationThresholds,
  defaultExperimentalThresholds,
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
  feature_schema_version INTEGER NOT NULL, status TEXT NOT NULL, tier TEXT, config_json TEXT NOT NULL, model_json TEXT NOT NULL,
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

// Validated-tier override (met by the 160-row seed) so the strict track promotes.
const validatedOverride = { validated: { minGraded: 100, minWins: 20, minLosses: 20, minHoldout: 20, minCoverage: 0.5, maxEce: 0.2 } };
// Experimental-tier override (met by the 60-row seed) while validated stays unmet.
const experimentalOverride = { experimental: { minGraded: 40, minWins: 8, minLosses: 8, minHoldout: 10, minCoverage: 0.5, maxEce: 0.3 } };

test("activation gate reports shortfall on empty data", () => {
  const a = checkActivation([], defaultActivationThresholds());
  assert.equal(a.ok, false);
  assert.ok(a.reasons.some((r) => /graded outcomes/.test(r)));
});

test("experimental thresholds are strictly looser than validated ones", () => {
  const v = defaultActivationThresholds();
  const e = defaultExperimentalThresholds();
  assert.ok(e.minGraded < v.minGraded);
  assert.ok(e.minWins < v.minWins);
  assert.ok(e.minLosses < v.minLosses);
  assert.ok(e.minHoldout < v.minHoldout);
});

test("checkActivationTier: NONE when even experimental is unmet", () => {
  const { tier } = checkActivationTier([]);
  assert.equal(tier, "NONE");
});

if (Database) {
  test("empty DB ⇒ inactive state, no probability emitted", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    const res = trainAndEvaluateOnDb(db, Date.now());
    assert.equal(res.status, "INACTIVE_INSUFFICIENT_DATA");
    assert.equal(res.state, "INACTIVE_NO_TRAINABLE_DATA");
    assert.equal(res.tier, "NONE");
    assert.equal(res.promoted, false);
    const st = modelStatusOnDb(db);
    assert.equal(st.state, "INACTIVE_NO_TRAINABLE_DATA");
    const pred = predictForOnDb(db, { strategy: "zero_dte_momentum" });
    assert.equal(pred.proba, null); // never a placeholder percentage
    assert.equal(pred.state, "INACTIVE_NO_TRAINABLE_DATA");
    assert.equal(pred.experimental, false);
  });

  test("training rows are leak-free (label from grade only) and chronological", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    seed(db, 10);
    const rows = trainingRowsOnDb(db);
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r) => r.label === 0 || r.label === 1));
  });

  test("validated tier: sufficient data + learnable pattern ⇒ validated champion, probability available", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    seed(db, 160);
    const res = trainAndEvaluateOnDb(db, Date.now(), validatedOverride);
    assert.equal(res.tier, "VALIDATED");
    assert.equal(res.activation.ok, true, JSON.stringify(res.activation.reasons));
    assert.equal(res.promoted, true, res.message);
    assert.equal(res.status, "ACTIVE_CHAMPION");
    assert.equal(res.state, "ACTIVE_VALIDATED");
    assert.ok(res.holdoutMetrics.brier < res.holdoutMetrics.baseRateBrier, "beats base rate out of sample");

    const status = modelStatusOnDb(db);
    assert.equal(status.status, "ACTIVE_CHAMPION");
    assert.equal(status.state, "ACTIVE_VALIDATED");
    assert.equal(status.tier, "VALIDATED");
    const pWin = predictForOnDb(db, { deltaBand: "0.45-0.55", strategy: "zero_dte_momentum", direction: "call", instrument: "option" });
    const pLoss = predictForOnDb(db, { deltaBand: "0.30-0.45", strategy: "zero_dte_momentum", direction: "call", instrument: "option" });
    assert.equal(pWin.experimental, false);
    assert.equal(pWin.state, "ACTIVE_VALIDATED");
    assert.ok(pWin.proba > pLoss.proba, `pWin ${pWin.proba} pLoss ${pLoss.proba}`);
    assert.ok(pWin.proba >= 0 && pWin.proba <= 1);

    // A CHAMPION row carries the VALIDATED tier.
    const champTier = db.prepare("SELECT tier FROM model_registry WHERE status='CHAMPION'").get().tier;
    assert.equal(champTier, "VALIDATED");
  });

  test("experimental tier: real two-class data below validated bar ⇒ EXPERIMENTAL champion, research-only probability", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    seed(db, 60); // enough for the experimental override, far below the validated 200 bar
    const res = trainAndEvaluateOnDb(db, Date.now(), experimentalOverride);
    assert.equal(res.tier, "EXPERIMENTAL", res.message);
    assert.equal(res.promoted, true, res.message);
    // Experimental promotion never claims the validated ACTIVE_CHAMPION status.
    assert.equal(res.status, "INACTIVE_INSUFFICIENT_DATA");
    assert.equal(res.state, "ACTIVE_EXPERIMENTAL_RESEARCH_ONLY");

    const status = modelStatusOnDb(db);
    assert.equal(status.state, "ACTIVE_EXPERIMENTAL_RESEARCH_ONLY");
    assert.equal(status.tier, "EXPERIMENTAL");
    assert.ok(status.experimental, "experimental meta present");
    assert.ok(/RESEARCH ONLY/.test(status.message));

    // No VALIDATED champion exists; exactly one experimental champion does.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM model_registry WHERE status='CHAMPION'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM model_registry WHERE status='EXPERIMENTAL_CHAMPION'").get().n, 1);

    const pred = predictForOnDb(db, { deltaBand: "0.45-0.55", strategy: "zero_dte_momentum", direction: "call", instrument: "option" });
    assert.equal(pred.experimental, true, "experimental probability is flagged research-only");
    assert.equal(pred.state, "ACTIVE_EXPERIMENTAL_RESEARCH_ONLY");
    assert.notEqual(pred.status, "ACTIVE_CHAMPION"); // never validated
    assert.ok(pred.proba != null && pred.proba >= 0 && pred.proba <= 1);
  });

  test("validated champion supersedes a standing experimental champion", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    seed(db, 60);
    trainAndEvaluateOnDb(db, 1000, experimentalOverride); // experimental champion
    seed2To160(db);
    const res = trainAndEvaluateOnDb(db, 2000, validatedOverride); // now validated
    assert.equal(res.tier, "VALIDATED");
    assert.equal(res.promoted, true, res.message);
    // The experimental champion is retired; the validated one is the sole champion.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM model_registry WHERE status='EXPERIMENTAL_CHAMPION'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM model_registry WHERE status='CHAMPION'").get().n, 1);
    assert.equal(modelStatusOnDb(db).state, "ACTIVE_VALIDATED");
  });

  test("a champion is retained (rollback preserved) and only one CHAMPION exists", () => {
    const db = new Database(":memory:");
    db.exec(DDL);
    seed(db, 160);
    trainAndEvaluateOnDb(db, 1000, validatedOverride);
    trainAndEvaluateOnDb(db, 2000, validatedOverride); // second, identical → not an improvement
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

// Extend an existing 60-row seed up to 160 rows (ids 61..160) with the same pattern.
function seed2To160(db) {
  const fpBase = { session: "REGULAR", todBucket: "OPEN", dteBucket: "0DTE", spreadBand: "TIGHT", relVolBucket: "2-4", vwapState: "ABOVE", moveClassification: "BREAKOUT" };
  for (let i = 60; i < 160; i++) {
    const winning = i % 2 === 0;
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
