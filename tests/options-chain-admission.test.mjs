/**
 * options-chain-admission.test.mjs — Phase 9, intra-lane provider priority.
 *
 * The named requirement: "A candidate like MRNA: CALL, score 1.0,
 * research_only 0 must not simply disappear because a lower-priority workload
 * consumed the minute partition."
 *
 * Plus the four ways a priority queue goes wrong: retry storm, infinite retry,
 * starvation, duplication.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  admitChainRequests, chainTicketPriority, chainTicketKey,
  DEFAULT_CHAIN_ADMISSION, chainAdmissionConfig,
} from "../lib/research/options/chain-admission.ts";

const NOW = 5_000_000;
const MIN = 60_000;

const ticket = (symbol, over = {}) => ({
  symbol, side: "call", strategyKey: "breakout_forming",
  score: 0.5, researchOnly: true, tier: 2,
  requestedAtMs: NOW, deadlineMs: NOW + 2 * MIN, attempts: 0, ...over,
});

/* ── the MRNA case ─────────────────────────────────────────────────────────*/

test("MRNA: a score-1.0 actionable CALL is served before low-quality research work", () => {
  // The lane's reserve is nearly gone — one slot left this cycle.
  const queue = [
    ...Array.from({ length: 20 }, (_, i) => ticket(`JUNK${i}`, { score: 0.4, researchOnly: true })),
    ticket("MRNA", { score: 1.0, researchOnly: false }),
    ...Array.from({ length: 20 }, (_, i) => ticket(`MORE${i}`, { score: 0.6, researchOnly: true })),
  ];
  const r = admitChainRequests(queue, 1, NOW, DEFAULT_CHAIN_ADMISSION);

  assert.equal(r.admitted.length, 1);
  assert.equal(r.admitted[0].symbol, "MRNA", "the best candidate gets the last slot");
  assert.equal(r.highPriorityDeferred, 0, "and nothing actionable was left behind");
});

test("MRNA keeps its place even when it arrives LAST", () => {
  // Arrival order is not quality order. That was the whole defect.
  const queue = [
    ...Array.from({ length: 30 }, (_, i) => ticket(`EARLY${i}`, { score: 0.7, requestedAtMs: NOW - 30_000 })),
    ticket("MRNA", { score: 1.0, researchOnly: false, requestedAtMs: NOW }),
  ];
  const r = admitChainRequests(queue, 3, NOW, DEFAULT_CHAIN_ADMISSION);
  assert.equal(r.admitted[0].symbol, "MRNA", "arriving last does not mean served last");
});

test("quality dominates aging by construction — an old weak ticket cannot overtake a fresh strong one", () => {
  const strongFresh = ticket("MRNA", { score: 1.0, researchOnly: false, requestedAtMs: NOW });
  // Waited a full hour: aging is capped at 30, so it cannot reach 140.
  const weakAncient = ticket("OLD", { score: 0.5, researchOnly: true, requestedAtMs: NOW - 3_600_000 });

  assert.equal(chainTicketPriority(strongFresh, NOW), 140, "1.0*100 + 40 actionable + 0 aging");
  assert.equal(chainTicketPriority(weakAncient, NOW), 80, "0.5*100 + 30 aging cap");
  const r = admitChainRequests([weakAncient, strongFresh], 1, NOW);
  assert.equal(r.admitted[0].symbol, "MRNA");
});

/* ── no starvation ─────────────────────────────────────────────────────────*/

test("no starvation: aging eventually promotes a comparable ticket stuck behind others", () => {
  // Long deadlines: this test is about aging, not expiry.
  const FAR = NOW + 600 * MIN;
  const stuck = ticket("STUCK", { score: 0.80, researchOnly: false, requestedAtMs: NOW, deadlineMs: FAR });
  const rivalAt = (t) => ticket("RIVAL", { score: 0.85, researchOnly: false, requestedAtMs: t, deadlineMs: FAR });

  // At equal age the slightly better rival wins, as it should.
  assert.equal(admitChainRequests([stuck, rivalAt(NOW)], 1, NOW).admitted[0].symbol, "RIVAL");

  // After the stuck ticket has waited an hour, aging closes the 5-point gap:
  // 0.80*100 + 40 + 30 aged = 150 against a fresh 0.85*100 + 40 = 125.
  const later = NOW + 60 * MIN;
  const r = admitChainRequests([stuck, rivalAt(later)], 1, later,
    { ...DEFAULT_CHAIN_ADMISSION, maxAttempts: 1000 });
  assert.equal(r.admitted[0].symbol, "STUCK", "waiting is part of priority, so nothing waits forever");
});

/* ── bounded defer: no infinite retry ──────────────────────────────────────*/

test("bounded defer: a ticket past its deadline LEAVES rather than being served stale", () => {
  const r = admitChainRequests([ticket("LATE", { deadlineMs: NOW - 1 })], 10, NOW);
  assert.equal(r.admitted.length, 0, "never served after the decision window");
  assert.equal(r.expired.length, 1);
  assert.equal(r.expired[0].outcome, "EXPIRED_DEADLINE");
  assert.match(r.expired[0].reason, /market that moved/);
});

test("bounded defer: attempts are capped, so a ticket cannot be retried forever", () => {
  const r = admitChainRequests(
    [ticket("SPIN", { attempts: DEFAULT_CHAIN_ADMISSION.maxAttempts })], 10, NOW);
  assert.equal(r.admitted.length, 0);
  assert.equal(r.expired[0].outcome, "EXPIRED_ATTEMPTS");
  assert.match(r.expired[0].reason, /abandoned rather than retried forever/);
});

