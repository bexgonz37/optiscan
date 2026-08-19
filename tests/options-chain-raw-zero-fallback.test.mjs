import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createCachedPartitionFetcher,
  fetchPartitionWithRawZeroFallback,
} from "../lib/research/options/live-deps.ts";
import { selectContractWithEvidence } from "../lib/research/options/contract-discovery.ts";

const PART = { side: "call", dteMin: 1, dteMax: 7, label: "call:1-7dte" };
const OCC = "O:MRNA260821C00120000";

function response(contracts, over = {}) {
  return {
    available: true,
    outcome: contracts.length ? "CONTRACTS_AVAILABLE" : "NO_CONTRACTS_IN_REQUESTED_RANGE",
    contracts,
    truncated: false,
    requestedDteMin: 1,
    requestedDteMax: 7,
    requestedExpirationGte: "2026-08-20",
    requestedExpirationLte: "2026-08-26",
    expirationsCovered: contracts.length ? ["2026-08-21"] : [],
    pagesRequested: 2,
    pagesReceived: 1,
    ...over,
  };
}

const mrna120c = {
  optionSymbol: OCC,
  side: "call",
  strike: 120,
  expiration: "2026-08-21",
  dte: 2,
  bid: 22,
  ask: 24,
  spreadPct: 8.7,
  volume: 250,
  openInterest: 900,
  iv: 1.2,
  delta: null,
  gamma: 0.01,
  providerTimestamp: Date.UTC(2026, 7, 19, 15, 0, 0),
};

test("MRNA regression: bounded raw-zero performs exactly one unbounded fallback and reaches selector", async () => {
  const calls = [];
  const fetchChain = async (_symbol, opts) => {
    calls.push(opts);
    return "strikeAroundPct" in opts ? response([]) : response([mrna120c]);
  };

  const outcome = await fetchPartitionWithRawZeroFallback(fetchChain, "MRNA", 143, PART, {
    strikeWindowPct: 0.08,
    maxPages: 2,
    observationTimestamp: Date.UTC(2026, 7, 19, 15, 0, 1),
  });

  assert.equal(calls.length, 2, "one bounded request plus one fallback; never an expanding loop");
  assert.equal(calls[0].strikeAroundPct, 0.08);
  assert.equal(calls[1].strikeAroundPct, undefined, "fallback removes strike bounds only");
  assert.equal(calls[1].maxPages, 2, "page/provider cap is unchanged");
  assert.equal(outcome.fallbackUsed, true);
  assert.equal(outcome.fallbackReason, "BOUNDED_PROVIDER_RAW_ZERO");
  assert.equal(outcome.requestedMinStrike, 131.56);
  assert.equal(outcome.requestedMaxStrike, 154.44);
  assert.equal(outcome.returnedMinStrike, 120);
  assert.equal(outcome.returnedMaxStrike, 120);
  assert.equal(outcome.providerRequests, 2);
  assert.equal(outcome.rawContractsReceived, 1);

  const picked = selectContractWithEvidence(outcome.contracts, "call", "confirmed_breakout", Date.now(), {
    symbol: "MRNA",
    underlyingPrice: 143,
    chainOutcome: outcome,
  });
  assert.equal(picked.contract?.optionSymbol, OCC, "the listed 120C reaches contract selection");
  assert.equal(picked.evidence.terminalReason, "CONTRACT_SELECTED");
});

test("the recovered chain is cached and fans out without another provider request", async () => {
  let requests = 0;
  const fetcher = createCachedPartitionFetcher(async (_symbol, opts) => {
    requests += 1;
    return "strikeAroundPct" in opts ? response([]) : response([mrna120c]);
  });

  const first = await fetcher("MRNA", 143, PART);
  const second = await fetcher("MRNA", 143, PART);
  assert.equal(requests, 2, "only the bounded+fallback pair reaches the provider");
  assert.equal(first.contracts[0].optionSymbol, OCC);
  assert.equal(second.contracts[0].optionSymbol, OCC);
  assert.equal(second.cacheHit, true);
  assert.equal(second.providerRequests, 0);
});

test("provider failure is distinct from raw-zero and is never negative-cached", async () => {
  let requests = 0;
  const fetcher = createCachedPartitionFetcher(async () => {
    requests += 1;
    return response([], { available: false, outcome: "PROVIDER_TIMEOUT", pagesReceived: 0 });
  });

  const first = await fetcher("FAIL", 143, PART);
  const second = await fetcher("FAIL", 143, PART);
  assert.equal(first.outcome, "PROVIDER_TIMEOUT");
  assert.equal(first.fallbackUsed, false);
  assert.equal(second.outcome, "PROVIDER_TIMEOUT");
  assert.equal(requests, 2, "a transient provider failure is retried, not cached as absence");
});
