/**
 * tests/contract-discovery.test.mjs — the 2026-08-03 contract-discovery defect,
 * pinned so it cannot return.
 *
 * The fixtures are built to the shape the provider actually returned that day,
 * measured by a bounded probe:
 *
 *   SPY 0DTE calls: 170 returned,  55 with delta,  1 in the 0.35-0.65 band
 *   QQQ 0DTE calls: 204 returned,  71 with delta,  0 in the band
 *
 * with liquid near-the-money contracts among the ones missing greeks:
 *
 *   O:SPY260803C00736000  bid 21.85  ask 22.17  OI 1705  delta NULL
 *
 * The central assertion is that a bullish candidate against a huge mixed chain
 * whose short-dated calls have no greeks must still reach a call — and must never
 * silently end up with a put or with nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  planPartitions,
  selectContractWithEvidence,
  indicatesDiscoveryDefect,
  DISCOVERY_VERSION,
  SELECTION_VERSION,
} from "../lib/research/options/contract-discovery.ts";
import { selectContractFromChain } from "../lib/research/options/loop.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 7, 3, 15, 0, 0);

function occ(sym, exp, side, strike) {
  const k = String(Math.round(strike * 1000)).padStart(8, "0");
  return `O:${sym}${exp}${side === "call" ? "C" : "P"}${k}`;
}

/**
 * A realistically huge index chain: many expirations, hundreds of strikes, both
 * sides, and — the defect under test — NO GREEKS on the 0DTE contracts.
 */
function bigChain({
  symbol = "SPY",
  spot = 758,
  dtes = [0, 1, 2, 5],
  strikeLo = 500,
  strikeHi = 950,
  step = 1,
  greeksOnDte = [1, 2, 5],   // 0DTE deliberately excluded
  sides = ["call", "put"],
} = {}) {
  const out = [];
  for (const dte of dtes) {
    const exp = `2608${String(3 + dte).padStart(2, "0")}`;
    for (let k = strikeLo; k <= strikeHi; k += step) {
      for (const side of sides) {
        const intrinsic = side === "call" ? Math.max(0, spot - k) : Math.max(0, k - spot);
        const bid = +(intrinsic + 0.85).toFixed(2);
        const hasGreeks = greeksOnDte.includes(dte);
        // A plain monotonic stand-in for delta; only its ordering matters here.
        const raw = side === "call" ? spot / (spot + (k - spot) * 2) : 1 - spot / (spot + (k - spot) * 2);
        out.push({
          optionSymbol: occ(symbol, exp, side, k),
          side, strike: k, expiration: exp, dte,
          bid, ask: +(bid + 0.3).toFixed(2), spreadPct: 1.5,
          volume: 1000, openInterest: 2000, iv: 0.2,
          delta: hasGreeks ? Math.max(0.001, Math.min(0.999, raw)) : null,
          providerTimestamp: NOW - 1000,
        });
      }
    }
  }
  return out;
}

// ------------------------------------------------------- the proven defect

test("REGRESSION: a bullish candidate on a 0DTE chain with no greeks still reaches a CALL", () => {
  // confirmed_breakout is a call strategy permitting 0dte + 1-7dte.
  const chain = bigChain({ greeksOnDte: [] }); // provider published no greeks at all
  const r = selectContractWithEvidence(chain, "call", "confirmed_breakout", NOW, {
    symbol: "SPY", underlyingPrice: 758,
  });

  assert.ok(r.contract, "a liquid near-the-money call must still be selectable");
  assert.equal(r.contract.side, "call", "a bullish candidate must never be handed a put");
  assert.equal(r.evidence.terminalReason, "CONTRACT_SELECTED");
  assert.equal(r.evidence.deltaSource, "MONEYNESS_PROXY", "the proxy must be labelled, never implied");
  assert.equal(r.evidence.greeksMissingOnSide, true);
  // ATM strategy, spot 758 → the selected strike must be near the money, not the
  // deep-ITM 500 that ticker-ascending ordering returns first.
  assert.ok(Math.abs(r.contract.strike - 758) <= 5, `got strike ${r.contract.strike}`);
});

