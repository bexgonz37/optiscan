import test from "node:test";
import assert from "node:assert/strict";
import {
  selectContract,
  PROFILES,
  rankZeroDte,
  entryGate,
  nearTheMoney,
  pickSwing,
} from "../lib/contract-selector.ts";

const NOW = Date.parse("2026-07-10T18:00:00.000Z");
const fresh = NOW - 5_000; // 5s old provider timestamp

/** A tradable 0DTE call near the money. */
const goodCall = (over = {}) => ({
  optionSymbol: "O:SPY_C500", side: "call", strike: 500, expiration: "2026-07-10", dte: 0,
  bid: 1.18, ask: 1.22, mid: 1.2, spreadPct: 3, delta: 0.5, iv: 0.9, openInterest: 1200, volume: 5000,
  providerTimestamp: fresh, underlyingPrice: 500, ...over,
});

function input(over = {}) {
  return {
    underlying: "SPY", spot: 500, side: "call",
    contracts: [goodCall()],
    session: "regular", chainAvailable: true, chainAsOfMs: fresh,
    minsToClose: 200, expRemainPct: 2, nowMs: NOW, ...over,
  };
}

// ── deterministic tie-breaking ──────────────────────────────────────────────

test("selection is deterministic: identical input → identical contract, stable optionSymbol tiebreak", () => {
  const a = { ...goodCall({ optionSymbol: "O:AAA", strike: 500 }) };
  const b = { ...goodCall({ optionSymbol: "O:BBB", strike: 500 }) };
  // identical score + distance → tiebreak by optionSymbol (AAA before BBB)
  const r1 = rankZeroDte([b, a], "call", { minsToClose: 200, expRemainPct: 2, underlying: 500 });
  const r2 = rankZeroDte([a, b], "call", { minsToClose: 200, expRemainPct: 2, underlying: 500 });
  assert.equal(r1[0].contract.optionSymbol, "O:AAA");
  assert.equal(r2[0].contract.optionSymbol, "O:AAA");
});

// ── happy path ──────────────────────────────────────────────────────────────

test("zero_dte_momentum selects a tradable call and marks it actionable", () => {
  const res = selectContract(input(), "zero_dte_momentum");
  assert.equal(res.ok, true);
  assert.equal(res.contract.optionSymbol, "O:SPY_C500");
  assert.equal(res.actionable, true);
  assert.equal(res.researchOnly, false);
  assert.ok(res.marketData.contractAsOfMs === fresh);
  assert.ok(res.score > 0);
});

// ── liquidity / spread / delta protections; no silent illiquid fallback ─────

test("zero_dte: a chain of only wide-spread contracts is rejected, never silently picked", () => {
  const wide = goodCall({ optionSymbol: "O:WIDE", spreadPct: 22 });
  const res = selectContract(input({ contracts: [wide] }), "zero_dte_momentum");
  assert.equal(res.ok, false);
  assert.equal(res.rejectionCode, "SPREAD_TOO_WIDE");
  assert.ok(res.blockedByGate.spread >= 1);
  assert.ok(/blocked by/.test(res.reason));
});

test("zero_dte: lotto/deep delta outside band is rejected with NO_DELTA_ZONE", () => {
  const lotto = goodCall({ optionSymbol: "O:LOTTO", delta: 0.08, spreadPct: 3 });
  const res = selectContract(input({ contracts: [lotto] }), "zero_dte_momentum");
  assert.equal(res.ok, false);
  assert.equal(res.rejectionCode, "NO_DELTA_ZONE");
});

test("swing_position enforces OI≥250, spread≤8, delta 0.40-0.70, DTE 7-35", () => {
  const base = { optionSymbol: "O:SW", side: "call", strike: 500, dte: 24, mid: 3, spreadPct: 5, delta: 0.55, openInterest: 1200, volume: 100, providerTimestamp: fresh };
  const inp = (over) => input({ side: "call", contracts: [{ ...base, ...over }] });
  assert.equal(selectContract(inp({}), "swing_position").ok, true);
  assert.equal(selectContract(inp({ openInterest: 100 }), "swing_position").ok, false);
  assert.equal(selectContract(inp({ spreadPct: 9 }), "swing_position").ok, false);
  assert.equal(selectContract(inp({ delta: 0.2 }), "swing_position").ok, false);
  assert.equal(selectContract(inp({ dte: 3 }), "swing_position").ok, false);
});

// ── no fabricated data ──────────────────────────────────────────────────────

test("missing greeks/mid are never fabricated — contract excluded / rejected", () => {
  const noMid = goodCall({ optionSymbol: "O:NOMID", mid: null, bid: null, ask: null });
  const res = selectContract(input({ contracts: [noMid] }), "zero_dte_momentum");
  assert.equal(res.ok, false); // no invented mid
});

// ── session + staleness (chain AND per-contract) ────────────────────────────

test("stale chain is rejected with CHAIN_STALE using session-aware max age", () => {
  const staleMs = NOW - 10 * 60_000; // 10 minutes old
  const res = selectContract(input({ chainAsOfMs: staleMs, contracts: [goodCall({ providerTimestamp: staleMs })] }), "zero_dte_momentum");
  assert.equal(res.ok, false);
  assert.equal(res.rejectionCode, "CHAIN_STALE");
});

