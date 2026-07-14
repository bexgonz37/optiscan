import test from "node:test";
import assert from "node:assert/strict";
import {
  syncOutcomesOnDb,
  freezeFingerprintOnDb,
  generateOutcomeOnDb,
} from "../lib/outcome-store.ts";

// better-sqlite3 is native; skip functional tests when the platform binary
// can't load (mirrors db-concurrency.test.mjs), the source-spec test still runs.
let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  Database = null;
}

// Minimal but representative schema: the paper_trades columns the store reads +
// the two authoritative tables (additive, IF NOT EXISTS — repeat-safe).
const PAPER_TRADES_DDL = `
CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER, opportunity_id TEXT, ticker TEXT,
  option_symbol TEXT, option_type TEXT, strike REAL, expiration TEXT, dte_at_entry INTEGER,
  contracts INTEGER, status TEXT, strategy TEXT, selector_profile TEXT,
  entry_price REAL, exit_price REAL, entry_at_ms INTEGER, exit_at_ms INTEGER,
  entry_delta REAL, entry_spread_pct REAL, rel_vol_entry REAL, above_vwap_entry INTEGER,
  short_rate_entry REAL, session_at_entry TEXT, risk_amount REAL, snapshot_version INTEGER,
  entry_fees REAL, exit_fees REAL, entry_slippage REAL, exit_slippage REAL,
  mfe_pct REAL, mae_pct REAL, opportunity_peak_pct REAL, exit_reason TEXT, close_reason TEXT,
  fingerprint_id TEXT, fingerprint_version INTEGER, fingerprint_dimensions_json TEXT, strategy_version INTEGER
);`;
const NEW_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS setup_fingerprints (
  fingerprint_id TEXT PRIMARY KEY, fingerprint_version INTEGER NOT NULL,
  strategy TEXT, strategy_version INTEGER, dimensions_json TEXT NOT NULL,
  human_summary TEXT NOT NULL, first_seen_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS paper_trade_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_trade_id INTEGER NOT NULL UNIQUE, alert_id INTEGER, opportunity_id TEXT,
  fingerprint_id TEXT, fingerprint_version INTEGER, strategy TEXT, strategy_version INTEGER,
  instrument_type TEXT, direction TEXT, selector_profile TEXT, option_symbol TEXT,
  strike REAL, expiration TEXT, dte_at_entry INTEGER,
  entry_time_ms INTEGER, exit_time_ms INTEGER, hold_minutes REAL,
  entry_price REAL, exit_price REAL, quantity REAL, gross_pnl REAL,
  entry_fees REAL, exit_fees REAL, entry_slippage REAL, exit_slippage REAL,
  net_pnl REAL, return_pct REAL, risk_amount REAL, r_multiple REAL, mfe_pct REAL, mae_pct REAL,
  opportunity_grade TEXT, peak_favorable_pct REAL, opportunity_threshold_pct REAL, opportunity_window TEXT,
  terminal_kind TEXT, exit_reason TEXT, close_reason TEXT, entry_session TEXT, exit_session TEXT,
  grade TEXT NOT NULL, grading_status TEXT NOT NULL, data_quality_status TEXT NOT NULL,
  data_quality_reasons_json TEXT, snapshot_version INTEGER, outcome_version INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`;

const T0 = Date.parse("2026-07-09T14:00:00Z");
const T1 = T0 + 15 * 60_000;

function freshDb() {
  const db = new Database(":memory:");
  db.exec(PAPER_TRADES_DDL);
  db.exec(NEW_TABLES_DDL);
  return db;
}

function insertTrade(db, over = {}) {
  const row = {
    alert_id: null, opportunity_id: null, ticker: "SPY",
    option_symbol: "O:SPY260709C00500000", option_type: "call", strike: 500, expiration: "2026-07-09", dte_at_entry: 0,
    contracts: 1, status: "TAKE_PROFIT", strategy: "zero_dte_momentum", selector_profile: "zero_dte_momentum",
    entry_price: 1.0, exit_price: 1.5, entry_at_ms: T0, exit_at_ms: T1,
    entry_delta: 0.48, entry_spread_pct: 2.5, rel_vol_entry: 3, above_vwap_entry: 1,
    short_rate_entry: 4, session_at_entry: "regular", risk_amount: 35, snapshot_version: 1,
    entry_fees: 0.65, exit_fees: 0.65, entry_slippage: 0.02, exit_slippage: 0.02,
    mfe_pct: 60, mae_pct: -5, exit_reason: "take_profit: target", close_reason: "take_profit: target",
    fingerprint_id: null, fingerprint_version: null, fingerprint_dimensions_json: null, strategy_version: null,
    ...over,
  };
  const keys = Object.keys(row);
  const info = db.prepare(`INSERT INTO paper_trades (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => row[k]));
  return Number(info.lastInsertRowid);
}