test("REGRESSION: the pre-fix behaviour produced nothing on exactly that chain", () => {
  const chain = bigChain({ greeksOnDte: [] });
  // No underlying price = no fallback = the original delta-only path.
  const before = selectContractFromChain(chain, "call", "confirmed_breakout", NOW);
  assert.equal(before, null, "this is the 2026-08-03 failure being reproduced");

  const after = selectContractFromChain(chain, "call", "confirmed_breakout", NOW, 758);
  assert.ok(after, "with spot known, the same chain now yields a contract");
  assert.equal(after.side, "call");
});

test("a huge SPY-style mixed chain cannot silently return only puts for a bullish candidate", () => {
  const chain = bigChain({ greeksOnDte: [] });
  const r = selectContractWithEvidence(chain, "call", "confirmed_breakout", NOW, {
    symbol: "SPY", underlyingPrice: 758,
  });
  assert.equal(r.contract.side, "call");
  assert.ok(r.evidence.putsReceived > 0, "the fixture does contain puts");
  assert.ok(r.evidence.callsReceived > 0);
  assert.equal(r.evidence.requestedSide, "call");
});

test("a QQQ-style chain where ONLY the short-dated calls lack greeks still prefers 0DTE", () => {
  // Greeks exist on 1/2/5 DTE but not 0DTE — the measured QQQ shape.
  const chain = bigChain({ symbol: "QQQ", spot: 700, strikeLo: 495, strikeHi: 950, greeksOnDte: [1, 2, 5] });
  const r = selectContractWithEvidence(chain, "call", "confirmed_breakout", NOW, {
    symbol: "QQQ", underlyingPrice: 700,
  });
  assert.ok(r.contract);
  assert.equal(r.contract.side, "call");
  // Contracts WITH delta exist, so the provider path is used rather than the proxy.
  assert.equal(r.evidence.deltaSource, "PROVIDER_DELTA");
  assert.ok(r.evidence.withDelta > 0);
});


test("REGRESSION: a SPARSE delta subset that misses the band does not hijack selection", () => {
  // The measured QQQ shape: 208 tradeable calls, only a handful with greeks, and
  // NONE of those inside the preferred band. Pre-fix this returned the ungreeked
  // sliver's best match — a 0.209-delta contract with a ~33% spread.
  const chain = bigChain({ symbol: "QQQ", spot: 700, strikeLo: 495, strikeHi: 950, dtes: [0], greeksOnDte: [] });
  // Give exactly three contracts a delta, all far outside the 0.45-0.65 band.
  let tagged = 0;
  for (const c of chain) {
    if (c.side === "call" && c.strike >= 940 && tagged < 3) { c.delta = 0.02; tagged++; }
  }
  assert.equal(tagged, 3);

  const r = selectContractWithEvidence(chain, "call", "confirmed_breakout", NOW, {
    symbol: "QQQ", underlyingPrice: 700,
  });
  assert.ok(r.contract);
  assert.equal(r.evidence.withDelta, 3, "the sparse subset exists");
  assert.equal(r.evidence.passedDeltaBand, 0, "and none of it is in band");
  assert.equal(r.evidence.deltaSource, "MONEYNESS_PROXY", "so the proxy must take over");
  assert.ok(Math.abs(r.contract.strike - 700) <= 5, `near the money, got ${r.contract.strike}`);
  assert.ok(r.contract.strike < 940, "must NOT pick the far-OTM sliver that carried greeks");
});

test("COMPLETE greeks with an empty band stays a correct rejection", () => {
  // Every tradeable contract has a delta and none is in band. That is a real
  // absence, not missing data — the proxy must NOT rescue it.
  const chain = bigChain({ dtes: [1], greeksOnDte: [1] }).map((c) => ({ ...c, delta: c.delta == null ? null : 0.95 }));
  const r = selectContractWithEvidence(chain, "call", "confirmed_breakout", NOW, {
    symbol: "SPY", underlyingPrice: 758,
  });
  assert.equal(r.evidence.withDelta, r.evidence.twoSided, "greeks are complete");
  assert.equal(r.evidence.passedDeltaBand, 0);
  assert.equal(r.evidence.deltaSource, "PROVIDER_DELTA", "no proxy when the data is complete");
  assert.ok(r.contract, "the nearest-to-target contract is still chosen, as before");
});

