/**
 * Options Paper Trading Integrity Audit — proof tests.
 * Encodes current formulas and invariants from lib/research/options/paper.ts,
 * grade.ts, report.ts, and the legacy paper_trades lane. Failing tests document
 * desired behavior only when paired with finding IDs in docs/OPTIONS_PAPER_INTEGRITY_AUDIT.md.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  conservativeEntryFill,
  realOptionExit,
  buildRealOptionEntry,
  persistDeliveredMirrorOnDb,
  persistRealOptionPaperOnDb,
} from "../lib/research/options/paper.ts";
import { decideOptionExit, gradeOpenOptionPositionsOnDb, defaultGradeConfig } from "../lib/research/options/grade.ts";
import { readOptionsReportOnDb } from "../lib/research/options/report.ts";
import { computeOptionTargets } from "../lib/research/options/targets.ts";

const NOW = 1_700_000_000_000;
const ENV = { REAL_OPTION_PAPER_ENABLED: "1", INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1" };

function miniDb() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_symbol TEXT NOT NULL,
      side TEXT,
      strike REAL,
      expiration TEXT,
      dte INTEGER,
      result_class TEXT NOT NULL,
      bid REAL,
      ask REAL,
      mid REAL,
      spread_pct REAL,
      entry_fill REAL,
      volume REAL,
      open_interest REAL,
      iv REAL,
      delta REAL,
      underlying_price REAL,
      strategy TEXT,
      target REAL,
      invalidation REAL,
      provenance TEXT,
      status TEXT NOT NULL,
      exit_fill REAL,
      pnl REAL,
      return_pct REAL,
      mfe_pct REAL,
      mae_pct REAL,
      last_mark_return_pct REAL,
      exit_reason TEXT,
      entered_at_ms INTEGER,
      exit_at_ms INTEGER,
      session TEXT,
      core_broad TEXT,
      feature_snapshot_json TEXT,
      paper_kind TEXT,
      alert_id TEXT,
      entry_source TEXT,
      experiment_id TEXT,
      experiment_variant TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE VIEW options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
    CREATE VIEW options_paper_research AS SELECT * FROM options_paper_trades WHERE paper_kind='RESEARCH_ONLY_PAPER';
  `);
  return d;
}

function recomputeOptionPnL(entryFill, exitFill, contracts = 1, fees = 0) {
  const entryDebit = entryFill * 100 * contracts;
  const exitValue = exitFill * 100 * contracts;
  const realizedPnL = exitValue - entryDebit - fees;
  const optionReturnPct = entryDebit > 0 ? (realizedPnL / entryDebit) * 100 : 0;
  return { entryDebit, exitValue, realizedPnL, optionReturnPct };
}

test("F1: option return uses premium change, not underlying percent", () => {
  const entryFill = 1.0;
  const ex = realOptionExit(entryFill, 1.45, 1.55);
  assert.equal(ex.returnPct, 47, "1.00 → ~1.47 exit fill is +47% option return, not underlying move");
  assert.notEqual(ex.returnPct, 50, "must not assume naive mid-to-mid without slippage model");
});

test("F2: worthless expiration with fresh penny quote is near -100%, not exactly -100%", () => {
  const ex = realOptionExit(2.0, 0.01, 0.02);
  assert.ok(ex.returnPct < -99 && ex.returnPct > -100, "penny bid still prices a small recovery");
  assert.equal(ex.pnl, +((ex.exitFill - 2.0) * 100).toFixed(4));
});

test("F3: expiration without quote closes honestly with null P&L (not fabricated -100%)", () => {
  const cfg = defaultGradeConfig({});
  const pos = {
    id: 1,
    option_symbol: "O:NVDA260117C00100000",
    side: "call",
    strike: 100,
    expiration: "2026-01-16",
    dte: 0,
    entry_fill: 2.0,
    result_class: "REAL_OPTION_PAPER",
    strategy: "zero_dte_index",
    underlying_price: 100,
    target: null,
    invalidation: null,
    entered_at_ms: NOW,
    status: "ENTERED",
  };
  const d = decideOptionExit(pos, null, Date.parse("2026-01-16T21:00:00Z"), cfg);
  assert.equal(d.reason, "expiration_no_quote");
  assert.equal(d.pnl, null);
  assert.equal(d.returnPct, null);
});

test("F4: two contracts doubles dollar P&L but not return_pct", () => {
  const one = realOptionExit(2.0, 3.0, 3.2, 1);
  const two = realOptionExit(2.0, 3.0, 3.2, 2);
  assert.equal(one.returnPct, two.returnPct);
  assert.equal(two.pnl, one.pnl * 2);
});

test("F5: spread/slippage changes simulated entry and exit fills", () => {
  const tight = conservativeEntryFill(1.0, 1.1);
  const wide = conservativeEntryFill(1.0, 1.5);
  assert.ok(wide > tight, "wider spread pays more toward ask on entry");
  const sellTight = realOptionExit(tight, 2.0, 2.1).exitFill;
  const sellWide = realOptionExit(wide, 2.0, 2.4).exitFill;
  assert.ok(sellWide < sellTight + 0.3, "exit fill moves toward bid, scaled by spread");
});

test("F6: report cumulative curve sums return_pct points, not dollar equity", () => {
  const d = miniDb();
  const entry = buildRealOptionEntry({
    quote: {
      optionSymbol: "O:NVDA260117C00100000",
      side: "call",
      strike: 100,
      expiration: "2026-01-17",
      dte: 5,
      bid: 2.0,
      ask: 2.1,
      volume: 500,
      openInterest: 2000,
      iv: 0.5,
      delta: 0.5,
      quoteAgeMs: 1000,
      providerTimestamp: NOW,
    },
    underlyingPrice: 100,
    strategy: "momentum_acceleration",
  }, ENV);
  persistDeliveredMirrorOnDb(d, entry, NOW, "oa_a");
  persistDeliveredMirrorOnDb(d, entry, NOW + 1, "oa_b");
  d.prepare("UPDATE options_paper_trades SET status='EXITED', return_pct=50 WHERE alert_id='oa_a'").run();
  d.prepare("UPDATE options_paper_trades SET status='EXITED', return_pct=-20 WHERE alert_id='oa_b'").run();
  const rep = readOptionsReportOnDb(d);
  assert.equal(rep.subscriberPerformance.expectancyPct, 15, "avg of +50 and -20 return points");
  assert.equal(rep.subscriberPerformance.maxDrawdownPct, 20, "peak-to-trough on cumulative return points");
});

test("F7: stock-paper and options-paper subscriber curves stay separated", () => {
  const d = miniDb();
  const entry = buildRealOptionEntry({
    quote: {
      optionSymbol: "O:NVDA260117C00100000",
      side: "call",
      strike: 100,
      expiration: "2026-01-17",
      dte: 5,
      bid: 1.0,
      ask: 1.1,
      volume: 500,
      openInterest: 2000,
      iv: 0.5,
      delta: 0.5,
      quoteAgeMs: 1000,
      providerTimestamp: NOW,
    },
    underlyingPrice: 100,
    strategy: "momentum_acceleration",
  }, ENV);
  persistDeliveredMirrorOnDb(d, entry, NOW, "oa_sub");
  persistRealOptionPaperOnDb(d, entry, NOW, { paperKind: "RESEARCH_ONLY_PAPER" });
  d.prepare("UPDATE options_paper_trades SET status='EXITED', return_pct=100 WHERE paper_kind='DELIVERED_ALERT_PAPER'").run();
  d.prepare("UPDATE options_paper_trades SET status='EXITED', return_pct=900 WHERE paper_kind='RESEARCH_ONLY_PAPER'").run();
  const rep = readOptionsReportOnDb(d);
  assert.equal(rep.subscriberPerformance.expectancyPct, 100);
  assert.equal(rep.researchPaper.closed, 1);
  assert.match(rep.note, /NEVER blended/);
});

test("F8: grader persists exit values matching realOptionExit formula", async () => {
  const d = miniDb();
  d.prepare(
    `INSERT INTO options_paper_trades (option_symbol, side, strike, expiration, dte, result_class, entry_fill, strategy, status, entered_at_ms, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("O:NVDA260117C00100000", "call", 100, "2026-01-17", 5, "REAL_OPTION_PAPER", 2.0, "momentum_acceleration", "ENTERED", NOW, NOW, NOW);
  const expected = realOptionExit(2.0, 5.0, 5.2);
  const res = await gradeOpenOptionPositionsOnDb(
    d,
    { now: () => NOW + 60_000, getQuote: async () => ({ bid: 5.0, ask: 5.2, quoteAgeMs: 1000 }) },
    ENV,
  );
  assert.equal(res.graded, 1);
  const row = d.prepare("SELECT exit_fill, pnl, return_pct FROM options_paper_trades").get();
  assert.equal(row.exit_fill, expected.exitFill);
  assert.equal(row.pnl, expected.pnl);
  assert.equal(row.return_pct, expected.returnPct);
});

test("F9: delivered mirror uses frozen mid entry, shadow uses conservative fill when gated", () => {
  const quote = {
    optionSymbol: "O:NVDA260117C00100000",
    side: "call",
    strike: 100,
    expiration: "2026-01-17",
    dte: 5,
    bid: 1.0,
    ask: 1.05,
    volume: 500,
    openInterest: 2000,
    iv: 0.5,
    delta: 0.5,
    quoteAgeMs: 1000,
    providerTimestamp: NOW,
  };
  const shadow = buildRealOptionEntry({ quote, underlyingPrice: 100, strategy: "momentum_acceleration" }, ENV);
  assert.equal(shadow.entryFill, conservativeEntryFill(1.0, 1.05));
  const targets = computeOptionTargets(shadow.mid, "momentum_acceleration");
  const delivered = { ...shadow, entryFill: shadow.mid, target: targets.t1, invalidation: targets.stop };
  assert.equal(delivered.entryFill, 1.025, "subscriber mirror uses displayed mid, not conservative fill");
  assert.notEqual(delivered.entryFill, shadow.entryFill);
});

test("F10: persisted row recomputation matches stored pnl/return_pct for five traced scenarios", () => {
  const scenarios = [
    { label: "target_hit winner", entryFill: 2.0, exitBid: 5.0, exitAsk: 5.2 },
    { label: "stop_hit loser", entryFill: 2.0, exitBid: 1.0, exitAsk: 1.1 },
    { label: "small winner", entryFill: 1.0, exitBid: 1.45, exitAsk: 1.55 },
    { label: "penny residual", entryFill: 2.0, exitBid: 0.01, exitAsk: 0.02 },
    { label: "wide spread exit", entryFill: 1.5, exitBid: 2.0, exitAsk: 2.6 },
  ];
  for (const s of scenarios) {
    const ex = realOptionExit(s.entryFill, s.exitBid, s.exitAsk);
    const rc = recomputeOptionPnL(s.entryFill, ex.exitFill);
    assert.equal(ex.pnl, +rc.realizedPnL.toFixed(4), `${s.label}: pnl matches qty×100×premium delta`);
    assert.equal(ex.returnPct, +rc.optionReturnPct.toFixed(4), `${s.label}: return_pct matches dollar basis`);
  }
});
