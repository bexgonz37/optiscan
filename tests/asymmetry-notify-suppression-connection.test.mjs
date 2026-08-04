/**
 * Suppression must never become deletion.
 *
 * The whole design of ASYM_NOTIFY_V2 rests on one claim: the decision to SPEAK
 * is separate from the decision to CAPTURE. If a suppressed case quietly stopped
 * being persisted, marked, paper-eligible or counted by Quant, the research
 * population would silently become "things we already alerted on" — exactly the
 * bias the radar exists to remove, and it would be invisible in every report.
 *
 * These tests drive the real runner against an in-memory database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runAsymmetryTransitions, nextState } from "../lib/research/asymmetry/transition-runner.ts";
import { openAsymmetryCaseOnDb, listCasesOnDb, ensureAsymmetrySchema } from "../lib/research/asymmetry/case-store.ts";
import { listNotifyDecisionsOnDb, journalRatioOnDb } from "../lib/research/asymmetry/notify-journal.ts";
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

const ENV = {
  HIGH_ASYMMETRY_CAPTURE_ENABLED: "1",
  HIGH_ASYMMETRY_PRIVATE_ENABLED: "1",
  HIGH_ASYMMETRY_PRIVATE_WEBHOOK: "https://discord.test/owner-private",
};

function seed(db, over = {}) {
  ensureAsymmetrySchema(db);
  openAsymmetryCaseOnDb(db, {
    sessionDate: SESSION, fingerprint: `${SESSION}|${OCC}`, symbol: "NVDA", direction: "CALL",
    optionSymbol: OCC, state: "CONFIRMING", firstDetectedAtMs: NOW - 10_000,
    earlyAsk: 3.25, earlyBid: 3.20, earlySpreadPct: 1.5,
    setupFamily: "pullback_continuation", scannerVersion: "test",
    evidenceJson: JSON.stringify({
      underlyingPrice: 198.1, priorMovePct: 0.1, roomToNextLevelPct: 1.5,
      distanceToTriggerPct: 0.1, delta: 0.45, targetT1: 5.0, targetStop: 2.0,
    }), missingEvidence: [],
    normalQualifiedAtMs: null, normalAsk: null, ...over,
  }, NOW - 600_000);
}

/** Observation that promotes CONFIRMING -> HIGH_ASYMMETRY. */
const obs = (over = {}) => ({
  fingerprint: `${SESSION}|${OCC}`,
  bid: 3.55, ask: 3.65, quoteAtMs: NOW - 5_000,
  triggered: false, invalidated: false, spreadPct: 2.7, openInterest: 5_000,
  contractVolume: 900, dte: 7, delta: 0.45,
  currentUnderlyingPrice: 198.2, underlyingQuoteAtMs: NOW - 5_000,
  ...over,
});

async function run(db, observation, sent) {
  return runAsymmetryTransitions(db, {
    observe: () => observation,
    memory: createPrivateCaseMemory(),
    send: async (_w, content) => { sent.push(content); return { ok: true }; },
    env: ENV, nowMs: NOW, sessionDate: SESSION,
  });
}

test("a NOTIFIED transition is journalled with its evidence and thresholds", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db);
  const sent = [];
  const res = await run(db, obs(), sent);
  assert.equal(res.notified, 1);
  assert.equal(sent.length, 1);

  const [row] = listNotifyDecisionsOnDb(db, SESSION);
  assert.equal(row.notify, true);
  assert.equal(row.notifyOutcome, "SENT");
  assert.equal(row.ask, 3.65);
  assert.equal(row.quoteAgeMs, 5_000);
  assert.equal(row.cfgMaxQuoteAgeMs, 30_000, "the strategy threshold in force is recorded");
  assert.equal(row.cfgMaxGiveBackFraction, 0.5);
  assert.equal(row.captureToNotifyMs, 10_000);
  assert.equal(row.setupFamily, "pullback_continuation");
  assert.equal(row.freshnessSource, "STRATEGY_CATALOG");
  assert.equal(row.deliveryLevel, "IMMEDIATE_OWNER_ALERT");
  assert.ok(row.qualityScore >= 80);
  assert.equal(row.strategyPolicy.minRewardRemainingPct, 10);
  assert.equal(row.strategyPolicy.minDistanceFromInvalidationPct, 5);
  assert.equal(row.decisionMetrics.targetT1, 5);
  assert.equal(row.decisionMetrics.targetStop, 2);
  assert.ok(row.decisionMetrics.rewardRemainingPct > 30);
  db.close();
});

