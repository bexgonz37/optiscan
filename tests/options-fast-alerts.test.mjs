import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runOptionsMonitorCycle, optionsMonitorMetrics, defaultMonitorConfig, __resetOptionsMonitorForTest } from "../lib/research/options/monitor.ts";
import { optionsTier0 } from "../lib/research/options/discovery.ts";
import { entryMidpoint, formatCompactAlert } from "../lib/research/options/format.ts";
import { computeOptionTargets } from "../lib/research/options/targets.ts";
import { sessionState, openingWindowAllows, defaultOpeningLimit } from "../lib/research/options/session-state.ts";
import { rankCandidates } from "../lib/research/options/ranking.ts";
import { deliverOptionsCallout } from "../lib/research/options/delivery.ts";

const NOW = 1_700_000_000_000;
function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT, feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT, experiment_id TEXT, experiment_variant TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE VIEW options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
          CREATE VIEW options_paper_research AS SELECT * FROM options_paper_trades WHERE paper_kind='RESEARCH_ONLY_PAPER';
          CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT, delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0, discord_status INTEGER, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT, attempted_at_ms INTEGER, sent_at_ms INTEGER, session_state TEXT, entry_mid REAL, delivered_spread_pct REAL, quote_ts_ms INTEGER, target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);`);
  return d;
}
const snap = (syms) => new Map(syms.map((s) => [s, { price: 500, dayDollarVolume: 900_000_000, relVolume: 3, velPct: 1, accelPct: 1, gapPct: null, aboveVwap: true, hodBreak: null, nearResistancePct: null, compressionPct: null, realizedVolExpanding: null, openingRange: null, premarketLevelTest: null }]));
const monDeps = (d) => ({ now: () => NOW, session: () => "regular", getDb: () => d, getUnderlyingBatch: async (s) => snap(s), getChain: async () => [] });
const ENV = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", EARLY_OPTIONS_CALLOUTS_ENABLED: "1" };
// A weekday timestamp helper at a given ET hour:minute (July = EDT = UTC-4). 2026-07-22 is a Wednesday.
const ET = (h, m) => Date.UTC(2026, 6, 22, h + 4, m, 0);

// ── 1+2. Tier 0 reserved budget: SPY/QQQ scanned even when the broad budget is exhausted ──
test("Tier 0 scans on its RESERVED budget even when the shared broad budget is exhausted", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const env = { ...ENV, OPTIONS_PROVIDER_BUDGET_PER_MINUTE: "1" }; // broad budget: 1 call/min
  const cfg = defaultMonitorConfig(env);
  // Exhaust the broad budget with a tier-2 cycle (uses the shared bucket)...
  await runOptionsMonitorCycle(2, ["XYZ"], monDeps(d), env, cfg);
  await runOptionsMonitorCycle(2, ["ABC"], monDeps(d), env, cfg); // throttled — bucket empty
  const before = optionsMonitorMetrics();
  assert.ok(before.throttles >= 1, "broad universe is throttled");
  // ...Tier 0 still scans because its budget bucket is separate and reserved.
  await runOptionsMonitorCycle(0, optionsTier0(env), monDeps(d), env, cfg);
  const m = optionsMonitorMetrics();
  assert.ok(m.tier0.scanned >= 3, "SPY/QQQ/IWM scanned despite exhausted broad budget");
  assert.equal(m.tier0.budgetSkips, 0, "no Tier 0 budget skip");
});

// ── 3. exact midpoint + targets ──
test("entry midpoint is round((bid+ask)/2, 2) — one exact price, cents precision", () => {
  assert.equal(entryMidpoint(1.16, 1.25), 1.21);
  assert.equal(entryMidpoint(0.95, 1.0), 0.98);
  assert.equal(entryMidpoint(2.0, 2.01), 2.01); // 2.005 → 2.01
});
test("targets are deterministic, ordered, and never missing", () => {
  const t = computeOptionTargets(1.21, "momentum_acceleration");
  assert.ok(t.stop < 1.21 && t.t1 > 1.21 && t.t2 > t.t1);
  assert.match(t.methodology, /mid=1\.21/);
  // repeatable — same input, same output
  assert.deepEqual(computeOptionTargets(1.21, "momentum_acceleration"), t);
});

// ── 4/5. compact message: no range, no n/a, mobile-friendly ──
test("compact alert format: exact midpoint, T1/T2/Stop, one setup line, no range, short", () => {
  const msg = formatCompactAlert({ symbol: "SPY", side: "call", strike: 640, expiration: "2026-07-24", entryMid: 1.21, t1: 1.45, t2: 1.7, stop: 0.98, strategyKey: "sr_reclaim" });
  assert.equal(msg.split("\n").length, 4, "exactly 4 lines (delivery appends the single disclaimer)");
  assert.match(msg, /^\*\*SPY CALL — 07\/24 \$640C\*\*$/m);
  assert.match(msg, /^Entry: \*\*\$1\.21\*\*$/m);
  assert.match(msg, /^T1: \*\*\$1\.45\*\* \| T2: \*\*\$1\.70\*\* \| Stop: \*\*\$0\.98\*\*$/m);
  assert.doesNotMatch(msg, /–|n\/a|Why:|Targets:/);
  assert.ok(msg.length < 200, "concise / mobile-friendly");
});

// ── 6. session states ──
test("session states: OPENING_DISCOVERY → REGULAR_SESSION → POWER_HOUR from the ET clock", () => {
  assert.equal(sessionState(ET(9, 45)), "OPENING_DISCOVERY");   // 09:45 ET
  assert.equal(sessionState(ET(10, 30)), "REGULAR_SESSION");    // 10:30 ET
  assert.equal(sessionState(ET(15, 30)), "POWER_HOUR");         // 15:30 ET
  assert.equal(sessionState(ET(8, 0)), "PREMARKET");
  assert.equal(sessionState(Date.UTC(2026, 6, 25, 15, 0)), "CLOSED", "Saturday is closed");
});

// ── 7. rolling opening limit: 20 candidates ≠ 20 messages; later new setup NOT blocked ──
test("opening window: 20 simultaneous broad candidates produce at most the rolling-window limit", async () => {
  const d = db();
  const openingNow = ET(9, 40); // inside OPENING_DISCOVERY
  let sends = 0;
  const send = async () => { sends += 1; return { ok: true, status: 204, messageId: "m", latencyMs: 3, ambiguous: false, error: null }; };
  const mk = (sym) => ({ candidateSymbol: sym, strategy: "momentum_acceleration", researchOnly: false, contract: { optionSymbol: `O:${sym}260724C00100000`, side: "call", strike: 100, expiration: "2026-07-24", bid: 1.0, ask: 1.1, spreadPct: 5, quoteAgeMs: 1000 }, message: "x", observedUnderlyingPrice: 100, currentUnderlyingPrice: 100, chaseLimitPct: 5, underlyingPrice: 100, decisionMs: openingNow, tier: 2 });
  for (let i = 0; i < 20; i++) await deliverOptionsCallout(mk(`BB${i}`), { getDb: () => d, send, now: () => openingNow }, ENV);
  assert.equal(sends, defaultOpeningLimit(ENV).maxAlerts, "only the best limited set is delivered, not 20");
  assert.ok(Number(d.prepare("SELECT COUNT(*) n FROM options_alerts WHERE failure_reason='opening_window_rate_limited'").get().n) >= 18);
  // rolling window releases: 11 minutes later a genuinely new setup is allowed (no fixed 60-min cooldown)
  let laterSends = 0;
  const send2 = async () => { laterSends += 1; return { ok: true, status: 204, messageId: "m", latencyMs: 3, ambiguous: false, error: null }; };
  await deliverOptionsCallout(mk("NEWSYM"), { getDb: () => d, send: send2, now: () => openingNow + 11 * 60_000 }, ENV);
  assert.equal(laterSends, 1, "the rolling window released — later new setups are never blocked indefinitely");
});

test("opening window: Tier 0 is EXEMPT from the cap so SPY beats broad opening noise", async () => {
  const d = db();
  const openingNow = ET(9, 40);
  let sends = 0;
  const send = async () => { sends += 1; return { ok: true, status: 204, messageId: "m", latencyMs: 3, ambiguous: false, error: null }; };
  const mk = (sym, tier) => ({ candidateSymbol: sym, strategy: "momentum_acceleration", researchOnly: false, contract: { optionSymbol: `O:${sym}260724C00100000`, side: "call", strike: 100, expiration: "2026-07-24", bid: 1.0, ask: 1.1, spreadPct: 5, quoteAgeMs: 1000 }, message: "x", observedUnderlyingPrice: 100, currentUnderlyingPrice: 100, chaseLimitPct: 5, underlyingPrice: 100, decisionMs: openingNow, tier });
  for (let i = 0; i < 5; i++) await deliverOptionsCallout(mk(`BB${i}`, 2), { getDb: () => d, send, now: () => openingNow }, ENV);
  const spyOut = await deliverOptionsCallout(mk("SPY", 0), { getDb: () => d, send, now: () => openingNow }, ENV);
  assert.equal(spyOut.state, "SENT", "SPY delivered even after broad names hit the opening cap");
});

// ── 8. duplicate-setup suppression, but a genuinely NEW setup still alerts ──
test("same symbol+side+strategy within the window is suppressed; a NEW strategy is a new setup", async () => {
  const d = db();
  const t = ET(11, 0); // REGULAR_SESSION
  let sends = 0;
  const send = async () => { sends += 1; return { ok: true, status: 204, messageId: "m", latencyMs: 3, ambiguous: false, error: null }; };
  const mk = (strategy, strike) => ({ candidateSymbol: "NVDA", strategy, researchOnly: false, contract: { optionSymbol: `O:NVDA260724C00${strike}000`, side: "call", strike, expiration: "2026-07-24", bid: 1.0, ask: 1.1, spreadPct: 5, quoteAgeMs: 1000 }, message: "x", observedUnderlyingPrice: 100, currentUnderlyingPrice: 100, chaseLimitPct: 5, underlyingPrice: 100, decisionMs: t, tier: 1 });
  await deliverOptionsCallout(mk("momentum_acceleration", 100), { getDb: () => d, send, now: () => t }, ENV);
  // same setup, different strike/expiration bucket 6 min later → suppressed (not a new setup)
  const dup = await deliverOptionsCallout(mk("momentum_acceleration", 105), { getDb: () => d, send, now: () => t + 6 * 60_000 }, ENV);
  assert.equal(dup.reason, "duplicate_setup");
  // a genuinely different strategy IS a new setup
  const fresh = await deliverOptionsCallout(mk("sr_reclaim", 100), { getDb: () => d, send, now: () => t + 6 * 60_000 }, ENV);
  assert.equal(fresh.state, "SENT");
  assert.equal(sends, 2);
});

// ── 9. frozen midpoint flows into the delivered mirror + persisted columns ──
test("delivered mirror uses the IDENTICAL frozen midpoint; alert row persists mid/targets/session", async () => {
  const d = db();
  const t = ET(11, 0);
  const send = async () => ({ ok: true, status: 204, messageId: "m", latencyMs: 3, ambiguous: false, error: null });
  const entry = { bid: 1.16, ask: 1.25, mid: 1.21, spreadPct: 7.5, quoteAgeMs: 900, t1: 1.45, t2: 1.7, stop: 0.98, methodology: "mid=1.21; stop=-19% (0.98); R=0.23; T1=+1R (1.45); T2=+2R (1.70)" };
  const out = await deliverOptionsCallout({ candidateSymbol: "SPY", strategy: "sr_reclaim", researchOnly: false, contract: { optionSymbol: "O:SPY260724C00640000", side: "call", strike: 640, expiration: "2026-07-24", bid: 1.16, ask: 1.25, spreadPct: 7.5, quoteAgeMs: 900, dte: 2, volume: 5000, openInterest: 9000, iv: 0.2, delta: 0.5, providerTimestamp: t - 900 }, message: "msg", observedUnderlyingPrice: 638, currentUnderlyingPrice: 638, chaseLimitPct: 5, underlyingPrice: 638, decisionMs: t, session: "regular", entry, tier: 0 }, { getDb: () => d, send, now: () => t }, { ...ENV, REAL_OPTION_PAPER_ENABLED: "1" });
  assert.equal(out.state, "SENT");
  const row = d.prepare("SELECT entry_mid, target_t1, target_t2, target_stop, session_state FROM options_alerts").get();
  assert.equal(row.entry_mid, 1.21);
  assert.equal(row.target_t1, 1.45); assert.equal(row.target_t2, 1.7); assert.equal(row.target_stop, 0.98);
  assert.equal(row.session_state, "REGULAR_SESSION");
  const mirror = d.prepare("SELECT entry_fill, target, invalidation FROM options_paper_delivered").get();
  assert.equal(mirror.entry_fill, 1.21, "mirror entry = the EXACT displayed midpoint, never improved");
  assert.equal(mirror.target, 1.45); assert.equal(mirror.invalidation, 0.98);
});

// ── 10. ranking: Tier 0 wins; then forming/earliness/spread ──
test("ranking: Tier 0 beats broad; within a tier the earlier, tighter setup wins", () => {
  const mk = (o) => ({ symbol: "X", tier: 2, forming: true, moveCompletedPct: 0.5, spreadPct: 5, liquidity: 1000, levelProximityPct: 1, extensionPct: 1, quality: 0.5, ...o });
  const ranked = rankCandidates([
    mk({ symbol: "BROAD_GOOD", tier: 2, moveCompletedPct: 0.1 }),
    mk({ symbol: "SPY", tier: 0, moveCompletedPct: 0.4 }),
    mk({ symbol: "CORE", tier: 1, moveCompletedPct: 0.05 }),
  ]);
  assert.deepEqual(ranked.map((r) => r.symbol), ["SPY", "CORE", "BROAD_GOOD"], "tier order dominates");
  const withinTier = rankCandidates([mk({ symbol: "LATE", moveCompletedPct: 0.8 }), mk({ symbol: "EARLY", moveCompletedPct: 0.1 })]);
  assert.equal(withinTier[0].symbol, "EARLY");
});

// ── 11. wide spread → reject rather than publish a misleading midpoint ──
test("a spread too wide for a credible midpoint REJECTS the alert", async () => {
  const { evaluateCallout } = await import("../lib/research/options/callout.ts");
  const r = evaluateCallout({ symbol: "XYZ", strategyKey: "sr_reclaim", researchOnly: false, contract: { optionSymbol: "O:XYZ260724C00100000", side: "call", strike: 100, expiration: "2026-07-24", dte: 2, bid: 1.0, ask: 1.6, spreadPct: 46, quoteAgeMs: 900, openInterest: 9000, volume: 5000 }, observedUnderlyingPrice: 100, observedAtMs: NOW, currentUnderlyingPrice: 100, currentAtMs: NOW, entryZone: null, targets: null, why: "x" });
  assert.equal(r.state, "REJECTED");
  assert.match(r.reason, /spread/);
});

// ── 12. rolling limiter unit behavior (no fixed cooldown) ──
test("openingWindowAllows is a rolling window, not a cooldown", () => {
  const cfg = { maxAlerts: 2, windowMs: 10 * 60_000 };
  const t0 = NOW;
  assert.equal(openingWindowAllows([], t0, cfg), true);
  assert.equal(openingWindowAllows([t0 - 1000, t0 - 2000], t0, cfg), false, "2 in window → blocked");
  assert.equal(openingWindowAllows([t0 - 11 * 60_000, t0 - 12 * 60_000], t0, cfg), true, "old sends age out → allowed");
});
