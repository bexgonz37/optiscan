/**
 * Mocked E2E: independent deliverOptionsCallout → paper mirror → opportunity case link.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { deliverOptionsCallout } from "../lib/research/options/delivery.ts";
import { buildPaperChainDiagnostic } from "../lib/research/options/paper-chain.ts";

const ENV = {
  INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
  EARLY_OPTIONS_CALLOUTS_ENABLED: "1",
  OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",
  REAL_OPTION_PAPER_ENABLED: "1",
  OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED: "1",
  MARKET_SESSION_GUARD: "shadow",
  ENTRY_QUALITY_GATE: "shadow",
  SUBSCRIBER_OPTIONS_DISCORD_OWNER: "independent",
};

function install(d) {
  d.exec(`
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT,
      research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT,
      delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0,
      discord_status INTEGER, discord_message_id TEXT, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT, attempted_at_ms INTEGER, sent_at_ms INTEGER, session_state TEXT, entry_mid REAL,
      delivered_spread_pct REAL, quote_ts_ms INTEGER, target_t1 REAL, target_t2 REAL, target_stop REAL,
      target_method TEXT, opportunity_case_id TEXT, opportunity_fingerprint TEXT, thesis_fingerprint TEXT,
      paper_trade_id INTEGER, paper_reservation_state TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
      result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL,
      volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL,
      strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL,
      exit_fill REAL, pnl REAL, return_pct REAL, mfe_pct REAL, mae_pct REAL, last_mark_return_pct REAL,
      exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER, session TEXT, core_broad TEXT,
      feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT,
      experiment_id TEXT, experiment_variant TEXT, thesis_fingerprint TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE VIEW options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
    CREATE UNIQUE INDEX options_paper_one_live_thesis_idx
      ON options_paper_trades(thesis_fingerprint)
      WHERE status IN ('PENDING_DELIVERY','ENTERED') AND thesis_fingerprint IS NOT NULL;
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL, option_symbol TEXT,
      mark_at_ms INTEGER NOT NULL, bid REAL, ask REAL, exit_fill REAL, return_pct REAL,
      quote_age_ms INTEGER, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE opportunity_cases (
      opportunity_id TEXT PRIMARY KEY, underlying_symbol TEXT NOT NULL, direction TEXT, setup_family TEXT,
      detected_at_ms INTEGER NOT NULL, market_session TEXT, source_path TEXT NOT NULL,
      acceptance_decision TEXT NOT NULL, delivery_decision TEXT NOT NULL, rejection_reason_codes_json TEXT,
      alert_id TEXT, case_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      opportunity_fingerprint TEXT, session_date TEXT, lifecycle_status TEXT, summary_json TEXT,
      discord_channel_id TEXT, discord_message_id TEXT, discord_thread_id TEXT, opening_delivered_at_ms INTEGER,
      thesis_fingerprint TEXT, opening_source TEXT
    );
    CREATE TABLE opportunity_active_index (
      opportunity_fingerprint TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL, session_date TEXT NOT NULL, strategy_key TEXT, lifecycle_status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE opportunity_thesis_active_index (
      thesis_fingerprint TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL, direction TEXT NOT NULL, option_type TEXT NOT NULL,
      session_date TEXT NOT NULL, lifecycle_status TEXT NOT NULL, opening_source TEXT NOT NULL,
      discord_message_id TEXT, opened_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE opportunity_contract_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thesis_fingerprint TEXT NOT NULL,
      opportunity_case_id TEXT NOT NULL, opportunity_fingerprint TEXT NOT NULL,
      option_symbol TEXT NOT NULL, previous_option_symbol TEXT, side TEXT NOT NULL,
      strike REAL NOT NULL, expiration TEXT NOT NULL, strategy_key TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL, bid REAL, ask REAL, spread_pct REAL, delta REAL,
      open_interest REAL, volume REAL, reason TEXT NOT NULL, expiration_difference_days INTEGER,
      strike_difference REAL, previous_liquidity_json TEXT, new_liquidity_json TEXT,
      previous_spread_pct REAL, previous_delta REAL, original_contract_remains_valid INTEGER,
      created_at_ms INTEGER NOT NULL, UNIQUE(opportunity_case_id, opportunity_fingerprint)
    );
    CREATE UNIQUE INDEX idx_paper_chain_active_thesis
      ON options_paper_trades(paper_kind, thesis_fingerprint)
      WHERE status='ENTERED' AND thesis_fingerprint IS NOT NULL;
    CREATE TABLE opportunity_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_case_id TEXT NOT NULL, event_key TEXT NOT NULL,
      event_type TEXT NOT NULL, milestone_percent REAL, label TEXT, reached_at_ms INTEGER NOT NULL,
      contract_mark REAL, return_percent REAL, delivered_at_ms INTEGER, claim_token TEXT,
      discord_message_id TEXT, details_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      UNIQUE(opportunity_case_id, event_key)
    );
    CREATE TABLE opportunity_lifecycle_metrics (metric_key TEXT PRIMARY KEY, metric_value INTEGER NOT NULL DEFAULT 0);
  `);
}

const input = (now) => ({
  candidateSymbol: "NVDA",
  strategy: "sr_reclaim",
  researchOnly: false,
  contract: { optionSymbol: "O:NVDA260725C00100000", side: "call", strike: 100, expiration: "2026-07-27", dte: 5, bid: 1, ask: 1.1, spreadPct: 4, quoteAgeMs: 500, providerTimestamp: now - 500, volume: 500, openInterest: 2000, delta: 0.5 },
  message: "test alert",
  observedUnderlyingPrice: 100,
  currentUnderlyingPrice: 100,
  chaseLimitPct: 5,
  underlyingPrice: 100,
  entry: { bid: 1, ask: 1.1, mid: 1.05, spreadPct: 4, quoteAgeMs: 500, t1: 1.2, t2: 1.3, stop: 0.9, methodology: "test" },
});

test("paper chain E2E: SENT → paper_linked → diagnostic row", async () => {
  const d = new Database(":memory:");
  install(d);
  const now = Date.UTC(2026, 6, 22, 14, 30);
  const out = await deliverOptionsCallout(input(now), {
    getDb: () => d,
    now: () => now,
    send: async () => ({ ok: true, status: 200, latencyMs: 12, messageId: "discord-123" }),
  }, ENV);
  assert.equal(out.sent, true);
  assert.equal(out.paperLinked, true);

  const diag = buildPaperChainDiagnostic(d, ENV, 5);
  assert.equal(diag.sent24h, 0);
  assert.equal(diag.rows.length, 1);
  assert.equal(diag.rows[0].alertId, out.alertId);
  assert.equal(diag.rows[0].discordMessageId, "discord-123");
  assert.ok(diag.rows[0].paperTradeId);
  assert.equal(diag.rows[0].deliveryProofStatus, "verified_delivered");
  assert.equal(diag.rows[0].subscriberDelivered, true);
  assert.equal(diag.rows[0].graderHealth, "healthy");
  assert.equal(diag.rows[0].verifiedPnlEligible, false, "missing grading mark is excluded from verified P&L");
  assert.ok(diag.rows[0].pnlExclusionReasons.includes("missing_or_invalid_grading_mark"));
});

test("paper chain marks HTTP-accepted rows without Discord message proof as audit-only", async () => {
  const d = new Database(":memory:");
  install(d);
  const now = Date.UTC(2026, 6, 22, 14, 35);
  const out = await deliverOptionsCallout(input(now), {
    getDb: () => d,
    now: () => now,
    send: async () => ({ ok: true, status: 200, latencyMs: 12, messageId: null }),
  }, ENV);
  assert.equal(out.sent, true);
  d.prepare("UPDATE options_paper_trades SET status='EXITED', pnl=500, return_pct=500 WHERE alert_id=?").run(out.alertId);

  const diag = buildPaperChainDiagnostic(d, ENV, 5);
  assert.equal(diag.rows.length, 1);
  assert.equal(diag.rows[0].deliveryProofStatus, "app_sent_unverified");
  assert.equal(diag.rows[0].subscriberDelivered, false);
  assert.deepEqual(diag.rows[0].missingDataWarnings, ["missing_opening_discord_message_id"]);
  assert.equal(diag.sumPnlUsd, 500, "raw operational audit still sees the closed mirror");
  assert.equal(diag.verifiedSumPnlUsd, null, "unverified row cannot become subscriber-delivered performance");
});

test("verified P&L includes only proof-complete rows with valid conservative grading marks", async () => {
  const d = new Database(":memory:");
  install(d);
  const now = Date.UTC(2026, 6, 22, 14, 40);
  const out = await deliverOptionsCallout(input(now), {
    getDb: () => d,
    now: () => now,
    send: async () => ({ ok: true, status: 200, latencyMs: 12, messageId: "discord-proof" }),
  }, ENV);
  const paper = d.prepare("SELECT id, entry_fill FROM options_paper_trades WHERE alert_id=?").get(out.alertId);
  d.prepare(
    `UPDATE options_paper_trades
     SET status='EXITED', exit_fill=1.50, pnl=?, return_pct=?, last_mark_return_pct=?, exit_reason='target_hit'
     WHERE id=?`,
  ).run((1.5 - paper.entry_fill) * 100, ((1.5 - paper.entry_fill) / paper.entry_fill) * 100, ((1.5 - paper.entry_fill) / paper.entry_fill) * 100, paper.id);
  d.prepare(
    `INSERT INTO options_paper_marks
      (trade_id,option_symbol,mark_at_ms,bid,ask,exit_fill,return_pct,quote_age_ms,created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(paper.id, input(now).contract.optionSymbol, now + 60_000, 1.48, 1.52, 1.5, ((1.5 - paper.entry_fill) / paper.entry_fill) * 100, 1_000, now + 60_000);

  const diag = buildPaperChainDiagnostic(d, ENV, 5);
  assert.equal(diag.rows[0].verifiedPnlEligible, true);
  assert.equal(diag.verifiedPnlBreakdown.invalidOrStaleMarkRowsExcluded, 0);
  assert.equal(diag.verifiedPnlBreakdown.realizedClosedPnlUsd, diag.verifiedSumPnlUsd);
  assert.equal(diag.account.currentEquityUsd, 100_000 + diag.verifiedSumPnlUsd);
});

test("paper chain exposes deterministic production source and selected date window", () => {
  const d = new Database(":memory:");
  install(d);
  const now = Date.now();
  const diag = buildPaperChainDiagnostic(d, ENV, 40, now - 30 * 86_400_000);
  assert.equal(diag.dataSourceLabel, "Production database");
  assert.equal(diag.selectedWindow.label, "Last 30 days");
  assert.equal(diag.selectedWindow.days, 30);
  assert.equal(diag.selectedWindow.minSentAtMs, now - 30 * 86_400_000);
});