test("a STALE-suppressed transition is still persisted, and its age is recoverable", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db);
  const sent = [];
  // Quote 126 seconds old at the moment of sending — the exact production
  // suppression observed on 2026-07-31 (LATE_OR_ROLLOVER_SUPPRESSION_STALE_126S).
  const res = await run(db, obs({ quoteAtMs: NOW - 126_000 }), sent);

  assert.equal(sent.length, 0, "nothing was said");
  assert.equal(res.silentCaptures, 1);
  assert.equal(res.transitions, 1, "THE TRANSITION IS STILL PERSISTED");

  const cases = listCasesOnDb(db, SESSION);
  assert.equal(cases.length, 1, "the case remains in the research population");
  assert.equal(cases[0].state, "HIGH_ASYMMETRY", "the state still advanced");

  const [row] = listNotifyDecisionsOnDb(db, SESSION);
  assert.equal(row.notify, false);
  assert.equal(row.timing, "STALE_EVIDENCE");
  assert.equal(row.quoteAgeMs, 126_000, "the measurement behind the suppression is stored");
  assert.match(row.reason, /STALE_126S/);
  db.close();
});

test("a ROLLOVER-suppressed transition is persisted with the give-back that caused it", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db);
  // Marks supply the peak: entry 3.25, peak 6.25 (gain 3.00), now 3.50 → gave
  // back 2.75 of 3.00 = 91.7%, past the 50% threshold.
  //
  // NOTE the narrow band this test has to sit in. The chase check (20%) is
  // evaluated BEFORE rollover, so rollover can only ever decide a case whose
  // premium is back NEAR its entry while being far off its peak. That is the
  // correct precedence — a chased entry is the more fundamental problem — but
  // it means the 50% give-back threshold governs a much smaller slice of the
  // population than its prominence suggests.
  db.prepare(`INSERT INTO asymmetry_marks
    (session_date, fingerprint, option_symbol, horizon_minutes, marked_at_ms, bid, ask, quote_age_ms, return_pct, rejected_reason)
    VALUES (?,?,?,?,?,?,?,?,?,NULL)`)
    .run(SESSION, `${SESSION}|${OCC}`, OCC, 5, NOW - 300_000, 6.20, 6.25, 1000, 90);

  const sent = [];
  const res = await run(db, obs({ ask: 3.50, bid: 3.45 }), sent);

  assert.equal(sent.length, 0);
  assert.equal(res.transitions, 1, "still persisted");
  const [row] = listNotifyDecisionsOnDb(db, SESSION);
  assert.equal(row.timing, "MOMENTUM_ROLLOVER");
  assert.equal(row.peakAskSinceCapture, 6.25, "read from persisted marks — no provider call");
  assert.equal(row.giveBackFraction, 0.9167);
  assert.equal(row.cfgMaxGiveBackFraction, 0.5, "the threshold it was judged against");
  db.close();
});

