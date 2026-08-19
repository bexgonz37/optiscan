/**
 * tests/asymmetry-mark-admission.test.mjs
 *
 * The 2026-08-19 shape, reproduced: many open cases, every horizon owed, and a
 * lane whose minute partition is far smaller than the backlog.
 *
 * BEFORE, the sweep fired every owed horizon regardless of budget. Each refusal
 * cost a provider refusal and a transient `PROVIDER_BUDGET` mark row, and a
 * transient row is re-offered on the next sweep — so the identical backlog was
 * re-fired every 60 seconds. Production: 748 admitted against 17,483 refused,
 * a 4.1% admission rate, draining at the reserve rate for the rest of the day.
 *
 * What must now hold:
 *   - the sweep issues at most what its partition allows, then STOPS;
 *   - it writes NO row for work it declined, so the horizon stays owed in
 *     exactly the state it would have been in had it been refused;
 *   - successive sweeps ROTATE, so a case at the back of a newest-first list is
 *     reached in bounded time instead of never;
 *   - with no admission wired, behaviour is what it was.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runDueAsymmetryMarks, MARKS_ENABLED_ENV } from "../lib/research/asymmetry/mark-runner.ts";
import { openAsymmetryCaseOnDb, ensureAsymmetrySchema } from "../lib/research/asymmetry/case-store.ts";
import { rotateForBudget } from "../lib/research/asymmetry/sweep-rotation.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }
const skip = Database ? false : "better-sqlite3 unavailable";

const SESSION = "2026-08-19";
// Mid-session, options open: 2026-08-19 15:00Z is 11:00 ET.
const NOW = Date.parse("2026-08-19T15:00:00Z");
const ENV = { [MARKS_ENABLED_ENV]: "1" };

/** N open cases, all detected 90 minutes ago so ALL SEVEN horizons are owed. */
function seed(db, n) {
  ensureAsymmetrySchema(db);
  for (let i = 0; i < n; i += 1) {
    const occ = `O:AAA${String(i).padStart(3, "0")}260821C00100000`;
    openAsymmetryCaseOnDb(db, {
      sessionDate: SESSION,
      fingerprint: `${SESSION}|${occ}`,
      symbol: `AAA${i}`,
      direction: "CALL",
      optionSymbol: occ,
      state: "CONFIRMING",
      // Stagger detection so listCasesOnDb's newest-first order is deterministic.
      firstDetectedAtMs: NOW - 90 * 60_000 - i * 1000,
      earlyAsk: 1.0, earlyBid: 0.9, earlySpreadPct: 10,
      setupFamily: "TEST", scannerVersion: "test",
      evidenceJson: "{}", missingEvidence: [],
      normalQualifiedAtMs: null, normalAsk: null,
    }, NOW);
  }
}

function deps(overrides = {}) {
  let calls = 0;
  const seen = [];
  return {
    calls: () => calls,
    seen,
    quote: async (optionSymbol) => {
      calls += 1;
      seen.push(optionSymbol);
      return {
        quote: { optionSymbol, bid: 1.2, ask: 1.3, quoteAtMs: NOW - 1000 },
        providerError: null,
        observedAtMs: NOW,
      };
    },
    nowMs: NOW,
    sessionDate: SESSION,
    env: ENV,
    ...overrides,
  };
}

test("an exhausted allowance stops the sweep instead of generating refusals", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db, 20);
  const d = deps({ admission: () => 0 });
  const res = await runDueAsymmetryMarks(db, d);

  assert.equal(d.calls(), 0, "an exhausted lane must not issue a single provider request");
  assert.equal(res.marksWritten, 0);
  assert.equal(res.marksRejected, 0, "and must not record a rejection it never asked for");
  const rows = db.prepare("SELECT COUNT(*) n FROM asymmetry_marks").get();
  assert.equal(rows.n, 0, "declined work leaves NO row — the horizon is simply still owed");
  assert.ok(res.casesDeferred > 0, "and the sweep says so");
  db.close();
});

test("the sweep spends its allowance and no more", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db, 40);
  // 40 cases x 7 owed horizons = 280 requests wanted. Allow 10.
  let left = 10;
  const d = deps({ admission: () => left });
  const inner = d.quote;
  d.quote = async (occ, sym) => { left -= 1; return inner(occ, sym); };

  const res = await runDueAsymmetryMarks(db, d);
  assert.equal(d.calls(), 10, "exactly the allowance was spent");
  assert.ok(res.marksWritten <= 10);
  const total = db.prepare("SELECT COUNT(*) n FROM asymmetry_marks").get().n;
  assert.equal(total, 10, "one row per request actually made, and none for the rest");
  db.close();
});

test("successive sweeps rotate, so a case at the back of the list is reached", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db, 30);
  const reached = new Set();
  // One request per sweep. Without rotation this would mark the same case forever.
  for (let sweep = 0; sweep < 12; sweep += 1) {
    let left = 1;
    const d = deps({ admission: () => left });
    const inner = d.quote;
    d.quote = async (occ, sym) => { left -= 1; return inner(occ, sym); };
    await runDueAsymmetryMarks(db, d);
    for (const occ of d.seen) reached.add(occ);
  }
  // 12 sweeps x 1 case each, cursor advancing: every sweep must land on a case
  // the previous sweeps did not. Anything less means the cutoff is fixed and the
  // back of the list is frozen — the failure rotation exists to prevent.
  assert.equal(reached.size, 12, `rotation must reach a new case each sweep; reached ${reached.size}`);
  db.close();
});

test("with no admission wired the sweep asks for everything it is owed", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db, 5);
  const d = deps({});
  const res = await runDueAsymmetryMarks(db, d);
  assert.equal(d.calls(), 5 * 7, "5 cases x 7 owed horizons, unchanged from before");
  assert.equal(res.budgetDeferred, 0);
  assert.equal(res.casesDeferred, 0);
  db.close();
});

test("rotateForBudget is the same function the transition sweep uses", { skip: false }, async () => {
  const viaTransitions = (await import("../lib/research/asymmetry/transition-runner.ts")).rotateForBudget;
  assert.equal(viaTransitions, rotateForBudget, "one implementation, two callers");
  // And the property both sweeps depend on: full coverage in bounded sweeps.
  const items = [...Array(10).keys()];
  let cursor = 0;
  const seen = new Set();
  for (let i = 0; i < 5; i += 1) {
    const r = rotateForBudget(items, cursor, 3);
    r.selected.forEach((x) => seen.add(x));
    cursor = r.nextCursor;
  }
  assert.equal(seen.size, 10, "every item is reached within ceil(n/budget) sweeps");
});
