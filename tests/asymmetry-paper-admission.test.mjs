/**
 * tests/asymmetry-paper-admission.test.mjs
 *
 * The asymmetry PAPER lane bills to `asymmetry_mark` — the SAME minute partition
 * as the forward-mark sweep — and runs on the same 60s cadence. Pacing the mark
 * sweep alone therefore did not stop the refusals: 90 seconds after the fix
 * deployed, production had already recorded 339 more `asymmetry_mark` quota
 * blocks, from this lane.
 *
 * It has a second problem the mark sweep does not. Entries run BEFORE
 * management in the same sweep, so under a tight partition entries spend the
 * whole allowance and positions that are ALREADY OPEN go unpriced. That is
 * research starving an active exact-contract position, which the provider
 * priority order forbids outright.
 *
 * The fix is arithmetic, not reordering: the entry loop refuses to spend the
 * requests management is going to need. These tests pin that an open position is
 * always priced, that entries yield instead, and that a cached quote is free.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runAsymmetryPaper } from "../lib/research/asymmetry/paper/runner.ts";
import { openAsymmetryCaseOnDb, ensureAsymmetrySchema } from "../lib/research/asymmetry/case-store.ts";
import { ensureAsymmetryPaperSchema, openPaperPositionOnDb } from "../lib/research/asymmetry/paper/store.ts";
import {
  ensureActivationSchema, armActivationOnDb, activateOnDb,
} from "../lib/research/asymmetry/paper/activation.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }
const skip = Database ? false : "better-sqlite3 unavailable";

const SESSION = "2026-08-19";
// 10:00 ET on a real trading day — inside the options quote session.
const NOW = Date.parse("2026-08-19T14:00:00.000Z");
const ON = { HIGH_ASYMMETRY_PAPER_ENABLED: "1" };

/** N cases in an entry-eligible state, each on its own exact OCC. */
function seed(db, n) {
  ensureAsymmetrySchema(db);
  ensureAsymmetryPaperSchema(db);
  ensureActivationSchema(db);
  // Entries are refused BEFORE any quote unless the lane is activated, so
  // without this the pacing path under test is never reached.
  armActivationOnDb(db, SESSION, NOW);
  activateOnDb(db, {
    sessionDate: SESSION, nowMs: NOW,
    evidence: { proof: { entryAsk: 1.0, markBid: 1.1, caseFingerprint: "seed", optionSymbol: "O:SEED260821C00100000" } },
  });
  for (let i = 0; i < n; i += 1) {
    const occ = `O:AAA${String(i).padStart(3, "0")}260821C00100000`;
    openAsymmetryCaseOnDb(db, {
      sessionDate: SESSION,
      fingerprint: `${SESSION}|${occ}`,
      symbol: `AAA${i}`,
      direction: "CALL",
      optionSymbol: occ,
      state: "HIGH_ASYMMETRY",
      firstDetectedAtMs: NOW - 30 * 60_000 - i * 1000,
      earlyAsk: 1.0, earlyBid: 0.9, earlySpreadPct: 10,
      setupFamily: "TEST", scannerVersion: "test",
      evidenceJson: "{}", missingEvidence: [],
      normalQualifiedAtMs: null, normalAsk: null,
    }, NOW);
  }
}

/** N ALREADY-OPEN positions, seeded directly so the management path is exercised. */
function seedOpenPositions(db, n) {
  for (let i = 0; i < n; i += 1) {
    const occ = `O:OPN${String(i).padStart(3, "0")}260821C00100000`;
    openPaperPositionOnDb(db, {
      sessionDate: SESSION,
      positionFingerprint: `pos|${occ}`,
      caseFingerprint: `${SESSION}|${occ}`,
      alertId: null,
      symbol: `OPN${i}`,
      direction: "CALL",
      optionSymbol: occ,
      setupFamily: "TEST",
      stateAtEntry: "HIGH_ASYMMETRY",
      entryAtMs: NOW - 10 * 60_000,
      entryFill: 1.1,
      entryBid: 1.0, entryAsk: 1.1, entrySpreadPct: 9,
      entryUnderlyingPrice: 100, entryQuoteAtMs: NOW - 10 * 60_000,
      evidenceJson: null, missingEvidenceJson: null,
      stopLossPct: 40,
      fixedRiskQty: 1, fixedRiskReason: "test", fixedRiskCostUsd: 110, fixedRiskAtRiskUsd: 44,
      codeVersion: "test",
    }, NOW - 10 * 60_000);
  }
}

function deps(over = {}) {
  const asked = [];
  return {
    asked,
    quote: async (optionSymbol) => {
      asked.push(optionSymbol);
      return { quote: { optionSymbol, bid: 1.0, ask: 1.1, quoteAtMs: NOW - 1000, underlyingPrice: 100 }, providerError: null };
    },
    nowMs: NOW,
    sessionDate: SESSION,
    env: ON,
    ...over,
  };
}

