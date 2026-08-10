/**
 * tests/historical-derive.test.mjs
 *
 * HIST_DERIVE_V1 — persisting replay discovery rows and derived market context.
 *
 * Runs against a REAL in-memory SQLite database rather than a fake, because the properties
 * under test are properties of the schema: the primary key is what makes a re-run
 * idempotent, and the origin being IN that key is what stops a reconstruction satisfying a
 * lookup meant for a live observation. A fake would let both pass while the DDL was wrong.
 *
 * What is being guarded:
 *
 *   · a replay row must never be indistinguishable from an observed one
 *   · re-running the same version must UPDATE, not duplicate
 *   · running a NEW version must ADD, not overwrite the old one
 *   · a context row that knows nothing must not be written at all, because
 *     readHistoricalMarketContextOnDb would return it as the context in force
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  persistPreMoveReplayOnDb,
  deriveAndPersistMarketContext,
  CONTEXT_SAMPLE_MS,
} from "../lib/research/historical/derive.ts";
import { PRE_MOVE_REPLAY_VERSION, REPLAY_ORIGIN } from "../lib/research/historical/pre-move-replay.ts";
import { readHistoricalMarketContextOnDb } from "../lib/research/historical/market-context.ts";

const DDL = `
CREATE TABLE IF NOT EXISTS historical_pre_move_replay (
  occ TEXT NOT NULL, decision_at_ms INTEGER NOT NULL, replay_version TEXT NOT NULL,
  origin TEXT NOT NULL, opportunity_case_id TEXT, event_id TEXT, symbol TEXT NOT NULL,
  side TEXT, session_date TEXT, detected_at_ms INTEGER, stage TEXT NOT NULL,
  underlying_move_consumed_pct REAL, premium_expansion_consumed_pct REAL,
  move_consumed_fraction REAL, reward_remaining_fraction REAL, reward_remaining_band TEXT,
  entry_ask REAL, spread_pct REAL, dte INTEGER, moneyness_pct REAL, regime TEXT,
  market_alignment TEXT, underlying_bars_used INTEGER NOT NULL DEFAULT 0,
  missing_fields_json TEXT, evidence_quality TEXT NOT NULL,
  source_quote_rows INTEGER, source_bar_rows INTEGER, reason TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (occ, decision_at_ms, replay_version, origin)
);
CREATE TABLE IF NOT EXISTS historical_market_context (
  session_date TEXT NOT NULL, as_of_ms INTEGER NOT NULL, context_version TEXT NOT NULL,
  origin TEXT NOT NULL, broad_direction TEXT, spy_trend TEXT, qqq_trend TEXT,
  spy_change_pct REAL, qqq_change_pct REAL, spy_above_vwap INTEGER, qqq_above_vwap INTEGER,
  volatility_state TEXT, trend_state TEXT, session_state TEXT,
  bars_used INTEGER NOT NULL DEFAULT 0, missing_fields_json TEXT, quality TEXT NOT NULL,
  ingest_version TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_date, as_of_ms, origin)
);
CREATE TABLE IF NOT EXISTS historical_underlying_bars (
  symbol TEXT NOT NULL, timeframe TEXT NOT NULL, ts_ms INTEGER NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL, vwap REAL, trade_count INTEGER,
  source TEXT NOT NULL, ingest_version TEXT NOT NULL, quality TEXT NOT NULL,
  ingested_at_ms INTEGER NOT NULL, PRIMARY KEY (symbol, timeframe, ts_ms)
);
CREATE TABLE IF NOT EXISTS historical_option_quotes (
  occ TEXT NOT NULL, ts_ms INTEGER NOT NULL, bid REAL, ask REAL, bid_size REAL, ask_size REAL,
  source TEXT NOT NULL, ingest_version TEXT NOT NULL, ingested_at_ms INTEGER NOT NULL,
  PRIMARY KEY (occ, ts_ms)
);
`;

function db() {
  const d = new Database(":memory:");
  d.exec(DDL);
  return d;
}

const OCC = "O:NVDA260807C00180000";
const T = Date.parse("2026-08-03T14:30:00Z");

function replayRow(over = {}) {
  return {
    version: PRE_MOVE_REPLAY_VERSION,
    origin: REPLAY_ORIGIN,
    occ: OCC,
    symbol: "NVDA",
    side: "CALL",
    sessionDate: "2026-08-03",
    detectedAtMs: T - 60_000,
    decisionAtMs: T,
    stage: "EARLY_CONFIRMATION",
    underlyingMoveConsumedPct: 0.4,
    premiumExpansionConsumedPct: 12,
    moveConsumedFraction: 0.2,
    rewardRemainingFraction: 0.8,
    rewardRemainingBand: "MOST_REMAINING",
    entryAsk: 2.5,
    spreadPct: 2.1,
    dte: 4,
    moneynessPct: 1.2,
    regime: "RISK_ON",
    marketAlignment: "ALIGNED",
    underlyingBarsUsed: 60,
    missingFields: [],
    evidenceQuality: "COMPLETE",
    reason: "test",
    ...over,
  };
}

const rows = (d) => d.prepare("SELECT * FROM historical_pre_move_replay").all();

// ── replay persistence ───────────────────────────────────────────────────────

test("a persisted replay row is stamped REPLAY_DERIVED, never observed", () => {
  const d = db();
  assert.equal(persistPreMoveReplayOnDb(d, replayRow(), 1000), true);
  const [r] = rows(d);
  assert.equal(r.origin, "REPLAY_DERIVED");
  assert.notEqual(r.origin, "OBSERVED_LIVE");
  assert.equal(r.replay_version, PRE_MOVE_REPLAY_VERSION);
  assert.equal(r.stage, "EARLY_CONFIRMATION");
  assert.equal(r.evidence_quality, "COMPLETE");
});

test("re-deriving the same moment updates in place rather than duplicating", () => {
  const d = db();
  persistPreMoveReplayOnDb(d, replayRow({ stage: "PRE_TRIGGER" }), 1000);
  persistPreMoveReplayOnDb(d, replayRow({ stage: "MATURE_MOVE", entryAsk: 4.1 }), 5000);
  const all = rows(d);
  assert.equal(all.length, 1, "one moment, one row");
  assert.equal(all[0].stage, "MATURE_MOVE", "the newer derivation wins");
  assert.equal(all[0].entry_ask, 4.1);
  assert.equal(all[0].created_at_ms, 1000, "first-derived is remembered");
  assert.equal(all[0].updated_at_ms, 5000, "so a changed reconstruction is detectable");
});

test("a new replay version adds a row instead of overwriting the old one", () => {
  const d = db();
  persistPreMoveReplayOnDb(d, replayRow({ stage: "PRE_TRIGGER" }), 1000);
  persistPreMoveReplayOnDb(d, replayRow({ version: "PRE_MOVE_DISCOVERY_REPLAY_V2", stage: "TOO_LATE" }), 2000);
  const all = rows(d);
  assert.equal(all.length, 2, "two versions are two claims about the same moment");
  const versions = all.map((r) => r.replay_version).sort();
  assert.deepEqual(versions, ["PRE_MOVE_DISCOVERY_REPLAY_V2", PRE_MOVE_REPLAY_VERSION].sort());
});

test("a replay row cannot collide with a live row for the same instant", () => {
  // Origin is IN the primary key. If it were merely a column, the second write would
  // overwrite the first and a reconstruction would be indistinguishable from a measurement.
  const d = db();
  persistPreMoveReplayOnDb(d, replayRow({ stage: "PRE_TRIGGER" }), 1000);
  d.prepare(
    `INSERT INTO historical_pre_move_replay
       (occ, decision_at_ms, replay_version, origin, symbol, stage, evidence_quality,
        underlying_bars_used, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(OCC, T, PRE_MOVE_REPLAY_VERSION, "OBSERVED_LIVE", "NVDA", "TOO_LATE", "COMPLETE", 0, 1, 1);
  const all = rows(d);
  assert.equal(all.length, 2);
  assert.equal(all.filter((r) => r.origin === "REPLAY_DERIVED")[0].stage, "PRE_TRIGGER");
  assert.equal(all.filter((r) => r.origin === "OBSERVED_LIVE")[0].stage, "TOO_LATE");
});

test("missing fields are stored, so a confident row is distinguishable from a partial one", () => {
  const d = db();
  persistPreMoveReplayOnDb(
    d,
    replayRow({ missingFields: ["detection.bars", "classify.trigger"], evidenceQuality: "PARTIAL" }),
    1000,
  );
  const [r] = rows(d);
  assert.deepEqual(JSON.parse(r.missing_fields_json), ["detection.bars", "classify.trigger"]);
  assert.equal(r.evidence_quality, "PARTIAL");
});

// ── market context derivation ────────────────────────────────────────────────

/** One session of SPY/QQQ 1m bars, trending up. */
function seedBars(d, sessionDate, { symbols = ["SPY", "QQQ"], drift = 0.02 } = {}) {
  const open = Date.parse(`${sessionDate}T13:30:00Z`); // 09:30 ET
  const ins = d.prepare(
    `INSERT OR REPLACE INTO historical_underlying_bars
       (symbol, timeframe, ts_ms, open, high, low, close, volume, vwap, trade_count,
        source, ingest_version, quality, ingested_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const symbol of symbols) {
    let px = 500;
    for (let i = 0; i < 390; i++) {
      px += drift;
      ins.run(symbol, "1m", open + i * 60_000, px, px + 0.2, px - 0.2, px, 1_000_000, px, 500,
        "test", "test", "OK", 1);
    }
  }
}

test("context rows derive across every session the bars actually cover", () => {
  const d = db();
  seedBars(d, "2026-08-03");
  seedBars(d, "2026-08-04");
  const r = deriveAndPersistMarketContext(d, { nowMs: 9000, everyMs: CONTEXT_SAMPLE_MS });
  assert.deepEqual(r.sessions, ["2026-08-03", "2026-08-04"]);
  assert.equal(r.origin, "DERIVED_FROM_HISTORICAL_BARS");
  assert.ok(r.persisted > 0, "something was written");
  const stored = d.prepare("SELECT DISTINCT origin FROM historical_market_context").all();
  assert.deepEqual(stored.map((s) => s.origin), ["DERIVED_FROM_HISTORICAL_BARS"]);
});

test("a session with no bars is never given a context row", () => {
  const d = db();
  seedBars(d, "2026-08-03");
  const r = deriveAndPersistMarketContext(d, { nowMs: 9000 });
  assert.deepEqual(r.sessions, ["2026-08-03"], "08-04 has no bars and is not visited");
  const dates = d.prepare("SELECT DISTINCT session_date FROM historical_market_context").all();
  assert.deepEqual(dates.map((x) => x.session_date), ["2026-08-03"]);
});

test("an insufficient reconstruction is not persisted at all", () => {
  // No bars anywhere: every instant would reconstruct to UNKNOWN. Writing those rows would
  // make readHistoricalMarketContextOnDb return an UNKNOWN regime as the context in force,
  // and absence would start looking like a reading.
  const d = db();
  const r = deriveAndPersistMarketContext(d, { nowMs: 9000, fromDate: "2026-08-03", toDate: "2026-08-04" });
  assert.equal(r.persisted, 0);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM historical_market_context").get().n, 0);
  assert.equal(readHistoricalMarketContextOnDb(d, T), null, "nothing to mistake for a measurement");
});

test("re-deriving context is idempotent", () => {
  const d = db();
  seedBars(d, "2026-08-03");
  const first = deriveAndPersistMarketContext(d, { nowMs: 1000 });
  const before = d.prepare("SELECT COUNT(*) AS n FROM historical_market_context").get().n;
  const second = deriveAndPersistMarketContext(d, { nowMs: 2000 });
  const after = d.prepare("SELECT COUNT(*) AS n FROM historical_market_context").get().n;
  assert.equal(after, before, "a second pass adds no rows");
  assert.equal(first.persisted, second.persisted);
});

test("a derived context row never claims to be a live observation", () => {
  const d = db();
  seedBars(d, "2026-08-03");
  deriveAndPersistMarketContext(d, { nowMs: 1000 });
  const ctx = readHistoricalMarketContextOnDb(d, Date.parse("2026-08-03T18:00:00Z"));
  assert.ok(ctx, "a row is in force");
  assert.equal(ctx.origin, "DERIVED_FROM_HISTORICAL_BARS");
  assert.notEqual(ctx.origin, "OBSERVED_LIVE");
});

test("context sampling stays inside the session and respects the cap", () => {
  const d = db();
  seedBars(d, "2026-08-03");
  const r = deriveAndPersistMarketContext(d, { nowMs: 1000, everyMs: 60_000, maxInstants: 5 });
  assert.equal(r.instantsExamined, 5, "the cap bounds the work");
  const stored = d.prepare("SELECT as_of_ms FROM historical_market_context ORDER BY as_of_ms").all();
  for (const s of stored) {
    const hourEt = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "numeric", hour12: false,
    }).format(new Date(Number(s.as_of_ms))));
    assert.ok(hourEt >= 9 && hourEt <= 16, `sampled at ${hourEt} ET, outside the session`);
  }
});
