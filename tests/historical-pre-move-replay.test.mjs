/**
 * tests/historical-pre-move-replay.test.mjs
 *
 * PRE_MOVE_DISCOVERY_REPLAY_V1 and the winner-event engine.
 *
 * Two failures these exist to prevent, both of which make a backtest look excellent:
 *
 *   · a replay row passing itself off as a live observation
 *   · a winner measured from an entry nobody was showing
 *
 * The hindsight checks here are the same invariance shape as the replay harness:
 * classify at T, write the future, classify again, assert identical.
 *
 * Fixture is the SAME migration production runs, not a hand-copy.
 */
import "./helpers/register-alias.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  writeBarsOnDb,
  writeOptionQuotesOnDb,
  writeContractReferenceOnDb,
} from "../lib/research/historical/store.ts";
import { replayPreMoveDiscoveryOnDb } from "../lib/research/historical/pre-move-replay.ts";
import {
  extractWinnerEventOnDb,
  extractWinnerEventsOnDb,
  winnerCandidatesFromCasesOnDb,
} from "../lib/research/historical/winner-events.ts";

const { applyProductionSchemaOnDb } = await import("@/lib/db");

const OPEN = Date.parse("2026-08-03T13:30:00.000Z");
const MIN = 60_000;
const DETECT = OPEN + 10 * MIN;
const DECIDE = OPEN + 20 * MIN;
const OCC = "O:NVDA260807C00180000";
const SRC = "test";

function db() {
  const d = new Database(":memory:");
  applyProductionSchemaOnDb(d);
  return d;
}

function seedBars(d, { symbol = "NVDA", from = OPEN, count = 25, base = 100, step = 0.05, high = null } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const c = base + i * step;
    rows.push({
      symbol, timeframe: "1m", tsMs: from + i * MIN,
      open: c, high: high ?? c + 0.02, low: c - 0.02, close: c,
      volume: 1000, vwap: c, tradeCount: 10,
    });
  }
  writeBarsOnDb(d, rows, { source: SRC, nowMs: OPEN });
}

function seedQuotes(d, pairs, occ = OCC) {
  writeOptionQuotesOnDb(d, pairs.map(([tsMs, bid, ask]) => ({ occ, tsMs, bid, ask })), { source: SRC, nowMs: OPEN });
}

function seedRef(d) {
  writeContractReferenceOnDb(d, [{
    occ: OCC, underlying: "NVDA", side: "call", strike: 180, expiration: "2026-08-07",
  }], { source: SRC, nowMs: OPEN });
}

/** A complete, gradable scene: index bars, symbol bars, contract, quotes. */
function seedScene(d) {
  seedBars(d, { symbol: "NVDA" });
  seedBars(d, { symbol: "SPY", base: 500, step: 0.1 });
  seedBars(d, { symbol: "QQQ", base: 400, step: 0.1 });
  seedRef(d);
  seedQuotes(d, [[DETECT - MIN, 1.95, 2.0], [DECIDE - MIN, 2.05, 2.1]]);
}

// ── identity ─────────────────────────────────────────────────────────────────

test("a replay row always declares itself REPLAY_DERIVED", () => {
  const d = db();
  seedScene(d);
  const r = replayPreMoveDiscoveryOnDb(d, {
    occ: OCC, symbol: "NVDA", side: "CALL", detectedAtMs: DETECT, decisionAtMs: DECIDE,
  });
  assert.equal(r.origin, "REPLAY_DERIVED");
  assert.equal(r.version, "PRE_MOVE_DISCOVERY_REPLAY_V1");
  assert.notEqual(r.origin, "OBSERVED_LIVE");
  assert.match(r.reason, /reconstruction, never a live observation/);
});

test("the classification is gradable and reports its own coverage", () => {
  const d = db();
  seedScene(d);
  const r = replayPreMoveDiscoveryOnDb(d, {
    occ: OCC, symbol: "NVDA", side: "CALL", detectedAtMs: DETECT, decisionAtMs: DECIDE,
  });
  assert.notEqual(r.stage, "UNGRADABLE");
  assert.equal(r.entryAsk, 2.1, "economics come from the stored NBBO at the decision instant");
  assert.equal(r.dte, 4);
  assert.ok(["COMPLETE", "PARTIAL"].includes(r.evidenceQuality));
  assert.ok(Array.isArray(r.missingFields));
});