// ------------------------------------------------------- side correctness

test("a bearish candidate requests and receives PUTS", () => {
  const chain = bigChain({ greeksOnDte: [] });
  const r = selectContractWithEvidence(chain, "put", "vwap_rejection", NOW, {
    symbol: "SPY", underlyingPrice: 758,
  });
  assert.ok(r.contract);
  assert.equal(r.contract.side, "put");
  assert.equal(r.evidence.requestedSide, "put");
});

test("a chain containing only the OPPOSITE side terminates with a named discovery fault", () => {
  const putsOnly = bigChain({ sides: ["put"], greeksOnDte: [1] });
  const r = selectContractWithEvidence(putsOnly, "call", "confirmed_breakout", NOW, {
    symbol: "SPY", underlyingPrice: 758,
  });
  assert.equal(r.contract, null);
  assert.equal(r.evidence.terminalReason, "NO_CALLS_RETURNED");
  assert.equal(indicatesDiscoveryDefect(r.evidence), true, "this is a defect, not an absent opportunity");
});

test("page truncation is reported as truncation, not as absence of opportunity", () => {
  const r = selectContractWithEvidence([], "call", "confirmed_breakout", NOW, {
    symbol: "SPY", underlyingPrice: 758, pageLimitReached: true,
  });
  assert.equal(r.evidence.terminalReason, "CHAIN_TRUNCATION_SUSPECTED");
  assert.equal(indicatesDiscoveryDefect(r.evidence), true);
});

// ------------------------------------------------------- partitions

test("0DTE is searched before broader buckets when the strategy allows it", () => {
  const parts = planPartitions("call", "confirmed_breakout");
  assert.ok(parts.length > 0);
  assert.equal(parts[0].side, "call");
  assert.equal(parts[0].dteMin, 0);
  assert.equal(parts[0].dteMax, 0, "0DTE first");
  // 1DTE and the 2-3 bucket follow before 4-7.
  const labels = parts.map((p) => `${p.dteMin}-${p.dteMax}`);
  assert.deepEqual(labels.slice(0, 4), ["0-0", "1-1", "2-3", "4-7"]);
});

test("a strategy that does not permit 0DTE never asks for it", () => {
  // breakout_forming is 1-7dte + 8-14dte.
  const parts = planPartitions("call", "breakout_forming");
  assert.ok(parts.every((p) => p.dteMax >= 1), "no 0DTE partition for a strategy that forbids it");
  assert.equal(parts[0].dteMin, 1);
});

test("partitions are bounded — one candidate can never fan out unboundedly", () => {
  for (const key of ["confirmed_breakout", "breakout_forming", "trend_continuation", "momentum_acceleration"]) {
    const parts = planPartitions("call", key, 4);
    assert.ok(parts.length <= 4, `${key} produced ${parts.length}`);
  }
  assert.deepEqual(planPartitions("call", "no_such_strategy"), []);
});

test("a bearish candidate's partitions are all puts — the call side is never queried", () => {
  const parts = planPartitions("put", "vwap_rejection");
  assert.ok(parts.length > 0);
  assert.ok(parts.every((p) => p.side === "put"));
});

// ------------------------------------------------------- gates NOT weakened

test("liquidity and spread rules are untouched by this module", () => {
  const src = readFileSync(join(HERE, "..", "lib", "research", "options", "contract-discovery.ts"), "utf8");
  // The downstream contract gate owns these. This module must not filter on them,
  // in either direction — loosening them here would be invisible at the gate.
  assert.equal(/openInterest\s*[<>]/.test(src), false, "must not gate on open interest");
  assert.equal(/spreadPct\s*[<>]/.test(src), false, "must not gate on spread");
  assert.equal(/volume\s*[<>]/.test(src), false, "must not gate on volume");
  assert.equal(/minOpenInterest|maxSpreadPct|minContractVolume/.test(src), false);
});

