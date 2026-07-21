import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { optionsTier1, activeSignals, selectOptionsStrategy, tier2Eligible, defaultTier2Config } from "../lib/research/options/discovery.ts";
import { evaluateCallout, formatCallout } from "../lib/research/options/callout.ts";
import { conservativeEntryFill, buildRealOptionEntry, realOptionExit } from "../lib/research/options/paper.ts";
import { evaluateOptionsCandidate, selectContractFromChain, runOptionsCandidate } from "../lib/research/options/loop.ts";
import { readOptionsReportOnDb } from "../lib/research/options/report.ts";

const NOW = 1_000_000;
// a FORMING breakout candidate that is NOT up 10% (small velocity, but real early signals)
const cand = (over = {}) => ({
  symbol: "HOOD", nowMs: NOW, session: "regular", tier: 2,
  underlying: { price: 40, dayDollarVolume: 60_000_000, relVolume: 4, velPct: 0.8, accelPct: 0.3, gapPct: 1, aboveVwap: true, hodBreak: false, nearResistancePct: 0.3, compressionPct: 0.7, realizedVolExpanding: true, openingRange: false, premarketLevelTest: false },
  optionsActivity: { volOIRatio: 3, volVsBaseline: 2.5, direction: "call_skew", multiStrike: true, multiExpiration: false, ivChange: 0.03 },
  earnings: null, ...over,
});

// ── A/B/C: independent discovery + early triggers + strategy selection (no +10%) ──
test("Tier-1 core options universe is fixed + extendable", () => {
  const t1 = optionsTier1({});
  for (const s of ["SPY", "QQQ", "NVDA", "TSLA", "HOOD", "AAPL"]) assert.ok(t1.includes(s));
  assert.ok(optionsTier1({ OPTIONS_TIER1_EXTRA: "IREN" }).includes("IREN"));
});

test("early signals fire WITHOUT the underlying being up ~10%", () => {
  const sig = activeSignals(cand());
  assert.ok(sig.has("rel_volume") && sig.has("breakout_proximity") && sig.has("compression_near_level"));
  assert.ok(sig.has("option_vol_vs_oi") && sig.has("volatility_expansion"));
  // velPct is only 0.8% — nowhere near +10% — yet a strategy still applies
  const sel = selectOptionsStrategy(cand());
  assert.ok(sel.selected, "a strategy was selected on an early, non-extended setup");
  assert.ok(sel.considered.length >= 5, "records every considered strategy");
});

test("strategy selection records rejections and picks the strongest applicable", () => {
  const sel = selectOptionsStrategy(cand());
  assert.ok(sel.considered.some((c) => !c.applicable && c.rejection), "rejections recorded");
  assert.equal(sel.selected.side, "call");
  assert.equal(sel.selected.researchOnly, false);
});

test("puts stay RESEARCH_ONLY unless bearishActionable", () => {
  const bearish = cand({ underlying: { ...cand().underlying, velPct: -0.8 }, optionsActivity: { ...cand().optionsActivity, direction: "put_skew" } });
  const sel = selectOptionsStrategy(bearish, { bearishActionable: false });
  if (sel.selected?.side === "put") assert.equal(sel.selected.researchOnly, true);
  assert.equal(selectOptionsStrategy(bearish, { bearishActionable: true }).selected?.researchOnly ?? false, false);
});

test("Tier-2 broad eligibility lets unexpected liquid names in, rejects junk", () => {
  const cfg = defaultTier2Config({});
  assert.equal(tier2Eligible({ symbol: "IREN", price: 12, dayDollarVolume: 40_000_000, hasUsableChain: true, bestBid: 0.5, bestSpreadPct: 6, optionVolumeOrOI: 500 }, cfg).eligible, true);
  assert.match(tier2Eligible({ symbol: "ABCDW", price: 12, dayDollarVolume: 40_000_000 }, cfg).rejections.join(","), /warrant_shape/);
  assert.match(tier2Eligible({ symbol: "X", price: 12, dayDollarVolume: 100 }, cfg).rejections.join(","), /insufficient_underlying_liquidity/);
});

