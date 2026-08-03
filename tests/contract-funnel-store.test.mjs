/**
 * contract-funnel-store.test.mjs
 *
 * The evidence `selectContractWithEvidence` has produced since `a4777ec` was
 * never stored. These tests pin the two things that failure made impossible:
 * measuring the PROVIDER_DELTA / MONEYNESS_PROXY split, and giving the discovery
 * monitor an input other than its own test file.
 *
 * They also pin the missing-data rules the options pipeline is being audited
 * against: an unknown coverage must never read back as 0%, and no absence of
 * evidence may be reported as a measured 0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  ensureContractFunnelSchema,
  recordContractFunnelOnDb,
  readRecentFunnelEvidenceOnDb,
  deltaSourceSplitOnDb,
  terminalReasonBreakdownOnDb,
} from "../lib/research/options/contract-funnel-store.ts";
import { selectContractWithEvidence } from "../lib/research/options/contract-discovery.ts";
import { evaluateDiscoveryHealth } from "../lib/research/options/discovery-monitor.ts";

const NOW = Date.UTC(2026, 7, 3, 15, 0, 0);
const DAY = "2026-08-03";

function db() {
  const d = new Database(":memory:");
  ensureContractFunnelSchema(d);
  return d;
}

function ev(over = {}) {
  return {
    symbol: "SPY", direction: "bullish", requestedSide: "call", strategyKey: "confirmed_breakout",
    atMs: NOW, discoveryVersion: "contract-discovery@2", selectionVersion: "contract-selection@3",
    partitionsAttempted: [], requestedDteBuckets: ["0dte"], preferredDelta: [0.45, 0.65],
    moneyness: "ATM", contractsReceived: 500, callsReceived: 300, putsReceived: 200,
    passedSide: 300, passedDte: 170, withBid: 170, withAsk: 170, twoSided: 170,
    withDelta: 55, deltaCoverage: 55 / 170, passedDeltaBand: 1, rankedCount: 170,
    deltaSource: "MONEYNESS_PROXY", selectedOcc: "O:SPY260803C00735000",
    terminalReason: "CONTRACT_SELECTED",
    greeksMissingOnSide: true, pageLimitReached: false, ...over,
  };
}

test("the schema is repeat-safe — ensuring it twice is a no-op", () => {
  const d = db();
  ensureContractFunnelSchema(d);
  ensureContractFunnelSchema(d);
  assert.equal(recordContractFunnelOnDb(d, DAY, ev()).ok, true);
});

test("a funnel row round-trips, including deltaSource", () => {
  const d = db();
  assert.equal(recordContractFunnelOnDb(d, DAY, ev()).ok, true);
  const back = readRecentFunnelEvidenceOnDb(d, DAY, 0);
  assert.equal(back.length, 1);
  assert.equal(back[0].symbol, "SPY");
  assert.equal(back[0].deltaSource, "MONEYNESS_PROXY");
  assert.equal(back[0].selectedOcc, "O:SPY260803C00735000");
  assert.equal(back[0].terminalReason, "CONTRACT_SELECTED");
  assert.equal(back[0].greeksMissingOnSide, true);
  assert.ok(Math.abs(back[0].deltaCoverage - 55 / 170) < 1e-9);
});

test("THE MEASUREMENT: the PROVIDER_DELTA / MONEYNESS_PROXY split is now answerable", () => {
  const d = db();
  for (let i = 0; i < 7; i++) recordContractFunnelOnDb(d, DAY, ev({ deltaSource: "MONEYNESS_PROXY" }));
  for (let i = 0; i < 3; i++) recordContractFunnelOnDb(d, DAY, ev({ deltaSource: "PROVIDER_DELTA" }));
  // Candidates that selected nothing must not be counted as either source.
  for (let i = 0; i < 5; i++) {
    recordContractFunnelOnDb(d, DAY, ev({ deltaSource: null, selectedOcc: null, terminalReason: "NO_CALLS_RETURNED" }));
  }
  const s = deltaSourceSplitOnDb(d, DAY);
  assert.equal(s.total, 15);
  assert.equal(s.moneynessProxy, 7);
  assert.equal(s.providerDelta, 3);
  assert.equal(s.unselected, 5, "an unselected candidate has NO delta source");
  assert.ok(Math.abs(s.proxyShareOfSelected - 0.7) < 1e-9, "7 of 10 SELECTED used the proxy");
});

test("no selections is null evidence, never a measured 0% proxy rate", () => {
  const d = db();
  recordContractFunnelOnDb(d, DAY, ev({ deltaSource: null, selectedOcc: null, terminalReason: "NO_CALLS_RETURNED" }));
  const s = deltaSourceSplitOnDb(d, DAY);
  assert.equal(s.proxyShareOfSelected, null, "absence of evidence must not read as 0");
});

test("an empty day reports null, not a fabricated zero", () => {
  const d = db();
  const s = deltaSourceSplitOnDb(d, DAY);
  assert.equal(s.total, 0);
  assert.equal(s.proxyShareOfSelected, null);
  assert.deepEqual(terminalReasonBreakdownOnDb(d, DAY), []);
});

test("UNKNOWN delta coverage is stored NULL and never read back as 0% coverage", () => {
  const d = db();
  // A candidate that died before any tradeable universe existed: coverage is
  // unknown. Storing 0 would let "we never looked" average in with "we looked and
  // the provider published no greeks".
  recordContractFunnelOnDb(d, DAY, ev({
    twoSided: 0, withDelta: 0, deltaCoverage: 0, deltaSource: null,
    selectedOcc: null, terminalReason: "NO_CALLS_RETURNED",
  }));
  const raw = d.prepare("SELECT delta_coverage FROM contract_funnel_evidence").get();
  assert.equal(raw.delta_coverage, null, "unknown coverage is NULL in the column");
});

test("terminal reasons aggregate into the 'what killed the funnel' breakdown", () => {
  const d = db();
  for (let i = 0; i < 9; i++) recordContractFunnelOnDb(d, DAY, ev({ terminalReason: "NO_CONTRACT_IN_DTE_RANGE" }));
  for (let i = 0; i < 4; i++) recordContractFunnelOnDb(d, DAY, ev({ terminalReason: "CONTRACT_SELECTED" }));
  const b = terminalReasonBreakdownOnDb(d, DAY);
  assert.equal(b[0].reason, "NO_CONTRACT_IN_DTE_RANGE");
  assert.equal(b[0].count, 9);
  assert.equal(b[1].count, 4);
});

test("THE MONITOR NOW HAS AN INPUT: stored evidence feeds evaluateDiscoveryHealth", () => {
  const d = db();
  // The 2026-08-03 shape: many bullish candidates, zero calls ever priced.
  for (let i = 0; i < 18; i++) {
    recordContractFunnelOnDb(d, DAY, ev({
      atMs: NOW + i * 1000, deltaSource: null, selectedOcc: null,
      withDelta: 0, deltaCoverage: 0, passedDeltaBand: 0,
      terminalReason: "NO_CONTRACT_IN_DELTA_RANGE",
    }));
  }
  const stored = readRecentFunnelEvidenceOnDb(d, DAY, 0);
  assert.equal(stored.length, 18, "the monitor's input comes from the database now");
  const alerts = evaluateDiscoveryHealth("SPY", "call", stored, 15 * 60_000);
  assert.ok(alerts.length > 0, "this shape must raise an alert, and now can");
  assert.ok(
    alerts.some((a) => a.kind === "BULLISH_CANDIDATES_NO_CALLS"),
    `expected the zero-calls alert, got ${alerts.map((a) => a.kind).join(",")}`,
  );
});

test("a healthy session that selects contracts raises nothing", () => {
  const d = db();
  for (let i = 0; i < 18; i++) {
    // Complete greeks AND a selected contract — nothing to report at any severity.
    recordContractFunnelOnDb(d, DAY, ev({
      atMs: NOW + i * 1000, deltaSource: "PROVIDER_DELTA",
      withDelta: 170, deltaCoverage: 1, passedDeltaBand: 12, greeksMissingOnSide: false,
    }));
  }
  const stored = readRecentFunnelEvidenceOnDb(d, DAY, 0);
  assert.deepEqual(evaluateDiscoveryHealth("SPY", "call", stored, 15 * 60_000), []);
});

test("REAL EVIDENCE: a live selector result persists and reads back unchanged", () => {
  const d = db();
  const chain = [];
  for (let k = 700; k <= 780; k++) {
    chain.push({
      optionSymbol: `O:SPY260803C${String(k * 1000).padStart(8, "0")}`,
      side: "call", strike: k, expiration: "260803", dte: 0,
      bid: 1.2, ask: 1.3, spreadPct: 8, volume: 100, openInterest: 500,
      iv: 0.2, delta: null, providerTimestamp: NOW - 1000,
    });
  }
  const r = selectContractWithEvidence(chain, "call", "confirmed_breakout", NOW, {
    symbol: "SPY", underlyingPrice: 735,
  });
  assert.equal(r.evidence.deltaSource, "MONEYNESS_PROXY");
  assert.equal(recordContractFunnelOnDb(d, DAY, r.evidence).ok, true);

  const back = readRecentFunnelEvidenceOnDb(d, DAY, 0)[0];
  assert.equal(back.deltaSource, r.evidence.deltaSource);
  assert.equal(back.selectedOcc, r.evidence.selectedOcc);
  assert.equal(back.terminalReason, r.evidence.terminalReason);
  assert.equal(back.selectionVersion, r.evidence.selectionVersion);
  assert.equal(back.withDelta, 0);
  assert.equal(back.deltaCoverage, 0, "greeks genuinely absent = a MEASURED 0, not unknown");
});

test("a persistence fault is swallowed and reported, never thrown at the scanner", () => {
  const broken = {
    exec() { throw new Error("disk is on fire"); },
    prepare() { throw new Error("disk is on fire"); },
  };
  const res = recordContractFunnelOnDb(broken, DAY, ev());
  assert.equal(res.ok, false);
  assert.match(res.error, /disk is on fire/);
  // And every reader degrades to empty rather than propagating.
  assert.deepEqual(readRecentFunnelEvidenceOnDb(broken, DAY, 0), []);
  assert.deepEqual(terminalReasonBreakdownOnDb(broken, DAY), []);
  assert.equal(deltaSourceSplitOnDb(broken, DAY).total, 0);
});

test("evidence is scoped to its session — yesterday cannot leak into today", () => {
  const d = db();
  recordContractFunnelOnDb(d, "2026-08-02", ev({ deltaSource: "PROVIDER_DELTA" }));
  recordContractFunnelOnDb(d, DAY, ev({ deltaSource: "MONEYNESS_PROXY" }));
  assert.equal(deltaSourceSplitOnDb(d, DAY).total, 1);
  assert.equal(deltaSourceSplitOnDb(d, DAY).moneynessProxy, 1);
  assert.equal(deltaSourceSplitOnDb(d, "2026-08-02").providerDelta, 1);
});

test("the split can be sliced by symbol and side", () => {
  const d = db();
  recordContractFunnelOnDb(d, DAY, ev({ symbol: "SPY", requestedSide: "call", deltaSource: "MONEYNESS_PROXY" }));
  recordContractFunnelOnDb(d, DAY, ev({ symbol: "QQQ", requestedSide: "call", deltaSource: "MONEYNESS_PROXY" }));
  recordContractFunnelOnDb(d, DAY, ev({ symbol: "SPY", requestedSide: "put", deltaSource: "PROVIDER_DELTA" }));
  assert.equal(deltaSourceSplitOnDb(d, DAY, { symbol: "SPY" }).total, 2);
  assert.equal(deltaSourceSplitOnDb(d, DAY, { symbol: "SPY", side: "call" }).moneynessProxy, 1);
  assert.equal(deltaSourceSplitOnDb(d, DAY, { side: "put" }).providerDelta, 1);
});
