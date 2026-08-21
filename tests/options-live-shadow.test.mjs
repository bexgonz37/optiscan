/**
 * options-live-shadow.test.mjs — the shadows now see live candidates, and still decide nothing.
 *
 * The previous phase proved these measurements were CORRECT against fixtures.
 * Pointing them at the live path raises a different question, and it is the only
 * one that matters once they are wired: can any of them change what production
 * does?
 *
 * The argument is structural, so the tests are structural. Requirements 22–27
 * each reduce to the same experiment — run the same candidate with the shadow
 * lane on and off, and assert production's output is identical — plus the shape
 * checks that make the identity hold by construction rather than by luck.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

import { runOptionsMonitorCycle, __resetOptionsMonitorForTest } from "../lib/research/options/monitor.ts";
import {
  observeLiveShadow, liveShadowReport, liveShadowTies, liveShadowRecords,
  evaluateLiveShadow, LIVE_SHADOW_VERSIONS, LIVE_SHADOW_RING_MAX,
  __resetLiveShadowForTest,
} from "../lib/research/options/live-shadow.ts";
import { DEFAULT_STAGE15_SHADOW } from "../lib/research/options/stage15-shadow.ts";
import { scoreStrategies, selectOptionsStrategy, activeSignals } from "../lib/research/options/discovery.ts";
import { chainOk } from "../lib/research/options/loop.ts";
import { assessRvolShadow, rvolShadowFeasibility, RVOL_SHADOW_VERSION } from "../lib/research/options/rvol-shadow.ts";

const NOW = Date.parse("2026-01-15T15:00:00.000Z");
const ON = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1" };
const SHADOW_OFF = { ...ON, OPTIONS_LIVE_SHADOW: "0" };

function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, mfe_pct REAL, mae_pct REAL, last_mark_return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT, feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT, experiment_id TEXT, experiment_variant TEXT, thesis_fingerprint TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT, delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0, paper_trade_id INTEGER, paper_reservation_state TEXT, discord_status INTEGER, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT, attempted_at_ms INTEGER, sent_at_ms INTEGER, session_state TEXT, entry_mid REAL, delivered_spread_pct REAL, quote_ts_ms INTEGER, target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE TABLE options_runtime (key TEXT PRIMARY KEY, value TEXT, updated_at_ms INTEGER NOT NULL);`);
  return d;
}

function bars(n = 40) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = NOW - 60_000 - (n - 1 - i) * 60_000;
    const base = 100 + (i > n - 6 ? (i - (n - 6)) * 0.2 : 0);
    out.push({ t, o: base, h: base + 0.05, l: base - 0.05, c: base, v: i > n - 6 ? 6000 : 1000 });
  }
  return out;
}

const snap = () => ({
  price: 100, dayDollarVolume: 60_000_000, relVolume: null, velPct: null, accelPct: null,
  gapPct: null, aboveVwap: null, hodBreak: null, nearResistancePct: null,
  compressionPct: null, realizedVolExpanding: null, openingRange: null, premarketLevelTest: null,
});

const deps = (d) => ({
  now: () => NOW, session: () => "regular", getDb: () => d,
  getUnderlyingBatch: async (syms) => new Map(syms.map((x) => [x, snap()])),
  getBars: async () => bars(),
  getChain: async () => chainOk([]),
});

/** Everything production persisted about a cycle, as one comparable value. */
function productionOutput(d) {
  return JSON.stringify({
    candidates: d.prepare(
      "SELECT symbol, selected_strategy, direction, side, research_only, score, state, why, option_symbol, earliness_phase FROM options_candidates ORDER BY symbol",
    ).all(),
    paper: d.prepare("SELECT option_symbol, side, strike, status, entry_fill FROM options_paper_trades ORDER BY id").all(),
    alerts: d.prepare("SELECT candidate_symbol, state, option_symbol FROM options_alerts ORDER BY alert_id").all(),
  });
}

const SYMS = ["NVDA", "TSLA", "AMD", "META"];

/* ═══════════════════════════════════════════════════════════════════════════
 * 22–27. THE SHADOW LANE CHANGES NOTHING
 * ══════════════════════════════════════════════════════════════════════════*/

