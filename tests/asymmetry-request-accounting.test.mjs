/**
 * Provider request accounting, caps, and the circuit breaker.
 *
 * These assertions exist because the historical lane is the first part of
 * OptiScan that can issue an unbounded number of provider requests. A cap that
 * silently fails open would burn the day's budget before the opening bell, and
 * the only evidence would be a bill.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RequestAccountant, DEFAULT_REQUEST_CAPS, resolveRequestCaps,
  emptyLedger, REQUEST_KINDS, HISTORICAL_KINDS, PROVIDER_BUDGET_BLOCKED,
} from "../lib/research/asymmetry/historical/request-accounting.ts";

const caps = (over = {}) => ({ ...DEFAULT_REQUEST_CAPS, ...over });

test("every request kind starts at zero and is counted separately", () => {
  const a = new RequestAccountant();
  for (const k of REQUEST_KINDS) assert.equal(a.ledger.requests[k], 0, `${k} must start at 0`);
  a.admit({ kind: "HIST_QUOTE", symbol: "NVDA", occ: "O:NVDA260807C00200000", windowKey: "1-2" });
  a.admit({ kind: "HIST_AGG", symbol: "NVDA", occ: "O:NVDA260807C00200000", windowKey: "1-2" });
  assert.equal(a.ledger.requests.HIST_QUOTE, 1);
  assert.equal(a.ledger.requests.HIST_AGG, 1);
  assert.equal(a.ledger.requests.HIST_TRADE, 0);
  assert.equal(a.ledger.historicalTotal, 2);
});

test("requests are counted BEFORE issue, so a crashed request is still accounted", () => {
  // admit() is the only counting point; there is no post-hoc increment that a
  // thrown request could skip.
  const a = new RequestAccountant();
  const r = a.admit({ kind: "HIST_QUOTE", symbol: "NVDA" });
  assert.equal(r.admitted, true);
  assert.equal(a.ledger.requests.HIST_QUOTE, 1, "counted at admission, not at completion");
});

test("per-run historical cap blocks and records PROVIDER_BUDGET_BLOCKED reason", () => {
  const a = new RequestAccountant(caps({ maxHistoricalPerRun: 2 }));
  assert.equal(a.admit({ kind: "HIST_QUOTE", symbol: "A" }).admitted, true);
  assert.equal(a.admit({ kind: "HIST_QUOTE", symbol: "B" }).admitted, true);
  const blocked = a.admit({ kind: "HIST_QUOTE", symbol: "C" });
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.reason, "MAX_HISTORICAL_PER_RUN");
  assert.equal(a.ledger.budgetBlocks, 1);
  assert.equal(a.ledger.blocksByReason.MAX_HISTORICAL_PER_RUN, 1);
  assert.equal(a.ledger.historicalTotal, 2, "a blocked request must NOT be counted as issued");
});

test("per-symbol cap is independent per symbol", () => {
  const a = new RequestAccountant(caps({ maxHistoricalPerSymbol: 2 }));
  for (let i = 0; i < 2; i++) assert.equal(a.admit({ kind: "HIST_QUOTE", symbol: "NVDA" }).admitted, true);
  assert.equal(a.admit({ kind: "HIST_QUOTE", symbol: "NVDA" }).reason, "MAX_HISTORICAL_PER_SYMBOL");
  assert.equal(a.admit({ kind: "HIST_QUOTE", symbol: "AAPL" }).admitted, true, "a different symbol has its own budget");
  assert.equal(a.ledger.perSymbol.NVDA, 2);
  assert.equal(a.ledger.perSymbol.AAPL, 1);
});

test("windows per OCC are capped, and a repeated window is not a new window", () => {
  const a = new RequestAccountant(caps({ maxWindowsPerOcc: 2 }));
  const occ = "O:NVDA260807C00200000";
  assert.equal(a.admit({ kind: "HIST_QUOTE", symbol: "NVDA", occ, windowKey: "w1" }).admitted, true);
  assert.equal(a.admit({ kind: "HIST_QUOTE", symbol: "NVDA", occ, windowKey: "w2" }).admitted, true);
  // Same window again: allowed, because it consumes no NEW window.
  assert.equal(a.admit({ kind: "HIST_QUOTE", symbol: "NVDA", occ, windowKey: "w1" }).admitted, true);
  assert.equal(a.ledger.windowsPerOcc[occ], 2, "distinct windows only");
  assert.equal(a.admit({ kind: "HIST_QUOTE", symbol: "NVDA", occ, windowKey: "w3" }).reason, "MAX_WINDOWS_PER_OCC");
});

test("live enrichment is capped per candidate, not globally", () => {
  const a = new RequestAccountant(caps({ maxLiveEnrichmentPerCandidate: 1 }));
  assert.equal(a.admit({ kind: "LIVE_QUOTE", candidateId: "c1" }).admitted, true);
  assert.equal(a.admit({ kind: "LIVE_QUOTE", candidateId: "c1" }).reason, "MAX_LIVE_ENRICHMENT_PER_CANDIDATE");
  assert.equal(a.admit({ kind: "LIVE_CHAIN", candidateId: "c2" }).admitted, true);
});

test("caps do not apply to live kinds without a candidate id", () => {
  const a = new RequestAccountant(caps({ maxHistoricalPerRun: 0 }));
  assert.equal(a.admit({ kind: "LIVE_CHAIN" }).admitted, true, "live capture must never be blocked by a historical cap");
  assert.equal(a.admit({ kind: "UNDERLYING" }).admitted, true);
  assert.equal(a.admit({ kind: "HIST_QUOTE", symbol: "NVDA" }).admitted, false, "historical still capped");
});

test("circuit breaker opens after consecutive failures and blocks admission", () => {
  const a = new RequestAccountant(caps({ circuitFailureThreshold: 3, circuitOpenMs: 10_000 }));
  const t0 = 1_000_000;
  a.recordFailure({}, t0);
  a.recordFailure({}, t0);
  assert.equal(a.isCircuitOpen(t0), false, "under threshold, still closed");
  a.recordFailure({}, t0);
  assert.equal(a.isCircuitOpen(t0), true);
  assert.equal(a.ledger.circuitOpens, 1);
  const blocked = a.admit({ kind: "HIST_QUOTE", symbol: "NVDA" }, t0);
  assert.equal(blocked.reason, "CIRCUIT_OPEN");
});

test("circuit half-opens after the window and a success closes it", () => {
  const a = new RequestAccountant(caps({ circuitFailureThreshold: 1, circuitOpenMs: 5_000 }));
  const t0 = 1_000_000;
  a.recordFailure({}, t0);
  assert.equal(a.isCircuitOpen(t0 + 1000), true, "still inside the open window");
  assert.equal(a.isCircuitOpen(t0 + 6000), false, "one probe allowed through after the window");
  a.recordSuccess();
  assert.equal(a.isCircuitOpen(t0 + 7000), false, "success fully closes it");
  assert.equal(a.snapshot().consecutiveFailures, 0);
});

test("429s are counted separately from provider failures", () => {
  const a = new RequestAccountant();
  a.recordFailure({ rateLimited: true });
  a.recordFailure({});
  assert.equal(a.ledger.rateLimited429, 1);
  assert.equal(a.ledger.providerFailures, 1);
});

test("backoff doubles deterministically with no jitter", () => {
  const a = new RequestAccountant(caps({ backoffBaseMs: 100 }));
  assert.equal(a.backoffMs(1), 100);
  assert.equal(a.backoffMs(2), 200);
  assert.equal(a.backoffMs(3), 400);
  assert.equal(a.backoffMs(1), 100, "deterministic across calls");
});

test("cache and duplicate counters are tracked", () => {
  const a = new RequestAccountant();
  a.recordCacheHit(); a.recordCacheHit(); a.recordCacheMiss(); a.recordDuplicateAvoided(); a.recordRetry();
  assert.equal(a.ledger.cacheHits, 2);
  assert.equal(a.ledger.cacheMisses, 1);
  assert.equal(a.ledger.duplicatesAvoided, 1);
  assert.equal(a.ledger.retries, 1);
});

test("snapshot is a copy — reading diagnostics cannot mutate the ledger", () => {
  const a = new RequestAccountant();
  a.admit({ kind: "HIST_QUOTE", symbol: "NVDA" });
  const s = a.snapshot();
  s.requests.HIST_QUOTE = 999;
  s.perSymbol.NVDA = 999;
  assert.equal(a.ledger.requests.HIST_QUOTE, 1, "snapshot must not alias internal state");
  assert.equal(a.ledger.perSymbol.NVDA, 1);
});

test("two accountants never share a budget", () => {
  const a = new RequestAccountant(caps({ maxHistoricalPerRun: 1 }));
  const b = new RequestAccountant(caps({ maxHistoricalPerRun: 1 }));
  assert.equal(a.admit({ kind: "HIST_QUOTE", symbol: "X" }).admitted, true);
  assert.equal(b.admit({ kind: "HIST_QUOTE", symbol: "X" }).admitted, true, "runs are isolated, not a module singleton");
});

test("env resolution clamps to sane bounds and falls back to defaults", () => {
  assert.deepEqual(resolveRequestCaps({}), DEFAULT_REQUEST_CAPS);
  const c = resolveRequestCaps({ ASYM_HIST_MAX_PER_RUN: "-5", ASYM_HIST_MAX_CONCURRENCY: "9999", ASYM_HIST_MAX_RETRIES: "nonsense" });
  assert.equal(c.maxHistoricalPerRun, 0, "clamped to the floor, not negative");
  assert.equal(c.maxConcurrency, 32, "clamped to the ceiling");
  assert.equal(c.maxRetries, DEFAULT_REQUEST_CAPS.maxRetries, "unparseable falls back to default");
});

test("HISTORICAL_KINDS is exactly the set the run/symbol caps govern", () => {
  assert.deepEqual([...HISTORICAL_KINDS].sort(), ["HIST_AGG", "HIST_CHAIN", "HIST_QUOTE", "HIST_TRADE"]);
  for (const k of HISTORICAL_KINDS) assert.ok(REQUEST_KINDS.includes(k));
});

test("emptyLedger has an entry for every kind", () => {
  const l = emptyLedger();
  for (const k of REQUEST_KINDS) assert.equal(l.requests[k], 0);
  assert.equal(PROVIDER_BUDGET_BLOCKED, "PROVIDER_BUDGET_BLOCKED");
});
