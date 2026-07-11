import test from "node:test";
import assert from "node:assert/strict";
import { revalidateContract } from "../lib/paper-revalidation.ts";

const NOW = Date.parse("2026-07-10T18:00:00.000Z");
const fresh = NOW - 5_000;

/** A tradable swing call (7–35 DTE, OI≥250, 0.40–0.70Δ, spread≤8%). */
const goodContract = (over = {}) => ({
  optionSymbol: "O:AAPL_C210", side: "call", strike: 210, expiration: "2026-08-07", dte: 28,
  bid: 3.1, ask: 3.2, mid: 3.15, spreadPct: 3.1, delta: 0.55, iv: 0.3, openInterest: 4000, volume: 1200,
  providerTimestamp: fresh, underlyingPrice: 211, ...over,
});

const alertContract = (over = {}) => ({
  optionSymbol: "O:AAPL_C210", side: "call", strike: 210, expiration: "2026-08-07", dte: 28,
  mid: 3.0, spreadPct: 2.5, delta: 0.54, ...over,
});

function input(over = {}) {
  return {
    underlying: "AAPL",
    alertContract: alertContract(),
    freshContracts: [goodContract()],
    chainAvailable: true,
    chainAsOfMs: fresh,
    session: "regular",
    spot: 211,
    profile: "swing_position",
    nowMs: NOW,
    ...over,
  };
}

// ── 1. fresh contract passes ──────────────────────────────────────────────────

test("1. a fresh, still-qualifying contract passes revalidation", () => {
  const r = revalidateContract(input());
  assert.equal(r.ok, true);
  assert.equal(r.revalidatedContract.optionSymbol, "O:AAPL_C210");
  assert.equal(r.actionable, true);
  assert.ok(r.drift, "drift computed");
});

// ── 2. stale chain rejects ────────────────────────────────────────────────────

test("2. a stale chain rejects entry (reused selector freshness gate)", () => {
  const r = revalidateContract(input({ chainAsOfMs: NOW - 60 * 60_000 }));
  assert.equal(r.ok, false);
  assert.equal(r.rejectionCode, "CHAIN_STALE");
  assert.equal(r.revalidatedContract, null);
});

// ── 3. fresh chain, individually stale contract rejects ──────────────────────

test("3. a fresh chain with a stale individual contract rejects", () => {
  const stale = goodContract({ providerTimestamp: NOW - 60 * 60_000 });
  const r = revalidateContract(input({ freshContracts: [stale] }));
  assert.equal(r.ok, false);
  assert.equal(r.rejectionCode, "STALE_CONTRACT");
});

// ── 4. contract disappeared ──────────────────────────────────────────────────

test("4. contract vanished from the chain → rejected, no substitution", () => {
  const other = goodContract({ optionSymbol: "O:AAPL_C215", strike: 215 });
  const r = revalidateContract(input({ freshContracts: [other] }));
  assert.equal(r.ok, false);
  assert.equal(r.rejectionCode, "CONTRACT_DISAPPEARED");
  assert.equal(r.revalidatedContract, null, "never selects a different contract");
});

// A 0DTE base (zero_dte_momentum soft-includes marginal contracts so granular
// gate codes surface; swing hard-filters → NO_SIDE_CONTRACTS by design).
const zdteContract = (over = {}) => ({
  optionSymbol: "O:SPY_C500", side: "call", strike: 500, expiration: "2026-07-10", dte: 0,
  bid: 1.18, ask: 1.22, mid: 1.2, spreadPct: 3, delta: 0.5, iv: 0.9, openInterest: 1200, volume: 5000,
  providerTimestamp: fresh, underlyingPrice: 500, ...over,
});
const zdteInput = (over = {}) => input({
  underlying: "SPY",
  alertContract: { optionSymbol: "O:SPY_C500", side: "call", strike: 500, expiration: "2026-07-10", dte: 0, mid: 1.1, spreadPct: 2.5, delta: 0.5 },
  freshContracts: [zdteContract()],
  spot: 500,
  profile: "zero_dte_momentum",
  ...over,
});

// ── 5. spread widened past the limit (granular code via 0DTE profile) ────────

test("5. spread widened beyond the profile limit rejects (SPREAD_TOO_WIDE)", () => {
  const wide = zdteContract({ spreadPct: 12, bid: 1.0, ask: 1.35 });
  const r = revalidateContract(zdteInput({ freshContracts: [wide] }));
  assert.equal(r.ok, false);
  assert.equal(r.rejectionCode, "SPREAD_TOO_WIDE");
  assert.ok(r.drift.spreadWidened, "drift reports the widening");
});

// ── 6. liquidity dropped (swing hard-filter → rejected, reason clarified) ─────

test("6. liquidity dropped below the swing minimum rejects, no substitution", () => {
  const thin = goodContract({ openInterest: 10 });
  const r = revalidateContract(input({ freshContracts: [thin] }));
  assert.equal(r.ok, false);
  assert.equal(r.revalidatedContract, null);
  assert.match(r.reason, /no longer meets the swing_position requirements/);
});

// ── 7. no longer matches the strategy profile (DTE window) ────────────────────

test("7. contract drifted out of the 0DTE window rejects (DTE_OUT_OF_WINDOW)", () => {
  const nearDte = zdteContract({ dte: 3 }); // zero_dte wants 0–1
  const r = revalidateContract(zdteInput({ freshContracts: [nearDte] }));
  assert.equal(r.ok, false);
  assert.equal(r.rejectionCode, "DTE_OUT_OF_WINDOW");
});

// ── 8. no silent substitution (even when a better contract exists) ───────────

test("8. a better sibling contract is NEVER substituted for a failing one", () => {
  const failing = goodContract({ spreadPct: 20, bid: 2.5, ask: 3.9 });
  const better = goodContract({ optionSymbol: "O:AAPL_C212", strike: 212, spreadPct: 2 });
  const r = revalidateContract(input({ freshContracts: [failing, better] }));
  assert.equal(r.ok, false, "the alert-time contract fails, so entry fails");
  assert.equal(r.revalidatedContract, null, "the better sibling is not selected");
});

// ── identity mismatch ────────────────────────────────────────────────────────

test("identity mismatch (strike changed under the same symbol) rejects", () => {
  const mismatched = goodContract({ strike: 215 });
  const r = revalidateContract(input({ freshContracts: [mismatched] }));
  assert.equal(r.ok, false);
  assert.equal(r.rejectionCode, "IDENTITY_MISMATCH");
});

// ── bearish safety: a put is never actionable through revalidation ───────────

test("a put revalidates for research but is never marked actionable", () => {
  const put = goodContract({ optionSymbol: "O:AAPL_P205", side: "put", strike: 205, delta: -0.5 });
  const r = revalidateContract(input({
    alertContract: { optionSymbol: "O:AAPL_P205", side: "put", strike: 205, expiration: "2026-08-07", dte: 28 },
    freshContracts: [put],
    spot: 206,
  }));
  assert.equal(r.actionable, false, "puts never actionable (bearish gate policy)");
});

// ── options session gate (unactionable session) ──────────────────────────────

test("preserves the alert-time contract on every rejection", () => {
  const r = revalidateContract(input({ chainAvailable: false }));
  assert.equal(r.ok, false);
  assert.equal(r.alertTimeContract.optionSymbol, "O:AAPL_C210", "alert-time contract preserved for audit");
});
