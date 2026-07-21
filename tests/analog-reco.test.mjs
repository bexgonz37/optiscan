import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { selectContract, defaultContractGates } from "../lib/research/reco/contract.ts";
import { buildCard } from "../lib/research/reco/card.ts";
import { buildRecommendation, persistRecommendationOnDb } from "../lib/research/reco/recommend.ts";

const NOW = 1_000_000;
function contract(over = {}) {
  return { optionSymbol: "O:NVDA260815C00135000", side: "call", strike: 135, expiration: "2026-08-15", dte: 30, bid: 4.1, ask: 4.3, mid: 4.2, spreadPct: 4.7, delta: 0.5, iv: 0.5, volume: 500, openInterest: 1200, ...over };
}
function chain(contracts, over = {}) { return { symbol: "NVDA", underlyingPrice: 134, asOfMs: NOW, available: true, contracts, ...over }; }
const explainOk = { abstain: false, reason: null, p: 0.61, nAnalogs: 41, effectiveSample: 33, winRate: 0.58, expectancy: 0.12, dispersion: 0.4, contradiction: 0.42, p10: -0.48, p50: 0.34, p90: 0.96, nearest: [], nearestWin: { id: "w", distance: 0.2, win: true, outcome: 0.61 }, nearestLoss: { id: "l", distance: 0.3, win: false, outcome: -0.44 } };
const sel = (over = {}) => selectContract({ chain: chain([contract()]), side: "call", holdingDays: 20, nowMs: NOW, env: {}, ...over });

// ── contract selection + gates ───────────────────────────────────────────────
test("selects a bracketing-expiry, delta-band contract that clears the gates", () => {
  const r = sel();
  assert.equal(r.ok, true);
  assert.equal(r.contract.optionSymbol, "O:NVDA260815C00135000");
  assert.equal(r.productionEligible, true);
});

test("MISSING chain → abstain (no fabricated contract)", () => {
  const r = selectContract({ chain: chain([], { available: false }), side: "call", holdingDays: 20, nowMs: NOW, env: {} });
  assert.equal(r.ok, false); assert.equal(r.rejectedGate, "chain_unavailable");
});

test("STALE chain → abstain", () => {
  const r = selectContract({ chain: chain([contract()], { asOfMs: NOW - 60_000 }), side: "call", holdingDays: 20, nowMs: NOW, env: {} });
  assert.equal(r.ok, false); assert.equal(r.rejectedGate, "chain_stale");
});

test("WIDE SPREAD → reject", () => {
  const r = selectContract({ chain: chain([contract({ spreadPct: 22 })]), side: "call", holdingDays: 20, nowMs: NOW, env: {} });
  assert.equal(r.ok, false); assert.equal(r.rejectedGate, "spread");
});

test("LOW OPEN INTEREST → reject", () => {
  const r = selectContract({ chain: chain([contract({ openInterest: 10 })]), side: "call", holdingDays: 20, nowMs: NOW, env: {} });
  assert.equal(r.ok, false); assert.equal(r.rejectedGate, "open_interest");
});

test("LOW VOLUME → reject", () => {
  const r = selectContract({ chain: chain([contract({ volume: 3 })]), side: "call", holdingDays: 20, nowMs: NOW, env: {} });
  assert.equal(r.ok, false); assert.equal(r.rejectedGate, "volume");
});

test("NO TWO-SIDED QUOTE → reject", () => {
  const r = selectContract({ chain: chain([contract({ bid: 0 })]), side: "call", holdingDays: 20, nowMs: NOW, env: {} });
  assert.equal(r.ok, false); assert.equal(r.rejectedGate, "no_two_sided_quote");
});

test("EVENT RISK (earnings within horizon) → abstain", () => {
  const r = selectContract({ chain: chain([contract()]), side: "call", holdingDays: 20, nowMs: NOW, env: {}, eventRisk: { earningsWithinHorizon: true } });
  assert.equal(r.ok, false); assert.equal(r.rejectedGate, "event_risk");
});