// ── no hindsight ─────────────────────────────────────────────────────────────

test("future bars cannot change a replay classification", () => {
  const d = db();
  seedScene(d);
  const before = replayPreMoveDiscoveryOnDb(d, {
    occ: OCC, symbol: "NVDA", side: "CALL", detectedAtMs: DETECT, decisionAtMs: DECIDE,
  });
  // The stock doubles after the decision instant.
  seedBars(d, { symbol: "NVDA", from: DECIDE + MIN, count: 200, base: 100, step: 1 });
  const after = replayPreMoveDiscoveryOnDb(d, {
    occ: OCC, symbol: "NVDA", side: "CALL", detectedAtMs: DETECT, decisionAtMs: DECIDE,
  });
  assert.deepEqual(after, before, "the afternoon had not happened at the decision instant");
});

test("future option quotes cannot change the entry or the stage", () => {
  const d = db();
  seedScene(d);
  const before = replayPreMoveDiscoveryOnDb(d, {
    occ: OCC, symbol: "NVDA", side: "CALL", detectedAtMs: DETECT, decisionAtMs: DECIDE,
  });
  seedQuotes(d, [[DECIDE + 1000, 12, 12.5], [DECIDE + 60 * MIN, 30, 31]]);
  const after = replayPreMoveDiscoveryOnDb(d, {
    occ: OCC, symbol: "NVDA", side: "CALL", detectedAtMs: DETECT, decisionAtMs: DECIDE,
  });
  assert.deepEqual(after, before);
  assert.equal(after.entryAsk, 2.1, "a +500% quote a second later is not the entry");
});

test("the day's final high cannot leak into the consumed fraction", () => {
  const d = db();
  seedScene(d);
  const before = replayPreMoveDiscoveryOnDb(d, {
    occ: OCC, symbol: "NVDA", side: "CALL", detectedAtMs: DETECT, decisionAtMs: DECIDE,
  });
  // A huge afternoon range. If the day's HOD leaked, the consumed fraction would shrink
  // and the stage would look earlier than it was.
  writeBarsOnDb(d, Array.from({ length: 120 }, (_, i) => ({
    symbol: "NVDA", timeframe: "1m", tsMs: DECIDE + (i + 1) * MIN,
    open: 150, high: 220, low: 140, close: 210, volume: 9999, vwap: 180,
  })), { source: SRC, nowMs: OPEN });
  const after = replayPreMoveDiscoveryOnDb(d, {
    occ: OCC, symbol: "NVDA", side: "CALL", detectedAtMs: DETECT, decisionAtMs: DECIDE,
  });
  assert.equal(after.moveConsumedFraction, before.moveConsumedFraction);
  assert.equal(after.stage, before.stage);
});

test("an unknown trigger does not short-circuit to PRE_TRIGGER", () => {
  const d = db();
  seedScene(d);
  const r = replayPreMoveDiscoveryOnDb(d, {
    occ: OCC, symbol: "NVDA", side: "CALL", detectedAtMs: DETECT, decisionAtMs: DECIDE,
    // no triggerLevel supplied
  });
  assert.notEqual(
    r.stage, "PRE_TRIGGER",
    "absent structural knowledge must fall through to measurement, not assert earliness",
  );
});

test("missing bars fail closed rather than producing a confident stage", () => {
  const d = db();
  seedRef(d);
  seedQuotes(d, [[DECIDE - MIN, 2.05, 2.1]]);
  const r = replayPreMoveDiscoveryOnDb(d, {
    occ: OCC, symbol: "NVDA", side: "CALL", detectedAtMs: DETECT, decisionAtMs: DECIDE,
  });
  assert.equal(r.stage, "UNGRADABLE");
  assert.equal(r.evidenceQuality, "INSUFFICIENT");
  assert.ok(r.missingFields.some((m) => m.includes("bars")));
});

