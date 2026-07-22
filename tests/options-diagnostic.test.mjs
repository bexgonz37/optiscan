import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runOptionsMonitorCycle, optionsMonitorMetrics, __resetOptionsMonitorForTest } from "../lib/research/options/monitor.ts";
import { optionsTier1Diagnostic } from "../lib/research/options/diagnostic.ts";
import { optionsTier1 } from "../lib/research/options/discovery.ts";

const NOW = 1_700_000_000_000;
function makeBars(n, lastAgeMs, { rising = true } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = NOW - lastAgeMs - (n - 1 - i) * 60_000;
    const base = 100 + (rising && i > n - 6 ? (i - (n - 6)) * 0.2 : 0);
    out.push({ t, o: base, h: base + 0.05, l: base - 0.05, c: base, v: i > n - 6 ? 6000 : 1000 });
  }
  return out;
}
function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);`);
  return d;
}
const T1 = optionsTier1({});
const ON = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1" };
const snapMap = (syms) => new Map(syms.map((s) => [s, { price: 100, dayDollarVolume: 60_000_000 }]));
const monDeps = (d, getBars) => ({ now: () => NOW, session: () => "regular", getDb: () => d, getUnderlyingBatch: async (syms) => new Map(syms.map((s) => [s, { price: 100, dayDollarVolume: 60_000_000, relVolume: null, velPct: null, accelPct: null, gapPct: null, aboveVwap: null, hodBreak: null, nearResistancePct: null, compressionPct: null, realizedVolExpanding: null, openingRange: null, premarketLevelTest: null }])), getBars, getChain: async () => [] });

// ── reproduce the exact production state ──
test("REPRODUCE: 14 Stage-1 passes, 14 enrichments, all STALE ⇒ 0 distributions, 0 Stage-2", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  // every symbol returns bars whose last bar is 30 minutes old (stale > 5min default)
  await runOptionsMonitorCycle(1, T1, monDeps(d, async () => makeBars(40, 30 * 60_000)), ON);
  const m = optionsMonitorMetrics();
  assert.equal(m.symbolsScanned, T1.length);
  assert.equal(m.stages.stage1Pass, T1.length);
  assert.equal(m.stages.stage15Enrich, T1.length);
  assert.equal(m.stages.stage15Stale, T1.length, "every enriched symbol was stale");
  assert.equal(m.stages.stage2Chain, 0);
  assert.equal(m.distributions.rvol.n, 0);
  assert.equal(m.distributions.vwapDistPct.n, 0);
  assert.equal(m.distributions.compression.n, 0);
  assert.equal(m.candidatesCreated, 0);
  assert.equal(m.candidatesRejected, T1.length);
});

test("PROVE regular-hours differ: FRESH bars record distributions (verify feature computation)", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  await runOptionsMonitorCycle(1, ["NVDA", "TSLA"], monDeps(d, async () => makeBars(40, 60_000)), ON); // last bar 1min old
  const m = optionsMonitorMetrics();
  assert.equal(m.stages.stage15Stale, 0, "fresh bars are not stale");
  assert.ok(m.distributions.vwapDistPct.n >= 1, "VWAP-distance samples exist with fresh bars");
  assert.ok(m.distributions.compression.n >= 1, "compression samples exist with fresh bars");
});

// ── evidence-only diagnostic ──
const diagDeps = (session, getBars) => ({ now: () => NOW, session: () => session, getUnderlyingBatch: async (syms) => snapMap(syms), getBars });

test("DIAGNOSTIC (closed): explicit stale/closed reason per symbol; no candidate fabricated", async () => {
  const diag = await optionsTier1Diagnostic(diagDeps("afterhours", async () => makeBars(40, 30 * 60_000)), ON);
  assert.equal(diag.marketOpenForOptions, false);
  assert.match(diag.note, /NOT in regular hours|EXPECTED/);
  assert.equal(diag.summary.symbols, optionsTier1({}).length);
  assert.equal(diag.summary.wouldReachStage2, 0);
  const one = diag.symbols[0];
  assert.equal(one.stale, true);
  assert.match(one.finalRejection, /stale bars|no bars/);
  assert.ok(one.strategies.length >= 5 && one.strategies[0].required.length > 0, "every strategy evaluated with required signals");
  assert.equal(typeof one.featureNullReasons.relVolume, "string", "exact null reason for rvol");
});

test("DIAGNOSTIC (regular, fresh): features present, null reasons explicit, near-miss reported", async () => {
  const diag = await optionsTier1Diagnostic(diagDeps("regular", async () => makeBars(40, 60_000)), ON);
  assert.equal(diag.marketOpenForOptions, true);
  assert.ok(diag.summary.withFreshBars >= 1);
  const one = diag.symbols[0];
  assert.equal(one.stale, false);
  assert.ok(one.features.vwap != null && one.features.compressionScore != null, "computed features present with fresh bars");
  assert.match(one.featureNullReasons.relVolume, /baseline/, "rvol null reason names the missing baseline");
  for (const s of one.strategies) assert.ok(typeof s.nearMissSignals === "number" && Array.isArray(s.missing));
});

test("DIAGNOSTIC clarifies distributions summarize all NON-STALE enriched symbols (not just candidates)", async () => {
  __resetOptionsMonitorForTest();
  const m0 = optionsMonitorMetrics();
  assert.equal(m0.distributionsScope, "all_non_stale_enriched");
});
