/**
 * tests/provider-admission.test.mjs
 *
 * THE PROPERTY UNDER TEST is the one that failed in production on 2026-08-19:
 * `asymmetry_mark` finished the session on 748 admitted requests against 17,483
 * refusals (4.1%) — not because its reserve was taken, but because the sweep
 * fired its whole owed backlog at a 44/minute partition and re-fired the same
 * backlog every 60 seconds.
 *
 * So the assertions that matter are:
 *   1. a consumer can find out what its OWN partition still permits, and that
 *      number equals how many consecutive `decideBudget` calls would be admitted;
 *   2. that answer is NOT the global "is the minute nearly full" answer;
 *   3. a sweep paced against it stops instead of generating refusals, and leaves
 *      the undone work owed rather than recorded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  minuteAllowanceFor,
  remainingMinuteAllowance,
} from "../lib/provider-admission.ts";
import {
  budgetSnapshot,
  commitBudget,
  decideBudget,
  emptyMinuteBudgetState,
} from "../lib/provider-budget.ts";

const CAP = 280;
const ENV = {};

function spend(state, consumer, n) {
  let admitted = 0;
  for (let i = 0; i < n; i += 1) {
    const d = decideBudget(consumer, state, CAP, ENV);
    if (!d.allowed) continue;
    commitBudget(consumer, state, d);
    admitted += 1;
  }
  return admitted;
}

/** How many MORE calls the real gate would admit, without mutating the caller's state. */
function probeAdmissible(state, consumer) {
  const copy = { reserveUsed: new Map(state.reserveUsed), sharedUsed: state.sharedUsed };
  let n = 0;
  while (n < CAP * 4) {
    const d = decideBudget(consumer, copy, CAP, ENV);
    if (!d.allowed) break;
    commitBudget(consumer, copy, d);
    n += 1;
  }
  return n;
}

test("the allowance equals what decideBudget would actually admit, at every stage of contention", () => {
  const state = emptyMinuteBudgetState();
  const stages = [
    () => {},
    () => spend(state, "scanner", 40),
    () => spend(state, "options_paper_mark", 120),
    () => spend(state, "options_discovery", 200),
    () => spend(state, "scanner", 200),
  ];
  for (const [i, advance] of stages.entries()) {
    advance();
    const callsThisMinute =
      [...state.reserveUsed.values()].reduce((a, b) => a + b, 0) + state.sharedUsed;
    for (const consumer of ["asymmetry_mark", "scanner", "options_paper_mark", "unattributed"]) {
      const view = budgetSnapshot(state, CAP, ENV);
      const allowance = minuteAllowanceFor(consumer, view, callsThisMinute);
      assert.equal(
        allowance.remaining,
        probeAdmissible(state, consumer),
        `stage ${i}: allowance for ${consumer} must equal what the gate admits`,
      );
    }
  }
});

test("a reserved lane still has an allowance while other lanes have saturated the shared pool", () => {
  // Reproduce the contention shape: two heavy lanes take everything they can.
  const state = emptyMinuteBudgetState();
  spend(state, "options_paper_mark", 1000);
  spend(state, "scanner", 1000);
  const callsThisMinute =
    [...state.reserveUsed.values()].reduce((a, b) => a + b, 0) + state.sharedUsed;
  const view = budgetSnapshot(state, CAP, ENV);

  const mark = minuteAllowanceFor("asymmetry_mark", view, callsThisMinute);
  assert.equal(mark.sharedRemaining, 0, "the shared pool is gone");
  assert.ok(mark.reserveRemaining > 0, "but the reserve is untouched");
  assert.equal(mark.remaining, mark.reserveRemaining, "so the lane may still spend its reserve");

  // THE POINT: one global number predicts neither lane. At the same instant, with
  // the same `callsThisMinute`, a reserved lane may still spend and an unreserved
  // lane may not — so "is the minute nearly full" cannot answer "may I spend".
  assert.equal(minuteAllowanceFor("unattributed", view, callsThisMinute).remaining, 0);
  assert.ok(
    callsThisMinute < CAP,
    "and the global counter is not even at the cap, so it would not have explained either answer",
  );
});

test("no partition configured means unbounded, not zero", () => {
  assert.equal(remainingMinuteAllowance("scanner", null), Number.POSITIVE_INFINITY);
  assert.equal(remainingMinuteAllowance("scanner", { callsThisMinute: 9999 }), Number.POSITIVE_INFINITY);
  const uncapped = minuteAllowanceFor("scanner", { minuteCap: 0, sharedPool: 0, sharedUsed: 0, reserves: [] }, 1e6);
  assert.equal(uncapped.remaining, Number.POSITIVE_INFINITY);
});

test("the allowance never promises more than the hard global cap permits", () => {
  // A misconfigured partition that over-reserves must not hand out calls the cap has spent.
  const view = { minuteCap: 100, sharedPool: 80, sharedUsed: 0, reserves: [{ consumer: "scanner", reserved: 80, used: 0 }] };
  const a = minuteAllowanceFor("scanner", view, 95);
  assert.equal(a.reserveRemaining + a.sharedRemaining, 160, "the partition alone would say 160");
  assert.equal(a.remaining, 5, "the global cap still binds");
});
