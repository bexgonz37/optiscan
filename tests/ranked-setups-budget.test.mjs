/**
 * Tests for ranked setups + provider budget estimates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildRankedSetupsNow } from "../lib/research/options/ranked-setups.ts";
import { estimateMassiveRequestBudget } from "../lib/research/options/provider-budget.ts";

test("provider budget defaults keep research off and caps present", () => {
  const b = estimateMassiveRequestBudget({});
  assert.equal(b.provider, "massive_polygon");
  assert.equal(b.priorities.liveScanner, 1);
  assert.ok(b.totals.softCapSubscriberTier0 > 0);
  assert.ok(b.totals.softCapZeroDteResearch > 0);
  const r0 = b.lanes.find((l) => l.lane === "zero_dte_research_r0");
  assert.equal(r0.estUnderlyingPerMin, 0);
});

test("ranked setups map delivery outcomes to SEND/WATCH/BLOCK/RESEARCH", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE options_delivery_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT, symbol TEXT, strategy TEXT, side TEXT, tier INTEGER,
      outcome TEXT, reason TEXT, quality REAL, rank INTEGER, batch_size INTEGER,
      components_json TEXT, alert_id TEXT, final_delivery_outcome TEXT, final_delivery_reason TEXT,
      created_at_ms INTEGER
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT, strategy TEXT, option_symbol TEXT, side TEXT,
      research_only INTEGER, state TEXT, entry_mid REAL, target_t1 REAL, target_stop REAL,
      opportunity_case_id TEXT, created_at_ms INTEGER, updated_at_ms INTEGER
    );
  `);
  const now = Date.now();
  db.prepare(
    `INSERT INTO options_delivery_decisions (
      batch_id, symbol, strategy, side, tier, outcome, reason, quality, rank, batch_size,
      components_json, alert_id, final_delivery_outcome, final_delivery_reason, created_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "b1", "SPY", "momentum_acceleration", "call", 0, "DELIVER_TO_DISCORD", "top", 0.9, 1, 2,
    JSON.stringify({ optionSymbol: "O:SPY260727C00635000", bid: 1.2, ask: 1.3, entryMid: 1.25, targetT1: 1.7, targetStop: 0.9, spreadPct: 8, entryQuality: "PASS" }),
    "a1", "DELIVER_TO_DISCORD", "selected", now - 5000,
  );
  db.prepare(
    `INSERT INTO options_alerts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("a1", "SPY", "momentum_acceleration", "O:SPY260727C00635000", "call", 0, "SENT", 1.25, 1.7, 0.9, "oc1", now - 5000, now - 5000);

  const rows = buildRankedSetupsNow(db, now, 5);
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].systemAction, "SEND");
  assert.equal(rows[0].symbol, "SPY");
  assert.equal(rows[0].realExecutableQuote, true);
  assert.ok(rows[0].href.includes("intelligence") || rows[0].href.includes("callouts"));
});
