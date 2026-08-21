/**
 * options-missed-opportunity.test.mjs — Phase 11.
 *
 * Two properties matter more than the feature: it never invents an option
 * outcome, and it is bounded. Full-universe awareness makes ~1,600 decisions a
 * cycle; an unbounded skip log would be ~624k rows a session.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  shouldRecordSkip, buildMissedOpportunity, collectMissedOpportunities,
  ensureMissedOpportunitySchema, persistMissedOpportunitiesOnDb,
  pruneMissedOpportunitiesOnDb, missedOpportunitiesForSymbol,
  DEFAULT_MISSED_OPPORTUNITY, missedOpportunityConfig,
} from "../lib/research/options/missed-opportunity.ts";
import { sweepAwareness } from "../lib/research/options/awareness.ts";

const NOW = 6_000_000;
const CTX = { sessionDate: "2026-08-21", universeSize: 1606, promotionCapacity: 25 };

const row = (over = {}) => ({
  symbol: "COIN", rawMovePct: 2.2, normalizedMovePct: 2.2, leverageMultiplier: 1,
  dollarVolume: 700_000_000, velocityPctPerMin: 1.8, rangePosition: 0.97, spreadPct: 0.4,
  band: "NEWLY_ACCELERATING", preScore: 72,
  components: { acceleration: 40, emergence: 18, activity: 8.6, rangePosition: 11.6, move: 1.3, extendedPenalty: 0, spreadPenalty: 0 },
  rank: 1, reason: "+2.2% · 1.80%/min · $700M traded · range pos 97% · spread 0.40%",
  observedAtMs: NOW, ...over,
});

const db = () => new Database(":memory:");

/* ── rule 1: never invent an option outcome ────────────────────────────────*/

test("the record carries NO option fields — an unfetched contract has no price to report", () => {
  const rec = buildMissedOpportunity(row(), "NOT_PROMOTED", CTX);
  for (const forbidden of [
    "optionSymbol", "option_symbol", "strike", "expiration", "dte", "premium",
    "entryFill", "exitFill", "pnl", "returnPct", "mid", "bid", "ask", "delta", "iv",
  ]) {
    assert.equal(forbidden in rec, false, `${forbidden} must not exist on the record`);
  }
  // What it DOES carry is underlying and decision state only.
  assert.equal(rec.symbol, "COIN");
  assert.equal(rec.normalizedMovePct, 2.2);
  assert.equal(rec.band, "NEWLY_ACCELERATING");
});

test("the SCHEMA has nowhere to put an option outcome, so a later writer cannot start inventing one", () => {
  const d = db();
  ensureMissedOpportunitySchema(d);
  const cols = d.prepare("PRAGMA table_info(options_missed_opportunities)").all().map((c) => c.name);
  for (const forbidden of ["option_symbol", "strike", "expiration", "premium", "pnl", "return_pct", "exit_fill"]) {
    assert.equal(cols.includes(forbidden), false, `${forbidden} column must not exist`);
  }
  assert.equal(cols.includes("pre_score"), true);
  assert.equal(cols.includes("reason"), true);
});

/* ── rule 2: bounded ───────────────────────────────────────────────────────*/

test("a quiet name passed over is NOT recorded — that is the design working, not a near miss", () => {
  assert.equal(shouldRecordSkip({ preScore: 3, band: "QUIET" }, "NOT_PROMOTED"), false);
  assert.equal(shouldRecordSkip({ preScore: 12, band: "QUIET" }, "NOT_PROMOTED"), false);
  // A genuinely close call is.
  assert.equal(shouldRecordSkip({ preScore: 60, band: "QUIET" }, "NOT_PROMOTED"), true);
  // And an interesting band always is, whatever it scored.
  assert.equal(shouldRecordSkip({ preScore: 1, band: "NEWLY_ACCELERATING" }, "NOT_PROMOTED"), true);
  assert.equal(shouldRecordSkip({ preScore: 1, band: "HIGH_PRIORITY" }, "NOT_PROMOTED"), true);
});

test("failures about US are always recorded, whatever the symbol scored", () => {
  for (const reason of ["QUOTA_BLOCKED", "DEEP_DEFERRED", "NO_CHAIN"]) {
    assert.equal(shouldRecordSkip({ preScore: 0, band: "QUIET" }, reason), true,
      `${reason} is evidence about the lane, not a judgement about the symbol`);
  }
  // A strategy rejection IS a judgement, so it follows the score floor.
  assert.equal(shouldRecordSkip({ preScore: 0, band: "QUIET" }, "STRATEGY_REJECTED"), false);
});

test("a full 1,606-symbol cycle produces a bounded number of rows, not 1,606", () => {
  const quotes = Array.from({ length: 1606 }, (_, i) => ({
    symbol: `S${i}`, price: 100, changePercent: (i % 40) * 0.9, volume: 3_000_000,
    dayHigh: 104, dayLow: 99, dayOpen: 100, prevClose: 99, bid: null, ask: null,
  }));
  const sweep = sweepAwareness(quotes, new Map(), NOW);
  const candidates = sweep.rows.map((r) => ({ row: r, reason: "NOT_PROMOTED" }));

  const out = collectMissedOpportunities(candidates, CTX);
  assert.equal(out.considered, 1606);
  assert.equal(out.recorded <= DEFAULT_MISSED_OPPORTUNITY.maxPerCycle, true,
    `recorded ${out.recorded}, cap ${DEFAULT_MISSED_OPPORTUNITY.maxPerCycle}`);
  assert.equal(out.records.length, out.recorded);
  // At 25/cycle and ~390 cycles a session this is ~9,750 rows/day worst case,
  // against ~624,000 if every skip were written.
  assert.equal(out.recorded, 25);
});

