import test from "node:test";
import assert from "node:assert/strict";
import {
  latchConfig, updateLatch, crossingSignal, markFired, EMPTY_LATCH,
} from "../lib/breakout-latch.ts";

const CFG = { ttlMs: 90_000, crossToleranceVwapDistPct: 0.6 };
const T = 1_000_000;

test("config defaults are safe and env-overridable", () => {
  const d = latchConfig({});
  assert.equal(d.ttlMs, 90_000);
  assert.equal(d.crossToleranceVwapDistPct, 0.6);
  const o = latchConfig({ CROSS_LATCH_TTL_MS: "45000", CROSS_LATCH_TOLERANCE_PCT: "0.4" });
  assert.equal(o.ttlMs, 45_000);
  assert.equal(o.crossToleranceVwapDistPct, 0.4);
});

test("a developing observation arms the stamp; the signal then goes active", () => {
  const l = updateLatch(undefined, { developingNow: true, invalidated: false, nowMs: T, cfg: CFG });
  assert.equal(l.developingSinceMs, T);
  assert.equal(l.firedAtMs, null);
  const sig = crossingSignal(l, T, CFG);
  assert.equal(sig.active, true);
  assert.equal(sig.alreadyFired, false);
  assert.equal(sig.crossToleranceVwapDistPct, 0.6);
});

test("restart safety: an empty/unknown latch yields an INACTIVE signal (no ghost alert)", () => {
  assert.equal(crossingSignal(undefined, T, CFG).active, false);
  assert.equal(crossingSignal(EMPTY_LATCH, T, CFG).active, false);
});

test("the stamp `since` is preserved across repeated developing observations (TTL from first)", () => {
  let l = updateLatch(undefined, { developingNow: true, invalidated: false, nowMs: T, cfg: CFG });
  l = updateLatch(l, { developingNow: true, invalidated: false, nowMs: T + 20_000, cfg: CFG });
  assert.equal(l.developingSinceMs, T); // unchanged — measures age from the first sighting
});

test("a stale stamp expires by TTL → signal inactive, no rescue", () => {
  const l = updateLatch(undefined, { developingNow: true, invalidated: false, nowMs: T, cfg: CFG });
  // 91s later, still developing but the ORIGINAL stamp is stale.
  const later = updateLatch(l, { developingNow: false, invalidated: false, nowMs: T + 91_000, cfg: CFG });
  assert.equal(later.developingSinceMs, null);
  assert.equal(crossingSignal(later, T + 91_000, CFG).active, false);
});

test("invalidation (reversed/extended/blocked) clears the whole episode immediately", () => {
  let l = updateLatch(undefined, { developingNow: true, invalidated: false, nowMs: T, cfg: CFG });
  l = markFired(l, T + 1);
  const cleared = updateLatch(l, { developingNow: false, invalidated: true, nowMs: T + 2, cfg: CFG });
  assert.deepEqual(cleared, { developingSinceMs: null, firedAtMs: null });
});

test("dedup: once fired, the signal is inactive until a clear + re-arm (no double fire)", () => {
  let l = updateLatch(undefined, { developingNow: true, invalidated: false, nowMs: T, cfg: CFG });
  l = markFired(l, T + 30_000);
  assert.equal(crossingSignal(l, T + 30_000, CFG).active, false);
  assert.equal(crossingSignal(l, T + 30_000, CFG).alreadyFired, true);
  // Still developing next cycle — must NOT re-arm to active (same episode).
  l = updateLatch(l, { developingNow: true, invalidated: false, nowMs: T + 40_000, cfg: CFG });
  assert.equal(crossingSignal(l, T + 40_000, CFG).active, false);
});

test("a fresh episode can arm again after the prior one expired", () => {
  let l = updateLatch(undefined, { developingNow: true, invalidated: false, nowMs: T, cfg: CFG });
  l = markFired(l, T + 1_000);
  // Expire it (>TTL, not developing) — clears since + fired.
  l = updateLatch(l, { developingNow: false, invalidated: false, nowMs: T + 100_000, cfg: CFG });
  assert.equal(l.developingSinceMs, null);
  assert.equal(l.firedAtMs, null);
  // New developing sighting re-arms a clean episode.
  l = updateLatch(l, { developingNow: true, invalidated: false, nowMs: T + 100_001, cfg: CFG });
  assert.equal(crossingSignal(l, T + 100_001, CFG).active, true);
});