test("the chase check is evaluated before rollover, so it wins when both apply", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db);
  db.prepare(`INSERT INTO asymmetry_marks
    (session_date, fingerprint, option_symbol, horizon_minutes, marked_at_ms, bid, ask, quote_age_ms, return_pct, rejected_reason)
    VALUES (?,?,?,?,?,?,?,?,?,NULL)`)
    .run(SESSION, `${SESSION}|${OCC}`, OCC, 5, NOW - 300_000, 6.20, 6.25, 1000, 90);
  const sent = [];
  // ask 4.00 is +23% from entry (chased) AND 75% off the peak (rolled over).
  await run(db, obs({ ask: 4.00, bid: 3.95 }), sent);
  const [row] = listNotifyDecisionsOnDb(db, SESSION);
  assert.equal(row.timing, "PREMIUM_CHASE", "the more fundamental defect is reported");
  assert.equal(row.giveBackFraction, 0.75, "the rollover measurement is still recorded for later analysis");
  db.close();
});

test("the rollover check is INERT when marks are missing — the production condition", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db);
  // No marks rows at all. This is production reality on 2026-07-31: forward
  // marking rejected 1,183 of ~1,230 attempts with NO_QUOTE, so peakAsk is null
  // for virtually every case and the 50% threshold can never fire.
  const sent = [];
  await run(db, obs({ ask: 3.50, bid: 3.45 }), sent);
  const [row] = listNotifyDecisionsOnDb(db, SESSION);
  assert.equal(row.peakAskSinceCapture, null);
  assert.equal(row.giveBackFraction, null, "null give-back, not a give-back of zero");
  assert.notEqual(row.timing, "MOMENTUM_ROLLOVER",
    "with no peak evidence the gate cannot claim a rollover — it must not guess");
  assert.equal(sent.length, 1, "and so the message goes out");
  db.close();
});

test("suppression does not stop a later state change from being captured", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db);
  const sent = [];
  await run(db, obs({ quoteAtMs: NOW - 126_000 }), sent); // suppressed
  // A later sweep on the same case with a fresh quote and a trigger.
  const later = await runAsymmetryTransitions(db, {
    observe: () => obs({ triggered: true, quoteAtMs: NOW + 60_000 - 1_000 }),
    memory: createPrivateCaseMemory(),
    send: async (_w, c) => { sent.push(c); return { ok: true }; },
    env: ENV, nowMs: NOW + 60_000, sessionDate: SESSION,
  });
  assert.equal(later.transitions, 1, "the case was still live and still transitioned");
  assert.equal(listCasesOnDb(db, SESSION)[0].state, "TRIGGERED");
  assert.equal(listNotifyDecisionsOnDb(db, SESSION).length, 2, "both decisions journalled");
  db.close();
});

test("the alert-to-capture ratio is computed from the journal, not from volatile counters", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db);
  seed(db, { fingerprint: `${SESSION}|O:NVDA260807C00205000`, optionSymbol: "O:NVDA260807C00205000" });
  const sent = [];
  await runAsymmetryTransitions(db, {
    // One fresh (sends), one stale (suppressed).
    observe: (c) => c.optionSymbol === OCC ? obs() : obs({ fingerprint: c.fingerprint, quoteAtMs: NOW - 200_000 }),
    memory: createPrivateCaseMemory(),
    send: async (_w, c) => { sent.push(c); return { ok: true }; },
    env: ENV, nowMs: NOW, sessionDate: SESSION,
  });
  const r = journalRatioOnDb(db, SESSION);
  assert.equal(r.distinctCases, 2);
  assert.equal(r.notified, 1);
  assert.equal(r.alertToCaptureRatioPct, 50);
  assert.equal(r.byTiming.STALE_EVIDENCE, 1);
  assert.equal(r.byTiming.ON_TIME, 1);
  db.close();
});

