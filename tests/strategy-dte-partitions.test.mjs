import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { planPartitions, selectContractWithEvidence } from "../lib/research/options/contract-discovery.ts";
import { runOptionsMonitorCycle, __resetOptionsMonitorForTest } from "../lib/research/options/monitor.ts";
import { chainOk } from "../lib/research/options/loop.ts";

const NOW = Date.parse("2026-08-04T15:30:00Z");
const ON = {
  INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
  OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",
};

function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);`);
  return d;
}

const longerSwingSnap = {
  price: 500,
  dayDollarVolume: 1_000_000_000,
  relVolume: null,
  velPct: 0.2,
  accelPct: 0,
  gapPct: null,
  aboveVwap: null,
  hodBreak: false,
  nearResistancePct: 0.2,
  compressionPct: 0.6,
  realizedVolExpanding: false,
  openingRange: false,
  premarketLevelTest: false,
};

test("longer_dated_swing plans only its strategy DTE partitions", () => {
  const parts = planPartitions("call", "longer_dated_swing", 6);
  assert.deepEqual(
    parts.map((p) => [p.side, p.dteMin, p.dteMax]),
    [
      ["call", 15, 30],
      ["call", 31, 60],
      ["call", 61, 90],
    ],
  );
});

test("the monitor passes selected strategy side and key to Stage-2 chain retrieval", async () => {
  __resetOptionsMonitorForTest();
  const seen = [];
  await runOptionsMonitorCycle(1, ["SPY"], {
    now: () => NOW,
    session: () => "regular",
    getDb: () => db(),
    getUnderlyingBatch: async (symbols) => new Map(symbols.map((s) => [s, longerSwingSnap])),
    getChain: async (symbol, underlyingPrice, opts) => {
      seen.push({ symbol, underlyingPrice, opts });
      return chainOk([]);
    },
  }, ON);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].symbol, "SPY");
  assert.equal(seen[0].opts.side, "call");
  assert.equal(seen[0].opts.strategyKey, "longer_dated_swing");
});

test("a strategy range that was never fetched is RANGE_NOT_FETCHED, not no contracts", () => {
  const outcome = {
    contracts: [],
    outcome: "NO_CONTRACTS_IN_REQUESTED_RANGE",
    truncated: false,
    expirationsCovered: [],
    requestedDteMin: 0,
    requestedDteMax: 14,
    requestedDteRanges: [{ dteMin: 0, dteMax: 14, label: "both:0-14dte" }],
    fetchedDteRanges: [{ dteMin: 0, dteMax: 14, label: "both:0-14dte" }],
    pagesRequested: 2,
    pagesReceived: 1,
  };
  const ev = selectContractWithEvidence([], "call", "longer_dated_swing", NOW, {
    symbol: "SPY",
    chainOutcome: outcome,
  }).evidence;

  assert.equal(ev.rangeCoverage, "NONE");
  assert.equal(ev.terminalReason, "RANGE_NOT_FETCHED");
});
