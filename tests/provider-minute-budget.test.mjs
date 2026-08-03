/**
 * tests/provider-minute-budget.test.mjs
 *
 * Gate B7 — per-minute provider budget partitions.
 *
 * THE PROPERTY UNDER TEST is the one that failed in production on 2026-08-03:
 * `asymmetry_mark` ended a full RTH session on 263 admitted requests against
 * 93,792 refusals (0.28%), and admitted ZERO more after its per-request cost was
 * cut by two thirds. Cheapness did not buy priority.
 *
 * So the assertion that matters is not "reserves are configured". It is
 * **a reserved lane is still served while every other lane is saturating the cap**.
 * That must fail the build, not the session.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MINUTE_RESERVE_FRACTIONS,
  budgetSnapshot,
  commitBudget,
  decideBudget,
  emptyMinuteBudgetState,
  minSharedPool,
  minuteReserveFor,
  sharedMinutePool,
  totalMinuteReserve,
} from "../lib/provider-budget.ts";
import { PROVIDER_CONSUMERS } from "../lib/provider-context.ts";

const CAP = 280;
const ENV = {};

/** Spend `n` calls for `consumer`, returning how many were admitted. */
function spend(state, consumer, n, env = ENV, cap = CAP) {
  let admitted = 0;
  for (let i = 0; i < n; i += 1) {
    const d = decideBudget(consumer, state, cap, env);
    if (!d.allowed) continue;
    commitBudget(consumer, state, d);
    admitted += 1;
  }
  return admitted;
}

// ── The guarantee ─────────────────────────────────────────────────────────────

test("a reserved lane is served even when another lane has saturated the cap", () => {
  const state = emptyMinuteBudgetState();

  // Discovery asks continuously — this is exactly what production did, and what
  // starved marking to a 0.28% admission rate.
  const discoveryGot = spend(state, "options_discovery", 5000);

  // Marking now wakes up on its horizon schedule, last, into a saturated minute.
  const markGot = spend(state, "asymmetry_mark", 100);

  assert.equal(markGot, minuteReserveFor("asymmetry_mark", ENV, CAP),
    "the reserved lane must still get its full reserve — this is the whole point of B7");
  assert.ok(markGot > 0, "a lane that gets zero is the production failure reproduced");
  assert.ok(discoveryGot > 0, "discovery must still be able to work");
  assert.ok(discoveryGot < CAP, "no single consumer may take the entire minute budget");
});

test("every reserved lane is reachable simultaneously under full contention", () => {
  const state = emptyMinuteBudgetState();
  // Saturate first with lanes that hold NO reserve, then with one that does.
  spend(state, "unattributed", 5000);
  spend(state, "options_discovery", 5000);

  for (const consumer of Object.keys(DEFAULT_MINUTE_RESERVE_FRACTIONS)) {
    const reserve = minuteReserveFor(consumer, ENV, CAP);
    assert.ok(reserve > 0, `${consumer} must resolve to a real reserve at the production cap`);
    const fresh = emptyMinuteBudgetState();
    spend(fresh, "unattributed", 5000);
    const got = spend(fresh, consumer, reserve + 10);
    assert.equal(got, reserve,
      `${consumer} must be able to spend its full reserve against a saturated shared pool`);
  }
});

test("an unreserved lane is refused once the shared pool is gone", () => {
  const state = emptyMinuteBudgetState();
  spend(state, "unattributed", 5000);
  const more = spend(state, "swing_scan", 50);
  assert.equal(more, 0,
    "research lanes hold no reserve — they must stop first, not compete with marking");
});

// ── The partition adds up ─────────────────────────────────────────────────────

test("reserves never exceed the cap, and the shared pool is what is left", () => {
  const reserved = totalMinuteReserve(ENV, CAP);
  assert.ok(reserved > 0, "reserves must actually exist");
  assert.ok(reserved < CAP, "reserves must leave a shared pool at the default cap");
  assert.equal(sharedMinutePool(CAP, ENV), CAP - reserved);
});

