import test from "node:test";
import assert from "node:assert/strict";
import { buildHealth, isLoopStalled, lastTickAgeMs } from "../lib/health.ts";

const NOW = 1_800_000_000_000;

function loop(overrides = {}) {
  return {
    running: true,
    intervalMs: 1000,
    lastTickAt: NOW - 500,
    ticks: 1234,
    triggers: 7,
    alerts: 5,
    errors: 0,
    note: null,
    session: "regular",
    ...overrides,
  };
}

const CALL_STATS = { callsToday: 41_000, callsThisMinute: 55, dailyCap: 200_000, minuteCap: 280, quotaExceeded: false };

function build(loopOverrides = {}, extra = {}) {
  return buildHealth({
    loop: loop(loopOverrides),
    callStats: CALL_STATS,
    dbWritable: true,
    provider: "polygon",
    keyPresent: true,
    nowMs: NOW,
    authorized: true,
    ...extra,
  });
}

test("healthy running loop during RTH returns 200 with full stats", () => {
  const { status, body } = build();
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.loopRunning, true);
  assert.equal(body.lastTickAgeMs, 500);
  assert.equal(body.session, "regular");
  assert.equal(body.ticks, 1234);
  assert.equal(body.callsToday, 41_000);
  assert.equal(body.callsThisMinute, 55);
  assert.equal(body.dailyCap, 200_000);
  assert.equal(body.minuteCap, 280);
  assert.equal(body.dbWritable, true);
});

test("stalled loop (lastTickAgeMs > 3x interval) during open session returns 503", () => {
  const { status, body } = build({ lastTickAt: NOW - 3001 });
  assert.equal(status, 503);
  assert.equal(body.ok, false);
});

test("age exactly at 3x interval is still healthy (boundary)", () => {
  const { status } = build({ lastTickAt: NOW - 3000 });
  assert.equal(status, 200);
});

test("loop not running during market hours returns 503", () => {
  const { status } = build({ running: false });
  assert.equal(status, 503);
});

test("running loop that never ticked during open session returns 503", () => {
  const { status } = build({ lastTickAt: null });
  assert.equal(status, 503);
});

test("closed session never 503s on staleness (loop may idle overnight)", () => {
  const { status, body } = build({ session: "closed", lastTickAt: NOW - 3_600_000, running: false });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test("premarket and afterhours count as open sessions for liveness", () => {
  assert.equal(build({ session: "premarket", lastTickAt: NOW - 10_000 }).status, 503);
  assert.equal(build({ session: "afterhours", lastTickAt: NOW - 10_000 }).status, 503);
});

test("backed-off interval widens the stall window (no false 503 during 429 backoff)", () => {
  const { status } = build({ intervalMs: 60_000, lastTickAt: NOW - 100_000 });
  assert.equal(status, 200);
});

test("unauthenticated body is shallow: liveness only, no notes/counters", () => {
  const { status, body } = build({ note: "polygon 500: internal stack detail" }, { authorized: false });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.loopRunning, true);
  assert.equal("note" in body, false, "error strings must not leak unauthenticated");
  assert.equal("ticks" in body, false);
  assert.equal("callsToday" in body, false);
  assert.equal("dbWritable" in body, false);
  assert.equal(body.quotaExceeded, false, "quota flag stays visible for ops");
});

test("unauthenticated stall still returns 503 (uptime monitors need no token)", () => {
  const { status } = build({ running: false }, { authorized: false });
  assert.equal(status, 503);
});

test("quotaExceeded surfaces in the body", () => {
  const { body } = build({}, { callStats: { ...CALL_STATS, quotaExceeded: true } });
  assert.equal(body.quotaExceeded, true);
});

test("helpers: lastTickAgeMs + isLoopStalled", () => {
  assert.equal(lastTickAgeMs(loop({ lastTickAt: null }), NOW), null);
  assert.equal(lastTickAgeMs(loop({ lastTickAt: NOW - 42 }), NOW), 42);
  assert.equal(isLoopStalled(loop(), NOW), false);
  assert.equal(isLoopStalled(loop({ session: null }), NOW), false, "null session treated as closed (safe)");
});