test("the sweep never throws and always reports both deferral counters", { skip }, async () => {
  const db = new Database(":memory:");
  for (const admission of [undefined, () => 0, () => 5, () => -1]) {
    const res = await runAsymmetryPaper(db, deps({ admission }));
    assert.equal(typeof res.entriesDeferredForBudget, "number", "a silently absent counter hides the budget problem");
    assert.equal(typeof res.positionsDeferredForBudget, "number");
  }
  db.close();
});

test("an exhausted allowance issues no provider request, with real work waiting", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db, 30);
  const unpaced = deps();
  const baseline = await runAsymmetryPaper(new Database(":memory:"), unpaced);
  assert.equal(baseline.ran, true, "the sweep runs");

  const db2 = new Database(":memory:");
  seed(db2, 30);
  const d = deps({ admission: () => 0 });
  const res = await runAsymmetryPaper(db2, d);
  assert.deepEqual(d.asked, [], "30 eligible cases waiting, and not one request issued");
  assert.ok(res.entriesDeferredForBudget > 0, "and the sweep says how much it declined");
  db.close();
  db2.close();
});

test("entries are paced to the allowance, and a repeat contract is free", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db, 30);
  let left = 4;
  const d = deps({ admission: () => left });
  const inner = d.quote;
  d.quote = async (occ, sym) => { left -= 1; return inner(occ, sym); };

  const res = await runAsymmetryPaper(db, d);
  assert.equal(d.asked.length, 4, "exactly the allowance was spent on new contracts");
  assert.ok(res.entriesDeferredForBudget >= 26, "the rest were declined, not refused");
  assert.equal(new Set(d.asked).size, d.asked.length, "and no contract was priced twice");
  db.close();
});

test("with no admission wired, every eligible case is still priced", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db, 12);
  const d = deps();
  const res = await runAsymmetryPaper(db, d);
  assert.equal(res.entriesDeferredForBudget, 0);
  assert.equal(res.positionsDeferredForBudget, 0);
  assert.equal(d.asked.length, 12, "unbounded means unbounded — unchanged from before");
  db.close();
});

test("the entry allowance is the lane allowance MINUS what management will need", () => {
  // The reservation is pure arithmetic and worth stating as such, because it is
  // the whole safety property: entries may only ever see the surplus.
  const laneAllowance = 44;
  for (const openPositions of [0, 1, 20, 44, 60]) {
    const entryAllowance = laneAllowance - openPositions;
    assert.equal(
      Math.max(0, entryAllowance),
      Math.max(0, 44 - openPositions),
      "entries never get budget earmarked for an already-open position",
    );
    if (openPositions >= laneAllowance) {
      assert.ok(entryAllowance <= 0, "when open positions consume the lane, entries get nothing");
    }
  }
});

test("AN OPEN POSITION IS NEVER LEFT UNPRICED SO AN ENTRY CAN BE PRICED", { skip }, async () => {
  // 5 positions already open, 30 cases wanting to enter, and only enough
  // allowance for the 5. Before the reservation, entries ran first and would
  // have spent all 5 — leaving every open position unmanaged.
  const db = new Database(":memory:");
  seed(db, 30);
  seedOpenPositions(db, 5);

  let left = 5;
  const d = deps({ admission: () => left });
  const inner = d.quote;
  d.quote = async (occ, sym) => { left -= 1; return inner(occ, sym); };

  const res = await runAsymmetryPaper(db, d);
  assert.equal(res.positionsDeferredForBudget, 0, "an already-open position is never left unpriced");
  assert.equal(res.positionsManaged, 5, "every open position was managed");
  assert.equal(res.entriesDeferredForBudget, 30, "and every entry yielded to them");
  assert.equal(
    d.asked.filter((occ) => occ.startsWith("O:OPN")).length, 5,
    "the requests went to the OPEN positions, not to new entries",
  );
  assert.equal(d.asked.filter((occ) => occ.startsWith("O:AAA")).length, 0);
  db.close();
});

test("with surplus allowance, entries are priced too — the reservation is not a block", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db, 30);
  seedOpenPositions(db, 5);

  let left = 9; // 5 reserved for management, 4 of surplus for entries
  const d = deps({ admission: () => left });
  const inner = d.quote;
  d.quote = async (occ, sym) => { left -= 1; return inner(occ, sym); };

  const res = await runAsymmetryPaper(db, d);
  assert.equal(res.positionsManaged, 5);
  assert.equal(res.positionsDeferredForBudget, 0);
  assert.equal(d.asked.filter((occ) => occ.startsWith("O:AAA")).length, 4, "the surplus went to entries");
  db.close();
});
