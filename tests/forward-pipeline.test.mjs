import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEarlyWatch, resolveConfirmation } from "../lib/research/forward/twospeed.ts";
import { stamp, stageDurations, percentile, computeLatencyMetrics, heavyWorkOffCriticalPath } from "../lib/research/forward/latency.ts";
import { checkEntryFreshness } from "../lib/research/forward/freshness.ts";

const GATES = { minRelVolume: 2, minAbsMovePct: 0.5, maxSpreadPct: 10, minOpenInterest: 100, minContractVolume: 50 };
const callInput = (over = {}) => ({ symbol: "NVDA", direction: "bullish", side: "call", underlyingPrice: 134, observedAtMs: 1000, relVolume: 4, movePct: 1.2, spreadPct: 5, openInterest: 1200, contractVolume: 500, twoSidedQuote: true, gates: GATES, env: {}, ...over });

// ── EARLY WATCH (fast path) ──
test("evaluateEarlyWatch emits EARLY_WATCH when the trigger + hard gates pass", () => {
  const r = evaluateEarlyWatch(callInput());
  assert.equal(r.emit, true);
  assert.equal(r.state, "EARLY_WATCH");
  assert.equal(r.productionEligible, true);
  assert.equal(r.researchOnly, false);
});

test("a failed hard gate rejects (no emit) with the reason", () => {
  assert.equal(evaluateEarlyWatch(callInput({ spreadPct: 25 })).emit, false);
  assert.equal(evaluateEarlyWatch(callInput({ twoSidedQuote: false })).gatesFailed.includes("two_sided_quote"), true);
  assert.equal(evaluateEarlyWatch(callInput({ relVolume: 1 })).gatesFailed.includes("rel_volume"), true);
});

test("bearish/put early-watch is research-only (never production-eligible) with BEARISH_ACTIONABLE off", () => {
  const bear = evaluateEarlyWatch(callInput({ direction: "bearish", side: "put", env: {} }));
  assert.equal(bear.emit, true, "it can still WATCH");
  assert.equal(bear.productionEligible, false);
  assert.equal(bear.researchOnly, true);
  // a plain call stays production-eligible
  assert.equal(evaluateEarlyWatch(callInput()).productionEligible, true);
});

// ── CONFIRMATION ──
const conf = (over = {}) => ({ ageMs: 1000, ttlMs: 60000, freshnessState: "FRESH", technicalConfirmed: true, optionsOk: true, remainingGatesFailed: [], ...over });
test("resolveConfirmation → CONFIRMED / CANCELED / TOO_LATE / EXPIRED", () => {
  assert.equal(resolveConfirmation(conf()).state, "CONFIRMED");
  assert.equal(resolveConfirmation(conf({ freshnessState: "TOO_LATE" })).state, "TOO_LATE");
  assert.equal(resolveConfirmation(conf({ ageMs: 99999 })).state, "EXPIRED");
  assert.equal(resolveConfirmation(conf({ technicalConfirmed: false })).state, "CANCELED");
  assert.equal(resolveConfirmation(conf({ remainingGatesFailed: ["event_risk"] })).state, "CANCELED");
  // freshness beats a would-be confirmation
  assert.equal(resolveConfirmation(conf({ freshnessState: "TOO_LATE", technicalConfirmed: true })).state, "TOO_LATE");
});

// ── latency instrumentation ──
test("stageDurations + percentile + metrics compute on one clock", () => {
  let rec = {};
  rec = stamp(rec, "market_data_received", 0);
  rec = stamp(rec, "trigger_detected", 200);
  rec = stamp(rec, "early_watch_queued", 900);
  rec = stamp(rec, "discord_request_end", 1500);
  rec = stamp(rec, "final_discord_update", 40000);
  const d = stageDurations(rec);
  assert.equal(d.eventToTrigger, 200);
  assert.equal(d.triggerToEarlyWatch, 700);
  assert.equal(d.eventToDiscordDelivery, 1500);
  assert.equal(d.eventToConfirmation, 40000);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
});

test("heavyWorkOffCriticalPath: heavy stages must start at/after EARLY_WATCH", () => {
  const off = stamp(stamp({}, "early_watch_queued", 900), "analog_lookup_start", 1000);
  assert.equal(heavyWorkOffCriticalPath(off), true);
  const on = stamp(stamp({}, "early_watch_queued", 900), "analog_lookup_start", 500);
  assert.equal(heavyWorkOffCriticalPath(on), false, "analog started BEFORE early-watch → on the path");
});

test("computeLatencyMetrics aggregates rates + flags heavy-work-on-path", () => {
  const mk = (state, ew, analogStart, lateEntry = false) => ({ latency: { market_data_received: 0, trigger_detected: 100, early_watch_queued: ew, analog_lookup_start: analogStart }, state, lateEntry });
  const m = computeLatencyMetrics([mk("CONFIRMED", 800, 900), mk("TOO_LATE", 1200, 1300, true), mk("CANCELED", 700, 300)]);
  assert.equal(m.total, 3);
  assert.equal(m.triggerToEarlyWatch.n, 3);
  assert.ok(m.tooLatePct > 0 && m.canceledPct > 0);
  assert.equal(m.lateEntryPct > 0, true);
  assert.equal(m.heavyWorkOnCriticalPath, 1, "the CANCELED one had analog before early-watch");
});

// ── entry freshness ──
test("checkEntryFreshness FRESH vs TOO_LATE (stale / chase / zone)", () => {
  const base = { side: "call", observedPrice: 100, observedAtMs: 0, currentPrice: 100.2, currentAtMs: 1000, entryZone: [99, 101], maxChasePct: 0.5, maxAgeMs: 5000 };
  assert.equal(checkEntryFreshness(base).state, "FRESH");
  assert.equal(checkEntryFreshness({ ...base, currentAtMs: 9000 }).state, "TOO_LATE"); // stale
  assert.equal(checkEntryFreshness({ ...base, currentPrice: 101.5 }).state, "TOO_LATE"); // chased up + out of zone
  // put: a DOWN move is the chase
  const put = { ...base, side: "put", currentPrice: 99, entryZone: null };
  assert.equal(checkEntryFreshness(put).state, "TOO_LATE");
  assert.equal(checkEntryFreshness({ ...put, currentPrice: 100.1 }).state, "FRESH");
});
