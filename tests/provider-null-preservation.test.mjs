/**
 * Unavailable market data must stay unavailable.
 *
 * `lib/polygon-provider.js` normalized two fields with `?? 0`:
 *
 *     volume:       numOrNull(day.volume) ?? 0
 *     openInterest: numOrNull(r.open_interest) ?? 0
 *
 * That converts "Polygon did not report this" into "we measured zero". The two
 * claims are opposites — an absence of evidence versus evidence of total
 * illiquidity — and every downstream consumer (liquidity gates, alert score,
 * the owner-facing OI display) received the fabricated one with no way to tell.
 *
 * A real reported zero must still read as zero. That distinction is the whole
 * point, so both directions are asserted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseOptionsSnapshot } from "../lib/polygon-provider.js";
import { selectContract, PROFILES } from "../lib/contract-selector.ts";

const NOW = Date.parse("2026-08-05T18:00:00.000Z");

function snapshot(over = {}) {
  return {
    results: [{
      details: { ticker: "O:AAPL260807C00230000", contract_type: "call", strike_price: 230, expiration_date: "2026-08-07" },
      last_quote: { bid: 1.0, ask: 1.1, midpoint: 1.05, last_updated: 1785000000000000000 },
      day: { close: 1.05, volume: 500 },
      greeks: { delta: 0.5, gamma: 0.01, theta: -0.2, vega: 0.1 },
      implied_volatility: 0.31,
      open_interest: 1200,
      underlying_asset: { price: 229.5 },
      ...over,
    }],
  };
}

test("a MISSING open interest stays null — it never becomes a measured zero", () => {
  const raw = snapshot();
  delete raw.results[0].open_interest;
  const [c] = parseOptionsSnapshot(raw, NOW);
  assert.equal(c.openInterest, null, "absent open interest is null, not 0");
});

test("a REPORTED zero open interest is preserved as zero", () => {
  const [c] = parseOptionsSnapshot(snapshot({ open_interest: 0 }), NOW);
  assert.equal(c.openInterest, 0, "a genuine zero must survive too");
});

test("a MISSING option volume stays null", () => {
  const raw = snapshot();
  delete raw.results[0].day.volume;
  const [c] = parseOptionsSnapshot(raw, NOW);
  assert.equal(c.volume, null);
});

test("a REPORTED zero volume is preserved as zero", () => {
  const [c] = parseOptionsSnapshot(snapshot({ day: { close: 1.05, volume: 0 } }), NOW);
  assert.equal(c.volume, 0);
});

test("a non-numeric open interest is null, not zero", () => {
  const [c] = parseOptionsSnapshot(snapshot({ open_interest: "n/a" }), NOW);
  assert.equal(c.openInterest, null);
});

/**
 * Drive the REAL selection path rather than a private helper, so the assertion
 * covers what production actually runs. A profile with a liquidity floor plus
 * one otherwise-perfect contract isolates the gate under test.
 */
function selectWith(contract, profileOver = {}) {
  const profile = { ...PROFILES.zero_dte, maxChainAgeMode: null, ...profileOver };
  return selectContract({
    underlying: "AAPL",
    spot: 229.5,
    side: "call",
    contracts: [{
      optionSymbol: "O:AAPL260807C00230000", side: "call", strike: 230,
      expiration: "2026-08-07", dte: 2, bid: 1.0, ask: 1.02, mid: 1.01,
      last: 1.01, spreadPct: 2, delta: 0.5, gamma: 0.01, iv: 0.31,
      providerTimestamp: NOW - 1000, volume: 800, openInterest: 5000,
      ...contract,
    }],
    session: "REGULAR",
    chainAvailable: true,
    chainAsOfMs: NOW - 1000,
    nowMs: NOW,
  }, profile);
}

test("unavailable open interest cannot pass a liquidity gate", () => {
  const res = selectWith({ openInterest: null }, { minOpenInterest: 500 });
  assert.equal(res.ok, false, "the gate must refuse an unavailable figure, not wave it through");
  assert.equal(res.rejectionCode, "NO_LIQUID_CONTRACT");
  const oi = res.gateFailures.find((f) => f.gate === "open_interest");
  assert.ok(oi, "the open_interest gate is named");
  assert.match(oi.msg, /unavailable/i, "and must say unavailable, not report a zero it never measured");
  assert.doesNotMatch(oi.msg, /open interest 0 </, "it must not print a fabricated 0");
});

test("a real zero open interest fails the gate as a measurement", () => {
  const res = selectWith({ openInterest: 0 }, { minOpenInterest: 500 });
  assert.equal(res.ok, false);
  const oi = res.gateFailures.find((f) => f.gate === "open_interest");
  assert.match(oi.msg, /open interest 0 < 500/, "a measured zero is reported as a measurement");
});

test("unavailable option volume cannot pass its gate either", () => {
  const res = selectWith({ volume: null }, { minVolume: 100, minOpenInterest: 0 });
  assert.equal(res.ok, false);
  const vol = res.gateFailures.find((f) => f.gate === "volume");
  assert.match(vol.msg, /volume unavailable/i);
});

test("an available, sufficient open interest still selects normally", () => {
  const res = selectWith({ openInterest: 5000 }, { minOpenInterest: 500 });
  assert.equal(res.ok, true, "the change must not block healthy contracts");
  assert.equal(res.marketData.openInterest, 5000);
});

test("marketData carries absence through instead of re-coercing it to 0", () => {
  const res = selectWith({ openInterest: null, volume: null }, { minOpenInterest: 0, minVolume: 0 });
  assert.equal(res.ok, true);
  assert.equal(res.marketData.openInterest, null, "`?? 0` here would recreate the defect one layer down");
  assert.equal(res.marketData.volume, null);
});

test("greeks and IV absence is already preserved and stays that way", () => {
  const raw = snapshot();
  delete raw.results[0].implied_volatility;
  raw.results[0].greeks = {};
  const [c] = parseOptionsSnapshot(raw, NOW);
  assert.equal(c.iv, null);
  assert.equal(c.delta, null);
  assert.equal(c.gamma, null, "gamma is mapped and its absence preserved");
});