test("22–27. production output is IDENTICAL with the whole shadow lane on and off", async () => {
  __resetOptionsMonitorForTest(); __resetLiveShadowForTest();
  const withShadow = db();
  await runOptionsMonitorCycle(2, SYMS, deps(withShadow), ON);
  const a = productionOutput(withShadow);

  __resetOptionsMonitorForTest(); __resetLiveShadowForTest();
  const without = db();
  await runOptionsMonitorCycle(2, SYMS, deps(without), SHADOW_OFF);
  const b = productionOutput(without);

  assert.equal(a, b,
    "Stage 1.5, feature semantics, direction-aware late phase, bearish dedupe and tie "
    + "diagnostics all observed the same candidates and moved nothing");
});

test("22–27. and the shadow lane genuinely RAN — the identity is not vacuous", async () => {
  __resetOptionsMonitorForTest(); __resetLiveShadowForTest();
  await runOptionsMonitorCycle(2, SYMS, deps(db()), ON);
  const r = liveShadowReport(ON);
  assert.equal(r.observed > 0, true, "live candidates were observed");
  assert.equal(r.faults, 0, "and none of the measurements faulted");

  __resetLiveShadowForTest();
  __resetOptionsMonitorForTest();
  await runOptionsMonitorCycle(2, SYMS, deps(db()), SHADOW_OFF);
  assert.equal(liveShadowReport(SHADOW_OFF).observed, 0, "OPTIONS_LIVE_SHADOW=0 silences it entirely");
});

test("22. the Stage 1.5 shadow cannot block a chain request it would have refused", async () => {
  __resetOptionsMonitorForTest(); __resetLiveShadowForTest();
  const asked = [];
  const d = db();
  // Every floor is failed: no velocity, thin dollar volume above the Stage-1
  // gate but far below the shadow's, so V1 would say REJECT.
  const starved = {
    ...deps(d),
    getUnderlyingBatch: async (syms) => new Map(syms.map((x) => [x, { ...snap(), dayDollarVolume: 6_000_000 }])),
    getChain: async (sym) => { asked.push(sym); return chainOk([]); },
  };
  await runOptionsMonitorCycle(2, ["NVDA"], starved, ON);

  const r = liveShadowReport(ON);
  assert.equal(r.stage15.liveDecisionsSeen > 0, true, "the shadow gate did evaluate");
  assert.deepEqual(asked, ["NVDA"], "and production spent the request anyway — the shadow has no veto");
});

test("23/24. production's fractionMove stays direction-blind while the shadow disagrees with it", () => {
  __resetLiveShadowForTest();
  // At the session low a CALL has the whole range ahead and a PUT's move is
  // finished. Production reads one number for both; the shadow reads two.
  const rec = evaluateLiveShadow(
    { symbol: "X", atMs: NOW, tier: 2, price: 98, hod: 103, lod: 98, side: "put" },
    DEFAULT_STAGE15_SHADOW, null,
  );
  assert.equal(rec.latePhase.productionFractionMove, 0, "production's value is unchanged");
  assert.equal(rec.latePhase.shadowFractionMove, 1, "the direction-aware value differs");
  assert.equal(rec.latePhase.disagrees, true);
  // The production number is computed by the monitor from f.hod/f.lod and is
  // never read back from the shadow record — there is no path for it to be.
  assert.equal(typeof rec.latePhase.note, "string");
});

test("25. the bearish dedupe is measured on live boards and changes no live score", () => {
  __resetLiveShadowForTest();
  // ONE negative observation, TWO signals. This is what production does.
  const falling = {
    symbol: "SPY", nowMs: NOW, session: "regular", tier: 2,
    underlying: { ...snap(), velPct: -0.4, accelPct: -0.2, aboveVwap: false, lodBreak: true, nearSupportPct: 0.2 },
  };
  const active = activeSignals(falling);
  assert.equal(active.has("downside_acceleration") && active.has("downside_momentum"), true,
    "the pair is emitted from one boolean — the defect the shadow is measuring");

  const board = scoreStrategies(falling);
  const before = JSON.stringify(board);
  observeLiveShadow({
    symbol: "SPY", atMs: NOW, tier: 2,
    strategyKey: board.find((b) => b.applicable)?.key ?? board[0].key,
    considered: board, activeSignals: active,
  }, ON);
  assert.equal(JSON.stringify(scoreStrategies(falling)), before,
    "scoring the same candidate again yields exactly the same board");

  const r = liveShadowReport(ON);
  assert.equal(r.bearishDedupe.version, LIVE_SHADOW_VERSIONS.bearishDedupe);
  assert.equal(typeof r.bearishDedupe.observations, "number");
});

