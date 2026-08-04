/**
 * tests/chain-outcome-classification.test.mjs — an empty option chain is five
 * different facts, and contract discovery used to guess one of them.
 *
 * `selectContractWithEvidence` assigned `PROVIDER_ERROR` on `chain.length === 0`
 * alone. Measured in production on 2026-08-04, that bucket was 1,699 of 3,206
 * contract-discovery rows — 53% of the entire funnel — and it silently contained
 * all of:
 *
 *   - a successful provider response with genuinely nothing in the range
 *   - OUR OWN admission control refusing the request for budget
 *   - a missing POLYGON_API_KEY, which is not a market-data result at all
 *   - a request that timed out
 *   - an actual provider failure, the only one the name ever described
 *
 * Every one of those needs a different fix, and the single label sent every
 * investigation to the provider. These tests pin each outcome to its own reason.
 *
 * The truncation case is separate and was the more damaging of the two defects:
 * see `chain-truncation` below.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { selectContractWithEvidence } from "../lib/research/options/contract-discovery.ts";
import { chainOk } from "../lib/research/options/loop.ts";

const STRATEGY = "momentum_acceleration"; // preferredDte includes "0dte"
const NOW = Date.parse("2026-08-04T16:24:00Z");

/** A chain outcome carrying no contracts, with a given code. */
const emptyWith = (outcome, extra = {}) => ({
  contracts: [], outcome, truncated: false, expirationsCovered: [],
  requestedDteMin: 0, requestedDteMax: 14, pagesRequested: 2, pagesReceived: 1,
  ...extra,
});

const reasonFor = (chainOutcome) =>
  selectContractWithEvidence([], "call", STRATEGY, NOW, { symbol: "SPY", chainOutcome })
    .evidence.terminalReason;

test("a SUCCESSFUL but empty provider response is not a provider error", () => {
  assert.equal(reasonFor(emptyWith("NO_CONTRACTS_IN_REQUESTED_RANGE")), "NO_CONTRACTS_RETURNED");
  // The provider answered. Nothing failed. Calling this an error is what made a
  // quiet expiration look like an outage.
  assert.notEqual(reasonFor(emptyWith("NO_CONTRACTS_IN_REQUESTED_RANGE")), "PROVIDER_ERROR");
});

test("a QUOTA refusal is ours, and never reads as a provider error", () => {
  assert.equal(reasonFor(emptyWith("PROVIDER_QUOTA_EXCEEDED")), "PROVIDER_QUOTA_EXCEEDED");
  assert.notEqual(reasonFor(emptyWith("PROVIDER_QUOTA_EXCEEDED")), "PROVIDER_ERROR");
});

test("a MISSING API key has its own result and is not a market-data fact", () => {
  assert.equal(
    reasonFor(emptyWith("PROVIDER_CONFIGURATION_MISSING")),
    "PROVIDER_CONFIGURATION_MISSING",
  );
  assert.notEqual(reasonFor(emptyWith("PROVIDER_CONFIGURATION_MISSING")), "PROVIDER_ERROR");
});

test("a TIMEOUT is distinguishable from a failure and from an empty market", () => {
  assert.equal(reasonFor(emptyWith("PROVIDER_TIMEOUT")), "PROVIDER_TIMEOUT");
});

test("an ACTUAL provider failure still reports PROVIDER_ERROR", () => {
  // The fix must not empty the bucket of the one thing it correctly described.
  assert.equal(reasonFor(emptyWith("PROVIDER_FAILURE")), "PROVIDER_ERROR");
  assert.equal(reasonFor(emptyWith("PROVIDER_INVALID_RESPONSE")), "PROVIDER_ERROR");
});

test("a caller that reports NO outcome keeps the old behaviour rather than inventing one", () => {
  // Guessing a specific reason for a caller that supplied no evidence would be
  // the same defect in a new place. Absence of evidence stays PROVIDER_ERROR.
  const ev = selectContractWithEvidence([], "call", STRATEGY, NOW, { symbol: "SPY" }).evidence;
  assert.equal(ev.terminalReason, "PROVIDER_ERROR");
});

test("chain-truncation: our own page limit is never reported as an empty market", () => {
  /**
   * THE DOMINANT DEFECT, measured live on 2026-08-04 during RTH.
   *
   * Polygon pages snapshots in option-ticker order and an OCC sorts by
   * expiration, so a dense underlying exhausts the page budget inside its
   * nearest expirations. SPY and QQQ returned 500 contracts across 2 pages and
   * every single one expired that day or the next — the 0-14 DTE window was
   * requested and never sampled past day one.
   *
   * Contract discovery then reported NO_CONTRACT_IN_DTE_RANGE, which asserts the
   * market had nothing. It had plenty; we stopped reading. 51 of 52 SPY rows
   * carried that reason.
   */
  const truncated = {
    ...emptyWith("CHAIN_TRUNCATED_BEFORE_RANGE", { truncated: true }),
    expirationsCovered: ["2026-08-04", "2026-08-05"],
  };

  // Case 1: nothing came back at all.
  assert.equal(reasonFor(truncated), "CHAIN_TRUNCATION_SUSPECTED");

  // Case 2 — the real production shape: contracts DID come back, on the right
  // side, but every one of them sits in the front expirations, so a strategy
  // asking for a longer band finds nothing. This must blame the truncation, not
  // the market.
  const frontOnly = [
    { optionSymbol: "O:SPY260804C00770000", side: "call", strike: 770, expiration: "2026-08-04", dte: 0, bid: 1.2, ask: 1.3, spreadPct: 8, volume: 100, openInterest: 500, iv: 0.2, delta: 0.5, providerTimestamp: NOW },
  ];
  const ev = selectContractWithEvidence(frontOnly, "call", "short_dated_directional", NOW, {
    symbol: "SPY", underlyingPrice: 769, chainOutcome: truncated,
  }).evidence;

  assert.equal(ev.contractsReceived, 1, "the chain was not empty");
  assert.equal(ev.passedSide, 1, "the call side was populated");
  assert.equal(ev.passedDte, 0, "nothing reached the strategy's 8-14dte band");
  assert.equal(
    ev.terminalReason, "CHAIN_TRUNCATION_SUSPECTED",
    "a band emptied by OUR page budget must not be reported as NO_CONTRACT_IN_DTE_RANGE",
  );
});

test("a COMPLETE chain with nothing in the band still reports NO_CONTRACT_IN_DTE_RANGE", () => {
  // The truncation fix must not swallow the genuine case. When the fetch saw the
  // whole window and the band is still empty, that IS a fact about the market.
  const complete = chainOk([
    { optionSymbol: "O:NVDA260805C00210000", side: "call", strike: 210, expiration: "2026-08-05", dte: 1, bid: 1.2, ask: 1.3, spreadPct: 8, volume: 100, openInterest: 500, iv: 0.4, delta: 0.5, providerTimestamp: NOW },
  ]);
  assert.equal(complete.truncated, false);
  const ev = selectContractWithEvidence(complete.contracts, "call", "short_dated_directional", NOW, {
    symbol: "NVDA", underlyingPrice: 210, chainOutcome: complete,
  }).evidence;
  assert.equal(ev.passedDte, 0);
  assert.equal(ev.terminalReason, "NO_CONTRACT_IN_DTE_RANGE");
});
