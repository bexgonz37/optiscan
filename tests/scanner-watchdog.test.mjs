/**
 * tests/scanner-watchdog.test.mjs
 *
 * The defect: the loop's beat rescheduled unconditionally but guarded its body on a
 * `busy` flag that only cleared when `await tick()` SETTLED. A tick whose promise
 * never settled left `busy` true for the life of the process — every later beat
 * short-circuited, no tick ever ran again, and the timer, the process and
 * `loopRunning: true` all kept insisting the scanner was alive. Production spent
 * ~5.5 hours there.
 *
 * The fix must recover WITHOUT letting the abandoned tick resume and send a
 * duplicate alert, so these tests pin both halves: the loop keeps ticking through a
 * permanent hang, and the hung tick is fenced out of its side effects forever.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  runWatchedTick,
  loopHealth,
  watchdogState,
  resetWatchdogForTests,
  currentGenerationIsActive,
  sideEffectAllowed,
  watchdogConfigFromEnv,
} from "../lib/scanner-watchdog.ts";

const CFG = { tickTimeoutMs: 40, maxOutstandingAbandoned: 3, stallWarnMs: 1_000 };
const never = () => new Promise(() => {});
const tiny = (ms) => new Promise((r) => setTimeout(r, ms));

test.beforeEach(() => resetWatchdogForTests());

// ── the wedge ───────────────────────────────────────────────────────────────

test("REPRODUCES THE WEDGE: a tick that never settles does not stop later ticks", async () => {
  // Under the old beat this hangs `busy` true forever and nothing below ever runs.
  const first = await runWatchedTick(never, CFG);
  assert.equal(first.started, true);

  let ranAgain = false;
  const second = await runWatchedTick(async () => { ranAgain = true; }, CFG);
  assert.equal(second.started, true);
  assert.equal(ranAgain, true, "the loop must keep ticking through a permanent hang");

  const s = watchdogState();
  assert.equal(s.timeouts, 1);
  assert.equal(s.recoveries, 1);
});

test("the abandoned tick is fenced out of its side effects forever", async () => {
  let sawFenceOpen = null;
  let released;
  const gate = new Promise((r) => { released = r; });

  // A tick that suspends past its budget, then resumes and tries to send.
  const hung = runWatchedTick(async () => {
    await gate;
    sawFenceOpen = sideEffectAllowed();
  }, CFG);
  await hung; // resolves on timeout, tick still suspended

  // The loop has moved on.
  await runWatchedTick(async () => {}, CFG);

  released();
  await tiny(10);

  assert.equal(sawFenceOpen, false, "a resumed abandoned tick must not be allowed to send");
  assert.equal(watchdogState().fencedSideEffects, 1);
});

test("the live tick is allowed to act while it holds the generation", async () => {
  let allowed = null;
  await runWatchedTick(async () => { allowed = sideEffectAllowed(); }, CFG);
  assert.equal(allowed, true);
  assert.equal(watchdogState().fencedSideEffects, 0);
});

test("code outside any tick scope is never fenced", () => {
  assert.equal(currentGenerationIsActive(), true);
  assert.equal(sideEffectAllowed(), true);
});

// ── no overlap, no pile-up ──────────────────────────────────────────────────

test("a tick still inside its budget is not duplicated", async () => {
  let starts = 0;
  const slow = async () => { starts += 1; await tiny(200); };
  const p = runWatchedTick(slow, CFG);
  const overlapping = await runWatchedTick(slow, CFG);
  assert.equal(overlapping.started, false);
  assert.equal(overlapping.skipped, "busy");
  assert.equal(starts, 1, "no second tick may run while the first still has budget");
  await p;
});

test("abandoned ticks are capped — the loop stops stacking work and says WEDGED", async () => {
  const cfg = { ...CFG, maxOutstandingAbandoned: 2 };
  await runWatchedTick(never, cfg);
  await runWatchedTick(never, cfg);

  const blocked = await runWatchedTick(never, cfg);
  assert.equal(blocked.started, false);
  assert.equal(blocked.skipped, "wedged", "must refuse rather than pile up suspended ticks");

  const h = loopHealth({ running: true, cfg });
  assert.equal(h.state, "WEDGED");
  assert.equal(h.outstandingAbandoned, 2);
  assert.equal(h.launchBlocked, true);
});

test("a late-settling abandoned tick releases its slot and is recorded", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await runWatchedTick(() => gate, CFG);
  assert.equal(watchdogState().outstandingAbandoned.size, 1);

  release();
  await tiny(10);

  const s = watchdogState();
  assert.equal(s.outstandingAbandoned.size, 0, "the slot must free when the hang turns out transient");
  assert.equal(s.lateSettled, 1);
});

// ── health truthfulness ─────────────────────────────────────────────────────

test("health does not report HEALTHY merely because the process is alive", () => {
  const h = loopHealth({ running: true, cfg: CFG });
  assert.notEqual(h.state, "HEALTHY");
  assert.equal(h.state, "RECOVERING");
});

test("a stopped loop is WEDGED, not HEALTHY", () => {
  const h = loopHealth({ running: false, cfg: CFG });
  assert.equal(h.state, "WEDGED");
  assert.match(h.reason, /not running/);
});

test("a completed tick reports HEALTHY", async () => {
  await runWatchedTick(async () => {}, CFG);
  const h = loopHealth({ running: true, cfg: CFG });
  assert.equal(h.state, "HEALTHY");
  assert.equal(h.ticksCompleted, 1);
  assert.equal(h.outstandingAbandoned, 0);
});

test("a throwing tick is DEGRADED, and the error is kept for diagnosis", async () => {
  await runWatchedTick(async () => { throw new Error("chain fetch exploded"); }, CFG);
  const h = loopHealth({ running: true, cfg: CFG });
  assert.equal(h.state, "DEGRADED");
  assert.equal(h.consecutiveFailures, 1);
  assert.match(h.lastError, /chain fetch exploded/);
});

test("recovery is observable: timeout count, recovery count and cause are retained", async () => {
  await runWatchedTick(never, CFG);
  const h = loopHealth({ running: true, cfg: CFG });
  assert.equal(h.timeoutCount, 1);
  assert.equal(h.recoveryCount, 1);
  assert.equal(h.state, "RECOVERING");
  assert.match(h.lastTimeoutNote, /abandoned/);
  assert.match(h.lastTimeoutNote, /fenced/);
});

test("a success after a failure clears the failure streak", async () => {
  await runWatchedTick(async () => { throw new Error("transient"); }, CFG);
  await runWatchedTick(async () => {}, CFG);
  const h = loopHealth({ running: true, cfg: CFG });
  assert.equal(h.consecutiveFailures, 0);
  assert.equal(h.state, "HEALTHY");
});

test("an overdue in-flight tick reads WEDGED while it is still hanging", async () => {
  const p = runWatchedTick(never, { ...CFG, tickTimeoutMs: 10_000 });
  await tiny(5);
  const h = loopHealth({ running: true, nowMs: Date.now() + 20_000, cfg: { ...CFG, tickTimeoutMs: 10_000 } });
  assert.equal(h.state, "WEDGED");
  assert.ok(h.currentTickDurationMs > 10_000);
  void p;
});

// ── config ──────────────────────────────────────────────────────────────────

test("config comes from env with safe floors", () => {
  const d = watchdogConfigFromEnv({});
  assert.equal(d.tickTimeoutMs, 90_000);
  assert.equal(d.maxOutstandingAbandoned, 3);

  const tuned = watchdogConfigFromEnv({ SCANNER_TICK_TIMEOUT_MS: "15000", SCANNER_MAX_ABANDONED_TICKS: "1" });
  assert.equal(tuned.tickTimeoutMs, 15_000);
  assert.equal(tuned.maxOutstandingAbandoned, 1);

  // Nonsense and dangerously low values fall back rather than disabling the guard.
  const bad = watchdogConfigFromEnv({ SCANNER_TICK_TIMEOUT_MS: "0", SCANNER_MAX_ABANDONED_TICKS: "nope" });
  assert.equal(bad.tickTimeoutMs, 90_000);
  assert.equal(bad.maxOutstandingAbandoned, 3);
});