test("market alignment separates COUNTER_TREND from UNKNOWN", () => {
  const d = db();
  seedBars(d, { symbol: "NVDA" });
  seedRef(d);
  seedQuotes(d, [[DETECT - MIN, 1.95, 2.0], [DECIDE - MIN, 2.05, 2.1]]);
  // No index bars at all.
  const blind = replayPreMoveDiscoveryOnDb(d, {
    occ: OCC, symbol: "NVDA", side: "CALL", detectedAtMs: DETECT, decisionAtMs: DECIDE,
  });
  assert.equal(blind.marketAlignment, "UNKNOWN", "we could not see the tape");

  // Indices down while holding a CALL.
  seedBars(d, { symbol: "SPY", base: 500, step: -0.5 });
  seedBars(d, { symbol: "QQQ", base: 400, step: -0.5 });
  const counter = replayPreMoveDiscoveryOnDb(d, {
    occ: OCC, symbol: "NVDA", side: "CALL", detectedAtMs: DETECT, decisionAtMs: DECIDE,
  });
  assert.equal(counter.regime, "RISK_OFF");
  assert.equal(counter.marketAlignment, "COUNTER_TREND", "we saw the tape and it disagreed");
});

// ── winner events ────────────────────────────────────────────────────────────

test("a winner event measures from the ask at entry and records the convention", () => {
  const d = db();
  seedRef(d);
  seedQuotes(d, [
    [DECIDE - 1000, 1.95, 2.0],       // entry ask 2.00
    [DECIDE + 6 * MIN, 2.4, 2.6],     // mid 2.50 → +25%
    [DECIDE + 15 * MIN, 3.9, 4.1],    // mid 4.00 → +100%
    [DECIDE + 40 * MIN, 1.0, 1.2],    // mid 1.10 → −45%
  ]);
  const e = extractWinnerEventOnDb(d, { occ: OCC, symbol: "NVDA", entryAtMs: DECIDE });
  assert.equal(e.entryPrice, 2.0);
  assert.match(e.entryConvention, /ASK at T/);
  assert.equal(e.peakMilestone, 100);
  assert.equal(e.msToMilestone["25"], 6 * MIN);
  assert.equal(e.msToMilestone["100"], 15 * MIN);
  assert.equal(e.msToMilestone["200"], null, "never reached is null, not 0");
  assert.equal(e.evidenceQuality, "VERIFIED");
  assert.equal(e.side, "call", "contract metadata comes from the expired-inclusive reference");
  assert.equal(e.strike, 180);
});

test("no executable quote at entry produces NO event, not an assumed one", () => {
  const d = db();
  seedRef(d);
  // Quotes exist only AFTER the entry instant.
  seedQuotes(d, [[DECIDE + MIN, 5.0, 5.2], [DECIDE + 20 * MIN, 20, 21]]);
  assert.equal(
    extractWinnerEventOnDb(d, { occ: OCC, symbol: "NVDA", entryAtMs: DECIDE }),
    null,
    "a +300% move from a price nobody was showing is not a result",
  );
});

test("a contract that was executable and went nowhere is still an event", () => {
  const d = db();
  seedRef(d);
  seedQuotes(d, [
    [DECIDE - 1000, 1.95, 2.0],
    [DECIDE + 5 * MIN, 1.9, 2.0],
    [DECIDE + 20 * MIN, 1.8, 1.9],
    [DECIDE + 40 * MIN, 1.7, 1.8],
  ]);
  const e = extractWinnerEventOnDb(d, { occ: OCC, symbol: "NVDA", entryAtMs: DECIDE });
  assert.ok(e, "the control group depends on these");
  assert.equal(e.peakMilestone, null);
  assert.ok(e.mfePct <= 0);
  assert.equal(e.evidenceQuality, "VERIFIED");
});

