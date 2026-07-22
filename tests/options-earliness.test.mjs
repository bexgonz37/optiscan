import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runOptionsMonitorCycle, optionsMonitorMetrics, __resetOptionsMonitorForTest } from "../lib/research/options/monitor.ts";

// Earliness fix: a FORMING symbol (passed liquidity + freshness, no plausible strategy YET) must be
// re-checked at the scan cadence instead of being frozen for the full 60s symbol cooldown — so the
// callout fires while the setup is still forming, not ~60s after it validates.

const NOW = 1_700_000_000_000;
function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT, feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT, experiment_id TEXT, experiment_variant TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE VIEW IF NOT EXISTS options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
          CREATE VIEW IF NOT EXISTS options_paper_research AS SELECT * FROM options_paper_trades WHERE paper_kind='RESEARCH_ONLY_PAPER';
          CREATE TABLE options_runtime (key TEXT PRIMARY KEY, value TEXT, updated_at_ms INTEGER NOT NULL);`);
  return d;
}
// Plausibility is driven through the Stage-1 snapshot (no getBars), mirroring how live momentum builds
// cycle-to-cycle. FORMING = all signal fields null/false → no strategy plausible yet. VALIDATED =
// acceleration + relative volume present → momentum_acceleration plausible.
const base = { price: 100, dayDollarVolume: 60_000_000, relVolume: null, velPct: null, accelPct: null, gapPct: null, aboveVwap: null, hodBreak: null, nearResistancePct: null, compressionPct: null, realizedVolExpanding: null, openingRange: null, premarketLevelTest: null };
const FORMING = (syms) => new Map(syms.map((s) => [s, { ...base }]));
const VALIDATED = (syms) => new Map(syms.map((s) => [s, { ...base, accelPct: 1.0, relVolume: 3, velPct: 1.0 }]));
function deps(d, nowRef, snapRef) {
  return { now: () => nowRef.v, session: () => "regular", getDb: () => d, getUnderlyingBatch: async (s) => snapRef.fn(s), getChain: async () => [] };
}

test("EARLINESS: a forming symbol is re-checked at the next cadence (default recheck=0), catching the setup ~45s sooner", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const nowRef = { v: NOW };
  const snapRef = { fn: FORMING };
  const env = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1" }; // OPTIONS_SYMBOL_FORMING_RECHECK_MS unset -> default 0

  // t0: forming (no signals) → passed Stage 1, no plausible strategy → released for a fast re-check.
  await runOptionsMonitorCycle(1, ["NVDA"], deps(d, nowRef, snapRef), env);
  let m = optionsMonitorMetrics();
  assert.equal(m.stages.stage1Pass, 1);
  assert.equal(m.stages.stage15Forming, 1, "forming symbol was released for re-check, not alerted");
  assert.equal(m.candidatesCreated, 0, "no gate bypass — a forming setup does NOT create an alert");
  assert.equal(m.cooldownSkips, 0);

  // t0 + 15s (one Tier-1 cadence later): the setup validates. Because it was NOT frozen 60s, it is
  // re-evaluated now and reaches Stage 2 while the move is still forming.
  nowRef.v = NOW + 15_000;
  snapRef.fn = VALIDATED;
  await runOptionsMonitorCycle(1, ["NVDA"], deps(d, nowRef, snapRef), env);
  m = optionsMonitorMetrics();
  assert.equal(m.cooldownSkips, 0, "the forming symbol was NOT skipped at +15s");
  assert.ok(m.stages.stage2Chain >= 1, "reached Stage 2 at +15s — alert path engaged while still forming");
});

test("CONTRAST: the OLD 60s forming cooldown would have skipped the same symbol at +15s (late)", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const nowRef = { v: NOW };
  const snapRef = { fn: FORMING };
  const env = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1", OPTIONS_SYMBOL_FORMING_RECHECK_MS: "60000" }; // pre-fix behavior

  await runOptionsMonitorCycle(1, ["NVDA"], deps(d, nowRef, snapRef), env); // forming, frozen 60s
  nowRef.v = NOW + 15_000;
  snapRef.fn = VALIDATED;
  await runOptionsMonitorCycle(1, ["NVDA"], deps(d, nowRef, snapRef), env); // still on cooldown
  const m = optionsMonitorMetrics();
  assert.equal(m.cooldownSkips, 1, "the symbol was frozen and skipped at +15s under the old cooldown");
  assert.equal(m.stages.stage2Chain, 0, "never reached Stage 2 within the cooldown window → alert would be late");
});

test("EXECUTABLE QUALITY UNCHANGED: success/stale/hard-reject paths still use the full symbol cooldown", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const nowRef = { v: NOW };
  const env = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1" };
  // stale bars (last bar 30min old) → hard reject with the full 60s cooldown (not the forming re-check).
  const stale = { now: () => nowRef.v, session: () => "regular", getDb: () => d, getUnderlyingBatch: async (s) => FORMING(s), getBars: async () => { const n = 40, out = []; for (let i = 0; i < n; i++) out.push({ t: NOW - 30 * 60_000 - (n - 1 - i) * 60_000, o: 100, h: 100.1, l: 99.9, c: 100, v: 1000 }); return out; }, getChain: async () => [] };
  await runOptionsMonitorCycle(1, ["NVDA"], stale, env);
  assert.equal(optionsMonitorMetrics().stages.stage15Stale, 1);
  nowRef.v = NOW + 15_000; // within 60s
  await runOptionsMonitorCycle(1, ["NVDA"], stale, env);
  assert.equal(optionsMonitorMetrics().cooldownSkips, 1, "a stale (untradable) symbol is still frozen 60s — unchanged");
});
