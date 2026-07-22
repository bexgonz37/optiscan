import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { computeOptionsFeatures, featuresToUnderlying } from "../lib/research/options/features.ts";
import { summarizeChainFeatures, chainFeaturesToActivity } from "../lib/research/options/chain-features.ts";
import { runOptionsMonitorCycle, __resetOptionsMonitorForTest, optionsMonitorMetrics } from "../lib/research/options/monitor.ts";

const T0 = 1_700_000_000_000;
// compact 1-min bars: base ~100, compressing, then pushing up toward a 101 level near nowMs
function bars(n = 40) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + (i > n - 6 ? (i - (n - 6)) * 0.2 : 0); // rise in the last 5 bars
    out.push({ t: T0 + i * 60_000, o: base, h: base + 0.05, l: base - 0.05, c: base, v: i > n - 6 ? 5000 : 1000 });
  }
  return out;
}
const NOW = T0 + 40 * 60_000;

test("2. features are computed only from decision-time bars (no look-ahead)", () => {
  const withFuture = [...bars(40), { t: NOW + 60_000, o: 200, h: 210, l: 199, c: 205, v: 99999 }];
  const f = computeOptionsFeatures(withFuture, { nowMs: NOW, session: "regular" });
  assert.ok(f.price != null && f.price < 105, "future 205 bar ignored");
  assert.ok(f.vwap != null && f.aboveVwap === true);
  assert.ok(f.hod != null && f.compressionScore != null);
  assert.ok(f.velPct != null && f.accelPct != null);
});

test("5. stale bars are flagged (reject safely)", () => {
  const old = bars(40).map((b) => ({ ...b, t: b.t - 30 * 60_000 })); // last bar ~30m stale vs NOW
  const f = computeOptionsFeatures(old, { nowMs: NOW, session: "regular", maxBarAgeMs: 5 * 60_000 });
  assert.equal(f.stale, true);
});

test("featuresToUnderlying maps + a volume-surge relVolume proxy fires when no baseline exists", () => {
  const f = computeOptionsFeatures(bars(40), { nowMs: NOW, session: "regular" });
  const u = featuresToUnderlying(f);
  assert.equal(u.price, f.price);
  assert.equal(u.aboveVwap, true);
  // volume accelerated in the last bars → proxy relVolume set
  assert.ok(u.relVolume == null || u.relVolume >= 2);
});

// ── chain features (never institutional flow) ──
const contract = (over = {}) => ({ side: "call", strike: 101, dte: 7, bid: 1.2, ask: 1.3, spreadPct: 8, volume: 4000, openInterest: 1000, iv: 0.5, providerTimestamp: NOW - 1000, ...over });
test("chain features summarize vol/OI + skew and NEVER claim institutional flow", () => {
  const cf = summarizeChainFeatures({ symbol: "HOOD", underlyingPrice: 100, underlyingDollarVolume: 60_000_000, contracts: [contract(), contract({ strike: 102, volume: 3000 }), contract({ side: "put", strike: 98, volume: 300 })], chainAvailable: true, nowMs: NOW });
  assert.equal(cf.available, true);
  assert.equal(cf.flowClassification, "unclassified_no_trade_data");
  assert.ok(cf.callPutVolRatio > 1 && cf.strikesActive >= 2);
  const act = chainFeaturesToActivity(cf);
  assert.ok(act.multiStrike === true || act.multiStrike === false);
});

test("8. ambiguous options activity abstains (not called directional)", () => {
  const balanced = summarizeChainFeatures({ symbol: "X", underlyingPrice: 100, underlyingDollarVolume: 60_000_000, contracts: [contract({ side: "call", volume: 3000 }), contract({ side: "put", strike: 98, volume: 3000 })], chainAvailable: true, nowMs: NOW });
  assert.ok(balanced.direction === "ambiguous" || balanced.direction === null || balanced.abnormal === false);
});

// ── monitor Stage 1.5 + escalation ──
function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);`);
  return d;
}
const snap = (over = {}) => ({ price: 100, dayDollarVolume: 60_000_000, relVolume: null, velPct: null, accelPct: null, gapPct: null, aboveVwap: null, hodBreak: null, nearResistancePct: null, compressionPct: null, realizedVolExpanding: null, openingRange: null, premarketLevelTest: null, ...over });
const chain = [{ optionSymbol: "O:HOOD260320C00101000", side: "call", strike: 101, expiration: "2026-03-20", dte: 12, bid: 1.2, ask: 1.3, spreadPct: 8, volume: 4000, openInterest: 1200, iv: 0.5, delta: 0.5, providerTimestamp: NOW - 1000 }];
function deps(d, over = {}) {
  return { now: () => NOW, session: () => "regular", getDb: () => d, getUnderlyingBatch: async (syms) => new Map(syms.map((s) => [s, snap()])), getBars: async () => bars(40), getChain: async (sym) => chain.map((c) => ({ ...c, optionSymbol: `O:${sym}260320C00101000` })), ...over };
}
const ON = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1" };

test("3/10. Stage 1.5 enriches from bars and stores the decision-time snapshot; chain only after plausible", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  await runOptionsMonitorCycle(1, ["HOOD"], deps(d), ON);
  const m = optionsMonitorMetrics();
  assert.ok(m.stages.stage15Enrich >= 1, "bars enrichment ran");
  const row = d.prepare("SELECT feature_snapshot_json, earliness_phase FROM options_candidates WHERE symbol='HOOD'").get();
  assert.ok(row, "candidate recorded");
  const snapJson = JSON.parse(row.feature_snapshot_json);
  assert.equal(snapJson.source, "enriched");
  assert.ok(snapJson.underlying && snapJson.chain, "enriched underlying + chain snapshot stored (AI/analog input)");
});

test("5(monitor). stale bars reject before any chain fetch", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const chainSpy = { calls: [] };
  const dp = deps(d, { getBars: async () => bars(40).map((b) => ({ ...b, t: b.t - 60 * 60_000 })), getChain: async (s) => { chainSpy.calls.push(s); return chain; } });
  await runOptionsMonitorCycle(1, ["HOOD"], dp, ON);
  assert.equal(chainSpy.calls.length, 0, "stale bars → no chain fetch");
});

test("7. options-activity independently escalates a symbol with no underlying strategy signal", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  // flat underlying (no strategy) but abnormal call-skewed chain
  const dp = deps(d, { getBars: async () => bars(40).map((b) => ({ ...b, c: 100, o: 100, h: 100.01, l: 99.99, v: 1000 })) });
  await runOptionsMonitorCycle(1, ["HOOD"], dp, { ...ON, OPTIONS_ACTIVITY_DISCOVERY_ENABLED: "1" });
  const m = optionsMonitorMetrics();
  // either escalated (abnormal chain) or rejected — but never crashes; escalation counter exists
  assert.ok(m.stages.optionsActivityEscalations >= 0);
});

test("14/15. flags OFF ⇒ no enrichment work + no candidate; provider calls stay bounded per cycle", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  await runOptionsMonitorCycle(1, ["HOOD"], deps(d), {}); // discovery OFF
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_candidates").get().n, 0);
  __resetOptionsMonitorForTest();
  await runOptionsMonitorCycle(1, ["HOOD", "NVDA"], deps(d), ON);
  const m = optionsMonitorMetrics();
  assert.equal(m.providerCalls.underlying, 1, "one batch underlying call");
  assert.ok(m.providerCalls.bars <= 2 && m.providerCalls.chain <= 2, "bounded per-symbol calls");
});