test("the queue drains rather than growing without bound", () => {
  // Zero capacity every cycle, which is the worst case. The queue must still
  // empty via the attempt cap instead of accumulating for the session.
  let queue = Array.from({ length: 10 }, (_, i) => ticket(`S${i}`, { deadlineMs: NOW + 60 * MIN }));
  const cfg = { ...DEFAULT_CHAIN_ADMISSION, maxAttempts: 3 };
  for (let cycle = 0; cycle < 10; cycle++) {
    queue = admitChainRequests(queue, 0, NOW + cycle * 1000, cfg).deferred;
  }
  assert.equal(queue.length, 0, "bounded defer means the queue is genuinely bounded");
});

/* ── no retry storm ────────────────────────────────────────────────────────*/

test("no retry storm: a deferred ticket waits for the next cycle and never re-spends capacity", () => {
  const queue = Array.from({ length: 50 }, (_, i) => ticket(`S${i}`));
  const r = admitChainRequests(queue, 5, NOW);
  // Exactly the capacity is spent — deferral costs nothing.
  assert.equal(r.admitted.length, 5);
  assert.equal(r.deferred.length, 45);
  assert.equal(r.admitted.length + r.deferred.length + r.expired.length, 50, "every ticket accounted for once");
  // Deferred tickets carry an incremented attempt count and their ORIGINAL
  // request time, so waiting accumulates instead of resetting.
  assert.equal(r.deferred.every((t) => t.attempts === 1), true);
  assert.equal(r.deferred.every((t) => t.requestedAtMs === NOW), true);
});

/* ── deduplication ─────────────────────────────────────────────────────────*/

test("duplication: the same symbol/side/strategy asked twice is one request", () => {
  const r = admitChainRequests([
    ticket("COIN", { requestedAtMs: NOW }),
    ticket("COIN", { requestedAtMs: NOW + 500 }),
    ticket("COIN", { requestedAtMs: NOW + 900 }),
  ], 10, NOW + 1000);
  assert.equal(r.admitted.length, 1, "one chain request, not three");
  assert.equal(r.duplicatesCollapsed, 2);
});

test("collapsing duplicates keeps the strongest claim and the longest wait", () => {
  const r = admitChainRequests([
    ticket("COIN", { requestedAtMs: NOW + 5000, score: 0.9, researchOnly: false }),
    ticket("COIN", { requestedAtMs: NOW, score: 0.4, researchOnly: true }),
  ], 10, NOW + 6000);
  assert.equal(r.admitted.length, 1);
  assert.equal(r.admitted[0].score, 0.9, "the better score survives");
  assert.equal(r.admitted[0].researchOnly, false, "actionable beats research-only");
  assert.equal(r.admitted[0].requestedAtMs, NOW, "collapsing never resets the clock");
});

test("different sides and strategies on one symbol are genuinely different requests", () => {
  const r = admitChainRequests([
    ticket("SPY", { side: "call" }),
    ticket("SPY", { side: "put" }),
    ticket("SPY", { side: "call", strategyKey: "sr_reclaim" }),
  ], 10, NOW);
  assert.equal(r.admitted.length, 3);
  assert.equal(r.duplicatesCollapsed, 0);
  assert.equal(new Set(r.admitted.map(chainTicketKey)).size, 3);
});

/* ── observability ─────────────────────────────────────────────────────────*/

test("every decision is observable, and the MRNA counter distinguishes wrong-order from genuinely-short", () => {
  const queue = [
    ticket("A", { score: 1.0, researchOnly: false }),
    ticket("B", { score: 0.9, researchOnly: false }),
    ticket("C", { score: 0.3, researchOnly: true }),
  ];
  const r = admitChainRequests(queue, 1, NOW);
  assert.equal(r.decisions.length, 3, "nothing is silently dropped");
  assert.equal(r.decisions.filter((d) => d.outcome === "ADMITTED").length, 1);
  assert.equal(r.decisions.filter((d) => d.outcome === "DEFERRED").length, 2);
  assert.equal(r.highPriorityDeferred, 1, "B was actionable and could not be served");
  assert.equal(r.decisions.every((d) => typeof d.reason === "string" && d.reason.length > 0), true);

  // With enough capacity the counter is zero: the lane is short only when it
  // genuinely cannot serve its actionable work.
  assert.equal(admitChainRequests(queue, 3, NOW).highPriorityDeferred, 0);
});

/* ── boundaries ────────────────────────────────────────────────────────────*/

test("zero capacity admits nothing and spends nothing", () => {
  const r = admitChainRequests([ticket("A"), ticket("B")], 0, NOW);
  assert.equal(r.admitted.length, 0);
  assert.equal(r.deferred.length, 2);
});

test("admission is reproducible — it does not depend on arrival order", () => {
  const q = [ticket("A", { score: 0.7 }), ticket("B", { score: 0.7 }), ticket("C", { score: 0.7 })];
  const a = admitChainRequests(q, 2, NOW).admitted.map((t) => t.symbol);
  const b = admitChainRequests([...q].reverse(), 2, NOW).admitted.map((t) => t.symbol);
  assert.deepEqual(a, b, "identical ties resolve identically");
});

test("config comes from env with safe floors", () => {
  assert.deepEqual(chainAdmissionConfig({}), DEFAULT_CHAIN_ADMISSION);
  assert.equal(chainAdmissionConfig({ OPTIONS_ADMISSION_MAX_ATTEMPTS: "0" }).maxAttempts, 5,
    "zero attempts would expire everything instantly — refused");
  assert.equal(chainAdmissionConfig({ OPTIONS_ADMISSION_MAX_ATTEMPTS: "2" }).maxAttempts, 2);
});