// ── PUT safety ───────────────────────────────────────────────────────────────
test("PUT is RESEARCH_ONLY (never production-eligible) with BEARISH_ACTIONABLE off", () => {
  const put = contract({ optionSymbol: "O:NVDA260815P00130000", side: "put", strike: 130, delta: -0.5 });
  const r = selectContract({ chain: chain([put]), side: "put", holdingDays: 20, nowMs: NOW, env: {} });
  assert.equal(r.ok, true, "a valid put contract can be selected for research");
  assert.equal(r.productionEligible, false, "but never production-eligible");
  assert.equal(r.researchOnly, true);
});

// ── card ─────────────────────────────────────────────────────────────────────
test("card has all required fields + modeled/observed disclosure", () => {
  const card = buildCard({ ticker: "nvda", side: "call", holdingDays: 20, explain: explainOk, selection: sel(), regimeRelevance: "32/41 in matching regime", nowMs: NOW });
  assert.equal(card.recommend, true);
  assert.equal(card.ticker, "NVDA");
  assert.equal(card.side, "CALL");
  assert.ok(card.contract.optionSymbol && card.contract.bid != null && card.contract.spreadPct != null);
  assert.ok(Array.isArray(card.entryRange));
  assert.equal(card.targets.typicalUnderlyingMovePct, 0.34);
  assert.equal(card.invalidation.underlyingMovePct, -0.48);
  assert.equal(card.confidence, 0.61);
  assert.equal(card.analogCount, 41); assert.equal(card.effectiveSample, 33);
  assert.equal(card.medianForwardOutcome, 0.34); assert.equal(card.outcomeDispersion, 0.4);
  assert.ok(card.closestWinner && card.closestLoser);
  assert.match(card.regimeRelevance, /matching regime/);
  assert.match(card.modeledDisclosure, /Modeled/);
  assert.match(card.outcomeBasis, /OBSERVED underlying|MODELED vehicle/);
});

test("abstaining evidence → card explains, no contract", () => {
  const card = buildCard({ ticker: "NVDA", side: "call", holdingDays: 20, explain: { ...explainOk, abstain: true, reason: "comparable pool 8 < 15" }, selection: sel(), regimeRelevance: "n/a", nowMs: NOW });
  assert.equal(card.recommend, false); assert.equal(card.contract, null);
  assert.match(card.abstainReason, /pool/);
});

test("gate rejection → card explains, no contract", () => {
  const card = buildCard({ ticker: "NVDA", side: "call", holdingDays: 20, explain: explainOk, selection: selectContract({ chain: chain([contract({ spreadPct: 22 })]), side: "call", holdingDays: 20, nowMs: NOW, env: {} }), regimeRelevance: "n/a", nowMs: NOW });
  assert.equal(card.recommend, false); assert.equal(card.contract, null);
  assert.match(card.rejectionReason, /spread/);
});

// ── orchestration + persistence ──────────────────────────────────────────────
test("buildRecommendation + persist is idempotent (paper research only)", () => {
  const d = new Database(":memory:");
  const ddl = `CREATE TABLE IF NOT EXISTS recommendations (id INTEGER PRIMARY KEY AUTOINCREMENT, rec_id TEXT NOT NULL UNIQUE, ticker TEXT NOT NULL, side TEXT, recommend INTEGER NOT NULL, production_eligible INTEGER NOT NULL, research_only INTEGER NOT NULL, option_symbol TEXT, strike REAL, expiration TEXT, dte INTEGER, bid REAL, ask REAL, spread_pct REAL, confidence REAL, analog_count INTEGER, effective_sample INTEGER, median_outcome REAL, dispersion REAL, win_rate REAL, abstain_reason TEXT, rejection_reason TEXT, outcome_basis TEXT, card_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);`;
  d.exec(ddl); d.exec(ddl);
  const card = buildRecommendation({ ticker: "NVDA", side: "call", holdingDays: 20, explain: explainOk, chain: chain([contract()]), nowMs: NOW, env: {} });
  const id1 = persistRecommendationOnDb(d, card, "2026-07-21", 1);
  persistRecommendationOnDb(d, card, "2026-07-21", 2);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM recommendations").get().n, 1);
  assert.equal(d.prepare("SELECT recommend r FROM recommendations WHERE rec_id=?").get(id1).r, 1);
});