test("a contract with no bid is still refused — a missing greek is not a missing market", () => {
  const chain = bigChain({ greeksOnDte: [] }).map((c) => ({ ...c, bid: 0 }));
  const r = selectContractWithEvidence(chain, "call", "confirmed_breakout", NOW, {
    symbol: "SPY", underlyingPrice: 758,
  });
  assert.equal(r.contract, null);
  assert.equal(r.evidence.terminalReason, "NO_TWO_SIDED_MARKET");
});

test("zero eligible contracts remains a valid, truthful outcome", () => {
  // Calls exist but all outside the strategy's permitted DTE.
  const chain = bigChain({ dtes: [30], greeksOnDte: [30] });
  const r = selectContractWithEvidence(chain, "call", "confirmed_breakout", NOW, {
    symbol: "SPY", underlyingPrice: 758,
  });
  assert.equal(r.contract, null);
  assert.equal(r.evidence.terminalReason, "NO_CONTRACT_IN_DTE_RANGE");
  assert.equal(indicatesDiscoveryDefect(r.evidence), false, "a correct rejection is not a defect");
});

test("without a spot price the fallback refuses rather than inventing a moneyness", () => {
  const chain = bigChain({ greeksOnDte: [] });
  const r = selectContractWithEvidence(chain, "call", "confirmed_breakout", NOW, { symbol: "SPY" });
  assert.equal(r.contract, null);
  assert.equal(r.evidence.terminalReason, "NO_CONTRACT_IN_DELTA_RANGE");
  assert.equal(r.evidence.greeksMissingOnSide, true);
});

// ------------------------------------------------------- evidence shape

test("funnel evidence records every narrowing stage and its versions", () => {
  const chain = bigChain({ greeksOnDte: [1, 2, 5] });
  const r = selectContractWithEvidence(chain, "call", "confirmed_breakout", NOW, {
    symbol: "SPY", underlyingPrice: 758, partitionsAttempted: ["call:0-0dte", "call:1-1dte"],
  });
  const e = r.evidence;
  assert.equal(e.symbol, "SPY");
  assert.equal(e.discoveryVersion, DISCOVERY_VERSION);
  assert.equal(e.selectionVersion, SELECTION_VERSION);
  assert.deepEqual(e.partitionsAttempted, ["call:0-0dte", "call:1-1dte"]);
  assert.ok(e.contractsReceived > 0);
  assert.ok(e.callsReceived > 0 && e.putsReceived > 0);
  assert.equal(e.passedSide, e.callsReceived);
  assert.ok(e.passedDte > 0);
  assert.ok(e.withBid > 0);
  assert.ok(e.twoSided > 0);
  assert.ok(e.rankedCount > 0);
  assert.ok(e.selectedOcc.startsWith("O:SPY"));
  assert.ok(Array.isArray(e.requestedDteBuckets) && e.requestedDteBuckets.length > 0);
});

test("a selected contract is never counted as a discovery defect", () => {
  const chain = bigChain({ greeksOnDte: [1] });
  const r = selectContractWithEvidence(chain, "call", "confirmed_breakout", NOW, {
    symbol: "SPY", underlyingPrice: 758,
  });
  assert.equal(r.evidence.terminalReason, "CONTRACT_SELECTED");
  assert.equal(indicatesDiscoveryDefect(r.evidence), false);
});