test("thin coverage keeps milestone times but withholds the extreme", () => {
  const d = db();
  seedRef(d);
  seedQuotes(d, [[DECIDE - 1000, 1.95, 2.0], [DECIDE + 8 * MIN, 2.9, 3.1]]);
  const e = extractWinnerEventOnDb(d, { occ: OCC, symbol: "NVDA", entryAtMs: DECIDE });
  assert.equal(e.evidenceQuality, "THIN");
  assert.equal(e.msToMilestone["25"], 8 * MIN, "it touched +25% at that moment — an observation");
  assert.equal(e.mfePct, null, "one post-entry quote cannot assert a maximum");
});

test("the census separates a coverage gap from an absence of movement", () => {
  const d = db();
  seedRef(d);
  const FLAT = "O:NVDA260807C00190000";
  // Contract A: executable and ran to +25%.
  seedQuotes(d, [[DECIDE - 1000, 1.95, 2.0], [DECIDE + 6 * MIN, 2.4, 2.6], [DECIDE + 9 * MIN, 2.5, 2.7]]);
  // Contract B: executable and went nowhere. A real observation, and the control group.
  seedQuotes(d, [[DECIDE - 1000, 1.0, 1.05], [DECIDE + 6 * MIN, 0.98, 1.02], [DECIDE + 9 * MIN, 0.95, 1.0]], FLAT);

  const { events, census } = extractWinnerEventsOnDb(d, [
    { occ: OCC, symbol: "NVDA", entryAtMs: DECIDE },
    { occ: FLAT, symbol: "NVDA", entryAtMs: DECIDE },
    { occ: "O:NVDA260807C00999000", symbol: "NVDA", entryAtMs: DECIDE }, // never ingested
  ]);

  assert.equal(census.examined, 3);
  // TWO contracts were observable; only ONE of them moved. The third was never stored.
  assert.equal(events.length, 2, "an executable contract that went nowhere is still an event");
  assert.equal(census.refusedNoEntry, 1, "no stored quote is a coverage gap, not a flat trade");
  assert.equal(census.byMilestone["25"], 1, "only one of the two observable contracts reached +25%");
  assert.equal(
    events.filter((e) => e.peakMilestone == null).length, 1,
    "and the flat one is counted as observed-and-flat, never merged with the unobserved one",
  );
  assert.match(census.note, /coverage gap, not evidence of no move/);
});

test("candidates come from real cases and never from a case with no frozen contract", () => {
  const d = db();
  d.prepare(
    `INSERT INTO opportunity_cases
       (opportunity_id, underlying_symbol, detected_at_ms, source_path, acceptance_decision,
        delivery_decision, case_json, created_at_ms, updated_at_ms)
     VALUES (?,?,?,'scanner','accepted','delivered',?,?,?)`,
  ).run("oc_w1", "NVDA", DECIDE, JSON.stringify({ selectedContract: { optionSymbol: OCC } }), DECIDE, DECIDE);
  d.prepare(
    `INSERT INTO opportunity_cases
       (opportunity_id, underlying_symbol, detected_at_ms, source_path, acceptance_decision,
        delivery_decision, case_json, created_at_ms, updated_at_ms)
     VALUES (?,?,?,'scanner','accepted','delivered','{}',?,?)`,
  ).run("oc_w2", "AMD", DECIDE, DECIDE, DECIDE);

  const cands = winnerCandidatesFromCasesOnDb(d, {});
  assert.equal(cands.length, 1);
  assert.equal(cands[0].occ, OCC);
  assert.equal(cands[0].opportunityCaseId, "oc_w1");
});

test("the event id is deterministic so re-extraction cannot duplicate", () => {
  const d = db();
  seedRef(d);
  seedQuotes(d, [[DECIDE - 1000, 1.95, 2.0], [DECIDE + 5 * MIN, 2.4, 2.6], [DECIDE + 9 * MIN, 2.5, 2.7]]);
  const a = extractWinnerEventOnDb(d, { occ: OCC, symbol: "NVDA", entryAtMs: DECIDE });
  const b = extractWinnerEventOnDb(d, { occ: OCC, symbol: "NVDA", entryAtMs: DECIDE });
  assert.equal(a.eventId, b.eventId);
  assert.deepEqual(a, b);
});