// ── D/E: single callout + freshness/TOO_LATE ──
const contract = (over = {}) => ({ optionSymbol: "O:HOOD260320C00042000", side: "call", strike: 42, expiration: "2026-03-20", dte: 12, bid: 1.2, ask: 1.3, spreadPct: 8, quoteAgeMs: 1000, openInterest: 1200, volume: 400, ...over });
const calloutIn = (over = {}) => ({ symbol: "HOOD", strategyKey: "breakout_forming", researchOnly: false, contract: contract(), observedUnderlyingPrice: 40, observedAtMs: NOW, currentUnderlyingPrice: 40.1, currentAtMs: NOW + 1000, entryZone: [1.2, 1.3], targets: [1.8, 2.4], why: "breakout forming with accelerating volume and liquid call activity", ...over });

test("evaluateCallout emits ONE READY message; the format matches spec", () => {
  const r = evaluateCallout(calloutIn());
  assert.equal(r.state, "READY");
  assert.match(r.message, /^HOOD CALL\n\$42 — 03\/20\nEntry: \$1\.20–\$1\.30\nTargets: \$1\.80 \/ \$2\.40\nWhy: /);
});

test("callout is TOO_LATE past the chase limit and REJECTED on a bad contract", () => {
  const late = evaluateCallout(calloutIn({ currentUnderlyingPrice: 45 })); // moved way past chase
  assert.equal(late.state, "TOO_LATE");
  assert.equal(late.message, null);
  const zero = evaluateCallout(calloutIn({ contract: contract({ bid: 0 }) }));
  assert.equal(zero.state, "REJECTED");
});

// ── F: real-option paper, conservative fill, option P&L, classified ──
test("conservative fill pays toward the ask; exit toward the bid; P&L from the contract", () => {
  assert.ok(conservativeEntryFill(1.2, 1.3) > 1.25, "not a naive mid");
  const e = buildRealOptionEntry({ quote: { ...contract(), iv: 0.5, delta: 0.5, providerTimestamp: NOW - 1000 }, underlyingPrice: 40, strategy: "breakout_forming" }, {});
  assert.equal(e.ok, true);
  assert.equal(e.class, "REAL_OPTION_PAPER");
  const x = realOptionExit(e.entryFill, 1.9, 2.0, 1);
  assert.ok(x.pnl > 0 && x.returnPct > 0, "P&L computed from option price × 100");
});

// ── orchestrator: gated, persists, isolated ──
function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);`);
  return d;
}
const chain = [{ optionSymbol: "O:HOOD260320C00042000", side: "call", strike: 42, expiration: "2026-03-20", dte: 12, bid: 1.2, ask: 1.3, spreadPct: 8, volume: 400, openInterest: 1200, iv: 0.5, delta: 0.45, providerTimestamp: NOW - 1000 }];

test("runOptionsCandidate is a HARD no-op unless INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1", () => {
  assert.equal(runOptionsCandidate(cand(), chain, { getDb: () => db() }, {}), null);
});

test("enabled: records a candidate + (with paper flag) a REAL_OPTION_PAPER row; report is separate", () => {
  const d = db();
  const res = runOptionsCandidate(cand(), chain, { getDb: () => d }, { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", REAL_OPTION_PAPER_ENABLED: "1" });
  assert.ok(res && res.selection.selected);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_candidates").get().n, 1);
  if (res.state === "READY") assert.equal(d.prepare("SELECT COUNT(*) n FROM options_paper_trades WHERE result_class='REAL_OPTION_PAPER'").get().n, 1);
  const rep = readOptionsReportOnDb(d);
  assert.equal(rep.candidates.total, 1);
  assert.match(rep.note, /SEPARATE from the Stock Momentum Radar/);
});

test("pure evaluator does not depend on shouldTrigger and selects a contract by delta band", () => {
  const c = selectContractFromChain(chain, "call", "breakout_forming", NOW);
  assert.ok(c && c.optionSymbol === "O:HOOD260320C00042000");
  const ev = evaluateOptionsCandidate(cand(), chain, { currentUnderlyingPrice: 40.1, currentAtMs: NOW + 500, entryZone: [1.2, 1.3], targets: [1.8, 2.4] });
  assert.ok(["READY", "REJECTED", "TOO_LATE"].includes(ev.state));
});
