/**
 * OPEN_POSITIONS_ONLY scope (2026-08-18 performance audit).
 *
 * The homepage used to build the ENTIRE paper-chain diagnostic -- every alert ever
 * SENT, three to five queries each -- and then throw away all but the handful of open
 * positions. The scope added to fix that is only safe if it stays a VIEW over the same
 * evidence: the moment it computes an open position differently from the full
 * diagnostic, the homepage becomes a second source of truth about what the owner holds.
 *
 * So the load-bearing assertion here is not "it is faster". It is that the rows it
 * returns are IDENTICAL, field for field, to the rows the full diagnostic returns for
 * the same trades -- and that it publishes no aggregate at all, because a profit factor
 * over "the trades that happen to still be open" is survivorship bias wearing the same
 * field name as the real number.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildPaperChainDiagnostic } from "../lib/research/options/paper-chain.ts";

const ENV = { OPTIONS_GRADE_MAX_QUOTE_AGE_MS: "900000" };

function install(d) {
  d.exec(`
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT,
      research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT,
      delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0,
      discord_status INTEGER, discord_message_id TEXT, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT, attempted_at_ms INTEGER, sent_at_ms INTEGER, session_state TEXT, entry_mid REAL,
      delivered_spread_pct REAL, quote_ts_ms INTEGER, target_t1 REAL, target_t2 REAL, target_stop REAL,
      target_method TEXT, opportunity_case_id TEXT, opportunity_fingerprint TEXT, thesis_fingerprint TEXT,
      paper_trade_id INTEGER, paper_reservation_state TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
      result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL,
      volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL,
      strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL,
      exit_fill REAL, pnl REAL, return_pct REAL, mfe_pct REAL, mae_pct REAL, last_mark_return_pct REAL,
      exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT,
      feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT,
      experiment_id TEXT, experiment_variant TEXT, thesis_fingerprint TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL, option_symbol TEXT,
      mark_at_ms INTEGER NOT NULL, bid REAL, ask REAL, exit_fill REAL, return_pct REAL,
      quote_age_ms INTEGER, created_at_ms INTEGER NOT NULL
    );
  `);
}

/** One SENT alert with a DELIVERED mirror in `status`, plus a fresh grading mark. */
function seed(d, { alertId, symbol, status, sentAtMs, entry = 1.0, mark = 1.2 }) {
  const occ = "O:" + symbol + "260725C00100000";
  d.prepare(
    `INSERT INTO options_alerts (alert_id, candidate_symbol, option_symbol, side, research_only, state,
       discord_message_id, paper_linked, sent_at_ms, entry_mid, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,0,'SENT',?,1,?,?,?,?)`,
  ).run(alertId, symbol, occ, "call", "msg-" + alertId, sentAtMs, entry, sentAtMs, sentAtMs);
  const info = d.prepare(
    `INSERT INTO options_paper_trades (option_symbol, side, result_class, entry_fill, status, paper_kind,
       alert_id, entered_at_ms, exit_at_ms, exit_fill, last_mark_return_pct, created_at_ms, updated_at_ms)
     VALUES (?,?,'open',?,?,'DELIVERED_ALERT_PAPER',?,?,?,?,?,?,?)`,
  ).run(
    occ, "call", entry, status, alertId, sentAtMs,
    status === "EXITED" ? sentAtMs + 60_000 : null,
    status === "EXITED" ? mark : null,
    ((mark - entry) / entry) * 100, sentAtMs, sentAtMs,
  );
  d.prepare(`UPDATE options_alerts SET paper_trade_id=? WHERE alert_id=?`).run(info.lastInsertRowid, alertId);
  d.prepare(
    `INSERT INTO options_paper_marks (trade_id, option_symbol, mark_at_ms, bid, ask, exit_fill, return_pct, quote_age_ms, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    info.lastInsertRowid, occ,
    status === "EXITED" ? sentAtMs + 60_000 : sentAtMs + 30_000,
    mark - 0.02, mark + 0.02, mark, ((mark - entry) / entry) * 100, 500, sentAtMs,
  );
}

function fixture() {
  const d = new Database(":memory:");
  install(d);
  const base = Date.UTC(2026, 7, 18, 14, 30);
  // Two open, three closed -- so "all history" genuinely differs from "currently open".
  seed(d, { alertId: "a-open-1", symbol: "NVDA", status: "ENTERED", sentAtMs: base });
  seed(d, { alertId: "a-closed-1", symbol: "AMD", status: "EXITED", sentAtMs: base - 3_600_000 });
  seed(d, { alertId: "a-open-2", symbol: "TSLA", status: "ENTERED", sentAtMs: base - 7_200_000 });
  seed(d, { alertId: "a-closed-2", symbol: "AAPL", status: "EXITED", sentAtMs: base - 86_400_000 });
  seed(d, { alertId: "a-closed-old", symbol: "MSFT", status: "EXITED", sentAtMs: base - 30 * 86_400_000 });
  return d;
}

test("OPEN_POSITIONS_ONLY returns exactly the open delivered mirrors", () => {
  const d = fixture();
  const open = buildPaperChainDiagnostic(d, ENV, 12, null, "OPEN_POSITIONS_ONLY");
  assert.equal(open.scope, "OPEN_POSITIONS_ONLY");
  assert.deepEqual(
    open.rows.map((r) => r.alertId).sort(),
    ["a-open-1", "a-open-2"],
    "only the ENTERED mirrors, and every one of them",
  );
  assert.ok(open.rows.every((r) => r.paperStatus === "ENTERED"));
});

test("OPEN_POSITIONS_ONLY is a VIEW: its rows are field-identical to the full diagnostic's", () => {
  const d = fixture();
  const full = buildPaperChainDiagnostic(d, ENV, 500, null, "FULL");
  const open = buildPaperChainDiagnostic(d, ENV, 12, null, "OPEN_POSITIONS_ONLY");

  const fullOpen = new Map(
    full.rows.filter((r) => r.paperStatus === "ENTERED").map((r) => [r.alertId, r]),
  );
  assert.equal(fullOpen.size, open.rows.length, "the two scopes agree on WHICH positions are open");
  assert.ok(open.rows.length > 0, "the fixture must actually exercise the comparison");

  // Two fields are excluded from the equality check for honest reasons, and both are
  // still checked, just not with deepEqual:
  //   `whatHappened` — exit-policy research, which the open scope deliberately does not
  //                    compute at all (asserted null in the aggregates test below).
  //   `ageMs`        — read off the wall clock, so the two calls differ by however many
  //                    milliseconds elapsed between them. Compared with a tolerance
  //                    instead, which is the real invariant: the same position, aged the
  //                    same way, not merely a field that happens to exist in both.
  const strip = (r) => { const { whatHappened, ageMs, ...rest } = r; return rest; };
  for (const row of open.rows) {
    const reference = fullOpen.get(row.alertId);
    assert.ok(reference, "full diagnostic is missing " + row.alertId);
    assert.deepEqual(strip(row), strip(reference), "row " + row.alertId + " diverges between scopes");
    assert.ok(
      Math.abs(Number(row.ageMs) - Number(reference.ageMs)) < 5_000,
      "row " + row.alertId + " ages differently between scopes",
    );
  }
});

test("OPEN_POSITIONS_ONLY publishes NO aggregate — a partial set must not price itself", () => {
  const d = fixture();
  const open = buildPaperChainDiagnostic(d, ENV, 12, null, "OPEN_POSITIONS_ONLY");

  assert.equal(open.sumPnlUsd, null, "realized P&L over open-only rows would be a number nobody realized");
  assert.equal(open.verifiedSumPnlUsd, null);
  assert.equal(open.exitPolicyResearch, null, "exit-policy research over unfinished trades is not research");
  assert.equal(open.verifiedPnlBreakdown, null);
  assert.equal(
    open.account.currentEquityUsd, null,
    "equity computed from only the open trades is survivorship bias with the real field name",
  );

  // And the full scope, on the same database, still does publish them.
  const full = buildPaperChainDiagnostic(d, ENV, 500, null, "FULL");
  assert.equal(full.scope, "FULL");
  assert.notEqual(full.sumPnlUsd, null, "the full diagnostic must still report realized P&L");
  assert.ok(full.exitPolicyResearch, "the full diagnostic must still run exit-policy research");
});

test("the default scope is FULL — no existing caller silently loses its aggregates", () => {
  const d = fixture();
  const dflt = buildPaperChainDiagnostic(d, ENV, 500);
  assert.equal(dflt.scope, "FULL");
  assert.notEqual(dflt.sumPnlUsd, null);
  assert.ok(dflt.rows.length > 2, "default scope still walks closed history");
});
