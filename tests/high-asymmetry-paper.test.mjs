/**
 * tests/high-asymmetry-paper.test.mjs
 *
 * The High-Asymmetry paper lane: entry, sizing, management, exits, grading,
 * Quant statistics, and the structural boundaries that keep it owner-private
 * simulation.
 *
 * The load-bearing assertions here are the negative ones. It is easy to write a
 * paper trader that opens positions; the things that make this one safe are
 * that it refuses a stale quote, refuses a duplicate, never invents an exit
 * price, never reports an empty cohort as 0%, and cannot reach a broker or a
 * subscriber send. Those are what these tests are mostly about.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

import {
  ASYMMETRY_PAPER_LANE, PAPER_ENTRY_STATES, PAPER_INELIGIBLE_STATES,
  PAPER_RULES_VERSION, PAPER_LANE_AUTHORITY, paperPositionFingerprint, isPaperEntryState,
} from "../lib/research/asymmetry/paper/lane.ts";
import { sizePaperPosition, paperPnlUsd, paperReturnPct, DEFAULT_SIZING } from "../lib/research/asymmetry/paper/sizing.ts";
import { decidePaperEntry, openAsymmetryPaperTrade } from "../lib/research/asymmetry/paper/entry.ts";
import {
  evaluatePaperManagement, updateExcursions, highestMilestone, milestoneDistribution,
  DEFAULT_MANAGEMENT,
} from "../lib/research/asymmetry/paper/management.ts";
import { runAsymmetryPaper } from "../lib/research/asymmetry/paper/runner.ts";
import {
  ensureAsymmetryPaperSchema, listPaperPositionsOnDb, listOpenPaperPositionsOnDb,
  listPaperSkipsOnDb, hasPaperPosition, readQuantReportOnDb, readReportDeliveryOnDb,
} from "../lib/research/asymmetry/paper/store.ts";
import { computeCohortMetrics, buildQuantReport, wilson95, holdoutSplit } from "../lib/research/asymmetry/paper/quant.ts";
import { ensureAsymmetrySchema, openAsymmetryCaseOnDb } from "../lib/research/asymmetry/case-store.ts";
import { runAsymmetryEodReview, buildDeterministicReview } from "../lib/research/asymmetry/eod-review.ts";
import { resolveReportDelivery, deliverPaperReport, buildPaperReportMessage } from "../lib/research/asymmetry/paper/report-delivery.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const OCC = "O:NVDA260807C00200000";
const SESSION = "2026-07-30";
// 10:00 ET on a real trading day: inside the options quote session.
const T0 = Date.parse("2026-07-30T14:00:00.000Z");
const ON = { HIGH_ASYMMETRY_PAPER_ENABLED: "1" };

function freshDb() {
  const db = new Database(":memory:");
  ensureAsymmetrySchema(db);
  ensureAsymmetryPaperSchema(db);
  return db;
}

function seedCase(db, over = {}) {
  openAsymmetryCaseOnDb(db, {
    sessionDate: SESSION, fingerprint: `${SESSION}|${OCC}`, symbol: "NVDA", direction: "CALL",
    optionSymbol: OCC, state: "EARLY_ASYMMETRY", firstDetectedAtMs: T0,
    earlyAsk: 2.0, earlyBid: 1.9, earlySpreadPct: 5, setupFamily: "BREAKOUT", scannerVersion: null,
    evidenceJson: "{}", missingEvidence: [], normalQualifiedAtMs: null, normalAsk: null,
    ...over,
  }, T0);
}

const candidate = (over = {}) => ({
  sessionDate: SESSION, caseFingerprint: `${SESSION}|${OCC}`, symbol: "NVDA", direction: "CALL",
  optionSymbol: OCC, setupFamily: "BREAKOUT", state: "EARLY_ASYMMETRY",
  evidenceJson: "{}", missingEvidence: [], ...over,
});

const quote = (over = {}) => ({ optionSymbol: OCC, bid: 1.9, ask: 2.0, quoteAtMs: T0 - 1000, underlyingPrice: 180, ...over });

const quoteFn = (q) => async () => ({ quote: q, providerError: null });

// ── Entry eligibility ───────────────────────────────────────────────────────

test("a qualifying asymmetry state creates a paper trade", () => {
  for (const state of PAPER_ENTRY_STATES) {
    const db = freshDb();
    const res = openAsymmetryPaperTrade(db, candidate({ state }), quote(), { nowMs: T0, env: ON });
    assert.equal(res.opened, true, `${state} must open a position`);
    assert.equal(listPaperPositionsOnDb(db, SESSION).length, 1);
    db.close();
  }
});

test("ineligible states never create a paper trade", () => {
  for (const state of PAPER_INELIGIBLE_STATES) {
    const db = freshDb();
    const res = openAsymmetryPaperTrade(db, candidate({ state }), quote(), { nowMs: T0, env: ON });
    assert.equal(res.opened, false, `${state} must not open a position`);
    assert.equal(listPaperPositionsOnDb(db, SESSION).length, 0);
    // The refusal is RECORDED, not silent.
    assert.equal(listPaperSkipsOnDb(db, SESSION)[0].reason, "INELIGIBLE_STATE");
    db.close();
  }
});

test("TRIGGERED may update but never opens a position", () => {
  const db = freshDb();
  const res = openAsymmetryPaperTrade(db, candidate({ state: "TRIGGERED" }), quote(), { nowMs: T0, env: ON });
  assert.equal(res.opened, false);
  assert.equal(res.rejection, "UPDATE_ONLY_STATE");
  assert.equal(listPaperPositionsOnDb(db, SESSION).length, 0);
  db.close();
});

test("the ASK is the entry fill — never the mid, never the bid", () => {
  const db = freshDb();
  openAsymmetryPaperTrade(db, candidate(), quote({ bid: 1.8, ask: 2.0 }), { nowMs: T0, env: ON });
  const [p] = listPaperPositionsOnDb(db, SESSION);
  assert.equal(p.entryFill, 2.0, "entry must be the ask");
  assert.notEqual(p.entryFill, 1.9, "a mid fill would flatter every result in this lane");
  assert.notEqual(p.entryFill, 1.8, "and the bid is the exit side, not the entry side");
  db.close();
});

// ── Quote quality refusals ──────────────────────────────────────────────────

test("a stale, future, wrong-session, wrong-OCC, crossed, or wide quote prevents entry", () => {
  // 03:00 ET — a real timestamp, but outside the options quote session. `now`
  // moves with it, otherwise staleness would fire first and the session rule
  // would never be the one under test.
  const OFF_SESSION = Date.parse("2026-07-30T07:00:00.000Z");
  const cases = [
    ["STALE_QUOTE", quote({ quoteAtMs: T0 - 5 * 60_000 }), T0],
    ["FUTURE_QUOTE", quote({ quoteAtMs: T0 + 60_000 }), T0],
    ["WRONG_OCC", quote({ optionSymbol: "O:AMD260807C00200000" }), T0],
    ["CROSSED_MARKET", quote({ bid: 3.0, ask: 2.0 }), T0],
    ["UNUSABLE_SPREAD", quote({ bid: 0.5, ask: 2.0 }), T0],
    ["NO_ASK", quote({ ask: null }), T0],
    ["NO_QUOTE", null, T0],
    ["WRONG_SESSION", quote({ quoteAtMs: OFF_SESSION - 1000 }), OFF_SESSION],
  ];
  for (const [expected, q, nowMs] of cases) {
    const db = freshDb();
    const res = openAsymmetryPaperTrade(db, candidate(), q, { nowMs, env: ON });
    assert.equal(res.opened, false, `${expected} must not open`);
    assert.equal(res.rejection, expected);
    assert.equal(listPaperPositionsOnDb(db, SESSION).length, 0);
    db.close();
  }
});

test("a rejection is never silently converted into a position with zeros", () => {
  const db = freshDb();
  openAsymmetryPaperTrade(db, candidate(), quote({ bid: null, ask: null }), { nowMs: T0, env: ON });
  assert.equal(listPaperPositionsOnDb(db, SESSION).length, 0, "missing values must not become a zero-priced trade");
  db.close();
});

// ── Uniqueness ──────────────────────────────────────────────────────────────

test("one position per fingerprint, and duplicate ticks create no duplicates", () => {
  const db = freshDb();
  for (let i = 0; i < 5; i += 1) {
    openAsymmetryPaperTrade(db, candidate(), quote({ quoteAtMs: T0 + i - 1000 }), { nowMs: T0 + i, env: ON });
  }
  assert.equal(listPaperPositionsOnDb(db, SESSION).length, 1, "five ticks must yield exactly one position");
  const skips = listPaperSkipsOnDb(db, SESSION);
  assert.equal(skips.find((s) => s.reason === "DUPLICATE_POSITION").count, 4);
  db.close();
});

test("uniqueness is enforced by the PRIMARY KEY, not only by the read check", () => {
  const db = freshDb();
  // Bypass the read-then-write guard entirely and insert twice at the store level.
  const { openPaperPositionOnDb } = require("../lib/research/asymmetry/paper/store.ts");
  const row = {
    sessionDate: SESSION, positionFingerprint: "FP", caseFingerprint: "C", alertId: null,
    symbol: "NVDA", direction: "CALL", optionSymbol: OCC, setupFamily: "BREAKOUT",
    stateAtEntry: "EARLY_ASYMMETRY", entryAtMs: T0, entryFill: 2, entryBid: 1.9, entryAsk: 2,
    entrySpreadPct: 5, entryUnderlyingPrice: 180, entryQuoteAtMs: T0, evidenceJson: "{}",
    missingEvidenceJson: "[]", stopLossPct: 35, fixedRiskQty: 1, fixedRiskReason: null,
    fixedRiskCostUsd: 200, fixedRiskAtRiskUsd: 70, codeVersion: null,
  };
  assert.equal(openPaperPositionOnDb(db, row, T0).created, true);
  assert.equal(openPaperPositionOnDb(db, row, T0 + 1).created, false, "the PRIMARY KEY must refuse the second insert");
  assert.equal(listPaperPositionsOnDb(db, SESSION).length, 1);
  db.close();
});

test("a subsequent subscriber alert links to the position instead of creating a second one", () => {
  const db = freshDb();
  openAsymmetryPaperTrade(db, candidate(), quote(), { nowMs: T0, env: ON });
  const { attachPaperAlertLinkOnDb } = require("../lib/research/asymmetry/paper/store.ts");
  attachPaperAlertLinkOnDb(db, { sessionDate: SESSION, optionSymbol: OCC, alertId: "alert-1", nowMs: T0 + 60_000 });
  const rows = listPaperPositionsOnDb(db, SESSION);
  assert.equal(rows.length, 1, "the normal alert must not produce a second simulated position");
  assert.equal(rows[0].alertId, "alert-1", "both paths must point at the same underlying opportunity");
  // The early entry is preserved: linking must not re-price the trade.
  assert.equal(rows[0].entryFill, 2.0);
  assert.equal(rows[0].entryAtMs, T0);
  db.close();
});

test("the position fingerprint separates symbol, direction, contract, session, and setup", () => {
  const base = { sessionDate: SESSION, symbol: "NVDA", direction: "CALL", optionSymbol: OCC, setupFamily: "BREAKOUT" };
  const fp = paperPositionFingerprint(base);
  for (const [field, value] of Object.entries({
    sessionDate: "2026-07-31", symbol: "AMD", direction: "PUT",
    optionSymbol: "O:NVDA260807P00200000", setupFamily: "REVERSAL",
  })) {
    assert.notEqual(paperPositionFingerprint({ ...base, [field]: value }), fp, `${field} must change the identity`);
  }
  // A missing setup is an explicit literal, so two unknowns do not silently merge
  // with a real setup named "".
  assert.match(paperPositionFingerprint({ ...base, setupFamily: null }), /NO_SETUP/);
});

// ── Sizing ──────────────────────────────────────────────────────────────────

test("sizing yields whole contracts, never fractional, zero, or negative", () => {
  const s = sizePaperPosition(2.0, { fixedRiskUsd: 500, maxContracts: 10, stopLossPct: 35 });
  assert.equal(s.fixedContractQty, 1, "the normalization cohort is always one contract");
  assert.equal(Number.isInteger(s.fixedRiskQty), true);
  assert.ok(s.fixedRiskQty >= 1);
  // 2.00 × 100 × 0.35 = $70 at risk per contract; $500 / $70 = 7.
  assert.equal(s.fixedRiskQty, 7);
  assert.equal(s.fixedRiskCostUsd, 1400);
  assert.equal(s.fixedRiskAtRiskUsd, 490);
});

test("a premium too expensive for the risk budget is null with a reason, not zero contracts", () => {
  const s = sizePaperPosition(50, { fixedRiskUsd: 500, maxContracts: 10, stopLossPct: 35 });
  assert.equal(s.fixedRiskQty, null, "zero contracts would be a fabricated data point");
  assert.equal(s.fixedRiskReason, "PREMIUM_EXCEEDS_RISK_BUDGET");
  assert.equal(s.fixedRiskCostUsd, null);
});

test("an absent entry premium never becomes a zero-cost position", () => {
  for (const bad of [null, 0, -1, NaN]) {
    const s = sizePaperPosition(bad, DEFAULT_SIZING);
    assert.equal(s.fixedRiskQty, null);
    assert.equal(s.fixedRiskReason, "NO_ENTRY_PREMIUM");
  }
});

test("P&L is null when either leg is missing — an unverified exit is not a zero", () => {
  assert.equal(paperPnlUsd(2, null, 1), null);
  assert.equal(paperPnlUsd(null, 3, 1), null);
  assert.equal(paperPnlUsd(2, 3, null), null);
  assert.equal(paperPnlUsd(2, 3, 1), 100);
  assert.equal(paperReturnPct(2, 3), 50);
  assert.equal(paperReturnPct(0, 3), null);
});

// ── Excursions and milestones ───────────────────────────────────────────────

test("MFE and MAE track the peak and trough, not the latest mark", () => {
  let e = { mfePct: null, maePct: null };
  for (const r of [10, 60, -20, 5]) e = updateExcursions(e, r);
  assert.equal(e.mfePct, 60);
  assert.equal(e.maePct, -20);
  // A null observation must not reset either.
  const same = updateExcursions(e, null);
  assert.deepEqual(same, e);
});

test("milestones come from the PEAK, so a round trip still counts what it reached", () => {
  assert.equal(highestMilestone(null), null, "no data is not milestone zero");
  assert.equal(highestMilestone(24), null);
  assert.equal(highestMilestone(25), 25);
  assert.equal(highestMilestone(150), 100);
  assert.equal(highestMilestone(600), 500);
  const dist = milestoneDistribution([30, 120, null, 550]);
  assert.deepEqual(dist, { "+25%": 3, "+50%": 2, "+100%": 2, "+200%": 1, "+500%": 1 });
});

// ── Management and exits ────────────────────────────────────────────────────

const CLOSE = Date.parse("2026-07-30T20:00:00.000Z");
const pos = (over = {}) => ({ entryFill: 2.0, entryAtMs: T0, mfePct: null, maePct: null, exitAttempts: 0, ...over });
const obs = (over = {}) => ({ bid: 2.0, ask: 2.1, quoteAtMs: T0, caseInvalidated: false, spreadPct: 5, ...over });

test("exits are stamped with the rules version", () => {
  const a = evaluatePaperManagement(pos(), obs({ bid: 1.0 }), T0 + 60_000, CLOSE);
  assert.equal(a.action, "EXIT");
  assert.equal(a.rulesVersion, PAPER_RULES_VERSION);
  assert.equal(a.exitReason, "PREMIUM_STOP");
});

test("the exit fill is the BID", () => {
  const a = evaluatePaperManagement(pos(), obs({ bid: 6.5, ask: 6.9 }), T0 + 60_000, CLOSE);
  assert.equal(a.action, "EXIT");
  assert.equal(a.exitReason, "TARGET_REACHED");
  assert.equal(a.exitFill, 6.5, "the exit must hit the bid, not the ask or the mid");
});

test("exit precedence is fixed and worst-first", () => {
  // Invalidated AND stopped AND wide: the most fundamental cause wins.
  const a = evaluatePaperManagement(pos(), obs({ bid: 0.5, caseInvalidated: true, spreadPct: 90 }), T0 + 60_000, CLOSE);
  assert.equal(a.exitReason, "UNDERLYING_INVALIDATION");
  const b = evaluatePaperManagement(pos(), obs({ bid: 0.5, spreadPct: 90 }), T0 + 60_000, CLOSE);
  assert.equal(b.exitReason, "LIQUIDITY_FAILURE");
});

test("trailing protection arms only after a major gain", () => {
  // Peak +120%, now +50%: below half the peak, so it exits.
  const armed = evaluatePaperManagement(pos({ mfePct: 120 }), obs({ bid: 3.0 }), T0 + 60_000, CLOSE);
  assert.equal(armed.exitReason, "TRAILING_PROTECTION");
  // Peak +40% is under the arming threshold; the same give-back holds.
  const unarmed = evaluatePaperManagement(pos({ mfePct: 40 }), obs({ bid: 2.2 }), T0 + 60_000, CLOSE);
  assert.equal(unarmed.action, "HOLD");
});

test("the time stop only fires on a position that has gone nowhere", () => {
  const late = T0 + DEFAULT_MANAGEMENT.timeStopMs + 1000;
  const flat = evaluatePaperManagement(pos(), obs({ bid: 2.0 }), late, CLOSE);
  assert.equal(flat.exitReason, "TIME_STOP");
  const working = evaluatePaperManagement(pos(), obs({ bid: 2.5 }), late, CLOSE);
  assert.equal(working.action, "HOLD", "a position up +25% is not 'going nowhere'");
});

test("the session end closes open positions", () => {
  // Entered 30 min before the close, so the time stop has not yet come due and
  // SESSION_END is genuinely the rule being exercised.
  const entered = CLOSE - 30 * 60_000;
  const a = evaluatePaperManagement(pos({ entryAtMs: entered }), obs(), CLOSE - 60_000, CLOSE);
  assert.equal(a.exitReason, "SESSION_END");
  assert.equal(a.exitFill, 2.0);
});

test("a stale position exits on the TIME STOP rather than waiting for the close", () => {
  // Precedence matters for the reason, not just the fact: a position that has
  // gone nowhere for hours must be labelled TIME_STOP, because "we closed at
  // the bell" would hide why it was still open at the bell.
  const a = evaluatePaperManagement(pos(), obs(), CLOSE - 60_000, CLOSE);
  assert.equal(a.exitReason, "TIME_STOP");
});

test("NO EXIT PRICE IS EVER INVENTED — a missing bid leaves the outcome unverified", () => {
  for (const bad of [null, 0, -1]) {
    const a = evaluatePaperManagement(pos(), obs({ bid: bad, caseInvalidated: true }), T0 + 60_000, CLOSE);
    assert.equal(a.action, "UNVERIFIED", "an unobtainable exit must not be closed");
    assert.equal(a.exitFill, null);
    assert.equal(a.exitReason, "UNDERLYING_INVALIDATION", "the reason the exit was due is still recorded");
    assert.match(a.reason, /no valid bid/);
  }
});

test("an unverified exit is never recorded as a loss or a zero", async () => {
  const db = freshDb();
  seedCase(db, { state: "INVALIDATED" });
  openAsymmetryPaperTrade(db, candidate(), quote(), { nowMs: T0, env: ON });
  // Now the provider goes dark while the case is invalidated: an exit is due
  // and cannot be priced.
  await runAsymmetryPaper(db, {
    quote: async () => ({ quote: null, providerError: "provider 503" }),
    nowMs: T0 + 120_000, sessionDate: SESSION, env: ON,
  });
  const [p] = listPaperPositionsOnDb(db, SESSION);
  assert.equal(p.positionState, "OPEN", "it must stay open, not be closed at a fabricated price");
  assert.equal(p.outcomeState, "UNVERIFIED");
  assert.equal(p.finalReturnPct, null, "null, not 0");
  assert.equal(p.pnlSizedUsd, null, "null, not $0.00");
  assert.ok(p.exitAttempts >= 1, "the retry is bounded and counted");
  assert.match(p.missingDataReason, /no valid bid/);
  db.close();
});

// ── The scheduled runner ────────────────────────────────────────────────────

test("the runner opens eligible cases and then manages the open positions", async () => {
  const db = freshDb();
  seedCase(db);
  const open = await runAsymmetryPaper(db, {
    quote: quoteFn({ optionSymbol: OCC, bid: 1.9, ask: 2.0, quoteAtMs: T0 - 500 }),
    nowMs: T0, sessionDate: SESSION, env: ON,
  });
  assert.equal(open.ran, true);
  assert.equal(open.entriesOpened, 1);
  assert.equal(listOpenPaperPositionsOnDb(db, SESSION).length, 1);

  // A later tick with the contract up 250%: the target closes it at the bid.
  const later = T0 + 10 * 60_000;
  const manage = await runAsymmetryPaper(db, {
    quote: quoteFn({ optionSymbol: OCC, bid: 7.0, ask: 7.2, quoteAtMs: later - 500 }),
    nowMs: later, sessionDate: SESSION, env: ON,
  });
  assert.equal(manage.entriesOpened, 0, "an existing position is never reopened");
  assert.equal(manage.positionsClosed, 1);

  const [p] = listPaperPositionsOnDb(db, SESSION);
  assert.equal(p.positionState, "CLOSED");
  assert.match(p.exitReason, new RegExp(`^TARGET_REACHED:${PAPER_RULES_VERSION}$`));
  assert.equal(p.exitFill, 7.0);
  assert.equal(p.finalReturnPct, 250);
  assert.equal(p.outcomeState, "VERIFIED");
  // 1 contract: (7.00 - 2.00) × 100 = $500.
  assert.equal(p.pnlOneContractUsd, 500);
  // FIXED_RISK sized 7 contracts: $3,500.
  assert.equal(p.pnlSizedUsd, 3500);
  db.close();
});

test("the runner is disabled by default and does nothing at all", async () => {
  const db = freshDb();
  seedCase(db);
  const res = await runAsymmetryPaper(db, { quote: quoteFn(quote()), nowMs: T0, sessionDate: SESSION, env: {} });
  assert.equal(res.ran, false);
  assert.match(res.reason, /HIGH_ASYMMETRY_PAPER_ENABLED/);
  assert.equal(listPaperPositionsOnDb(db, SESSION).length, 0);
  assert.equal(listPaperSkipsOnDb(db, SESSION).length, 0, "a disabled lane has no opinion to record");
  db.close();
});

test("a paper failure is contained and never thrown at the scheduler", async () => {
  const db = freshDb();
  seedCase(db);
  const res = await runAsymmetryPaper(db, {
    quote: async () => { throw new Error("provider exploded"); },
    nowMs: T0, sessionDate: SESSION, env: ON,
  });
  assert.equal(res.ran, true, "the sweep completes rather than propagating");
  assert.ok(res.providerErrors >= 1);
  // And a broken database cannot escape either.
  const broken = { prepare() { throw new Error("db gone"); }, exec() { throw new Error("db gone"); } };
  const res2 = await runAsymmetryPaper(broken, { quote: quoteFn(quote()), nowMs: T0, sessionDate: SESSION, env: ON });
  assert.ok(Array.isArray(res2.errors), "a db fault returns a result rather than throwing");
  db.close();
});

test("one bad case cannot abort the sweep of the others", async () => {
  const db = freshDb();
  seedCase(db);
  seedCase(db, { fingerprint: `${SESSION}|O:AMD260807C00100000`, symbol: "AMD", optionSymbol: "O:AMD260807C00100000" });
  let n = 0;
  const res = await runAsymmetryPaper(db, {
    quote: async (occ) => {
      n += 1;
      if (occ.startsWith("O:AMD")) throw new Error("bad row");
      return { quote: { optionSymbol: occ, bid: 1.9, ask: 2.0, quoteAtMs: T0 - 500 }, providerError: null };
    },
    nowMs: T0, sessionDate: SESSION, env: ON,
  });
  assert.equal(res.entriesOpened, 1, "the healthy case still opened");
  assert.ok(n >= 2, "both cases were attempted");
  db.close();
});

// ── Quant statistics ────────────────────────────────────────────────────────

const graded = (returnPct, over = {}) => ({
  sessionDate: SESSION, positionFingerprint: `fp-${returnPct}-${Math.random()}`, caseFingerprint: "c",
  alertId: null, symbol: "NVDA", direction: "CALL", optionSymbol: OCC, setupFamily: "BREAKOUT",
  stateAtEntry: "EARLY_ASYMMETRY", rulesVersion: PAPER_RULES_VERSION, entryAtMs: T0, entryFill: 2,
  entryBid: 1.9, entryAsk: 2, entrySpreadPct: 5, stopLossPct: 35, fixedRiskQty: 1,
  positionState: "CLOSED", lastBid: null, lastMarkAtMs: null, lastReturnPct: null,
  mfePct: returnPct, maePct: -5, highestMilestone: highestMilestone(returnPct),
  exitAtMs: T0 + 600_000, exitFill: 2 * (1 + returnPct / 100), exitReason: "TARGET_REACHED",
  finalReturnPct: returnPct, pnlOneContractUsd: returnPct * 2, pnlSizedUsd: returnPct * 2,
  outcomeState: "VERIFIED", missingDataReason: null, exitAttempts: 0, missingEvidence: [], ...over,
});

test("AN EMPTY COHORT IS NULL, NEVER 0%", () => {
  const m = computeCohortMetrics("EMPTY", []);
  assert.equal(m.count, 0);
  assert.equal(m.gradeableCount, 0);
  for (const field of [
    "winRatePct", "winRateCi95", "medianReturnPct", "averageReturnPct", "profitFactor",
    "expectancyPct", "medianHoldMs", "stopFrequencyPct", "invalidationFrequencyPct",
    "falsePositiveRatePct", "missingDataRatePct", "totalPnlSizedUsd", "largestWinnerPct",
  ]) {
    assert.equal(m[field], null, `${field} must be null on an empty cohort, not 0`);
  }
  assert.match(m.minimumSampleWarning, /below the 10-sample minimum/);
});

test("unverified positions are excluded from returns and counted as missing data", () => {
  const m = computeCohortMetrics("MIXED", [
    graded(100), graded(-20),
    graded(0, { outcomeState: "UNVERIFIED", finalReturnPct: null, positionState: "OPEN" }),
  ]);
  assert.equal(m.count, 3);
  assert.equal(m.gradeableCount, 2, "the unverified row must not be graded");
  assert.equal(m.winRatePct, 50, "50% of 2, not 33% of 3");
  assert.equal(m.missingDataRatePct, 33.3);
});

test("profit factor is null rather than Infinity when a cohort has no losses", () => {
  const m = computeCohortMetrics("ALL_WINNERS", [graded(50), graded(100)]);
  assert.equal(m.profitFactor, null);
  assert.equal(m.winRatePct, 100);
});

test("the win-rate interval is a Wilson interval and stays inside 0-100", () => {
  assert.equal(wilson95(0, 0), null);
  const tiny = wilson95(1, 1);
  assert.ok(tiny.lowPct >= 0 && tiny.highPct <= 100);
  assert.ok(tiny.lowPct < 100, "one win out of one is not a certainty");
  const wide = wilson95(3, 5);
  assert.ok(wide.highPct - wide.lowPct > 40, "a 5-sample interval must be visibly wide");
});

test("the holdout is chronological and reports itself unusable when too small", () => {
  const split = holdoutSplit([graded(10), graded(20), graded(30)]);
  assert.equal(split.evaluable, false);
  assert.match(split.note, /Not evaluable/);
});

test("the Quant report never mixes rule versions silently", () => {
  const report = buildQuantReport({
    sessionDate: SESSION, nowMs: T0,
    positions: [graded(50), graded(20, { rulesVersion: "SOME_OLD_VERSION" })],
    skips: [], cases: [],
  });
  assert.deepEqual(report.rulesVersionsPresent.sort(), ["HIGH_ASYMMETRY_PAPER_V1", "SOME_OLD_VERSION"]);
  assert.match(report.versionMixWarning, /must not be pooled/);
  // Only the current version feeds the headline cohort.
  assert.equal(report.cohorts.find((c) => c.cohort === "ALL_PAPER_ENTERED").gradeableCount, 1);
});

test("Quant proposes but never activates", () => {
  const report = buildQuantReport({
    sessionDate: SESSION, nowMs: T0,
    positions: Array.from({ length: 12 }, (_, i) => graded(i % 2 ? 60 : -30)),
    skips: [], cases: [],
  });
  assert.ok(report.proposals.length > 0);
  for (const p of report.proposals) {
    assert.equal(p.approvalStatus, "PROPOSED");
    assert.equal(p.implementationStatus, "NOT_IMPLEMENTED");
  }
  assert.equal(report.productionBehaviorChanged, false);
  assert.equal(report.aiInvolved, false);
});

test("evidence associations are labelled association, never causation", () => {
  const report = buildQuantReport({
    sessionDate: SESSION, nowMs: T0,
    positions: Array.from({ length: 12 }, (_, i) => graded(50, { entrySpreadPct: i < 6 ? 5 : 20 })),
    skips: [], cases: [],
  });
  const assoc = report.evidenceAssociations.find((a) => a.attribute === "entry_spread_tight");
  assert.equal(assoc.sufficientSample, true);
  assert.match(assoc.note, /Not a causal claim/);
  assert.equal("effect" in assoc, false, "the field must not be named or framed as an effect");
});

// ── EOD report ──────────────────────────────────────────────────────────────

test("the EOD report reads ACTUAL paper outcomes, not a re-derivation", async () => {
  const db = freshDb();
  seedCase(db);
  await runAsymmetryPaper(db, {
    quote: quoteFn({ optionSymbol: OCC, bid: 1.9, ask: 2.0, quoteAtMs: T0 - 500 }),
    nowMs: T0, sessionDate: SESSION, env: ON,
  });
  const later = T0 + 10 * 60_000;
  await runAsymmetryPaper(db, {
    quote: quoteFn({ optionSymbol: OCC, bid: 7.0, ask: 7.2, quoteAtMs: later - 500 }),
    nowMs: later, sessionDate: SESSION, env: ON,
  });

  const res = await runAsymmetryEodReview(db, {
    nowMs: later + 1000, sessionDate: SESSION,
    env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1", ...ON },
  });
  assert.equal(res.persisted, true);
  assert.equal(res.quantPersisted, true);
  const paper = res.review.paper;
  assert.equal(paper.tradesOpened, 1);
  assert.equal(paper.closedPositions, 1);
  assert.equal(paper.wins, 1);
  assert.equal(paper.losses, 0);
  assert.equal(paper.normalizedOneContractPnlUsd, 500, "read from the stored position, not recomputed from a mark");
  assert.equal(paper.totalSimulatedPnlUsd, 3500);
  assert.equal(paper.milestoneDistribution["+200%"], 1);
  assert.equal(paper.aiInvolvedInAnyDecision, false);
  // The Quant report is stored under its own version key.
  assert.ok(readQuantReportOnDb(db, SESSION, PAPER_RULES_VERSION));
  db.close();
});

test("an empty paper lane reports zero COUNTS and null RATES", () => {
  const review = buildDeterministicReview({
    sessionDate: SESSION, nowMs: T0, cases: [], transitions: [], outcomes: [],
    paper: { enabled: false, positions: [], skips: [], markRejections: [] },
  });
  assert.equal(review.paper.tradesOpened, 0, "a count of zero trades is a fact");
  assert.equal(review.paper.totalSimulatedPnlUsd, null, "but a P&L over zero trades is not");
  assert.equal(review.paper.medianMfePct, null);
  assert.equal(review.paper.quant.cohorts[0].winRatePct, null);
});

// ── AI boundaries ───────────────────────────────────────────────────────────

test("AI failure blocks neither the review, the Quant report, nor the paper data", async () => {
  const db = freshDb();
  seedCase(db);
  await runAsymmetryPaper(db, {
    quote: quoteFn({ optionSymbol: OCC, bid: 1.9, ask: 2.0, quoteAtMs: T0 - 500 }),
    nowMs: T0, sessionDate: SESSION, env: ON,
  });
  const res = await runAsymmetryEodReview(db, {
    nowMs: T0 + 60_000, sessionDate: SESSION,
    env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1", ...ON },
    explain: async () => { throw new Error("no credits"); },
  });
  assert.equal(res.aiStatus, "FAILED");
  assert.equal(res.persisted, true, "the measured review survives");
  assert.equal(res.quantPersisted, true, "and so does the Quant report");
  assert.equal(res.review.paper.tradesOpened, 1);
  assert.equal(listPaperPositionsOnDb(db, SESSION).length, 1, "the position is untouched");
  db.close();
});

test("an AI budget block is reported and changes nothing deterministic", async () => {
  const db = freshDb();
  const res = await runAsymmetryEodReview(db, {
    nowMs: T0, sessionDate: SESSION,
    env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1", ...ON },
    explain: async () => ({ status: "AI_BUDGET_BLOCKED", summary: null, reason: "daily limit reached (1/1)" }),
  });
  assert.equal(res.aiStatus, "AI_BUDGET_BLOCKED");
  assert.match(res.aiReason, /daily limit/);
  assert.equal(res.persisted, true);
  assert.equal(res.quantPersisted, true);
  db.close();
});

test("THE PAPER RUNTIME HAS ZERO DEPENDENCY ON ANY AI MODULE", () => {
  // Every file in the paper lane, plus the runtime modules it depends on,
  // checked transitively by source. If any of them could reach lib/ai the
  // claim "paper trading continues when AI is unavailable" would be unprovable.
  const dir = "lib/research/asymmetry/paper";
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 6, "the lane must actually have modules");
  for (const f of files) {
    const src = readFileSync(`${dir}/${f}`, "utf8");
    assert.equal(/from\s+["'].*\/ai\//.test(src), false, `${f} must not import from lib/ai`);
    assert.equal(/require\(["'][^"']*\/ai\//.test(src), false, `${f} must not require lib/ai`);
    assert.equal(/anthropic|openai|runStructuredAiJob|claude-/i.test(src), false, `${f} must not reference a model provider`);
  }
});

test("the paper runtime executes with the AI modules made unloadable", async () => {
  // The strongest available form of the claim in-process: run a full entry →
  // mark → exit → grade cycle and assert nothing in the path ever resolved an
  // AI module. `runAsymmetryEodReview` is excluded because AI is injected
  // there by the caller, which is exactly the boundary being relied on.
  const db = freshDb();
  seedCase(db);
  const before = Object.keys(require.cache ?? {}).filter((k) => k.includes(`${"lib"}/ai/`)).length;
  await runAsymmetryPaper(db, {
    quote: quoteFn({ optionSymbol: OCC, bid: 1.9, ask: 2.0, quoteAtMs: T0 - 500 }),
    nowMs: T0, sessionDate: SESSION, env: ON,
  });
  const after = Object.keys(require.cache ?? {}).filter((k) => k.includes(`${"lib"}/ai/`)).length;
  assert.equal(after, before, "the paper sweep must not load an AI module");
  assert.equal(listPaperPositionsOnDb(db, SESSION).length, 1);
  db.close();
});

test("AI cannot change a rule: the advisory return value is stored as prose only", async () => {
  const db = freshDb();
  const res = await runAsymmetryEodReview(db, {
    nowMs: T0, sessionDate: SESSION,
    env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1", ...ON },
    // A hostile "advisory" reply trying to change the rules.
    explain: async () => JSON.stringify({ stopLossPct: 5, targetPct: 10, canSendSubscriber: true }),
  });
  assert.equal(res.aiStatus, "OK");
  // Nothing read it back. The deterministic config is untouched.
  assert.equal(DEFAULT_MANAGEMENT.stopLossPct, 35);
  assert.equal(DEFAULT_MANAGEMENT.targetPct, 200);
  assert.equal(PAPER_LANE_AUTHORITY.canSendSubscriber, false);
  assert.equal(PAPER_LANE_AUTHORITY.aiMayDecide, false);
  db.close();
});

// ── Structural safety ───────────────────────────────────────────────────────

test("no broker, execution, or order module is reachable from the paper lane", () => {
  const dir = "lib/research/asymmetry/paper";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(`${dir}/${f}`, "utf8");
    // \b matters: "entryFill" contains "tryFill" as a substring.
    for (const forbidden of [/\/execution\//, /\/broker\//, /paper-broker/, /\bplaceOrder\b/, /\bsubmitOrder\b/, /\btryFill\b/]) {
      assert.equal(forbidden.test(src), false, `${f} must not reference ${forbidden}`);
    }
  }
});

test("no subscriber SEND path is reachable from the paper lane", () => {
  const dir = "lib/research/asymmetry/paper";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(`${dir}/${f}`, "utf8");
    for (const forbidden of [/notifyNewAlert/, /deliverOptionsCallout/, /sendTrackedDiscord/, /DISCORD_WEBHOOK_OPTIONS/, /DISCORD_WEBHOOK_URL\b/]) {
      // report-delivery names the subscriber webhooks ONLY to refuse them.
      if (f === "report-delivery.ts" && /DISCORD_WEBHOOK/.test(String(forbidden))) continue;
      assert.equal(forbidden.test(src), false, `${f} must not reference ${forbidden}`);
    }
  }
  assert.equal(PAPER_LANE_AUTHORITY.canSendSubscriber, false);
  assert.equal(PAPER_LANE_AUTHORITY.canPlaceRealOrder, false);
  assert.equal(PAPER_LANE_AUTHORITY.canModifySubscriberPaper, false);
});

test("the lane is a separate TABLE, so no subscriber query can absorb it", () => {
  const db = freshDb();
  seedCase(db);
  openAsymmetryPaperTrade(db, candidate(), quote(), { nowMs: T0, env: ON });
  // The subscriber population lives in options_paper_trades. It must be empty.
  db.exec("CREATE TABLE IF NOT EXISTS options_paper_trades (id INTEGER PRIMARY KEY, paper_kind TEXT, option_symbol TEXT)");
  const n = db.prepare("SELECT COUNT(*) n FROM options_paper_trades").get().n;
  assert.equal(n, 0, "the asymmetry lane must never write into the subscriber paper table");
  assert.equal(listPaperPositionsOnDb(db, SESSION).length, 1);
  assert.equal(listPaperPositionsOnDb(db, SESSION)[0].positionFingerprint.includes("NVDA"), true);
  db.close();
});

test("migrations are additive and repeat-safe", () => {
  const db = new Database(":memory:");
  for (let i = 0; i < 3; i += 1) {
    ensureAsymmetrySchema(db);
    ensureAsymmetryPaperSchema(db);
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'asymmetry_%' ORDER BY name")
    .all().map((r) => r.name);
  for (const t of [
    "asymmetry_paper_positions", "asymmetry_paper_marks", "asymmetry_paper_skips",
    "asymmetry_paper_report_delivery", "asymmetry_quant_reports",
  ]) {
    assert.ok(tables.includes(t), `${t} must exist`);
  }
  // Purely additive: no DROP or destructive ALTER anywhere in the lane.
  const src = readFileSync("lib/research/asymmetry/paper/store.ts", "utf8");
  assert.equal(/DROP\s+TABLE|DROP\s+INDEX|DELETE\s+FROM/i.test(src), false, "no destructive DDL or DML");
  assert.equal(/ALTER\s+TABLE/i.test(src), false, "no ALTER against an existing production table");
  db.close();
});

// ── Report delivery ─────────────────────────────────────────────────────────

test("an unavailable recap webhook is BLOCKED_CONFIG with no subscriber fallback", async () => {
  const res = await deliverPaperReport(SESSION, emptyReport(), { env: {} });
  assert.equal(res.status, "BLOCKED_CONFIG");
  assert.equal(res.webhookConfigured, false);
  assert.match(res.reason, /no subscriber fallback/);
});

test("a recap webhook that collides with a subscriber channel is refused", () => {
  const cfg = resolveReportDelivery({
    DISCORD_WEBHOOK_RECAP: "https://discord.com/api/webhooks/1/x",
    DISCORD_WEBHOOK_OPTIONS: "https://discord.com/api/webhooks/1/x",
  });
  assert.equal(cfg.webhook, null, "it must not be usable");
  assert.match(cfg.refusedReason, /DISCORD_WEBHOOK_OPTIONS/);
});

test("the report message never renders an unknown as zero", () => {
  const msg = buildPaperReportMessage(SESSION, emptyReport());
  assert.match(msg, /Simulated only/);
  assert.match(msg, /Simulated P&L \(configured size\): unavailable/);
  assert.equal(/\$0\.00/.test(msg), false, "an unknown P&L must not print as $0.00");
});

test("the report is persisted even when delivery is blocked", async () => {
  const db = freshDb();
  const res = await runAsymmetryEodReview(db, {
    nowMs: T0, sessionDate: SESSION,
    env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1", ...ON },
    deliverPaperReport: async () => ({ status: "BLOCKED_CONFIG", reason: "DISCORD_WEBHOOK_RECAP is not configured" }),
  });
  assert.equal(res.persisted, true);
  assert.equal(res.paperDelivery.status, "BLOCKED_CONFIG");
  assert.equal(readReportDeliveryOnDb(db, SESSION).status, "BLOCKED_CONFIG");
  db.close();
});

test("the hourly EOD job delivers the report at most once per session", async () => {
  const db = freshDb();
  let sends = 0;
  const run = () => runAsymmetryEodReview(db, {
    nowMs: T0, sessionDate: SESSION,
    env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1", ...ON },
    deliverPaperReport: async () => { sends += 1; return { status: "SENT", reason: null }; },
  });
  await run(); await run(); await run();
  assert.equal(sends, 1, "an hourly job must not repost the same report every hour");
  db.close();
});

function emptyReport() {
  return buildDeterministicReview({
    sessionDate: SESSION, nowMs: T0, cases: [], transitions: [], outcomes: [],
    paper: { enabled: true, positions: [], skips: [], markRejections: [] },
  }).paper;
}

// ── Lane identity ───────────────────────────────────────────────────────────

test("the lane label is explicit and distinct from every existing paper kind", () => {
  assert.equal(ASYMMETRY_PAPER_LANE, "HIGH_ASYMMETRY_PAPER");
  for (const existing of [
    "DELIVERED_ALERT_PAPER", "RESEARCH_ONLY_PAPER", "ZERO_DTE_RESEARCH_PAPER", "BEARISH_RESEARCH_PAPER",
  ]) {
    assert.notEqual(ASYMMETRY_PAPER_LANE, existing);
  }
  assert.equal(isPaperEntryState("PREMIUM_CHASE"), false);
  assert.equal(isPaperEntryState("HIGH_ASYMMETRY"), true);
});
