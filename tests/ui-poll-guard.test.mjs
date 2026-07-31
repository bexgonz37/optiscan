/**
 * tests/ui-poll-guard.test.mjs — regression cover for the production incident
 * where a slow endpoint stacked in-flight requests until the browser's
 * per-host connection pool was exhausted and every page hung on its skeleton.
 *
 * Root cause measured in production: `/api/now` answered in ~14s while
 * app/watchlist/page.tsx polled it every 3s with no in-flight guard, producing
 * ~5 concurrent requests permanently.
 *
 * These tests prove the guard makes that impossible, and assert the cadences
 * the pages actually ship with.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPollGuard, isAbortError } from "../lib/dashboard/poll-guard.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The property that broke production ──────────────────────────────────────

test("a slow endpoint cannot create overlapping requests", async () => {
  const guard = createPollGuard();
  let started = 0;
  let concurrent = 0;
  let maxConcurrent = 0;

  // Endpoint far slower than the tick, exactly like /api/now at 14s vs 3s.
  const slowRequest = async () => {
    started += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(60);
    concurrent -= 1;
  };

  // Fire ticks much faster than the request can complete.
  const ticks = [];
  for (let i = 0; i < 12; i++) {
    ticks.push(guard.run(slowRequest));
    await sleep(5);
  }
  const outcomes = await Promise.all(ticks);

  assert.equal(maxConcurrent, 1, "at most one request may ever be in flight");
  assert.ok(started < 12, `most ticks must be skipped, only ${started} ran`);
  assert.ok(outcomes.includes("skipped"), "overlapping ticks must report skipped");
  assert.ok(outcomes.includes("ran"), "at least one tick must actually run");

  // Once the slow run settles, the guard is reusable — it does not latch.
  await sleep(80);
  assert.equal(guard.isRunning(), false);
  assert.equal(await guard.run(async () => {}), "ran");
});

test("a skipped tick is dropped, never queued", async () => {
  const guard = createPollGuard();
  let runs = 0;
  const slow = async () => { runs += 1; await sleep(50); };

  const first = guard.run(slow);
  const skipped = await Promise.all([guard.run(slow), guard.run(slow), guard.run(slow)]);
  await first;
  assert.deepEqual(skipped, ["skipped", "skipped", "skipped"]);
  assert.equal(runs, 1, "queued ticks would have raised this above 1");

  // Nothing runs later as a backlog.
  await sleep(80);
  assert.equal(runs, 1);
});

// ── Unmount safety ──────────────────────────────────────────────────────────

test("dispose aborts the in-flight request and refuses further runs", async () => {
  const guard = createPollGuard();
  let observed = null;
  const run = guard.run(async (signal) => {
    observed = signal;
    await sleep(50);
  });

  assert.equal(observed.aborted, false);
  guard.dispose();
  assert.equal(observed.aborted, true, "unmount must abort the open request");
  await run;

  assert.equal(guard.isDisposed(), true);
  assert.equal(await guard.run(async () => { throw new Error("must not run"); }), "disposed");
});

test("a run finishing after dispose cannot revive the guard", async () => {
  const guard = createPollGuard();
  const run = guard.run(async () => { await sleep(30); });
  guard.dispose();
  await run;
  assert.equal(guard.isDisposed(), true);
  assert.equal(await guard.run(async () => {}), "disposed");
});

test("dispose is idempotent and never throws", () => {
  const guard = createPollGuard();
  guard.dispose();
  guard.dispose();
  assert.equal(guard.isDisposed(), true);
});

test("a rejecting request releases the guard rather than latching it", async () => {
  const guard = createPollGuard();
  await assert.rejects(guard.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(guard.isRunning(), false, "a failed request must not block all later ticks");
  assert.equal(await guard.run(async () => {}), "ran");
});

test("isAbortError recognises only real aborts", () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(isAbortError(abort), true);
  assert.equal(isAbortError(new Error("network")), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError(undefined), false);
});

// ── The cadences the pages actually ship with ───────────────────────────────

test("the Watchlist polls the slow plan endpoints far slower than the tape", () => {
  const src = readFileSync("app/watchlist/page.tsx", "utf8");
  const tape = Number(src.match(/const TAPE_POLL_MS = ([\d_]+)/)[1].replace(/_/g, ""));
  const plan = Number(src.match(/const PLAN_POLL_MS = ([\d_]+)/)[1].replace(/_/g, ""));

  assert.ok(plan >= 60_000, `/api/now must poll at >= 60s, got ${plan}ms`);
  assert.ok(plan > tape, "the plan cadence must be slower than the tape cadence");
  assert.ok(tape >= 3_000, "the tape cadence must not become faster than before");

  // /api/now and the professional Watchlist must sit on the SLOW tick only.
  // Comments are stripped first: prose about /api/now sits between the two
  // functions and would otherwise read as a call site.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const planFn = stripComments(src.slice(src.indexOf("const loadPlans"), src.indexOf("useEffect(")));
  assert.match(planFn, /\/api\/now/);
  assert.match(planFn, /\/api\/research\/watchlist\/professional/);
  const tapeFn = stripComments(src.slice(src.indexOf("const loadTape"), src.indexOf("const loadPlans")));
  assert.equal(/\/api\/now/.test(tapeFn), false, "/api/now must not ride the 3s tape tick");
  assert.equal(/watchlist\/professional/.test(tapeFn), false, "the professional endpoint must not ride the 3s tick");
});

test("NOW polls /api/now at >= 60s", () => {
  const src = readFileSync("components/NowPage.tsx", "utf8");
  const now = Number(src.match(/const NOW_POLL_MS = ([\d_]+)/)[1].replace(/_/g, ""));
  assert.ok(now >= 60_000, `/api/now must poll at >= 60s, got ${now}ms`);
});

test("both polling pages guard every tick and dispose on unmount", () => {
  for (const file of ["app/watchlist/page.tsx", "components/NowPage.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /createPollGuard\(\)/, `${file} must use the guard`);
    assert.match(src, /\.dispose\(\)/, `${file} must dispose on unmount`);
    assert.match(src, /signal/, `${file} must pass an AbortSignal to fetch`);
    // No bare interval may call a fetch function directly, bypassing the guard.
    const bare = src.match(/setInterval\(\s*(load|loadTape|loadPlans|loadSentToday)\s*,/);
    assert.equal(bare, null, `${file} has an unguarded setInterval: ${bare?.[0]}`);
  }
});