test("db.ts declares the new tables additively and the fingerprint columns as guarded ALTERs", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(root, "lib/db.ts"), "utf8");
  assert.ok(/CREATE TABLE IF NOT EXISTS setup_fingerprints/.test(src));
  assert.ok(/CREATE TABLE IF NOT EXISTS paper_trade_outcomes/.test(src));
  assert.ok(/paper_trade_id INTEGER NOT NULL UNIQUE/.test(src));
  for (const col of ["fingerprint_id", "fingerprint_version", "fingerprint_dimensions_json", "strategy_version"]) {
    assert.ok(src.includes(`ALTER TABLE paper_trades ADD COLUMN ${col}`), `guarded ALTER for ${col}`);
  }
});

if (Database) {
  // (11) filled + terminal ⇒ exactly one outcome, fingerprint frozen
  test("filled terminal trade creates one outcome and freezes a fingerprint", () => {
    const db = freshDb();
    const id = insertTrade(db);
    const res = syncOutcomesOnDb(db, Date.now());
    assert.equal(res.fingerprints, 1);
    assert.equal(res.outcomes, 1);
    const t = db.prepare("SELECT * FROM paper_trades WHERE id=?").get(id);
    assert.match(t.fingerprint_id, /^sf1_/);
    const o = db.prepare("SELECT * FROM paper_trade_outcomes WHERE paper_trade_id=?").get(id);
    assert.equal(o.grade, "WIN");
    assert.equal(o.grading_status, "GRADED");
    assert.equal(o.net_pnl, 48.7); // 50 gross − 1.30 fees
    assert.equal(o.selector_profile, "zero_dte_momentum"); // (28) selector retained
    assert.equal(o.option_symbol, "O:SPY260709C00500000");
    assert.equal(o.terminal_kind, "TARGET");
    // Opportunity grade: peak favorable +60% ≥ 25% threshold ⇒ HIT (independent of realized P&L).
    assert.equal(o.opportunity_grade, "HIT");
    assert.equal(o.peak_favorable_pct, 60);
    assert.equal(o.opportunity_threshold_pct, 25);
  });

  // Opportunity is graded independently of realized P&L: a stopped-out LOSS whose
  // contract still ran +50% before expiration is an opportunity HIT.
  test("a realized LOSS whose contract ran green is still an opportunity HIT", () => {
    const db = freshDb();
    const id = insertTrade(db, {
      status: "STOPPED_OUT", exit_price: 0.6, exit_reason: "stop_loss: stop",
      mfe_pct: 12, opportunity_peak_pct: 55, // held window only +12%, but ran +55% after exit
    });
    syncOutcomesOnDb(db, Date.now());
    const o = db.prepare("SELECT * FROM paper_trade_outcomes WHERE paper_trade_id=?").get(id);
    assert.equal(o.grade, "LOSS");                 // realized: stopped out
    assert.equal(o.opportunity_grade, "HIT");      // opportunity: ran +55% to expiration
    assert.equal(o.peak_favorable_pct, 55);        // lifetime peak = max(mfe 12, post-exit 55)
    assert.equal(o.opportunity_window, "to_expiration");
  });

  // (15) idempotent across repeated sweeps + process restarts
  test("repeated sync is idempotent (no duplicate outcomes)", () => {
    const db = freshDb();
    insertTrade(db);
    syncOutcomesOnDb(db, Date.now());
    const second = syncOutcomesOnDb(db, Date.now());
    const third = syncOutcomesOnDb(db, Date.now());
    assert.equal(second.outcomes, 0);
    assert.equal(third.outcomes, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paper_trade_outcomes").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM setup_fingerprints").get().n, 1);
  });

  // (12/13/14) rejected / failed-reval / unfilled / cancelled ⇒ no graded outcome
  test("non-filled trades never produce a graded outcome", () => {
    const db = freshDb();
    insertTrade(db, { status: "READY", entry_price: null });       // never filled
    insertTrade(db, { status: "CANCELLED", entry_price: null, exit_reason: "pre-entry revalidation failed" });
    insertTrade(db, { status: "CANCELLED", entry_price: null, exit_reason: "entry window lapsed" });
    const res = syncOutcomesOnDb(db, Date.now());
    assert.equal(res.outcomes, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paper_trade_outcomes").get().n, 0);
  });

  // (29) bearish research never creates an actionable graded paper trade
  test("bearish put research that never filled creates no graded outcome", () => {
    const db = freshDb();
    insertTrade(db, { option_type: "put", status: "CANCELLED", entry_price: null, exit_reason: "research only — not actionable" });
    const res = syncOutcomesOnDb(db, Date.now());
    assert.equal(res.outcomes, 0);
  });

  // (20) filled but missing exit ⇒ UNGRADABLE outcome recorded (not dropped)
  test("filled terminal trade missing exit price is recorded UNGRADABLE, not dropped", () => {
    const db = freshDb();
    const id = insertTrade(db, { status: "EXPIRED", exit_price: null, exit_at_ms: null });
    const res = syncOutcomesOnDb(db, Date.now());
    assert.equal(res.outcomes, 1);
    const o = db.prepare("SELECT * FROM paper_trade_outcomes WHERE paper_trade_id=?").get(id);
    assert.equal(o.grade, "UNGRADABLE");
    assert.equal(o.grading_status, "UNGRADABLE");
    assert.ok(JSON.parse(o.data_quality_reasons_json).includes("missing_exit_price"));
  });

  // (26) NBBO-backed stock outcome
  test("filled stock trade produces a stock outcome graded on net P&L", () => {
    const db = freshDb();
    const id = insertTrade(db, {
      option_symbol: null, option_type: "call", strike: null, expiration: null, dte_at_entry: null,
      strategy: "momentum_stock", selector_profile: null, contracts: 10,
      entry_price: 20, exit_price: 20.5, entry_delta: null, entry_spread_pct: null,
      entry_fees: 0, exit_fees: 0, status: "TAKE_PROFIT", risk_amount: 9,
    });
    syncOutcomesOnDb(db, Date.now());
    const o = db.prepare("SELECT * FROM paper_trade_outcomes WHERE paper_trade_id=?").get(id);
    assert.equal(o.instrument_type, "stock");
    assert.equal(o.direction, "LONG");
    assert.equal(o.gross_pnl, 5); // (20.5-20)*1*10
    assert.equal(o.net_pnl, 5);
    assert.equal(o.grade, "WIN");
  });

  // (27) no stock fill without executable NBBO ⇒ no outcome (represented by unfilled)
  test("stock candidate that never filled (no executable NBBO) yields no outcome", () => {
    const db = freshDb();
    insertTrade(db, {
      option_symbol: null, status: "CANCELLED", entry_price: null,
      strategy: "momentum_stock", exit_reason: "stock scalp refused: no usable two-sided quote",
    });
    const res = syncOutcomesOnDb(db, Date.now());
    assert.equal(res.outcomes, 0);
  });

  // (10) entry-time fingerprint immutable (COALESCE guard)
  test("a frozen fingerprint is never overwritten by a later freeze", () => {
    const db = freshDb();
    const id = insertTrade(db);
    const first = freezeFingerprintOnDb(db, db.prepare("SELECT * FROM paper_trades WHERE id=?").get(id), Date.now());
    // Mutate a would-be dimension and re-freeze: id must not change.
    db.prepare("UPDATE paper_trades SET entry_delta=0.99, session_at_entry='afterhours' WHERE id=?").run(id);
    const again = freezeFingerprintOnDb(db, db.prepare("SELECT * FROM paper_trades WHERE id=?").get(id), Date.now());
    const stored = db.prepare("SELECT fingerprint_id FROM paper_trades WHERE id=?").get(id).fingerprint_id;
    assert.equal(stored, first, "COALESCE must preserve the original frozen fingerprint");
    assert.notEqual(again, null);
  });

  // (30) additive DDL is repeat-safe
  test("new-table DDL is repeat-safe (exec twice without error)", () => {
    const db = new Database(":memory:");
    db.exec(PAPER_TRADES_DDL);
    db.exec(NEW_TABLES_DDL);
    assert.doesNotThrow(() => { db.exec(NEW_TABLES_DDL); db.exec(PAPER_TRADES_DDL); });
  });

  test("generateOutcomeOnDb refuses a non-terminal filled trade", () => {
    const db = freshDb();
    const id = insertTrade(db, { status: "ENTERED", exit_price: null, exit_at_ms: null });
    const made = generateOutcomeOnDb(db, db.prepare("SELECT * FROM paper_trades WHERE id=?").get(id), Date.now());
    assert.equal(made, false);
  });
}
