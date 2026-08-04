/**
 * The forward-mark quote path: cost, attribution, and retryability.
 *
 * Production on 2026-07-31 recorded 2,718 NO_QUOTE mark rejections against 7
 * usable marks (0.4%), which read as "these contracts had no market". They did.
 * The real cause was that reading ONE contract fetched its ENTIRE chain, which
 * exhausted the shared daily provider budget mid-session; every refusal after
 * that was then filed as a missing quote.
 *
 * Each test below pins one part of that failure so it cannot return quietly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMark, writeMarkOnDb, runDueAsymmetryMarks, dueHorizons,
  isTransientRejection, TRANSIENT_MARK_REJECTIONS, MARK_HORIZONS_MINUTES,
} from "../lib/research/asymmetry/mark-runner.ts";
import {
  rotateForBudget, resolveSweepQuoteBudget, DEFAULT_MAX_QUOTES_PER_SWEEP,
  runAsymmetryTransitions,
} from "../lib/research/asymmetry/transition-runner.ts";
import { openAsymmetryCaseOnDb, ensureAsymmetrySchema } from "../lib/research/asymmetry/case-store.ts";
import { createPrivateCaseMemory } from "../lib/research/asymmetry/private-notify.ts";

let Database = null;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = null; }
const skip = Database ? false : "better-sqlite3 unavailable";

const SESSION = "2026-07-31";
const OCC = "O:NVDA260807C00200000";
const NOW = 1_785_516_000_000;
const FP = `${SESSION}|${OCC}`;

// ── attribution: three failures that must stay distinguishable ─────────────

test("a budget refusal is recorded as PROVIDER_BUDGET, never as NO_QUOTE", { skip }, async () => {
  const db = new Database(":memory:");
  seedCase(db);
  const res = await runDueAsymmetryMarks(db, {
    quote: async () => ({ quote: null, providerError: null, budgetBlocked: true }),
    nowMs: NOW, sessionDate: SESSION, env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
  });
  assert.ok(res.marksRejected > 0);
  const reasons = db.prepare("SELECT DISTINCT rejected_reason r FROM asymmetry_marks").all().map((x) => x.r);
  assert.deepEqual(reasons, ["PROVIDER_BUDGET"],
    "a self-inflicted budget refusal must never be filed as a contract with no market");
  db.close();
});

test("a provider outage is PROVIDER_ERROR, still not NO_QUOTE", { skip }, async () => {
  const db = new Database(":memory:");
  seedCase(db);
  await runDueAsymmetryMarks(db, {
    quote: async () => ({ quote: null, providerError: "connection reset", budgetBlocked: false }),
    nowMs: NOW, sessionDate: SESSION, env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
  });
  const reasons = db.prepare("SELECT DISTINCT rejected_reason r FROM asymmetry_marks").all().map((x) => x.r);
  assert.deepEqual(reasons, ["PROVIDER_ERROR"]);
  db.close();
});

test("a quote that arrived with no two-sided market is its own reason", { skip }, () => {
  // This one IS a real observation about the contract, unlike the two above.
  const zeroBid = validateMark({ optionSymbol: OCC, bid: 0, ask: 0.05, quoteAtMs: NOW - 1000 }, OCC, SESSION, NOW);
  assert.equal(zeroBid, "NO_TWO_SIDED_MARKET");
  const crossed = validateMark({ optionSymbol: OCC, bid: 2, ask: 1, quoteAtMs: NOW - 1000 }, OCC, SESSION, NOW);
  assert.equal(crossed, "NO_TWO_SIDED_MARKET");
  // A quote that never arrived stays NO_QUOTE.
  assert.equal(validateMark({ optionSymbol: OCC, bid: null, ask: null, quoteAtMs: NOW - 1000 }, OCC, SESSION, NOW), "NO_QUOTE");
  assert.equal(validateMark({ optionSymbol: OCC, bid: 1, ask: 1.1, quoteAtMs: null }, OCC, SESSION, NOW), "NO_QUOTE");
});

test("staleness and wrong-contract checks are unchanged", { skip }, () => {
  assert.equal(validateMark({ optionSymbol: "O:OTHER260807C00200000", bid: 1, ask: 1.1, quoteAtMs: NOW }, OCC, SESSION, NOW), "WRONG_OCC");
  assert.equal(validateMark({ optionSymbol: OCC, bid: 1, ask: 1.1, quoteAtMs: NOW + 5000 }, OCC, SESSION, NOW), "FUTURE_QUOTE");
  assert.equal(validateMark({ optionSymbol: OCC, bid: 1, ask: 1.1, quoteAtMs: NOW - 300_000 }, OCC, SESSION, NOW), "STALE_QUOTE");
});

// ── retryability: a transient failure must not consume the horizon ─────────

test("transient rejections are classified as retryable; real ones are not", { skip }, () => {
  assert.equal(isTransientRejection("PROVIDER_BUDGET"), true);
  assert.equal(isTransientRejection("PROVIDER_ERROR"), true);
  assert.equal(isTransientRejection("NO_QUOTE"), true);
  assert.equal(isTransientRejection("NO_TWO_SIDED_MARKET"), false, "a real market condition is settled");
  assert.equal(isTransientRejection("STALE_QUOTE"), false);
  assert.equal(isTransientRejection(null), false, "a successful mark is settled");
  assert.equal(TRANSIENT_MARK_REJECTIONS.length, 3);
});

test("a budget-blocked horizon is retried and can later be replaced by a real mark", { skip }, async () => {
  const db = new Database(":memory:");
  seedCase(db);
  const env = { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" };

  // Sweep 1: budget exhausted.
  await runDueAsymmetryMarks(db, {
    quote: async () => ({ quote: null, providerError: null, budgetBlocked: true }),
    nowMs: NOW, sessionDate: SESSION, env,
  });
  const afterBlocked = db.prepare("SELECT horizon_minutes h, rejected_reason r, bid FROM asymmetry_marks ORDER BY h").all();
  assert.ok(afterBlocked.length > 0);
  assert.ok(afterBlocked.every((r) => r.r === "PROVIDER_BUDGET"));

  // Sweep 2: budget restored. The SAME horizons must be offered again.
  const res2 = await runDueAsymmetryMarks(db, {
    quote: async () => ({ quote: { optionSymbol: OCC, bid: 4.10, ask: 4.20, quoteAtMs: NOW - 1000 }, providerError: null, budgetBlocked: false }),
    nowMs: NOW, sessionDate: SESSION, env,
  });
  assert.ok(res2.marksWritten > 0, "the deferred horizons were retried, not lost");
  const after = db.prepare("SELECT horizon_minutes h, rejected_reason r, bid FROM asymmetry_marks ORDER BY h").all();
  assert.ok(after.every((r) => r.r === null), "transient rows were replaced by real observations");
  assert.ok(after.every((r) => r.bid === 4.10));
  db.close();
});

test("a SETTLED mark is never overwritten by a later sweep", { skip }, () => {
  const db = new Database(":memory:");
  ensureAsymmetrySchema(db);
  const base = { sessionDate: SESSION, fingerprint: FP, optionSymbol: OCC, horizonMinutes: 5, markedAtMs: NOW };
  assert.equal(writeMarkOnDb(db, { ...base, bid: 3.00, ask: 3.10, quoteAgeMs: 100, returnPct: 10, rejectedReason: null }), true);
  // A later sweep must not clobber a real observation.
  assert.equal(writeMarkOnDb(db, { ...base, markedAtMs: NOW + 60_000, bid: 9.99, ask: 9.99, quoteAgeMs: 1, returnPct: 999, rejectedReason: null }), false);
  const row = db.prepare("SELECT bid, return_pct FROM asymmetry_marks WHERE horizon_minutes=5").get();
  assert.equal(row.bid, 3.00, "the original mark stands");
  assert.equal(row.return_pct, 10);
  db.close();
});

test("a settled market condition is not retried either", { skip }, () => {
  const db = new Database(":memory:");
  ensureAsymmetrySchema(db);
  const base = { sessionDate: SESSION, fingerprint: FP, optionSymbol: OCC, horizonMinutes: 5, markedAtMs: NOW };
  writeMarkOnDb(db, { ...base, bid: null, ask: null, quoteAgeMs: null, returnPct: null, rejectedReason: "NO_TWO_SIDED_MARKET" });
  assert.equal(writeMarkOnDb(db, { ...base, bid: 1, ask: 1.1, quoteAgeMs: 1, returnPct: 5, rejectedReason: null }), false,
    "NO_TWO_SIDED_MARKET is a real observation and stays");
  db.close();
});

test("dueHorizons is unchanged: only elapsed, unmarked horizons", { skip }, () => {
  const t0 = NOW - 20 * 60_000;
  assert.deepEqual(dueHorizons(t0, NOW, []), [1, 3, 5, 10, 15]);
  assert.deepEqual(dueHorizons(t0, NOW, [1, 3]), [5, 10, 15]);
  assert.deepEqual(dueHorizons(NOW, NOW, []), []);
  assert.equal(MARK_HORIZONS_MINUTES.length, 7);
});

// ── the per-sweep quote budget ─────────────────────────────────────────────

test("rotation serves every case within ceil(N/budget) sweeps", { skip }, () => {
  const cases = Array.from({ length: 10 }, (_, i) => i);
  const seen = new Set();
  let cursor = 0;
  for (let sweep = 0; sweep < 4; sweep++) {
    const r = rotateForBudget(cases, cursor, 3);
    for (const c of r.selected) seen.add(c);
    cursor = r.nextCursor;
  }
  assert.equal(seen.size, 10, "no case is permanently starved — a starved case can never transition");
});

test("a budget at or above the population selects everything and resets", { skip }, () => {
  const cases = [1, 2, 3];
  const r = rotateForBudget(cases, 0, 10);
  assert.deepEqual(r.selected, [1, 2, 3]);
  assert.equal(r.deferred, 0);
  assert.equal(r.nextCursor, 0);
});

test("a zero budget defers everything rather than failing it", { skip }, () => {
  const r = rotateForBudget([1, 2, 3], 0, 0);
  assert.deepEqual(r.selected, []);
  assert.equal(r.deferred, 3, "deferred, not rejected — the cases keep their state");
});

test("rotation wraps around the end of the list", { skip }, () => {
  const r = rotateForBudget([0, 1, 2, 3, 4], 4, 3);
  assert.deepEqual(r.selected, [4, 0, 1]);
  assert.equal(r.nextCursor, 2);
});

test("the sweep budget bounds how many cases are observed", { skip }, async () => {
  const db = new Database(":memory:");
  for (let i = 0; i < 10; i++) {
    seedCase(db, { fingerprint: `${SESSION}|occ${i}`, optionSymbol: `O:NVDA260807C0020${String(i).padStart(4, "0")}` });
  }
  let observed = 0;
  const res = await runAsymmetryTransitions(db, {
    observe: (c) => { observed += 1; return { fingerprint: c.fingerprint, bid: 3.55, ask: 3.65, quoteAtMs: NOW - 5000, triggered: false, invalidated: false, spreadPct: 2.7, openInterest: 5000 }; },
    memory: createPrivateCaseMemory(),
    send: async () => ({ ok: true }),
    env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
    nowMs: NOW, sessionDate: SESSION, maxQuotesPerSweep: 4,
  });
  assert.equal(res.casesRead, 10);
  assert.equal(observed, 4, "the sweep spent exactly its budget");
  assert.equal(res.casesObserved, 4);
  assert.equal(res.casesDeferredForBudget, 6, "the rest are deferred, and are first in line next sweep");
  db.close();
});

test("the budget is env-configurable and clamped", { skip }, () => {
  assert.equal(resolveSweepQuoteBudget({}), DEFAULT_MAX_QUOTES_PER_SWEEP);
  assert.equal(resolveSweepQuoteBudget({ ASYM_MAX_QUOTES_PER_SWEEP: "50" }), 50);
  assert.equal(resolveSweepQuoteBudget({ ASYM_MAX_QUOTES_PER_SWEEP: "-5" }), 0);
  assert.equal(resolveSweepQuoteBudget({ ASYM_MAX_QUOTES_PER_SWEEP: "99999" }), 2000);
  assert.equal(resolveSweepQuoteBudget({ ASYM_MAX_QUOTES_PER_SWEEP: "junk" }), DEFAULT_MAX_QUOTES_PER_SWEEP);
});

test("the default budget keeps the sweep inside the provider minute cap", { skip }, () => {
  // POLYGON_MINUTE_CALL_CAP defaults to 280 and is SHARED with the live
  // scanner. One quote per case per sweep at a 60s cadence means the budget is
  // requests-per-minute directly.
  assert.ok(DEFAULT_MAX_QUOTES_PER_SWEEP < 280,
    "the research lane must never be able to consume the whole minute cap on its own");
});

test("a closed ordinary options session stops transition enrichment before provider work", { skip }, async () => {
  const db = new Database(":memory:");
  seedCase(db);
  let observed = 0;
  const closedAtMs = Date.parse("2026-07-31T20:30:00Z");
  const res = await runAsymmetryTransitions(db, {
    observe: () => {
      observed += 1;
      return { fingerprint: FP, bid: 3.55, ask: 3.65, quoteAtMs: closedAtMs, triggered: false, invalidated: false, spreadPct: 2.7, openInterest: 5000 };
    },
    memory: createPrivateCaseMemory(),
    send: async () => ({ ok: true }),
    env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
    nowMs: closedAtMs,
    sessionDate: SESSION,
  });

  assert.equal(res.ran, false);
  assert.equal(res.reason, "OPTIONS_SESSION_CLOSED");
  assert.equal(observed, 0, "after-hours reprocessing must not spend exact-OCC provider capacity");
  assert.equal(res.notified, 0);
  db.close();
});

test("a closed ordinary options session stops forward marks before provider work", { skip }, async () => {
  const db = new Database(":memory:");
  seedCase(db);
  let quotes = 0;
  const closedAtMs = Date.parse("2026-07-31T20:30:00Z");
  const res = await runDueAsymmetryMarks(db, {
    quote: async () => {
      quotes += 1;
      return { quote: null, providerError: null, budgetBlocked: false };
    },
    nowMs: closedAtMs,
    sessionDate: SESSION,
    env: { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" },
  });

  assert.equal(res.ran, false);
  assert.equal(res.reason, "OPTIONS_SESSION_CLOSED");
  assert.equal(quotes, 0, "after-hours marking must not spend exact-OCC provider capacity");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM asymmetry_marks").get().n, 0);
  db.close();
});

function seedCase(db, over = {}) {
  ensureAsymmetrySchema(db);
  openAsymmetryCaseOnDb(db, {
    sessionDate: SESSION, fingerprint: FP, symbol: "NVDA", direction: "CALL",
    optionSymbol: OCC, state: "CONFIRMING", firstDetectedAtMs: NOW - 600_000,
    earlyAsk: 3.25, earlyBid: 3.20, earlySpreadPct: 1.5,
    setupFamily: "pullback_continuation", scannerVersion: "test",
    evidenceJson: JSON.stringify({ underlyingPrice: 198.1 }), missingEvidence: [],
    normalQualifiedAtMs: null, normalAsk: null, ...over,
  }, NOW - 600_000);
}
