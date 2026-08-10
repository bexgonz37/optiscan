/**
 * tests/paper-trade-excursion-column.test.mjs
 *
 * `options_paper_trades.mfe_pct` / `mae_pct` are the TRADE-level copy of the excursion.
 * They are observability columns — no exit, stop or gate reads them — but the AI, the
 * quant lanes and the report cards do, so a wrong value there is a wrong number in
 * front of a reader just the same.
 *
 * The invariant is the one the case level already enforces:
 *
 *     A TRADE'S EXCURSION IS COMPUTED ONLY FROM MARKS ON THAT TRADE'S OWN CONTRACT.
 *
 * The aggregate used to be `MAX(return_pct) ... WHERE trade_id=?` with no contract
 * predicate, and the 0DTE lane ratcheted `mfe_pct` off its own previous stored value.
 * Both are the shape that produced the +185.4% case peak: a price observed on one
 * contract, divided by an entry paid on another. A mirror is normally single-contract,
 * so these tests deliberately construct the abnormal case — that is the only condition
 * under which the two implementations differ, and therefore the only one that proves
 * the path is gone rather than merely unused.
 *
 * Fixture is the SAME migration production runs, not a hand-copy.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { gradeOpenOptionPositionsOnDb } from "../lib/research/options/grade.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const NOW = Date.parse("2026-08-10T15:00:00.000Z");
const FROZEN = "O:GOOGL260807P00357500";
const FOREIGN = "O:GOOGL260819P00355000";
const ENV = {
  REAL_OPTION_PAPER_ENABLED: "1",
  INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
  OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED: "0",
};

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

function seedOpenTrade(d) {
  d.prepare(
    `INSERT INTO options_paper_trades
      (id, option_symbol, side, strike, expiration, dte, result_class, entry_fill, status,
       paper_kind, alert_id, entered_at_ms, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(901, FROZEN, "put", 357.5, "2026-08-31", 21, "REAL_OPTION_PAPER", 2.0, "ENTERED",
    "DELIVERED_ALERT_PAPER", "oa_x", NOW - 600_000, NOW, NOW);
  return 901;
}

function mark(d, tradeId, occ, returnPct, atMs) {
  d.prepare(
    `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, return_pct, created_at_ms)
     VALUES (?,?,?,?,?)`,
  ).run(tradeId, occ, atMs, returnPct, atMs);
}

/** A quote that marks the position at roughly +10% against a 2.00 entry. */
const quoteDeps = {
  now: () => NOW,
  getQuote: async () => ({ bid: 2.15, ask: 2.25, quoteAgeMs: 1000, providerTimestamp: NOW - 1000 }),
};

test("a foreign-contract mark cannot raise the trade's stored peak", async () => {
  const d = db();
  const id = seedOpenTrade(d);
  mark(d, id, FROZEN, 4, NOW - 300_000);
  // A price this trade never paid for, on a contract it never bought.
  mark(d, id, FOREIGN, 185.4077, NOW - 240_000);

  await gradeOpenOptionPositionsOnDb(d, quoteDeps, ENV);

  const row = d.prepare("SELECT mfe_pct, mae_pct FROM options_paper_trades WHERE id=?").get(id);
  assert.ok(row.mfe_pct != null, "the pass recorded an excursion");
  assert.ok(
    row.mfe_pct < 100,
    `the foreign +185.4% must not reach the stored peak (got ${row.mfe_pct})`,
  );
});

test("a foreign-contract mark cannot deepen the trade's stored drawdown", async () => {
  const d = db();
  const id = seedOpenTrade(d);
  mark(d, id, FROZEN, 4, NOW - 300_000);
  mark(d, id, FOREIGN, -92, NOW - 240_000);

  await gradeOpenOptionPositionsOnDb(d, quoteDeps, ENV);

  const row = d.prepare("SELECT mae_pct FROM options_paper_trades WHERE id=?").get(id);
  assert.ok(
    row.mae_pct > -50,
    `the foreign -92% must not reach the stored drawdown (got ${row.mae_pct})`,
  );
});

test("marks on the trade's own contract DO set its extremes", async () => {
  const d = db();
  const id = seedOpenTrade(d);
  mark(d, id, FROZEN, 33, NOW - 300_000);
  mark(d, id, FROZEN, -18, NOW - 240_000);

  await gradeOpenOptionPositionsOnDb(d, quoteDeps, ENV);

  const row = d.prepare("SELECT mfe_pct, mae_pct FROM options_paper_trades WHERE id=?").get(id);
  // Filtering must not be so aggressive that it discards the trade's real trajectory.
  assert.equal(row.mfe_pct, 33);
  assert.equal(row.mae_pct, -18);
});

test("case sensitivity in a stored OCC does not orphan a trade's own marks", async () => {
  const d = db();
  const id = seedOpenTrade(d);
  mark(d, id, FROZEN.toLowerCase(), 27, NOW - 300_000);

  await gradeOpenOptionPositionsOnDb(d, quoteDeps, ENV);

  const row = d.prepare("SELECT mfe_pct FROM options_paper_trades WHERE id=?").get(id);
  assert.equal(row.mfe_pct, 27, "identity is the contract, not its capitalisation");
});
