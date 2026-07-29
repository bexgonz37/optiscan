import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runOpportunityLifecycleSmoke } from "../lib/research/options/lifecycle-smoke.ts";

function install(d) {
  d.exec(`
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT,
      research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT,
      delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0,
      discord_status INTEGER, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT,
      attempted_at_ms INTEGER, sent_at_ms INTEGER, session_state TEXT, entry_mid REAL, delivered_spread_pct REAL,
      quote_ts_ms INTEGER, target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT,
      opportunity_case_id TEXT, opportunity_fingerprint TEXT, thesis_fingerprint TEXT, discord_message_id TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
      result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL,
      volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL,
      strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL,
      exit_fill REAL, pnl REAL, return_pct REAL, exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER,
      session TEXT, core_broad TEXT, feature_snapshot_json TEXT, paper_kind TEXT, alert_id TEXT, entry_source TEXT,
      experiment_id TEXT, experiment_variant TEXT, thesis_fingerprint TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX options_paper_one_active_thesis_idx
      ON options_paper_trades(thesis_fingerprint)
      WHERE status='ENTERED' AND thesis_fingerprint IS NOT NULL;
    CREATE VIEW options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
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
      session_date TEXT NOT NULL, lifecycle_status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      discord_message_id TEXT, opening_source TEXT
    );
    CREATE TABLE opportunity_contract_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_case_id TEXT NOT NULL,
      thesis_fingerprint TEXT NOT NULL, opportunity_fingerprint TEXT NOT NULL,
      option_symbol TEXT NOT NULL, previous_option_symbol TEXT, reason TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL, expiration TEXT, previous_expiration TEXT,
      strike REAL, previous_strike REAL, expiration_difference_days INTEGER,
      strike_difference REAL, liquidity_json TEXT, spread_json TEXT, delta_json TEXT,
      original_contract_remains_valid INTEGER, details_json TEXT,
      created_at_ms INTEGER NOT NULL,
      UNIQUE(opportunity_case_id, opportunity_fingerprint)
    );
    CREATE TABLE opportunity_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_case_id TEXT NOT NULL, event_key TEXT NOT NULL,
      event_type TEXT NOT NULL, milestone_percent REAL, label TEXT NOT NULL, reached_at_ms INTEGER NOT NULL,
      contract_mark REAL, return_percent REAL, delivered_at_ms INTEGER, claim_token TEXT,
      discord_message_id TEXT, details_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      UNIQUE(opportunity_case_id, event_key)
    );
    CREATE TABLE opportunity_evidence_events (
      id TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL, observed_at_ms INTEGER NOT NULL,
      source TEXT NOT NULL, signal_type TEXT NOT NULL, score REAL, details_json TEXT, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE opportunity_content_events (
      id TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL, event_type TEXT NOT NULL, symbol TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL, frozen_entry REAL, current_mark REAL, return_percent REAL,
      milestone_percent REAL, max_return_percent REAL, direction TEXT, option_type TEXT, strike REAL,
      expiration TEXT, original_thesis_json TEXT, evidence_summary_json TEXT, strategy_key TEXT,
      content_status TEXT NOT NULL DEFAULT 'PENDING', label TEXT, payload_json TEXT, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE opportunity_suppression_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, strategy TEXT, fingerprint TEXT,
      existing_opportunity_case_id TEXT, decision TEXT NOT NULL, reason TEXT NOT NULL,
      latest_return_percent REAL, next_undelivered_milestone REAL, details_json TEXT, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE options_runtime (key TEXT PRIMARY KEY, value TEXT, updated_at_ms INTEGER NOT NULL);
  `);
}

test("lifecycle smoke is disabled unless OPTIONS_LIFECYCLE_SMOKE=1", async () => {
  const d = new Database(":memory:");
  install(d);
  const r = await runOpportunityLifecycleSmoke({
    getDb: () => d,
    env: { OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED: "1" },
    send: async () => ({ ok: true, status: 204, messageId: "m", latencyMs: 1, ambiguous: false, error: null }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /OPTIONS_LIFECYCLE_SMOKE/);
});

test("lifecycle smoke: open once, suppress duplicate+evidence, milestone reply, close", async () => {
  const d = new Database(":memory:");
  install(d);
  const payloads = [];
  let n = 0;
  const r = await runOpportunityLifecycleSmoke({
    getDb: () => d,
    now: () => 1_700_000_000_000,
    env: {
      OPTIONS_LIFECYCLE_SMOKE: "1",
      OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED: "1",
      INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
      EARLY_OPTIONS_CALLOUTS_ENABLED: "1",
      OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",
    },
    send: async (p) => {
      payloads.push(p);
      n += 1;
      return { ok: true, status: 204, messageId: `msg${n}`, latencyMs: 1, ambiguous: false, error: null };
    },
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.openingSent, true);
  assert.equal(r.duplicateSuppressed, true);
  assert.ok(r.evidenceAttached >= 1);
  assert.equal(r.milestoneSent, true);
  assert.equal(r.milestonePercent, 50);
  assert.equal(r.milestoneRepliedToOpening, true);
  assert.equal(r.closed, true);
  assert.equal(r.closeSent, true);
  assert.equal(r.closeRepliedToOpening, true);
  assert.equal(payloads.length, 3, "exactly one opening + one milestone + one close Discord payload");
  assert.ok(payloads[1].message_reference?.message_id, "milestone references opening message");
  assert.ok(payloads[2].message_reference?.message_id, "close references opening message");
  assert.match(String(payloads[2].content), /CLOSED/);
});