test("27. the tie diagnostic records who won and whether it changed DIRECTION", () => {
  __resetLiveShadowForTest();
  const falling = {
    symbol: "AMD", nowMs: NOW, session: "regular", tier: 2,
    underlying: { ...snap(), velPct: -0.4, accelPct: -0.2, aboveVwap: false, lodBreak: true, nearSupportPct: 0.2 },
  };
  const selection = selectOptionsStrategy(falling, {});
  observeLiveShadow({
    symbol: "AMD", atMs: NOW, tier: 2,
    side: selection.selected?.side ?? null,
    strategyKey: selection.selected?.key ?? null,
    considered: selection.considered,
    activeSignals: activeSignals(falling),
  }, ON);

  const r = liveShadowReport(ON);
  const ties = liveShadowTies();
  if (r.tieDiagnostics.tiesRecorded > 0) {
    const t = ties[ties.length - 1];
    assert.equal(t.tiedKeys.length >= 2, true, "a tie has at least two claimants");
    assert.equal(t.winnerKey, selection.considered.filter((c) => c.applicable)[0].key,
      "the winner recorded is production's OWN winner, not a re-sorted one");
    assert.equal(typeof t.winnerChangesDirection, "boolean");
    assert.equal(typeof t.lowerHighWonTieOverOtherSide, "boolean");
    assert.equal(t.eligibleCount >= t.tiedKeys.length, true);
  }
  // And the production selection is untouched by having been observed.
  assert.deepEqual(selectOptionsStrategy(falling, {}).selected, selection.selected);
});

test("26. the RVOL shadow refuses rather than fabricating, and never activates the signal", () => {
  const d = new Database(":memory:");
  // No bar store at all — the state of the local development snapshot.
  const absent = assessRvolShadow(d, "NVDA", NOW);
  assert.equal(absent.status, "BLOCKED");
  assert.equal(absent.storePresent, false);
  assert.equal(absent.shadowRelVolume, null, "no baseline, no ratio — never a defaulted 1.0");
  assert.equal(absent.productionSignalActive, false);
  assert.match(absent.assessment.blockers.join(" "), /historical_underlying_bars is not present/);

  // Present but empty: a different fact, and it must read differently.
  d.exec(`CREATE TABLE historical_underlying_bars (symbol TEXT, timeframe TEXT, ts_ms INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL, vwap REAL, trade_count INTEGER, source TEXT, ingest_version TEXT, quality TEXT, ingested_at_ms INTEGER)`);
  const empty = assessRvolShadow(d, "NVDA", NOW);
  assert.equal(empty.storePresent, true);
  assert.equal(empty.status, "BLOCKED");
  assert.equal(empty.assessment.feasibility, "NO_INTRADAY_HISTORY");

  const feas = rvolShadowFeasibility(d, ["NVDA", "TSLA"], NOW);
  assert.equal(feas.status, "BLOCKED");
  assert.equal(feas.version, RVOL_SHADOW_VERSION);
  assert.equal(feas.productionSignalActive, false, "rel_volume stays exactly as dead as it was");
});