test("a fresh chain does NOT rescue an individually stale contract (req 14)", () => {
  // chain timestamp fresh, but the selected contract's own quote is very old
  const staleContract = goodCall({ optionSymbol: "O:STALE", providerTimestamp: NOW - 10 * 60_000 });
  const res = selectContract(input({ chainAsOfMs: fresh, contracts: [staleContract] }), "zero_dte_momentum");
  assert.equal(res.ok, false);
  assert.equal(res.rejectionCode, "STALE_CONTRACT");
  assert.ok(res.blockedByGate.stale_contract >= 1);
});

test("unavailable chain and empty chain are explicit rejections", () => {
  assert.equal(selectContract(input({ chainAvailable: false }), "zero_dte_momentum").rejectionCode, "CHAIN_UNAVAILABLE");
  assert.equal(selectContract(input({ contracts: [] }), "zero_dte_momentum").rejectionCode, "NO_CONTRACTS");
});

test("zero_dte outside RTH selects for research but is not actionable", () => {
  const res = selectContract(input({ session: "afterhours", chainAsOfMs: NOW - 5000 }), "zero_dte_momentum");
  // after-hours max age is larger, contract still fresh → selects, but session gate blocks actionable
  assert.equal(res.ok, true);
  assert.equal(res.actionable, false);
  assert.equal(res.researchOnly, true);
  assert.ok(res.notes.some((n) => /session/i.test(n)));
});

// ── BEARISH: selector may pick a put for research but NEVER marks it actionable ─

test("put contracts are selected for research/scoring but never actionable (bearish gate is downstream authority)", () => {
  const put = goodCall({ optionSymbol: "O:SPY_P500", side: "put", delta: -0.5 });
  const res = selectContract(input({ side: "put", contracts: [put] }), "zero_dte_momentum");
  assert.equal(res.ok, true);            // identified for research
  assert.ok(res.score >= 0);             // scored
  assert.equal(res.actionable, false);   // NEVER actionable from the selector
  assert.equal(res.researchOnly, true);
  assert.ok(res.notes.some((n) => /bearish/i.test(n)));
});

// ── near_money_context: research widening, but non-actionable when gates fail ─

test("near_money_context surfaces a nearest-strike research contract but marks it non-actionable when spread is wide", () => {
  const wideNear = goodCall({ optionSymbol: "O:NEAR", strike: 500, spreadPct: 12, delta: 0.5 });
  const res = selectContract(input({ contracts: [wideNear] }), "near_money_context");
  assert.equal(res.ok, true);           // research contract surfaced
  assert.equal(res.contract.optionSymbol, "O:NEAR");
  assert.equal(res.actionable, false);  // wide spread → not actionable
  assert.equal(res.researchOnly, true);
});

test("near_money_context does NOT widen the spread/liquidity gate — a tight near-money contract stays actionable", () => {
  const res = selectContract(input({ contracts: [goodCall({ optionSymbol: "O:TIGHT" })] }), "near_money_context");
  assert.equal(res.ok, true);
  assert.equal(res.actionable, true);
});

// ── multi-gate rejection reporting (req 13) ─────────────────────────────────

test("multiple failing gates → primary code + all gate counts + human reason", () => {
  const bad = goodCall({ optionSymbol: "O:BAD", spreadPct: 30, delta: 0.05 });
  const res = selectContract(input({ contracts: [bad] }), "zero_dte_momentum");
  assert.equal(res.ok, false);
  assert.ok(Object.keys(res.blockedByGate).length >= 2, JSON.stringify(res.blockedByGate));
  assert.ok(typeof res.reason === "string" && res.reason.length > 0);
  assert.ok(["SPREAD_TOO_WIDE", "NO_DELTA_ZONE"].includes(res.rejectionCode));
});

// ── canonical low-level helpers still behave (consolidation sanity) ─────────

test("entryGate / nearTheMoney / pickSwing canonical helpers are exported and pure", () => {
  assert.equal(entryGate({ mid: 1.2, spreadPct: 3, delta: 0.5 }, { underlying: 100, expRemainPct: 1.5 }).ok, true);
  assert.equal(entryGate({ mid: 1.2, spreadPct: 9.2, delta: 0.5 }, { underlying: 100, expRemainPct: 2 }).ok, false);
  const pair = nearTheMoney([goodCall({ strike: 500 })], 500.2);
  assert.equal(pair.call.strike, 500);
  assert.equal(pickSwing([{ optionSymbol: "S", side: "call", dte: 24, spreadPct: 5, openInterest: 900, delta: 0.55, mid: 3 }], "call").optionSymbol, "S");
});

test("every built-in profile is well-formed", () => {
  for (const name of Object.keys(PROFILES)) {
    const p = PROFILES[name];
    assert.equal(p.name, name);
    assert.ok(p.deltaMin < p.deltaMax);
    assert.ok(p.maxSpreadPct > 0);
    assert.ok(["zero_dte", "swing", "near_money"].includes(p.mode));
  }
});
