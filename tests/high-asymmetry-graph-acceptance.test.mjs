/**
 * tests/high-asymmetry-graph-acceptance.test.mjs — the acceptance gate.
 *
 * Fails if any required node lacks a real runtime edge, if any module is
 * reachable only from tests, if any runner lacks a caller or scheduler, or if
 * any table has only a writer or only a reader.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ensureAsymmetrySchema, openAsymmetryCaseOnDb, listCasesOnDb, attachNormalQualificationOnDb } from "../lib/research/asymmetry/case-store.ts";
import { runAsymmetryTransitions, nextState } from "../lib/research/asymmetry/transition-runner.ts";
import { runDueAsymmetryMarks, dueHorizons, validateMark, aggregateOutcomesOnDb, listOutcomesOnDb, MARK_HORIZONS_MINUTES } from "../lib/research/asymmetry/mark-runner.ts";
import { runAsymmetryEodReview, buildDeterministicReview, readEodReviewOnDb } from "../lib/research/asymmetry/eod-review.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const OBSERVED = Date.parse("2026-07-30T14:00:00.000Z"); // 10:00 ET
const OCC = "O:NVDA260807C00200000";
const SESSION = "2026-07-30";
const FP = `${SESSION}|${OCC}`;
const ON = { HIGH_ASYMMETRY_CAPTURE_ENABLED: "1" };

function seeded() {
  const db = new Database(":memory:");
  ensureAsymmetrySchema(db);
  openAsymmetryCaseOnDb(db, {
    sessionDate: SESSION, fingerprint: FP, symbol: "NVDA", direction: "CALL",
    optionSymbol: OCC, state: "EARLY_ASYMMETRY", firstDetectedAtMs: OBSERVED,
    earlyAsk: 2.00, earlyBid: 1.95, earlySpreadPct: 2.5,
    setupFamily: "confirmed_breakout", scannerVersion: "test",
    // The underlying price is part of the MINIMUM notification payload, and it
    // is genuinely captured at detection — a case without it is silently
    // tracked rather than surfaced (see the notification gate).
    evidenceJson: JSON.stringify({
      underlyingPrice: 198.4, priorMovePct: 0.1, roomToNextLevelPct: 1.5,
      targetT1: 5.0, targetStop: 1.2,
      distanceToTriggerPct: 0.1, delta: 0.5,
    }), missingEvidence: ["NO_CATALYST"],
    normalQualifiedAtMs: null, normalAsk: null,
  }, OBSERVED);
  return db;
}
const src = (f) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ── Gate: every runner has a real caller or scheduler ───────────────────────

test("GATE: every runner is reachable from production, not only from tests", () => {
  const loop = src("lib/research/options/loop.ts");
  const sched = src("lib/scheduler.ts");
  assert.match(loop, /captureAsymmetryCandidate\(/, "capture must be called by the live loop");
  assert.match(sched, /runDueAsymmetryMarks/, "the mark runner must be called by the scheduler");
  assert.match(sched, /runAsymmetryEodReview/, "the EOD review must be called by the scheduler");
  assert.match(sched, /explainAsymmetryReview/, "the EOD job must call the AI advisory layer");
});

test("GATE: the scheduler actually schedules both radar jobs in the beat", () => {
  const sched = src("lib/scheduler.ts");
  assert.match(sched, /jobDue\(s\.lastRun\.asymmetryMarks, iv\.asymmetryMarksMs, nowMs\)/);
  assert.match(sched, /runJob\("asymmetryMarks"/);
  assert.match(sched, /jobDue\(s\.lastRun\.asymmetryEod, iv\.asymmetryEodMs, nowMs\)/);
  assert.match(sched, /runJob\("asymmetryEod"/);
  const policy = src("lib/scheduler-policy.ts");
  assert.match(policy, /asymmetryMarksMs: clampInt/);
  assert.match(policy, /asymmetryEodMs: clampInt/);
});

test("GATE: diagnostics reads every required table", () => {
  const route = src("app/api/research/asymmetry/live/route.ts");
  for (const reader of ["listCasesOnDb", "listOutcomesOnDb", "readEodReviewOnDb", "asymmetry_transitions", "asymmetry_marks"]) {
    assert.ok(route.includes(reader), `diagnostics must read ${reader}`);
  }
  // Read-only: no writes, no sends.
  for (const forbidden of ["INSERT ", "UPDATE ", "DELETE ", "fetch("]) {
    assert.equal(route.includes(forbidden), false, `diagnostics must not ${forbidden.trim()}`);
  }
});

// ── Gate: every table has BOTH a writer and a reader ────────────────────────

test("GATE: every table has both a writer and a reader", () => {
  const all = ["case-store", "mark-runner", "eod-review", "transition-runner"]
    .map((m) => src(`lib/research/asymmetry/${m}.ts`)).join("\n")
    + src("app/api/research/asymmetry/live/route.ts");
  for (const table of ["asymmetry_cases", "asymmetry_transitions", "asymmetry_marks", "asymmetry_outcomes", "asymmetry_daily_reviews"]) {
    const written = new RegExp(`(INSERT[^;]*INTO ${table}|UPDATE ${table})`).test(all);
    const read = new RegExp(`FROM ${table}`).test(all);
    assert.ok(written, `${table} must have a writer`);
    assert.ok(read, `${table} must have a reader`);
  }
});

// ── The edges, exercised end to end ────────────────────────────────────────

test("EDGE: transition runner reads cases, writes transitions, invokes the notifier", async () => {
  const db = seeded();
  const sends = [];
  const res = await runAsymmetryTransitions(db, {
    // ask 2.05 vs a 2.00 entry is only a 2.5% expansion, so this is a genuine
    // TRIGGERED rather than a chase.
    observe: async () => ({
      fingerprint: FP, bid: 2.00, ask: 2.05, quoteAtMs: OBSERVED + 9_000,
      triggered: true, invalidated: false, spreadPct: 3, openInterest: 4000,
      contractVolume: 800, dte: 7, delta: 0.5,
      currentUnderlyingPrice: 198.5, underlyingQuoteAtMs: OBSERVED + 9_000,
    }),
    send: async (w, c) => { sends.push({ w, c }); return { ok: true }; },
    env: { ...ON, HIGH_ASYMMETRY_PRIVATE_ENABLED: "1", HIGH_ASYMMETRY_PRIVATE_WEBHOOK: "https://private/hook" },
    nowMs: OBSERVED + 10_000, sessionDate: SESSION,
  });
  assert.equal(res.ran, true);
  assert.equal(res.casesRead, 1);
  assert.equal(res.transitions, 1, "a state change must be persisted");
  assert.equal(sends.length, 1, "an eligible transition must reach the notifier");
  assert.equal(sends[0].w, "https://private/hook");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM asymmetry_transitions").get().c, 1);
  db.close();
});

test("EDGE: mark runner writes marks; aggregator reads them and writes outcomes", async () => {
  const db = seeded();
  // 60+ minutes later: every horizon is due at once.
  const now = OBSERVED + 61 * 60_000;
  const res = await runDueAsymmetryMarks(db, {
    quote: async () => ({ quote: { optionSymbol: OCC, bid: 4.00, ask: 4.10, quoteAtMs: now - 1000 }, providerError: null }),
    nowMs: now, sessionDate: SESSION, env: ON,
  });
  assert.equal(res.ran, true);
  assert.equal(res.marksWritten, MARK_HORIZONS_MINUTES.length, "all due horizons must be marked");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM asymmetry_marks").get().c, 7);

  const outcomes = listOutcomesOnDb(db, SESSION);
  assert.equal(outcomes.length, 1, "the aggregator must have written an outcome");
  // ask entry 2.00 -> bid mark 4.00 = +100%
  assert.equal(outcomes[0].mfePct, 100);
  assert.equal(outcomes[0].hit25, true);
  assert.equal(outcomes[0].hit100, true);
  assert.equal(outcomes[0].hit200, false, "a 100% move must not read as 200%");
  db.close();
});

test("EDGE: EOD job reads cases/transitions/marks/outcomes, writes the review, then calls AI", async () => {
  const db = seeded();
  const now = OBSERVED + 61 * 60_000;
  await runDueAsymmetryMarks(db, { quote: async () => ({ quote: { optionSymbol: OCC, bid: 4.0, ask: 4.1, quoteAtMs: now - 1000 }, providerError: null }), nowMs: now, sessionDate: SESSION, env: ON });
  let aiSawReview = null;
  const res = await runAsymmetryEodReview(db, {
    nowMs: now, sessionDate: SESSION, env: ON,
    explain: async (review) => { aiSawReview = review; return "measured summary"; },
  });
  assert.equal(res.ran, true);
  assert.equal(res.persisted, true);
  assert.equal(res.aiStatus, "OK");
  assert.equal(res.review.candidatesSurfaced, 1);
  assert.equal(res.review.graded, 1);
  assert.ok(aiSawReview, "AI must be called WITH the measured review");
  const stored = readEodReviewOnDb(db, SESSION);
  assert.equal(stored.aiSummary, "measured summary");
  assert.equal(stored.review.candidatesSurfaced, 1);
  db.close();
});

// ── Safety ──────────────────────────────────────────────────────────────────

test("AI failure cannot remove or alter the measured review", async () => {
  const db = seeded();
  const res = await runAsymmetryEodReview(db, {
    nowMs: OBSERVED + 1000, sessionDate: SESSION, env: ON,
    explain: async () => { throw new Error("provider down"); },
  });
  assert.equal(res.persisted, true, "the deterministic review must survive AI failure");
  assert.equal(res.aiStatus, "FAILED");
  const stored = readEodReviewOnDb(db, SESSION);
  assert.ok(stored.review, "the review row must still exist");
  assert.equal(stored.aiSummary, null);
  db.close();
});

test("AI has no mutation authority anywhere on the path", () => {
  const ai = src("lib/ai/asymmetry-explain.ts");
  for (const forbidden of ["INSERT", "UPDATE", "DELETE", "process.env.HIGH_ASYMMETRY", "sendTrackedDiscord", "placeOrder"]) {
    assert.equal(ai.includes(forbidden), false, `ai-explain must not contain ${forbidden}`);
  }
  const eod = src("lib/research/asymmetry/eod-review.ts");
  // The review must be persisted BEFORE AI is called.
  assert.ok(eod.indexOf("INSERT INTO asymmetry_daily_reviews") < eod.indexOf("deps.explain("),
    "the deterministic review must be persisted before AI runs");
});

test("the notifier is never reached for ineligible states", async () => {
  const db = seeded();
  const sends = [];
  const res = await runAsymmetryTransitions(db, {
    observe: async () => ({ fingerprint: FP, bid: 0.1, ask: 9.0, quoteAtMs: OBSERVED, triggered: false, invalidated: false, spreadPct: 200, openInterest: 4000 }),
    send: async (w, c) => { sends.push({ w, c }); return { ok: true }; },
    env: { ...ON, HIGH_ASYMMETRY_PRIVATE_ENABLED: "1", HIGH_ASYMMETRY_PRIVATE_WEBHOOK: "https://private/hook" },
    nowMs: OBSERVED + 60_000, sessionDate: SESSION,
  });
  assert.equal(res.transitions, 1, "the LIQUIDITY_FAILURE transition is still recorded");
  assert.equal(sends.length, 0, "but it must never be surfaced");
  db.close();
});

test("missing private config produces zero network calls", async () => {
  const db = seeded();
  let called = false;
  await runAsymmetryTransitions(db, {
    observe: async () => ({ fingerprint: FP, bid: 2.00, ask: 2.05, quoteAtMs: OBSERVED, triggered: true, invalidated: false, spreadPct: 3, openInterest: 4000 }),
    send: async () => { called = true; return { ok: true }; },
    env: ON, // capture on, private notification NOT configured
    nowMs: OBSERVED + 60_000, sessionDate: SESSION,
  });
  assert.equal(called, false, "no webhook configured means no network call");
  db.close();
});

// ── Determinism, rejection, idempotency ────────────────────────────────────

test("transitions are deterministic and precedence-ordered", () => {
  const obs = (o) => ({ fingerprint: FP, bid: 2, ask: 2.1, quoteAtMs: OBSERVED, triggered: false, invalidated: false, spreadPct: 3, openInterest: 100, ...o });
  assert.equal(nextState("EARLY_ASYMMETRY", obs({ invalidated: true }), 2), "INVALIDATED");
  assert.equal(nextState("EARLY_ASYMMETRY", obs({ bid: null }), 2), "LIQUIDITY_FAILURE");
  assert.equal(nextState("EARLY_ASYMMETRY", obs({ spreadPct: 90 }), 2), "LIQUIDITY_FAILURE");
  assert.equal(nextState("EARLY_ASYMMETRY", obs({ ask: 3.0 }), 2), "PREMIUM_CHASE", "a 50% expansion is a chase");
  assert.equal(nextState("EARLY_ASYMMETRY", obs({ triggered: true }), 2), "TRIGGERED");
  // Same input, same answer.
  for (let i = 0; i < 5; i++) assert.equal(nextState("CONFIRMING", obs({}), 2), nextState("CONFIRMING", obs({}), 2));
});

test("marks reject stale, future, wrong-OCC, and wrong-session evidence", () => {
  const now = OBSERVED + 5 * 60_000;
  assert.equal(validateMark({ optionSymbol: "O:WRONG260807C00200000", bid: 1, ask: 2, quoteAtMs: now }, OCC, SESSION, now), "WRONG_OCC");
  assert.equal(validateMark({ optionSymbol: OCC, bid: 1, ask: 2, quoteAtMs: now + 60_000 }, OCC, SESSION, now), "FUTURE_QUOTE");
  assert.equal(validateMark({ optionSymbol: OCC, bid: 1, ask: 2, quoteAtMs: now - 10 * 60_000 }, OCC, SESSION, now), "STALE_QUOTE");
  assert.equal(validateMark({ optionSymbol: OCC, bid: null, ask: null, quoteAtMs: now }, OCC, SESSION, now), "NO_QUOTE");
  // A different trading day is refused even if otherwise fresh.
  assert.equal(validateMark({ optionSymbol: OCC, bid: 1, ask: 2, quoteAtMs: now }, OCC, "2026-07-29", now), "WRONG_SESSION");
  assert.equal(validateMark({ optionSymbol: OCC, bid: 1, ask: 2, quoteAtMs: now - 1000 }, OCC, SESSION, now), null);
});

test("due horizons are computed, not timed, and never repeat", () => {
  assert.deepEqual(dueHorizons(OBSERVED, OBSERVED + 4 * 60_000, []), [1, 3]);
  assert.deepEqual(dueHorizons(OBSERVED, OBSERVED + 4 * 60_000, [1]), [3]);
  assert.deepEqual(dueHorizons(OBSERVED, OBSERVED + 61 * 60_000, [1, 3, 5, 10, 15, 30, 60]), []);
});

test("mark and outcome writes are repeat-safe", async () => {
  const db = seeded();
  const now = OBSERVED + 61 * 60_000;
  const deps = { quote: async () => ({ quote: { optionSymbol: OCC, bid: 4.0, ask: 4.1, quoteAtMs: now - 1000 }, providerError: null }), nowMs: now, sessionDate: SESSION, env: ON };
  await runDueAsymmetryMarks(db, deps);
  const first = db.prepare("SELECT COUNT(*) c FROM asymmetry_marks").get().c;
  await runDueAsymmetryMarks(db, deps);
  await runDueAsymmetryMarks(db, deps);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM asymmetry_marks").get().c, first, "a replayed sweep must add nothing");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM asymmetry_outcomes").get().c, 1, "outcomes must upsert, not duplicate");
  db.close();
});

test("an empty cohort yields null rates, never zero", () => {
  const review = buildDeterministicReview({ sessionDate: SESSION, nowMs: OBSERVED, cases: [], transitions: [], outcomes: [] });
  assert.equal(review.hitRate25Pct, null, "no graded outcomes means an unknown rate");
  assert.equal(review.medianLeadMs, null);
  assert.equal(review.medianPremiumAvoidedPct, null);
  assert.match(review.minimumSampleWarning, /below the 10-sample minimum/);
});

test("runner failures are isolated and never throw", async () => {
  const broken = { prepare() { throw new Error("disk full"); }, exec() { throw new Error("disk full"); } };
  const t = await runAsymmetryTransitions(broken, { observe: async () => null, env: ON, nowMs: OBSERVED, sessionDate: SESSION });
  assert.ok(Array.isArray(t.errors));
  const m = await runDueAsymmetryMarks(broken, { quote: async () => ({ quote: null, providerError: null }), nowMs: OBSERVED, sessionDate: SESSION, env: ON });
  assert.ok(Array.isArray(m.errors));
  const e = await runAsymmetryEodReview(broken, { nowMs: OBSERVED, sessionDate: SESSION, env: ON });
  assert.ok(Array.isArray(e.errors));

  // One bad case must not abort a sweep of many.
  const db = seeded();
  const res = await runAsymmetryTransitions(db, {
    observe: async () => { throw new Error("observer blew up"); },
    env: ON, nowMs: OBSERVED + 60_000, sessionDate: SESSION,
  });
  assert.equal(res.ran, true);
  assert.equal(res.errors.length, 1, "the failure is recorded, not propagated");
  db.close();
});

test("all runners are OFF by default and do no work", async () => {
  const db = seeded();
  const t = await runAsymmetryTransitions(db, { observe: async () => null, env: {}, nowMs: OBSERVED, sessionDate: SESSION });
  const m = await runDueAsymmetryMarks(db, { quote: async () => ({ quote: null, providerError: null }), nowMs: OBSERVED, sessionDate: SESSION, env: {} });
  const e = await runAsymmetryEodReview(db, { nowMs: OBSERVED, sessionDate: SESSION, env: {} });
  for (const r of [t, m, e]) assert.equal(r.ran, false, "a disabled runner must not run");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM asymmetry_marks").get().c, 0);
  db.close();
});

test("lead time and premium avoided flow through to the review", async () => {
  const db = seeded();
  attachNormalQualificationOnDb(db, { sessionDate: SESSION, optionSymbol: OCC, qualifiedAtMs: OBSERVED + 300_000, ask: 2.60 });
  const res = await runAsymmetryEodReview(db, { nowMs: OBSERVED + 400_000, sessionDate: SESSION, env: ON });
  assert.equal(res.review.medianLeadMs, 300_000);
  assert.equal(res.review.medianPremiumAvoidedPct, 30);
  assert.equal(res.review.laterNormalAlerts, 1);
  assert.equal(res.review.normalScannerMisses, 0);
  db.close();
});

test("no radar module can reach a subscriber SEND path", () => {
  for (const m of ["capture", "case-store", "transition-runner", "mark-runner", "eod-review", "live-quote", "private-notify", "live-intake"]) {
    const code = src(`lib/research/asymmetry/${m}.ts`);
    for (const forbidden of ["deliverOptionsCallout", "sendTrackedDiscord", "assertSubscriberDeliveryAllowed", "placeOrder", "submitOrder"]) {
      assert.equal(code.includes(forbidden), false, `${m}.ts must not reference ${forbidden}`);
    }
  }
});

// ── Regression: the EOD review must create its own table, and AI must not run
//    when the deterministic review was not stored. Both were found in
//    production during controlled activation: the review failed with
//    "no such table: asymmetry_daily_reviews" while aiStatus reported OK,
//    meaning the model described a result that was never persisted.

test("REGRESSION: the EOD review creates its own tables on a zero-case session", async () => {
  const bare = new Database(":memory:"); // no schema at all
  const res = await runAsymmetryEodReview(bare, {
    nowMs: OBSERVED, sessionDate: SESSION, env: ON,
    explain: async () => "summary",
  });
  assert.equal(res.persisted, true, "the review must persist even with zero captured cases");
  assert.deepEqual(res.errors, [], "a missing table must not surface as an error");
  assert.equal(readEodReviewOnDb(bare, SESSION).review.candidatesSurfaced, 0);
  bare.close();
});

test("REGRESSION: AI is skipped when the deterministic review was not persisted", async () => {
  // A database that reads but refuses every write.
  const readOnlyish = {
    exec() { throw new Error("attempt to write a readonly database"); },
    prepare(sql) {
      if (/^\s*(INSERT|UPDATE)/i.test(sql)) throw new Error("attempt to write a readonly database");
      return { get: () => undefined, all: () => [], run: () => { throw new Error("readonly"); } };
    },
  };
  let aiCalled = false;
  const res = await runAsymmetryEodReview(readOnlyish, {
    nowMs: OBSERVED, sessionDate: SESSION, env: ON,
    explain: async () => { aiCalled = true; return "should not happen"; },
  });
  assert.equal(res.persisted, false);
  assert.equal(aiCalled, false, "AI must never explain a review that was not stored");
  assert.equal(res.aiStatus, "SKIPPED");
});