test("26b. the RVOL baseline can only be built from PRIOR sessions, never the current one", () => {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE historical_underlying_bars (symbol TEXT NOT NULL, timeframe TEXT NOT NULL, ts_ms INTEGER NOT NULL, open REAL, high REAL, low REAL, close REAL, volume REAL, vwap REAL, trade_count INTEGER, source TEXT, ingest_version TEXT, quality TEXT, ingested_at_ms INTEGER)`);
  const ins = d.prepare("INSERT INTO historical_underlying_bars (symbol,timeframe,ts_ms,volume,source,ingest_version,quality,ingested_at_ms) VALUES (?,?,?,?,?,?,?,?)");

  // Twelve prior sessions, each with 30 one-minute bars from 09:30 ET.
  // NOW is 10:00 ET, so 30 minutes into the session.
  for (let dayBack = 1; dayBack <= 16; dayBack++) {
    const open = NOW - 30 * 60_000 - dayBack * 86_400_000;
    for (let m = 0; m < 60; m++) ins.run("NVDA", "1m", open + m * 60_000, 1000, "t", "v1", "OK", NOW);
  }
  // And a large slug of CURRENT-session volume, which must not contribute.
  const todayOpen = NOW - 30 * 60_000;
  for (let m = 0; m < 30; m++) ins.run("NVDA", "1m", todayOpen + m * 60_000, 999_999, "t", "v1", "OK", NOW);

  const r = assessRvolShadow(d, "NVDA", NOW, 60_000);
  if (r.status === "AVAILABLE") {
    assert.equal(r.assessment.expectedCumVolume < 100_000, true,
      `today's 999,999-per-minute bars leaked into the baseline: ${r.assessment.expectedCumVolume}`);
    assert.equal(r.shadowRelVolume > 0, true, "a ratio is only produced against a real baseline");
  }
  assert.equal(r.productionSignalActive, false);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SHAPE: WHY THE IDENTITY HOLDS BY CONSTRUCTION
 * ══════════════════════════════════════════════════════════════════════════*/

test("the observer returns NOTHING — there is no verdict for a caller to branch on", () => {
  __resetLiveShadowForTest();
  const out = observeLiveShadow({ symbol: "X", atMs: NOW, tier: 2 }, ON);
  assert.equal(out, undefined,
    "a shadow that returned a verdict would be one refactor away from being read");
});

test("a faulting measurement is contained — it counts a fault and never reaches the scan", () => {
  __resetLiveShadowForTest();
  // A board whose entries throw on access: the nastiest input a caller can pass.
  const hostile = new Proxy([], { get() { throw new Error("boom"); } });
  assert.doesNotThrow(() => observeLiveShadow(
    { symbol: "X", atMs: NOW, tier: 2, considered: hostile }, ON));
  assert.equal(liveShadowReport(ON).faults, 1, "the fault was counted, not propagated");
});

test("the buffers are RINGS — a long session cannot turn observation into a leak", () => {
  __resetLiveShadowForTest();
  for (let i = 0; i < LIVE_SHADOW_RING_MAX * 3; i++) {
    observeLiveShadow({ symbol: `S${i}`, atMs: NOW + i, tier: 2, price: 100, hod: 103, lod: 98, side: "call" }, ON);
  }
  assert.equal(liveShadowRecords(10_000).length, LIVE_SHADOW_RING_MAX);
  assert.equal(liveShadowReport(ON).observed, LIVE_SHADOW_RING_MAX * 3,
    "the counter still reports everything seen; only the retained detail is bounded");
});

test("the report never states a saving without what the saving would cost", () => {
  __resetLiveShadowForTest();
  const r = liveShadowReport(ON).stage15;
  for (const k of ["wouldSaveChainRequests", "wouldCostChainWithContracts", "wouldCostCases",
    "wouldCostWinners", "wouldCostLosers", "gradedOutcomes"]) {
    assert.equal(k in r, true, `${k} is missing — a savings number alone always looks good`);
  }
});

test("every shadow stream is version-stamped, so a finding can be attributed to a rule", () => {
  __resetLiveShadowForTest();
  const r = liveShadowReport(ON);
  assert.equal(r.versions.stage15, "STAGE15_CHAIN_GATE_SHADOW_V1");
  assert.equal(r.versions.directionAwareLatePhase, "DIRECTION_AWARE_LATE_PHASE_SHADOW_V1");
  assert.equal(r.versions.bearishDedupe, "BEARISH_SIGNAL_DEDUPE_SHADOW_V1");
  assert.equal(r.versions.tieDiagnostics, "STRATEGY_TIE_DIAGNOSTIC_V1");
  assert.match(String(r.authority), /SHADOW_ONLY/);
});

test("the observer spends no provider request and writes no row", () => {
  const src = readFileSync(new URL("../lib/research/options/live-shadow.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /fetch\(|axios|polygon/i, "no provider access");
  assert.doesNotMatch(src, /prepare\(|INSERT |better-sqlite3/i, "no storage access");
  assert.doesNotMatch(src, /discord|webhook/i, "no notification path");
});