test("total admissions in a minute never exceed the cap", () => {
  const state = emptyMinuteBudgetState();
  let total = 0;
  // Every consumer hammers simultaneously.
  for (const c of PROVIDER_CONSUMERS) total += spend(state, c, 1000);
  assert.ok(total <= CAP, `admitted ${total} against a cap of ${CAP} — a partition must never raise a cap`);
});

test("the partition raises no cap: reserves plus pool equal the cap exactly", () => {
  assert.equal(totalMinuteReserve(ENV, CAP) + sharedMinutePool(CAP, ENV), CAP);
});

// ── Configuration ─────────────────────────────────────────────────────────────

test("a reserve is configurable per consumer, and explicit 0 disables it", () => {
  assert.equal(minuteReserveFor("asymmetry_mark", { PROVIDER_MINUTE_RESERVE_ASYMMETRY_MARK: "77" }, CAP), 77);
  assert.equal(minuteReserveFor("asymmetry_mark", { PROVIDER_MINUTE_RESERVE_ASYMMETRY_MARK: "0" }, CAP), 0,
    "explicit 0 must disable the reserve, not fall back to the default");
  assert.equal(minuteReserveFor("asymmetry_mark", {}, CAP),
    Math.floor(DEFAULT_MINUTE_RESERVE_FRACTIONS.asymmetry_mark * CAP));
  assert.equal(minuteReserveFor("asymmetry_mark", { PROVIDER_MINUTE_RESERVE_ASYMMETRY_MARK: "junk" }, CAP),
    Math.floor(DEFAULT_MINUTE_RESERVE_FRACTIONS.asymmetry_mark * CAP),
    "a malformed override falls back to the default");
});

test("the two mark lanes hold separate reserves", () => {
  // A shared `mark` reserve would be won by the subscriber lane every minute,
  // reproducing the same starvation one level down.
  assert.ok(minuteReserveFor("options_paper_mark", ENV, CAP) > 0);
  assert.ok(minuteReserveFor("asymmetry_mark", ENV, CAP) > 0);
  const state = emptyMinuteBudgetState();
  spend(state, "unattributed", 5000);
  spend(state, "options_paper_mark", 1000);
  const asym = spend(state, "asymmetry_mark", 100);
  assert.equal(asym, minuteReserveFor("asymmetry_mark", ENV, CAP),
    "the subscriber mark lane must not be able to consume the asymmetry lane's reserve");
});

test("over-reservation is scaled down, never allowed to deadlock the provider", () => {
  const env = { PROVIDER_MINUTE_RESERVE_SCANNER: "9999" };
  const pool = sharedMinutePool(CAP, env);
  assert.ok(pool >= minSharedPool(CAP),
    "the shared pool has a FLOOR — squeezing it to zero would stop any unreserved lane, "
    + "including `unattributed`, from making a single call");
  assert.ok(totalMinuteReserve(env, CAP) <= CAP, "reserves can never exceed the cap");
  const state = emptyMinuteBudgetState();
  // Scanner still gets the lion's share; other lanes still get the floor.
  assert.ok(spend(state, "scanner", 500, env) > 0);
  const fresh = emptyMinuteBudgetState();
  assert.ok(spend(fresh, "swing_scan", 500, env) > 0,
    "an unreserved lane must always be able to try");
});

test("a tiny configured cap does not starve every unreserved lane", () => {
  // REGRESSION. Reserves were first written as absolute counts tuned for 280.
  // At a cap of 2 they consumed the whole budget and the FIRST call of any
  // unreserved lane was refused, breaking the global quota semantics outright.
  for (const cap of [1, 2, 5, 10]) {
    assert.ok(totalMinuteReserve(ENV, cap) < cap,
      `reserves must leave room at cap=${cap}`);
    const state = emptyMinuteBudgetState();
    assert.ok(spend(state, "unattributed", 1, ENV, cap) === 1,
      `an unreserved lane must get its first call at cap=${cap}`);
  }
});

