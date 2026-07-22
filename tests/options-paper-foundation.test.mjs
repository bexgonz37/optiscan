import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { deliverOptionsCallout } from "../lib/research/options/delivery.ts";
import { persistRealOptionPaperOnDb, persistDeliveredMirrorOnDb, buildRealOptionEntry } from "../lib/research/options/paper.ts";
import { readOptionsReportOnDb } from "../lib/research/options/report.ts";

// Data foundation for the future AI Research Lab: DELIVERED_ALERT_PAPER (subscriber mirror) and
// RESEARCH_ONLY_PAPER (shadow/experiment) are STRUCTURALLY separated and can never mix in stats.

const NOW = 1_700_000_000_000;
const OCC = "O:NVDA260117C00100000";
function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE options_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT, selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL, considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT, chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT, earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT, created_at_ms INTEGER NOT NULL);
          CREATE TABLE options_paper_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER, result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL, volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL, strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL, exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT, feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT, experiment_id TEXT, experiment_variant TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE VIEW options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
          CREATE VIEW options_paper_research AS SELECT * FROM options_paper_trades WHERE paper_kind='RESEARCH_ONLY_PAPER';
          CREATE TABLE options_alerts (alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT, delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0, discord_status INTEGER, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT, attempted_at_ms INTEGER, sent_at_ms INTEGER, session_state TEXT, entry_mid REAL, delivered_spread_pct REAL, quote_ts_ms INTEGER, target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);`);
  return d;
}
const ENV = { INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1", EARLY_OPTIONS_CALLOUTS_ENABLED: "1", REAL_OPTION_PAPER_ENABLED: "1" };
const contract = (over = {}) => ({ optionSymbol: OCC, side: "call", strike: 100, expiration: "2026-01-17", bid: 1.0, ask: 1.1, spreadPct: 5, quoteAgeMs: 1000, dte: 5, volume: 500, openInterest: 2000, iv: 0.5, delta: 0.5, providerTimestamp: NOW - 1000, ...over });
const input = (over = {}) => ({ candidateSymbol: "NVDA", strategy: "momentum_acceleration", researchOnly: false, contract: contract(), message: "buy", observedUnderlyingPrice: 100, currentUnderlyingPrice: 100, chaseLimitPct: 5, underlyingPrice: 100, decisionMs: NOW, session: "regular", ...over });
const okSend = async () => ({ ok: true, status: 204, messageId: "m1", latencyMs: 5, ambiguous: false, error: null });

test("a delivered alert creates EXACTLY ONE linked DELIVERED_ALERT_PAPER (idempotent across restart)", async () => {
  const d = db();
  const first = await deliverOptionsCallout(input(), { getDb: () => d, send: okSend, now: () => NOW }, ENV);
  assert.equal(first.state, "SENT");
  assert.equal(first.paperLinked, true);
  const rows = d.prepare("SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER'").all();
  assert.equal(rows.length, 1, "exactly one mirror");
  // the mirror preserves the exact alert linkage + contract + quote + underlying + strategy + timestamp
  const alertId = first.alertId;
  assert.equal(rows[0].alert_id, alertId);
  assert.equal(rows[0].option_symbol, OCC);
  assert.equal(rows[0].bid, 1.0);
  assert.equal(rows[0].ask, 1.1);
  assert.equal(rows[0].underlying_price, 100);
  assert.equal(rows[0].strategy, "momentum_acceleration");
  assert.equal(rows[0].entered_at_ms, NOW, "entry uses the decision timestamp, not a later time");
  assert.equal(rows[0].entry_source, "discord_delivery");
  // "restart" → same DB, deliver again: dedup suppresses, still exactly one mirror (no second entry).
  const second = await deliverOptionsCallout(input(), { getDb: () => d, send: okSend, now: () => NOW }, ENV);
  assert.match(second.reason, /duplicate/);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER'").get().n, 1);
});

test("a FAILED Discord send creates NO delivered mirror (no dishonest subscriber trade)", async () => {
  const d = db();
  const out = await deliverOptionsCallout(input(), { getDb: () => d, send: async () => ({ ok: false, status: 500, messageId: null, latencyMs: 5, ambiguous: false, error: "discord 500" }), now: () => NOW, maxRetries: 0 }, ENV);
  assert.equal(out.state, "SEND_FAILED");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_paper_delivered").get().n, 0, "no mirror when the alert did not deliver");
});

test("a research/experiment trade can NEVER enter subscriber statistics", () => {
  const d = db();
  // subscriber mirror: a modest closed loss
  const entry = buildRealOptionEntry({ quote: { optionSymbol: OCC, side: "call", strike: 100, expiration: "2026-01-17", dte: 5, bid: 2.0, ask: 2.1, volume: 500, openInterest: 2000, iv: 0.5, delta: 0.5, quoteAgeMs: 1000, providerTimestamp: NOW }, underlyingPrice: 100, strategy: "momentum_acceleration" }, ENV);
  persistDeliveredMirrorOnDb(d, entry, NOW, "oa_test");
  d.prepare("UPDATE options_paper_trades SET status='EXITED', return_pct=-20 WHERE paper_kind='DELIVERED_ALERT_PAPER'").run();
  // research experiment: a huge fabricated win that must NOT touch subscriber numbers
  persistRealOptionPaperOnDb(d, entry, NOW, { paperKind: "RESEARCH_ONLY_PAPER", entrySource: "research_experiment", experimentId: "exp1", experimentVariant: "aggressive_entry" });
  d.prepare("UPDATE options_paper_trades SET status='EXITED', return_pct=500 WHERE paper_kind='RESEARCH_ONLY_PAPER'").run();

  const rep = readOptionsReportOnDb(d);
  assert.equal(rep.subscriberPerformance.source, "DELIVERED_ALERT_PAPER");
  assert.equal(rep.subscriberPerformance.total, 1, "only the delivered mirror counts as subscriber");
  assert.equal(rep.subscriberPerformance.winRate, 0, "the +500% research win did NOT inflate subscriber win rate");
  assert.equal(rep.subscriberPerformance.expectancyPct, -20, "subscriber expectancy reflects ONLY delivered trades");
  assert.equal(rep.researchPaper.total, 1);
  assert.equal(rep.researchPaper.closed, 1);
});

test("the two views are disjoint and legacy rows are quarantined from BOTH", () => {
  const d = db();
  const e = buildRealOptionEntry({ quote: { optionSymbol: OCC, side: "call", strike: 100, expiration: "2026-01-17", dte: 5, bid: 2, ask: 2.1, volume: 500, openInterest: 2000, iv: 0.5, delta: 0.5, quoteAgeMs: 1000, providerTimestamp: NOW }, underlyingPrice: 100, strategy: "x" }, ENV);
  persistDeliveredMirrorOnDb(d, e, NOW, "oa_1");
  persistRealOptionPaperOnDb(d, e, NOW, { paperKind: "RESEARCH_ONLY_PAPER" });
  // a legacy row with no paper_kind (pre-foundation)
  d.prepare("INSERT INTO options_paper_trades (option_symbol, result_class, status, paper_kind, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?)").run(OCC, "REAL_OPTION_PAPER", "ENTERED", "LEGACY_UNCLASSIFIED", NOW, NOW);
  const dv = d.prepare("SELECT COUNT(*) n FROM options_paper_delivered").get().n;
  const rv = d.prepare("SELECT COUNT(*) n FROM options_paper_research").get().n;
  const total = d.prepare("SELECT COUNT(*) n FROM options_paper_trades").get().n;
  assert.equal(dv, 1);
  assert.equal(rv, 1);
  assert.equal(total, 3, "legacy row exists but appears in NEITHER view");
  assert.equal(readOptionsReportOnDb(d).legacyQuarantined, 1);
});

test("persist is FAIL-SAFE: an unlabeled paper trade defaults to RESEARCH_ONLY, never subscriber", () => {
  const d = db();
  const e = buildRealOptionEntry({ quote: { optionSymbol: OCC, side: "call", strike: 100, expiration: "2026-01-17", dte: 5, bid: 2, ask: 2.1, volume: 500, openInterest: 2000, iv: 0.5, delta: 0.5, quoteAgeMs: 1000, providerTimestamp: NOW }, underlyingPrice: 100, strategy: "x" }, ENV);
  persistRealOptionPaperOnDb(d, e, NOW); // no paperKind given
  assert.equal(d.prepare("SELECT paper_kind FROM options_paper_trades").get().paper_kind, "RESEARCH_ONLY_PAPER");
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_paper_delivered").get().n, 0, "an unlabeled trade can NEVER be a subscriber mirror");
});

test("puts are suppressed from actionable delivery → never a delivered mirror", async () => {
  const d = db();
  const out = await deliverOptionsCallout(input({ researchOnly: true, contract: contract({ side: "put" }) }), { getDb: () => d, send: okSend, now: () => NOW }, ENV);
  assert.equal(out.sent, false);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM options_paper_delivered").get().n, 0);
});