test("the immediate-message budget is spent on the highest-ranked fresh case", { skip }, async () => {
  const db = new Database(":memory:");
  const highOcc = OCC;
  const lowOcc = "O:NVDA260807C00205000";
  seed(db, {
    fingerprint: `${SESSION}|${highOcc}`,
    optionSymbol: highOcc,
    firstDetectedAtMs: NOW - 10_000,
  });
  seed(db, {
    fingerprint: `${SESSION}|${lowOcc}`,
    optionSymbol: lowOcc,
    firstDetectedAtMs: NOW - 5_000,
  });
  const sent = [];
  await runAsymmetryTransitions(db, {
    observe: (c) => c.optionSymbol === highOcc
      ? obs({ fingerprint: c.fingerprint, ask: 3.30, bid: 3.28, spreadPct: 0.61 })
      : obs({ fingerprint: c.fingerprint, ask: 3.55, bid: 3.40, spreadPct: 4.32, openInterest: 1_500, contractVolume: 300 }),
    memory: createPrivateCaseMemory(),
    send: async (_w, content) => { sent.push(content); return { ok: true }; },
    env: { ...ENV, HIGH_ASYMMETRY_MAX_MESSAGES_PER_SESSION: "1" },
    nowMs: NOW,
    sessionDate: SESSION,
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /NVDA 08\/07 \$200 Call/, "the stronger contract gets the scarce immediate slot");
  const rows = listNotifyDecisionsOnDb(db, SESSION);
  assert.equal(rows.length, 2, "both cases remain persisted even though only one message can send");
  const high = rows.find((r) => r.optionSymbol === highOcc);
  const low = rows.find((r) => r.optionSymbol === lowOcc);
  assert.ok(high.qualityScore > low.qualityScore);
  assert.equal(high.notifyOutcome, "SENT");
  assert.equal(low.notifyOutcome, "SUPPRESSED_RATE_LIMIT");
  db.close();
});

test("a journal write failure never stops the notification or the transition", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db);
  // Make only the journal insert fail, leaving the rest of the DB working.
  const realPrepare = db.prepare.bind(db);
  const guarded = {
    prepare: (sql) => {
      if (/asymmetry_notify_decisions/.test(sql)) throw new Error("journal table is broken");
      return realPrepare(sql);
    },
    exec: (sql) => {
      if (/asymmetry_notify_decisions/.test(sql)) throw new Error("journal table is broken");
      return db.exec(sql);
    },
  };
  const sent = [];
  const res = await run(guarded, obs(), sent);
  assert.equal(sent.length, 1, "the message still went out");
  assert.equal(res.transitions, 1, "the transition was still persisted");
  assert.ok(res.errors.some((e) => /journal/.test(e)), "the fault is reported, not hidden");
  db.close();
});

test("nextState is unchanged by the journal — capture logic is untouched", { skip }, () => {
  // Guards against the journal accidentally becoming load-bearing in the state
  // machine. These are the same expectations as before this change.
  assert.equal(nextState("CONFIRMING", { bid: 1, ask: 1.1, spreadPct: 5, openInterest: 100, triggered: false, invalidated: false }, 1.0), "HIGH_ASYMMETRY");
  assert.equal(nextState("CONFIRMING", { bid: 1, ask: 1.1, spreadPct: 5, openInterest: 100, triggered: false, invalidated: true }, 1.0), "INVALIDATED");
  assert.equal(nextState("CONFIRMING", { bid: null, ask: null, spreadPct: null, openInterest: null, triggered: false, invalidated: false }, 1.0), "LIQUIDITY_FAILURE");
  assert.equal(nextState("CONFIRMING", { bid: 1.5, ask: 1.6, spreadPct: 5, openInterest: 100, triggered: false, invalidated: false }, 1.0), "PREMIUM_CHASE");
});

test("no research state can authorize a subscriber send, whatever the journal says", { skip }, async () => {
  const db = new Database(":memory:");
  seed(db);
  const sent = [];
  const res = await run(db, obs(), sent);
  assert.equal(res.notified, 1);
  const { canResearchStateSend, RESEARCH_STATE_CAN_SEND } = await import("../lib/research/asymmetry/states.ts");
  for (const [, v] of Object.entries(RESEARCH_STATE_CAN_SEND)) assert.equal(v, false);
  assert.equal(canResearchStateSend("TRIGGERED"), false);
  db.close();
});
