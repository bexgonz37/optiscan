/**
 * The daily recap must never present a SUBSCRIBER-population count as an unlabelled total.
 *
 * On 2026-08-07 the recap printed "Callouts: sent 0" and "Paper: opened 0" on a day when three
 * owner CALL openings had provably been delivered (QQQ 10/16 $750C, META 08/14 $600C,
 * SPY 08/21 $777C). Both numbers were arithmetically correct for the population they queried —
 * `options_alerts.state='SENT'` and `paper_kind='DELIVERED_ALERT_PAPER'` — and both are
 * structurally blind to owner openings, which write discord_deliveries + OWNER_VALIDATION_PAPER
 * and never write an options_alerts row.
 *
 * The recap is also the deterministic context the nightly AI reasons over, so an unlabelled
 * zero here becomes a false premise everywhere downstream.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  buildDailySummaryOnDb,
  formatDailySummaryMessage,
  etDay,
} from "../lib/research/options/daily-summary.ts";

const NOW = Date.parse("2026-08-07T20:05:00Z");
const DAY = etDay(NOW);
const START = Date.parse(`${DAY}T04:00:00Z`);
const AT = START + 11 * 3_600_000; // ~11:00 ET

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, side TEXT, selected_strategy TEXT,
      state TEXT, why TEXT, earliness_phase TEXT, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, status TEXT NOT NULL,
      paper_kind TEXT, return_pct REAL, entered_at_ms INTEGER, exit_at_ms INTEGER
    );
    CREATE TABLE discord_deliveries (
      delivery_id TEXT PRIMARY KEY, payload_type TEXT, lifecycle_state TEXT, status TEXT,
      option_side TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE runtime_keys (key TEXT PRIMARY KEY, value TEXT, updated_at_ms INTEGER);
  `);
  return d;
}

/** Reproduce 2026-08-07: three owner CALL openings sent, zero subscriber activity. */
function seedOwnerOnlyDay(d, { mirrored }) {
  const iso = new Date(AT).toISOString();
  for (const [i, side] of [["a", "call"], ["b", "call"], ["c", "call"]]) {
    d.prepare(
      `INSERT INTO discord_deliveries (delivery_id, payload_type, lifecycle_state, status, option_side, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(`dd_${i}`, "owner_intraday_actionable", "OPENING", "SENT", side, iso);
  }
  for (let i = 0; i < mirrored; i++) {
    d.prepare(
      `INSERT INTO options_paper_trades (option_symbol, status, paper_kind, entered_at_ms)
       VALUES (?,?,?,?)`,
    ).run(`O:TEST26082${i}C00100000`, "ENTERED", "OWNER_VALIDATION_PAPER", AT);
  }
  d.prepare(
    "INSERT INTO options_candidates (symbol, side, selected_strategy, state, created_at_ms) VALUES (?,?,?,?,?)",
  ).run("QQQ", "call", "momentum_acceleration", "READY", AT);
}

test("owner openings are counted and labelled, never folded into subscriber callouts", () => {
  const d = db();
  seedOwnerOnlyDay(d, { mirrored: 3 });

  const s = buildDailySummaryOnDb(d, NOW, { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1" });
  assert.ok(s, "a day with owner openings is never 'no activity'");

  // The subscriber population is genuinely zero and must stay zero — it is not wrong, only partial.
  assert.equal(s.calloutsSent, 0);
  assert.equal(s.paperOpened, 0);

  // The owner population is separate and non-zero.
  assert.equal(s.owner.sent, 3);
  assert.equal(s.owner.calls, 3);
  assert.equal(s.owner.puts, 0);
  assert.equal(s.owner.mirrored, 3);
  assert.equal(s.owner.open, 3);

  const msg = formatDailySummaryMessage(s);
  // Every zero must name the audience it belongs to, so no reader — human or AI — can read
  // "sent 0" as "nothing was sent today".
  assert.match(msg, /SUBSCRIBER callouts: sent 0/);
  assert.match(msg, /OWNER validation: sent 3 \(3 CALL \/ 0 PUT\)/);
  assert.doesNotMatch(msg, /^Callouts: sent/m, "no unlabelled callout total may survive");
});

test("an owner opening with no paper mirror is reported, not silently dropped", () => {
  const d = db();
  seedOwnerOnlyDay(d, { mirrored: 0 }); // exactly the 2026-08-07 production state

  const s = buildDailySummaryOnDb(d, NOW, { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1" });
  assert.equal(s.owner.sent, 3);
  assert.equal(s.owner.mirrored, 0);

  const msg = formatDailySummaryMessage(s);
  assert.match(msg, /3 owner opening\(s\) left NO paper evidence/);
});

test("a fully mirrored day carries no unmirrored warning", () => {
  const d = db();
  seedOwnerOnlyDay(d, { mirrored: 3 });
  const msg = formatDailySummaryMessage(buildDailySummaryOnDb(d, NOW, { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1" }));
  assert.doesNotMatch(msg, /NO paper evidence/);
});
