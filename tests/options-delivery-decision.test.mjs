import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { decideDeliveryBatch, computeSubscriberQuality, clusterKey, deliveryDecisionMetricsOnDb, decisionConfig } from "../lib/research/options/delivery-decision.ts";
import { runOptionsMonitorCycle, __resetOptionsMonitorForTest } from "../lib/research/options/monitor.ts";

// Portfolio-level delivery decision: technically-valid ≠ subscriber-worthy. The scanner stays sensitive;
// Discord becomes selective. NOW is a Tuesday 15:00 UTC = 11:00 ET (REGULAR_SESSION) unless stated.
const NOW = Date.UTC(2026, 6, 21, 15, 0, 0);
function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_delivery_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, symbol TEXT NOT NULL, strategy TEXT, side TEXT, tier INTEGER, outcome TEXT NOT NULL, reason TEXT, quality REAL, rank INTEGER, batch_size INTEGER, components_json TEXT, cluster_key TEXT, threshold REAL, session_state TEXT, alert_id TEXT, would_deliver_solo INTEGER, competing_json TEXT, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT, delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0, discord_status INTEGER, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT, attempted_at_ms INTEGER, sent_at_ms INTEGER, session_state TEXT, entry_mid REAL, delivered_spread_pct REAL, quote_ts_ms INTEGER, target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT, feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT, experiment_id TEXT, experiment_variant TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE VIEW options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
          CREATE VIEW options_paper_research AS SELECT * FROM options_paper_trades WHERE paper_kind='RESEARCH_ONLY_PAPER';
          CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL);`);
  return d;
}
const dIn = (sym) => ({ candidateSymbol: sym, strategy: "sr_reclaim", researchOnly: false, contract: { optionSymbol: `O:${sym}260724C00100000`, side: "call", strike: 100, expiration: "2026-07-24", bid: 1.0, ask: 1.1, spreadPct: 5, quoteAgeMs: 1000 }, message: "x", observedUnderlyingPrice: 100, currentUnderlyingPrice: 100, chaseLimitPct: 5, underlyingPrice: 100, decisionMs: NOW });
// fixtures with known quality (see computed expectations in comments)
const STRONG = (sym, tier = 1) => ({ deliveryInput: dIn(sym), symbol: sym, side: "call", strategy: "sr_reclaim", researchOnly: false, tier, matchedSignals: 3, requiredSignals: 4, strategyScore: 0.75, spreadPct: 4, openInterest: 5000, volume: 1000, fractionMove: 0.3, levelProximityPct: 0.4, nowMs: NOW });   // ≈0.72
const MEDIOCRE = (sym, tier = 1) => ({ deliveryInput: dIn(sym), symbol: sym, side: "call", strategy: "pullback_continuation", researchOnly: false, tier, matchedSignals: 2, requiredSignals: 2, strategyScore: 1.0, spreadPct: 8, openInterest: 600, volume: 100, fractionMove: null, levelProximityPct: null, nowMs: NOW }); // ≈0.56
const EXCELLENT = (sym, tier = 1) => ({ deliveryInput: dIn(sym), symbol: sym, side: "call", strategy: "breakout_forming", researchOnly: false, tier, matchedSignals: 4, requiredSignals: 4, strategyScore: 1.0, spreadPct: 2, openInterest: 20000, volume: 5000, fractionMove: 0.1, levelProximityPct: 0.2, nowMs: NOW }); // ≈0.89
const WEAK = (sym) => ({ deliveryInput: dIn(sym), symbol: sym, side: "call", strategy: "x", researchOnly: false, tier: 2, matchedSignals: 1, requiredSignals: 4, strategyScore: 0.25, spreadPct: 9.9, openInterest: 0, volume: 0, fractionMove: 0.9, levelProximityPct: null, nowMs: NOW }); // ≈0.16
const okDeliver = () => { const sent = []; return { sent, deliver: async (input) => { sent.push(input.candidateSymbol); return { state: "SENT", alertId: `oa_${input.candidateSymbol}`, sent: true }; } }; };
const ENV = { OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1" };

test("calibration fix: a thin 2-of-2 strategy scores BELOW a rich 3-of-4 despite a higher raw score", () => {
  const strong = computeSubscriberQuality(STRONG("A"), null);
  const thin = computeSubscriberQuality(MEDIOCRE("B"), null);
  assert.ok(strong.quality > thin.quality, `rich evidence ${strong.quality} must beat thin 2-of-2 ${thin.quality}`);
  assert.ok(thin.components.signalCompleteness < 0.7, "2-of-2 completeness is evidence-weighted down");
});

test("hard gates alone NEVER reach Discord: a mediocre candidate becomes RESEARCH_ONLY, not an alert", async () => {
  const d = db(); const { sent, deliver } = okDeliver();
  const out = await decideDeliveryBatch([MEDIOCRE("NVDA")], { getDb: () => d, now: () => NOW, deliver }, ENV);
  assert.equal(out[0].outcome, "RESEARCH_ONLY");
  assert.match(out[0].reason, /below_subscriber_threshold/);
  assert.equal(sent.length, 0, "zero Discord messages for merely-acceptable setups");
});

test("batch competition: best delivered; good-but-not-great withheld_by ranking bar; weak REJECTED", async () => {
  const d = db(); const { sent, deliver } = okDeliver();
  const out = await decideDeliveryBatch([MEDIOCRE("AAA"), STRONG("NVDA"), WEAK("ZZZ")], { getDb: () => d, now: () => NOW, deliver }, ENV);
  const bySym = Object.fromEntries(out.map((o) => [o.symbol, o]));
  assert.equal(bySym.NVDA.outcome, "DELIVER_TO_DISCORD");
  assert.match(bySym.NVDA.reason, /subscriber_worthy/);
  assert.equal(bySym.AAA.outcome, "RESEARCH_ONLY");
  assert.equal(bySym.ZZZ.outcome, "REJECT");
  assert.deepEqual(sent, ["NVDA"], "only the worthy candidate interrupted subscribers");
});

test("correlation: SPY+QQQ same side = ONE index thesis → strongest delivers, other RESEARCH_ONLY", async () => {
  const d = db(); const { sent, deliver } = okDeliver();
  assert.equal(clusterKey("SPY", "call"), clusterKey("QQQ", "call"), "index complex is one cluster");
  const spy = STRONG("SPY", 0); const qqq = { ...STRONG("QQQ", 0), spreadPct: 5 }; // SPY slightly better
  const out = await decideDeliveryBatch([qqq, spy], { getDb: () => d, now: () => NOW, deliver }, ENV);
  const delivered = out.filter((o) => o.outcome === "DELIVER_TO_DISCORD");
  assert.equal(delivered.length, 1, "one expression of the market thesis");
  assert.equal(delivered[0].symbol, "SPY", "the stronger expression wins");
  assert.match(out.find((o) => o.symbol === "QQQ").reason, /withheld_correlation/);
  assert.equal(sent.length, 1);
});

test("independently EXCELLENT candidates may both deliver — even in the same cluster", async () => {
  const d = db(); const { sent, deliver } = okDeliver();
  const out = await decideDeliveryBatch([EXCELLENT("SPY", 0), EXCELLENT("QQQ", 0)], { getDb: () => d, now: () => NOW, deliver }, ENV);
  assert.equal(out.filter((o) => o.outcome === "DELIVER_TO_DISCORD").length, 2, "multiple alerts allowed when independently excellent");
  assert.equal(sent.length, 2);
});

test("Tier 0 priority = ranked first, NOT auto-delivered: mediocre SPY stays RESEARCH_ONLY", async () => {
  const d = db(); const { sent, deliver } = okDeliver();
  const out = await decideDeliveryBatch([MEDIOCRE("SPY", 0)], { getDb: () => d, now: () => NOW, deliver }, ENV);
  assert.equal(out[0].outcome, "RESEARCH_ONLY", "Tier 0 gets no unlimited delivery priority");
  assert.equal(sent.length, 0);
  // but when both clear the bar, Tier 0 outranks a broad name
  const out2 = await decideDeliveryBatch([STRONG("HOOD", 2), STRONG("SPY", 0)], { getDb: () => db(), now: () => NOW, deliver: okDeliver().deliver }, ENV);
  assert.equal(out2.find((o) => o.symbol === "SPY").rank, 1, "Tier 0 ranked first among equals");
});

test("correlation window vs RECENTLY DELIVERED alerts: same thesis within 15min is withheld unless excellent", async () => {
  const d = db(); const { sent, deliver } = okDeliver();
  d.prepare("INSERT INTO options_alerts (alert_id, candidate_symbol, side, state, sent_at_ms, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run("oa_prev", "QQQ", "call", "SENT", NOW - 5 * 60_000, NOW - 5 * 60_000, NOW - 5 * 60_000);
  const out = await decideDeliveryBatch([STRONG("SPY", 0)], { getDb: () => d, now: () => NOW, deliver }, ENV);
  assert.equal(out[0].outcome, "RESEARCH_ONLY");
  assert.match(out[0].reason, /withheld_correlation/);
  assert.equal(out[0].wouldDeliverSolo, false, "solo answer accounts for the recent correlated alert");
  const out2 = await decideDeliveryBatch([EXCELLENT("SPY", 0)], { getDb: () => d, now: () => NOW, deliver }, ENV);
  assert.equal(out2[0].outcome, "DELIVER_TO_DISCORD", "independently excellent still clears a recent cluster");
});

test("opening session raises the bar: a candidate that delivers midday is withheld at 9:35 ET", async () => {
  // borderline fixture: quality ≈0.674 — clears the 0.62 midday bar, NOT the 0.68 opening bar
  const BORDERLINE = (nowMs) => ({ ...STRONG("NVDA"), spreadPct: 6, openInterest: 1500, nowMs });
  const midday = await decideDeliveryBatch([BORDERLINE(NOW)], { getDb: () => db(), now: () => NOW, deliver: okDeliver().deliver }, ENV);
  assert.equal(midday[0].outcome, "DELIVER_TO_DISCORD");
  const openMs = Date.UTC(2026, 6, 21, 13, 35, 0); // 9:35 ET Tuesday
  const opening = await decideDeliveryBatch([BORDERLINE(openMs)], { getDb: () => db(), now: () => openMs, deliver: okDeliver().deliver }, ENV);
  assert.equal(opening[0].sessionState, "OPENING_DISCOVERY");
  assert.equal(opening[0].outcome, "RESEARCH_ONLY", "≈0.674 quality clears 0.62 midday but not 0.68 at the open");
  assert.ok(opening[0].threshold > midday[0].threshold);
});

test("every decision persists the full rationale: rank, quality, cluster, competitors, threshold, solo", async () => {
  const d = db();
  await decideDeliveryBatch([STRONG("NVDA"), MEDIOCRE("AAA")], { getDb: () => d, now: () => NOW, deliver: okDeliver().deliver }, ENV);
  const rows = d.prepare("SELECT * FROM options_delivery_decisions ORDER BY rank").all();
  assert.equal(rows.length, 2, "withheld candidates are recorded too");
  const win = rows.find((r) => r.symbol === "NVDA");
  assert.equal(win.outcome, "DELIVER_TO_DISCORD");
  assert.match(win.reason, /subscriber_worthy/);
  assert.ok(win.quality > 0.6 && win.rank === 1 && win.batch_size === 2 && win.threshold > 0);
  assert.equal(win.would_deliver_solo, 1);
  assert.ok(JSON.parse(win.components_json).signalCompleteness > 0);
  const competing = JSON.parse(win.competing_json);
  assert.equal(competing[0].symbol, "AAA", "competing candidates + why they were withheld are stored");
  const loser = rows.find((r) => r.symbol === "AAA");
  assert.match(loser.reason, /below_subscriber_threshold/);
});

test("observability metrics: counts by outcome, withheld reasons, avg vs delivered quality", async () => {
  const d = db();
  await decideDeliveryBatch([STRONG("NVDA"), MEDIOCRE("AAA"), WEAK("ZZZ")], { getDb: () => d, now: () => NOW, deliver: okDeliver().deliver }, ENV);
  const m = deliveryDecisionMetricsOnDb(d);
  assert.equal(m.candidatesRanked, 3);
  assert.equal(m.delivered, 1);
  assert.equal(m.researchOnly, 1);
  assert.equal(m.rejected, 1);
  assert.equal(m.withheldByThreshold, 1);
  assert.ok(m.avgDeliveredQuality > m.avgQuality, "delivered quality exceeds the average candidate");
});

test("END-TO-END: monitor cycle in portfolio mode collects READY candidates and flushes ONE ranked decision", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const env = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", EARLY_OPTIONS_CALLOUTS_ENABLED: "1", OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1", OPTIONS_CALLOUTS_KILL: "1" }; // kill switch: decisions recorded, no real send
  const snap = (syms) => new Map(syms.map((s) => [s, { price: 500, dayDollarVolume: 900_000_000, relVolume: 3, velPct: 1, accelPct: 1, gapPct: null, aboveVwap: true, hodBreak: null, nearResistancePct: null, compressionPct: null, realizedVolExpanding: null, openingRange: null, premarketLevelTest: null }]));
  const chain = (sym) => [{ optionSymbol: `O:${sym}260724C00500000`, side: "call", strike: 500, expiration: "2026-07-24", dte: 2, bid: 1.2, ask: 1.3, spreadPct: 8, volume: 400, openInterest: 1200, iv: 0.5, delta: 0.5, providerTimestamp: NOW - 1000 }];
  await runOptionsMonitorCycle(1, ["NVDA", "TSLA"], { now: () => NOW, session: () => "regular", getDb: () => d, getUnderlyingBatch: async (s) => snap(s), getChain: async (sym) => chain(sym) }, env);
  const rows = d.prepare("SELECT symbol, outcome, rank, batch_size FROM options_delivery_decisions").all();
  assert.ok(rows.length >= 2, "both READY candidates entered ONE ranked batch");
  assert.equal(new Set(rows.map((r) => r.batch_size)).size, 1, "single batch — candidates competed against each other");
  // sensitivity preserved: candidate rows exist for everything regardless of the delivery outcome
  assert.ok(d.prepare("SELECT COUNT(*) n FROM options_candidates").get().n >= 2);
});

test("flag OFF → zero decision rows and legacy immediate-delivery path (unchanged behavior)", async () => {
  __resetOptionsMonitorForTest();
  const d = db();
  const env = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", EARLY_OPTIONS_CALLOUTS_ENABLED: "1", OPTIONS_CALLOUTS_KILL: "1" };
  const snap = (syms) => new Map(syms.map((s) => [s, { price: 500, dayDollarVolume: 900_000_000, relVolume: 3, velPct: 1, accelPct: 1, gapPct: null, aboveVwap: true, hodBreak: null, nearResistancePct: null, compressionPct: null, realizedVolExpanding: null, openingRange: null, premarketLevelTest: null }]));
  const chain = (sym) => [{ optionSymbol: `O:${sym}260724C00500000`, side: "call", strike: 500, expiration: "2026-07-24", dte: 2, bid: 1.2, ask: 1.3, spreadPct: 8, volume: 400, openInterest: 1200, iv: 0.5, delta: 0.5, providerTimestamp: NOW - 1000 }];
  await runOptionsMonitorCycle(1, ["NVDA"], { now: () => NOW, session: () => "regular", getDb: () => d, getUnderlyingBatch: async (s) => snap(s), getChain: async (sym) => chain(sym) }, env);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_delivery_decisions").get().n, 0, "portfolio layer is a hard no-op when the flag is off");
});

test("puts stay research-only in the decision layer too (bearish safeguards untouched)", async () => {
  const put = { ...EXCELLENT("NVDA"), side: "put", researchOnly: true };
  const { sent, deliver } = okDeliver();
  const out = await decideDeliveryBatch([put], { getDb: () => db(), now: () => NOW, deliver }, ENV);
  assert.equal(out[0].outcome, "RESEARCH_ONLY");
  assert.equal(out[0].reason, "research_only_put");
  assert.equal(sent.length, 0);
});

test("decision config is env-tunable and clamped", () => {
  const c = decisionConfig({ OPTIONS_QUALITY_DELIVER_BAR: "0.7", OPTIONS_MAX_DELIVER_PER_FLUSH: "3" });
  assert.equal(c.deliverBar, 0.7);
  assert.equal(c.maxPerFlush, 3);
  assert.equal(decisionConfig({ OPTIONS_QUALITY_DELIVER_BAR: "7" }).deliverBar, 0.62, "out-of-range falls back to default");
});
