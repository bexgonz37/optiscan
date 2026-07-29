import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildQuantLabSnapshot } from "../lib/research/options/quant-lab.ts";

function migrateMinimal(db) {
  db.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
      result_class TEXT, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL,
      volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL,
      strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT,
      exit_fill REAL, pnl REAL, return_pct REAL, mfe_pct REAL, mae_pct REAL, last_mark_return_pct REAL,
      exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER,
      session TEXT, core_broad TEXT, feature_snapshot_json TEXT,
      paper_kind TEXT, alert_id TEXT, entry_source TEXT, experiment_id TEXT, experiment_variant TEXT,
      strategy_family TEXT, exit_policy_version TEXT, time_bucket TEXT, market_regime TEXT,
      contract_moneyness TEXT, delta_band TEXT, account_risk_usd REAL, fingerprint TEXT, contract_alts_json TEXT,
      created_at_ms INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT,
      research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, sent_at_ms INTEGER
    );
  `);
}

function insertPaper(db, {
  paperKind,
  optionSymbol,
  side = "call",
  dte = 1,
  returnPct,
  mfe = 20,
  mae = -8,
  exitReason = "target_hit",
  strategy = "momentum",
  family = "index_intraday_momentum",
  qualityScore = 0.8,
}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO options_paper_trades (
      option_symbol, side, dte, status, return_pct, mfe_pct, mae_pct, exit_reason,
      strategy, strategy_family, paper_kind, feature_snapshot_json,
      time_bucket, market_regime, contract_moneyness, delta_band, exit_policy_version,
      entered_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    optionSymbol,
    side,
    dte,
    "EXITED",
    returnPct,
    mfe,
    mae,
    exitReason,
    strategy,
    family,
    paperKind,
    JSON.stringify({ qualityScore }),
    "open_drive",
    "trend",
    "ATM",
    "0.40-0.50",
    "fixed_r",
    now - 60_000,
    now,
    now,
  );
}

test("quant-lab snapshot keeps delivered and 0DTE lanes separate", () => {
  const db = new Database(":memory:");
  migrateMinimal(db);

  insertPaper(db, {
    paperKind: "DELIVERED_ALERT_PAPER",
    optionSymbol: "O:SPY260727C00500000",
    returnPct: 10,
    qualityScore: 0.9,
  });
  insertPaper(db, {
    paperKind: "DELIVERED_ALERT_PAPER",
    optionSymbol: "O:QQQ260727P00480000",
    side: "put",
    returnPct: -5,
    exitReason: "stop_hit",
    qualityScore: 0.6,
  });
  insertPaper(db, {
    paperKind: "ZERO_DTE_RESEARCH_PAPER",
    optionSymbol: "O:SPY260727C00501000",
    dte: 0,
    returnPct: 40,
    mfe: 50,
    qualityScore: 0.5,
  });
  insertPaper(db, {
    paperKind: "ZERO_DTE_RESEARCH_PAPER",
    optionSymbol: "O:SPY260727P00499000",
    side: "put",
    dte: 0,
    returnPct: -15,
    exitReason: "stop_hit",
    qualityScore: 0.4,
  });
  insertPaper(db, {
    paperKind: "ZERO_DTE_RESEARCH_PAPER",
    optionSymbol: "O:QQQ260727C00502000",
    dte: 0,
    returnPct: 12,
    qualityScore: 0.75,
  });

  const now = Date.now();
  db.prepare(
    `INSERT INTO options_alerts (alert_id, candidate_symbol, state, created_at_ms, updated_at_ms, sent_at_ms)
     VALUES (?,?,?,?,?,?)`,
  ).run("a1", "SPY", "SENT", now - 2500, now, now);

  const snap = buildQuantLabSnapshot(db, {});

  assert.equal(snap.lanes.delivered.sampleSize, 2);
  assert.equal(snap.lanes.zero_dte_research.sampleSize, 3);
  assert.equal(snap.sampleSize, 2, "top-level defaults to delivered lane");
  assert.notEqual(snap.lanes.delivered.sampleSize, snap.lanes.zero_dte_research.sampleSize);

  // Lanes must not blend: delivered mean should be (10 + -5)/2 = 2.5, not include +40/+12/-15
  assert.ok(snap.lanes.delivered.metrics.meanReturn != null);
  assert.ok(Math.abs(snap.lanes.delivered.metrics.meanReturn - 2.5) < 1e-4);
  assert.ok(snap.lanes.zero_dte_research.metrics.meanReturn != null);
  const zdMean = snap.lanes.zero_dte_research.metrics.meanReturn;
  assert.ok(Math.abs(zdMean - (40 - 15 + 12) / 3) < 1e-4);

  assert.ok(["LOW", "MEDIUM", "HIGH"].includes(snap.confidence));
  assert.ok(["LOW", "MEDIUM", "HIGH"].includes(snap.lanes.delivered.confidence));
  assert.ok(["LOW", "MEDIUM", "HIGH"].includes(snap.lanes.zero_dte_research.confidence));
  assert.equal(snap.timeWindow, "all_exited");
  assert.equal(snap.resultKind, "realized");
  assert.equal(snap.dataLane, "delivered");
  assert.equal(snap.lanes.delivered.dataLane, "delivered");
  assert.equal(snap.lanes.zero_dte_research.dataLane, "zero_dte_research");

  assert.ok(snap.lanes.delivered.metrics.detectionToDiscordLatencyMs != null);
  assert.ok(snap.lanes.delivered.metrics.detectionToDiscordLatencyMs >= 2000);

  assert.ok(snap.lanes.delivered.breakdowns.callsVsPuts.length >= 1);
  assert.ok(snap.lanes.zero_dte_research.breakdowns.zeroDteOnly.some((s) => s.key === "dte=0" && s.n === 3));
  assert.equal(snap.lanes.delivered.metadataCompleteness.moneyness, 100);
  assert.equal(snap.lanes.delivered.metadataCompleteness.deltaBand, 100);
});

test("missing Quant metadata lowers completeness and cannot support default conclusions", () => {
  const db = new Database(":memory:");
  migrateMinimal(db);
  for (let i = 0; i < 6; i += 1) {
    insertPaper(db, {
      paperKind: "DELIVERED_ALERT_PAPER",
      optionSymbol: `O:SPY260727C${String(500000 + i * 1000).padStart(8, "0")}`,
      returnPct: i % 2 ? -5 : 8,
    });
  }
  db.prepare(
    `UPDATE options_paper_trades
     SET market_regime=NULL, contract_moneyness=NULL, delta_band=NULL,
         exit_policy_version=NULL, feature_snapshot_json=NULL`,
  ).run();
  const report = buildQuantLabSnapshot(db, {}).lanes.delivered;
  assert.equal(report.sampleSize, 6);
  assert.equal(report.metadataCompleteness.marketRegime, 0);
  assert.equal(report.metadataCompleteness.moneyness, 0);
  assert.equal(report.metadataCompleteness.deltaBand, 0);
  assert.equal(report.metadataCompleteness.exitPolicy, 0);
  assert.equal(report.metadataCompleteness.qualityScore, 0);
  assert.equal(report.confidence, "LOW");
});