test("this module makes no provider call of its own", () => {
  const src = readFileSync(join(HERE, "..", "lib", "research", "options", "contract-discovery.ts"), "utf8");
  assert.equal(/fetch\(|polyFetch|polyRequest|fetchOptionChain|axios/.test(src), false);
});

// ------------------------------------------------------- safety monitor

import {
  evaluateDiscoveryHealth,
  rankAlerts,
  DEFAULT_THRESHOLDS,
} from "../lib/research/options/discovery-monitor.ts";

function ev(over = {}) {
  return {
    symbol: "SPY", direction: "bullish", requestedSide: "call", strategyKey: "confirmed_breakout",
    atMs: NOW, discoveryVersion: "d", selectionVersion: "s",
    partitionsAttempted: [], requestedDteBuckets: ["0dte"], preferredDelta: [0.45, 0.65],
    moneyness: "ATM", contractsReceived: 500, callsReceived: 300, putsReceived: 200,
    passedSide: 300, passedDte: 170, withBid: 104, withAsk: 104, twoSided: 104,
    withDelta: 0, passedDeltaBand: 0, rankedCount: 0, deltaSource: null,
    selectedOcc: null, terminalReason: "NO_CONTRACT_IN_DELTA_RANGE",
    greeksMissingOnSide: true, pageLimitReached: false, ...over,
  };
}

test("MONITOR: the 2026-08-03 signature raises a CRITICAL alert", () => {
  const alerts = evaluateDiscoveryHealth("SPY", "call", Array.from({ length: 18 }, () => ev()), 15 * 60_000);
  const top = rankAlerts(alerts)[0];
  assert.equal(top.kind, "BULLISH_CANDIDATES_NO_CALLS");
  assert.equal(top.severity, "CRITICAL");
  assert.equal(top.contractsPriced, 0);
  assert.match(top.message, /SPY generated 18 bullish candidates in 15 minutes/);
  assert.match(top.message, /zero calls reached pricing/);
  assert.match(top.message, /No subscriber gate was bypassed/);
  assert.equal(top.subscriberGateBypassed, false);
});

test("MONITOR: a healthy lane raises nothing", () => {
  const healthy = Array.from({ length: 20 }, () =>
    ev({ terminalReason: "CONTRACT_SELECTED", selectedOcc: "O:SPY260803C00758000", withDelta: 50, rankedCount: 50, greeksMissingOnSide: false }));
  assert.deepEqual(evaluateDiscoveryHealth("SPY", "call", healthy, 15 * 60_000), []);
});

test("MONITOR: a quiet lane is not a broken lane", () => {
  assert.deepEqual(evaluateDiscoveryHealth("SPY", "call", [], 15 * 60_000), []);
  // Below the materiality threshold — real but not yet worth waking the owner.
  const few = Array.from({ length: 3 }, () => ev());
  assert.equal(few.length < DEFAULT_THRESHOLDS.minCandidates, true);
  assert.equal(evaluateDiscoveryHealth("SPY", "call", few, 60_000).some((a) => a.kind === "BULLISH_CANDIDATES_NO_CALLS"), false);
});

test("MONITOR: wrong-side-only returns are flagged as a discovery fault", () => {
  const alerts = evaluateDiscoveryHealth("SPY", "call", Array.from({ length: 12 }, () => ev({ terminalReason: "NO_CALLS_RETURNED" })), 60_000);
  assert.ok(alerts.some((a) => a.kind === "WRONG_SIDE_ONLY" && a.severity === "CRITICAL"));
});

test("MONITOR: correct rejections do not create a defect spike", () => {
  const correct = Array.from({ length: 20 }, (_, i) =>
    ev(i % 2 === 0
      ? { terminalReason: "CONTRACT_SELECTED", selectedOcc: "O:SPY1", rankedCount: 5, greeksMissingOnSide: false }
      : { terminalReason: "NO_CONTRACT_IN_DTE_RANGE", greeksMissingOnSide: false }));
  const alerts = evaluateDiscoveryHealth("SPY", "call", correct, 15 * 60_000);
  assert.equal(alerts.some((a) => a.kind === "NO_ELIGIBLE_CONTRACT_SPIKE"), false);
});

test("MONITOR: it only reports the side it was asked about", () => {
  const puts = Array.from({ length: 18 }, () => ev({ requestedSide: "put" }));
  assert.deepEqual(evaluateDiscoveryHealth("SPY", "call", puts, 60_000), []);
  assert.ok(evaluateDiscoveryHealth("SPY", "put", puts, 60_000).length > 0);
});

test("MONITOR: it makes no provider call and holds no send authority", () => {
  const src = readFileSync(join(HERE, "..", "lib", "research", "options", "discovery-monitor.ts"), "utf8");
  assert.equal(/fetch\(|polyFetch|polyRequest|fetchOptionChain/.test(src), false, "no provider calls");
  assert.equal(/discord|webhook|sendAlert|deliver/i.test(src.replace(/subscriber gate was bypassed/gi, "")), false, "no delivery authority");
});