test("the cap binds even if every skip qualifies, and truncation is reported rather than silent", () => {
  const candidates = Array.from({ length: 500 }, (_, i) => ({
    row: row({ symbol: `H${i}`, band: "HIGH_PRIORITY", preScore: 90 }),
    reason: "NOT_PROMOTED",
  }));
  const out = collectMissedOpportunities(candidates, CTX);
  assert.equal(out.recorded, 25);
  assert.equal(out.truncated, 475, "what was dropped is counted, not hidden");
});

test("when the cap truncates, capacity failures outrank judgements", () => {
  const candidates = [
    ...Array.from({ length: 30 }, (_, i) => ({ row: row({ symbol: `J${i}`, preScore: 99 }), reason: "NOT_PROMOTED" })),
    { row: row({ symbol: "BLOCKED", preScore: 50 }), reason: "QUOTA_BLOCKED" },
  ];
  const out = collectMissedOpportunities(candidates, CTX, { ...DEFAULT_MISSED_OPPORTUNITY, maxPerCycle: 5 });
  assert.equal(out.records[0].symbol, "BLOCKED",
    "a quota block is the thing most worth reviewing, even at a lower score");
  assert.equal(out.recorded, 5);
});

/* ── the COIN question ─────────────────────────────────────────────────────*/

test("the COIN question is answerable afterwards from what was observed at the time", () => {
  const d = db();
  const recs = [
    buildMissedOpportunity(row({ observedAtMs: NOW }), "NOT_PROMOTED", CTX),
    buildMissedOpportunity(row({ observedAtMs: NOW + 60_000, preScore: 81, rank: 1 }), "QUOTA_BLOCKED", CTX),
  ];
  const w = persistMissedOpportunitiesOnDb(d, recs);
  assert.equal(w.error, null);
  assert.equal(w.inserted, 2);

  const found = missedOpportunitiesForSymbol(d, "COIN");
  assert.equal(found.length, 2);
  assert.equal(found[0].reason, "QUOTA_BLOCKED", "newest first");
  assert.equal(found[0].awarenessRank, 1);
  assert.equal(found[0].universeSize, 1606, "the rank is interpretable because the universe size is stored");
  assert.equal(found[0].promotionCapacity, 25, "and so is the capacity it lost to");
  assert.match(found[1].observation, /1\.80%\/min/, "the point-in-time observation survives verbatim");
});

/* ── storage hygiene ───────────────────────────────────────────────────────*/

test("retention prunes old rows, so storage is bounded independently of write rate", () => {
  const d = db();
  const old = buildMissedOpportunity(row({ observedAtMs: NOW - 60 * 86_400_000 }), "NOT_PROMOTED", CTX);
  const fresh = buildMissedOpportunity(row({ observedAtMs: NOW }), "NOT_PROMOTED", CTX);
  persistMissedOpportunitiesOnDb(d, [old, fresh]);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_missed_opportunities").get().n, 2);

  const pruned = pruneMissedOpportunitiesOnDb(d, NOW, DEFAULT_MISSED_OPPORTUNITY);
  assert.equal(pruned.error, null);
  assert.equal(pruned.deleted, 1);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_missed_opportunities").get().n, 1);
});

test("a write fault is returned, never thrown — a diagnostic row cannot take down the scan", () => {
  const broken = { exec: () => { throw new Error("disk full"); }, prepare: () => { throw new Error("disk full"); } };
  const r = persistMissedOpportunitiesOnDb(broken, [buildMissedOpportunity(row(), "NOT_PROMOTED", CTX)]);
  assert.equal(r.inserted, 0);
  assert.match(r.error, /disk full/);
  const p = pruneMissedOpportunitiesOnDb(broken, NOW);
  assert.match(p.error, /disk full/);
});

test("writing nothing is a no-op, not an error", () => {
  const r = persistMissedOpportunitiesOnDb(db(), []);
  assert.deepEqual(r, { inserted: 0, error: null });
});

test("schema creation is idempotent", () => {
  const d = db();
  ensureMissedOpportunitySchema(d);
  ensureMissedOpportunitySchema(d);
  persistMissedOpportunitiesOnDb(d, [buildMissedOpportunity(row(), "NOT_PROMOTED", CTX)]);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_missed_opportunities").get().n, 1);
});

test("config comes from env with safe floors", () => {
  assert.deepEqual(missedOpportunityConfig({}), DEFAULT_MISSED_OPPORTUNITY);
  assert.equal(missedOpportunityConfig({ OPTIONS_MISSED_MAX_PER_CYCLE: "0" }).maxPerCycle, 25,
    "a zero cap is refused rather than adopted");
  assert.equal(missedOpportunityConfig({ OPTIONS_MISSED_MAX_PER_CYCLE: "10" }).maxPerCycle, 10);
});
