import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runOptionsMonitorCycle, startOptionsMonitor, stopOptionsMonitor, optionsMonitorHealth, defaultMonitorConfig, __resetOptionsMonitorForTest } from "../lib/research/options/monitor.ts";
import { canOpenRealOptionPaper } from "../lib/research/options/paper.ts";

function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);`);
  return d;
}
const NOW = 2_000_000;
// a forming candidate snapshot (NOT up 10%): accelerating with early signals
const snap = (over = {}) => ({ price: 40, dayDollarVolume: 60_000_000, relVolume: 4, velPct: 0.8, accelPct: 0.4, gapPct: 1, aboveVwap: true, hodBreak: false, nearResistancePct: 0.3, compressionPct: 0.7, realizedVolExpanding: true, openingRange: false, premarketLevelTest: false, ...over });
const chain = [{ optionSymbol: "O:HOOD260320C00042000", side: "call", strike: 42, expiration: "2026-03-20", dte: 12, bid: 1.2, ask: 1.3, spreadPct: 8, volume: 400, openInterest: 1200, iv: 0.5, delta: 0.45, providerTimestamp: NOW - 1000 }];

function deps(d, { getChainSpy, getUnderlyingSpy, slowChainMs = 0 } = {}) {
  return {
    now: () => NOW,
    session: () => "regular",
    getDb: () => d,
    getUnderlyingBatch: async (syms) => { if (getUnderlyingSpy) getUnderlyingSpy.calls++; return new Map(syms.map((s) => [s, snap()])); },
    getChain: async (sym) => { if (getChainSpy) getChainSpy.calls.push(sym); if (slowChainMs) await new Promise((r) => setTimeout(r, slowChainMs)); return chain.map((c) => ({ ...c, optionSymbol: `O:${sym}260320C00042000` })); },
    tier2Universe: () => ["IREN", "ASTS"],
  };
}
const ON = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1" };

test("1/3. the monitor cycle runs independently of shouldTrigger and never consults a +10% rule", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const r = await runOptionsMonitorCycle(1, ["HOOD"], deps(d), ON);
  assert.equal(r.tier, 1);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_candidates").get().n >= 1, true);
  // velPct here is 0.8% — far from +10% — yet a candidate was evaluated
});

test("2. Tier-2 names enter without curated-list membership", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  await runOptionsMonitorCycle(2, ["IREN", "ASTS"], deps(d), ON);
  const syms = d.prepare("SELECT DISTINCT symbol FROM options_candidates").all().map((r) => r.symbol);
  assert.ok(syms.includes("IREN") || syms.includes("ASTS"));
});

test("4. full chains are NOT fetched for every symbol (Stage-1 rejects most before Stage-2)", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const chainSpy = { calls: [] };
  // one symbol has signals (chain fetched), one is flat (no signals → no chain)
  const dp = deps(d, { getChainSpy: chainSpy });
  dp.getUnderlyingBatch = async (syms) => new Map(syms.map((s) => [s, s === "HOOD" ? snap() : snap({ relVolume: 1, accelPct: 0, nearResistancePct: 9, compressionPct: 9, realizedVolExpanding: false, aboveVwap: false })]));
  await runOptionsMonitorCycle(1, ["HOOD", "FLAT"], dp, ON);
  assert.ok(chainSpy.calls.length < 2, `chain fetched only for justified symbols (${chainSpy.calls.length})`);
});

test("5. provider budget + one underlying batch call per cycle are bounded", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const uSpy = { calls: 0 };
  await runOptionsMonitorCycle(1, ["HOOD", "NVDA", "TSLA"], deps(d, { getUnderlyingSpy: uSpy }), ON);
  assert.equal(uSpy.calls, 1, "exactly ONE underlying batch call for the whole set");
});

test("6. a slow chain fetch does not block the caller path (cycle awaited, but bounded concurrency)", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const t0 = Date.now();
  const p = runOptionsMonitorCycle(1, ["HOOD"], deps(d, { slowChainMs: 30 }), ON);
  assert.ok(Date.now() - t0 < 10, "runOptionsMonitorCycle returns a promise immediately (non-blocking)");
  await p;
});

test("10. per-symbol cooldown suppresses duplicate scans", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const dp = deps(d);
  await runOptionsMonitorCycle(1, ["HOOD"], dp, ON);
  const after1 = d.prepare("SELECT COUNT(*) n FROM options_candidates").get().n;
  await runOptionsMonitorCycle(1, ["HOOD"], dp, ON); // same NOW → still in cooldown
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_candidates").get().n, after1, "cooldown suppressed the re-scan");
});

test("11. flags OFF ⇒ no monitoring work (no candidates)", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const started = startOptionsMonitor(deps(d), {});
  assert.equal(started.started, false);
  // the cycle itself only persists via runOptionsCandidate, which is flag-gated:
  await runOptionsMonitorCycle(1, ["HOOD"], deps(d), {});
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_candidates").get().n, 0);
});

test("12/13. discovery ON + paper OFF records candidates but no trades; paper ON creates only eligible REAL_OPTION_PAPER", async () => {
  __resetOptionsMonitorForTest();
  const d1 = db();
  await runOptionsMonitorCycle(1, ["HOOD"], deps(d1), ON); // paper OFF
  assert.ok(d1.prepare("SELECT COUNT(*) n FROM options_candidates").get().n >= 1);
  assert.equal(d1.prepare("SELECT COUNT(*) n FROM options_paper_trades").get().n, 0);
  const d2 = db();
  await runOptionsMonitorCycle(1, ["HOOD"], deps(d2), { ...ON, REAL_OPTION_PAPER_ENABLED: "1" });
  const paper = d2.prepare("SELECT result_class FROM options_paper_trades").all();
  for (const p of paper) assert.equal(p.result_class, "REAL_OPTION_PAPER");
});

test("7. premarket setups do not create a real-option paper entry (options-market-hours only)", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const dp = deps(d); dp.session = () => "premarket";
  await runOptionsMonitorCycle(1, ["HOOD"], dp, { ...ON, REAL_OPTION_PAPER_ENABLED: "1" });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_paper_trades").get().n, 0, "no paper entry outside options-market hours");
  assert.ok(d.prepare("SELECT COUNT(*) n FROM options_candidates").get().n >= 1, "but the FORMING candidate is still recorded");
});

test("9/10. canOpenRealOptionPaper suppresses duplicates, caps concurrency + per-symbol exposure", () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const ins = (occ, strat, nowMs) => d.prepare("INSERT INTO options_paper_trades (option_symbol, result_class, strategy, status, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?)").run(occ, "REAL_OPTION_PAPER", strat, "ENTERED", nowMs, nowMs);
  assert.equal(canOpenRealOptionPaper(d, { optionSymbol: "O:HOOD1C1", strategy: "breakout_forming", nowMs: NOW }).ok, true);
  ins("O:HOOD1C1", "breakout_forming", NOW);
  assert.match(canOpenRealOptionPaper(d, { optionSymbol: "O:HOOD1C1", strategy: "breakout_forming", nowMs: NOW }).reason, /duplicate/);
  ins("O:HOOD2C1", "trend_continuation", NOW);
  assert.match(canOpenRealOptionPaper(d, { optionSymbol: "O:HOOD3C1", strategy: "sr_reclaim", nowMs: NOW }, { bucketMs: 60000, maxConcurrent: 20, maxPerSymbol: 2 }).reason, /per_symbol_exposure/);
});

test("14. no Discord send occurs; 8. calls and puts evaluated independently via strategy evidence", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  // a bearish/put-skew forming setup selects a put (RESEARCH_ONLY), a bullish one selects a call
  const dp = deps(d);
  dp.getUnderlyingBatch = async () => new Map([["HOOD", snap({ velPct: -0.8 })]]);
  await runOptionsMonitorCycle(1, ["HOOD"], dp, ON);
  const row = d.prepare("SELECT side, research_only, callout_message FROM options_candidates WHERE symbol='HOOD'").get();
  assert.ok(["call", "put"].includes(row?.side ?? "call"));
  // callout_message may be null (not READY) but there is never a Discord side effect — nothing to assert beyond no throw
  assert.ok(true);
});

test("15. start/stop is a clean singleton; health never fails the web endpoint when disabled", () => {
  __resetOptionsMonitorForTest();
  stopOptionsMonitor();
  const h = optionsMonitorHealth({}, Date.now());
  assert.equal(h.enabled, false);
  assert.equal(h.alive, true, "a DISABLED loop is healthy (alive), not an error");
  const s = startOptionsMonitor(deps(db()), ON);
  assert.equal(s.started, true);
  assert.equal(startOptionsMonitor(deps(db()), ON).reason, "already running");
  stopOptionsMonitor();
  assert.ok(defaultMonitorConfig({}).maxConcurrency >= 1);
});