// ── Safety properties ─────────────────────────────────────────────────────────

test("no minute cap configured means no partitioning", () => {
  const state = emptyMinuteBudgetState();
  assert.equal(spend(state, "swing_scan", 50, ENV, 0), 50,
    "with no cap there is nothing to partition — the guard must not invent one");
});

test("a refusal consumes no budget", () => {
  const state = emptyMinuteBudgetState();
  spend(state, "unattributed", 5000);
  const before = state.sharedUsed;
  for (let i = 0; i < 100; i += 1) decideBudget("swing_scan", state, CAP, ENV);
  assert.equal(state.sharedUsed, before, "deciding must be pure — only an admitted call commits");
});

test("a fresh minute restores every reserve in full", () => {
  const reserve = minuteReserveFor("asymmetry_mark", ENV, CAP);
  const saturated = () => {
    const s = emptyMinuteBudgetState();
    spend(s, "unattributed", 5000); // drain the shared pool, leaving only reserves
    return s;
  };

  const state = saturated();
  assert.equal(spend(state, "asymmetry_mark", 100), reserve);
  assert.equal(spend(state, "asymmetry_mark", 100), 0, "the reserve is spent within the minute");

  // The provider meter swaps in a fresh state on the minute roll, so the next
  // contended minute must serve the lane again from zero.
  assert.equal(spend(saturated(), "asymmetry_mark", 100), reserve,
    "a new minute must restore the guarantee in full");
});

test("a reserve is a floor, not a ceiling — a lane may burst into a free pool", () => {
  // The reserve guarantees a MINIMUM under contention. When nothing else is
  // competing, an idle shared pool must not sit unused.
  const state = emptyMinuteBudgetState();
  const got = spend(state, "asymmetry_mark", 1000);
  assert.equal(got, minuteReserveFor("asymmetry_mark", ENV, CAP) + sharedMinutePool(CAP, ENV),
    "an uncontended lane should get its reserve plus the whole shared pool");
  assert.ok(got < CAP, "but still never the entire minute cap — other reserves stay held");
});

test("the snapshot reports the partition an operator needs to see", () => {
  const state = emptyMinuteBudgetState();
  spend(state, "asymmetry_mark", 5);
  const snap = budgetSnapshot(state, CAP, ENV);
  assert.equal(snap.minuteCap, CAP);
  assert.equal(snap.totalReserved, totalMinuteReserve(ENV, CAP));
  assert.equal(snap.sharedPool, sharedMinutePool(CAP, ENV));
  const row = snap.reserves.find((r) => r.consumer === "asymmetry_mark");
  assert.ok(row, "a reserved lane must appear in the snapshot");
  assert.equal(row.used, 5);
  assert.equal(row.reserved, minuteReserveFor("asymmetry_mark", ENV, CAP));
  assert.equal(row.category, "mark");
});

// ── The enforcement point ─────────────────────────────────────────────────────

test("recordPolygonCall enforces the partition, and reads the ambient consumer", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("lib/polygon-provider.js", "utf8");
  const fn = src.slice(src.indexOf("export function recordPolygonCall"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /currentProviderConsumer\(\)/,
    "the budget must read the AMBIENT consumer — the old `purpose` argument was never threaded, "
    + "which is why the grader reserve never once fired");
  assert.match(body, /decideBudget/, "the partition must be enforced where calls are admitted");
  assert.match(body, /commitBudget/, "an admitted call must be committed against the partition");
  // The partition must be the LAST guard, so it can never admit what the global caps refused.
  assert.ok(body.indexOf('QuotaExceededError("minute"') < body.indexOf("decideBudget"),
    "the global minute cap must be checked before the partition");
});

test("a partition refusal is a distinct, recognisable quota kind", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("lib/polygon-provider.js", "utf8");
  assert.match(src, /QuotaExceededError\("minute_partition"/,
    "a partition refusal must be distinguishable from a global cap refusal — and, like every "
    + "other budget refusal, must never be recorded as missing market data");
});
