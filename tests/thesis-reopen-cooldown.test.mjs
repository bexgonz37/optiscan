/**
 * Post-close thesis re-open cooldown.
 *
 * Regression: closing a case (target hit) deleted the thesis active-index row, which
 * re-armed the outward opening path. The same symbol + direction could then send a
 * SECOND opening alert minutes after the subscriber was told the first one hit T1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { deliverOptionsCallout } from "../lib/research/options/delivery.ts";
import {
  claimOpportunityOpenOnDb,
  closeOpportunityOnDb,
} from "../lib/opportunity-case/live.ts";
import {
  DEFAULT_THESIS_REOPEN_COOLDOWN_MS,
  activeThesisReopenCooldownsOnDb,
  findThesisReopenCooldownOnDb,
  thesisReopenCooldownMs,
} from "../lib/opportunity-case/reopen-cooldown.ts";

const ET = (h, m) => Date.UTC(2026, 6, 22, h + 4, m, 0);
const ENV = {
  INDEPENDENT_OPTIONS_DISCOVERY_ENABLED: "1",
  OPTIONS_PORTFOLIO_DELIVERY_ENABLED: "1",
  EARLY_OPTIONS_CALLOUTS_ENABLED: "1",
  OPTIONS_OPPORTUNITY_LIFECYCLE_ENABLED: "1",
  REAL_OPTION_PAPER_ENABLED: "1",
};
const BEARISH_ENV = { ...ENV, BEARISH_PIPELINE_ENABLED: "1", BEARISH_SUBSCRIBER_DELIVERY_ENABLED: "1" };

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE options_alerts (
      alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT,
      research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT,
      delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0,
      discord_status INTEGER, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT,
      attempted_at_ms INTEGER, sent_at_ms INTEGER, session_state TEXT, entry_mid REAL, delivered_spread_pct REAL,
      quote_ts_ms INTEGER, target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT,
      opportunity_case_id TEXT, opportunity_fingerprint TEXT, discord_message_id TEXT,
      thesis_fingerprint TEXT, paper_trade_id INTEGER, paper_reservation_state TEXT,
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
      experiment_id TEXT, experiment_variant TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      thesis_fingerprint TEXT
    );
    CREATE VIEW options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER';
    CREATE TABLE options_paper_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL, option_symbol TEXT NOT NULL,
      mark_at_ms INTEGER NOT NULL, bid REAL, ask REAL, exit_fill REAL, return_pct REAL, quote_age_ms INTEGER,
      created_at_ms INTEGER NOT NULL, UNIQUE(trade_id, mark_at_ms)
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
    CREATE TABLE opportunity_thesis_reopen_cooldown (
      thesis_fingerprint TEXT PRIMARY KEY, opportunity_case_id TEXT NOT NULL,
      symbol TEXT NOT NULL, direction TEXT NOT NULL, option_type TEXT NOT NULL, session_date TEXT NOT NULL,
      closed_at_ms INTEGER NOT NULL, close_reason TEXT, return_percent REAL,
      cooldown_until_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
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
  return d;
}

function aaplPut(t, overrides = {}) {
  return {
    candidateSymbol: "AAPL",
    strategy: "momentum_breakdown",
    researchOnly: false,
    contract: {
      optionSymbol: "O:AAPL260724P00220000",
      side: "put",
      strike: 220,
      expiration: "2026-07-24",
      bid: 3.1, ask: 3.3, spreadPct: 4.0, quoteAgeMs: 500,
      dte: 2, volume: 900, openInterest: 4000, iv: 0.38, delta: -0.45,
      providerTimestamp: t - 500,
    },
    message: "🔴 **BUYING AAPL $220 PUT** · exp 07/24\nBreaking session support on expanding volume.",
    observedUnderlyingPrice: 222, currentUnderlyingPrice: 222, underlyingPrice: 222,
    chaseLimitPct: 5, decisionMs: t, session: "regular",
    entry: { bid: 3.1, ask: 3.3, mid: 3.2, spreadPct: 4.0, quoteAgeMs: 500, t1: 3.8, t2: 4.5, stop: 2.6, methodology: "test" },
    tier: 0,
    featureSnapshot: {
      underlying: {
        velPct: -0.4, accelPct: -0.2, shortMomentumPct: -0.3,
        trendSlopePctPerBar: -0.1, aboveVwap: false, lodBreak: true,
      },
      chain: { direction: "put" },
    },
    ...overrides,
  };
}

function claimArgs(nowMs, overrides = {}) {
  return {
    symbol: "AAPL",
    side: "put",
    expiration: "2026-07-24",
    strike: 220,
    strategyKey: "momentum_breakdown",
    direction: "bearish",
    nowMs,
    openingSource: "canonical",
    ...overrides,
  };
}

// ── Cooldown window config ──────────────────────────────────────────────────
test("cooldown window defaults, parses, clamps, and can be disabled", () => {
  assert.equal(thesisReopenCooldownMs({}), DEFAULT_THESIS_REOPEN_COOLDOWN_MS);
  assert.equal(thesisReopenCooldownMs({ OPPORTUNITY_THESIS_REOPEN_COOLDOWN_MS: "600000" }), 600_000);
  assert.equal(thesisReopenCooldownMs({ OPPORTUNITY_THESIS_REOPEN_COOLDOWN_MS: "0" }), 0);
  assert.equal(
    thesisReopenCooldownMs({ OPPORTUNITY_THESIS_REOPEN_COOLDOWN_MS: "999999999" }),
    6 * 60 * 60_000,
    "clamped to 6h",
  );
  assert.equal(
    thesisReopenCooldownMs({ OPPORTUNITY_THESIS_REOPEN_COOLDOWN_MS: "not-a-number" }),
    DEFAULT_THESIS_REOPEN_COOLDOWN_MS,
  );
  assert.equal(
    thesisReopenCooldownMs({ OPPORTUNITY_THESIS_REOPEN_COOLDOWN_MS: "-5" }),
    DEFAULT_THESIS_REOPEN_COOLDOWN_MS,
    "negative is not a disable switch — only an explicit 0 is",
  );
});

// ── Claim path ──────────────────────────────────────────────────────────────
test("a closed thesis cannot be re-claimed inside the cooldown, and can after it", () => {
  const d = db();
  const t = ET(11, 0);

  const opened = claimOpportunityOpenOnDb(d, claimArgs(t, { optionSymbol: "O:AAPL260724P00220000" }));
  assert.equal(opened.claimed, true);

  closeOpportunityOnDb(d, {
    opportunityCaseId: opened.opportunityCaseId,
    nowMs: t + 10 * 60_000,
    exitReason: "target_hit",
    returnPct: 18.75,
    currentMark: 3.8,
  });

  const cooldown = findThesisReopenCooldownOnDb(d, opened.thesisFingerprint, t + 11 * 60_000);
  assert.ok(cooldown, "close records a cooldown");
  assert.equal(cooldown.closeReason, "target_hit");
  assert.equal(cooldown.symbol, "AAPL");
  assert.equal(cooldown.optionType, "PUT");
  assert.equal(cooldown.cooldownUntilMs, t + 10 * 60_000 + DEFAULT_THESIS_REOPEN_COOLDOWN_MS);

  const tooSoon = claimOpportunityOpenOnDb(d, claimArgs(t + 12 * 60_000, { optionSymbol: "O:AAPL260724P00220000" }));
  assert.equal(tooSoon.claimed, false);
  assert.equal(tooSoon.reason, "THESIS_REOPEN_COOLDOWN");
  assert.equal(tooSoon.cooldown?.opportunityCaseId, opened.opportunityCaseId);

  // A different strike is still the SAME thesis (symbol + direction + type) — also blocked.
  const otherStrike = claimOpportunityOpenOnDb(
    d,
    claimArgs(t + 13 * 60_000, { strike: 215, optionSymbol: "O:AAPL260724P00215000" }),
  );
  assert.equal(otherStrike.claimed, false);
  assert.equal(otherStrike.reason, "THESIS_REOPEN_COOLDOWN");

  const afterWindow = claimOpportunityOpenOnDb(
    d,
    claimArgs(t + 10 * 60_000 + DEFAULT_THESIS_REOPEN_COOLDOWN_MS + 1, { optionSymbol: "O:AAPL260724P00220000" }),
  );
  assert.equal(afterWindow.claimed, true, "the window expires — this is a cooldown, not a permanent ban");
});

test("the cooldown is direction-scoped: a closed PUT does not block a CALL", () => {
  const d = db();
  const t = ET(11, 0);
  const put = claimOpportunityOpenOnDb(d, claimArgs(t, { optionSymbol: "O:AAPL260724P00220000" }));
  assert.equal(put.claimed, true);
  closeOpportunityOnDb(d, {
    opportunityCaseId: put.opportunityCaseId,
    nowMs: t + 60_000,
    exitReason: "target_hit",
    returnPct: 18.75,
  });

  const call = claimOpportunityOpenOnDb(d, claimArgs(t + 2 * 60_000, {
    side: "call",
    direction: "bullish",
    strike: 230,
    optionSymbol: "O:AAPL260724C00230000",
  }));
  assert.equal(call.claimed, true, "the opposite direction is a different thesis");
});

test("a later close extends the window but never shortens it", () => {
  const d = db();
  const t = ET(11, 0);
  const first = claimOpportunityOpenOnDb(d, claimArgs(t, { optionSymbol: "O:AAPL260724P00220000" }));
  closeOpportunityOnDb(d, { opportunityCaseId: first.opportunityCaseId, nowMs: t + 60_000, exitReason: "target_hit" });
  const after = t + 60_000 + DEFAULT_THESIS_REOPEN_COOLDOWN_MS + 1;
  const second = claimOpportunityOpenOnDb(d, claimArgs(after, { optionSymbol: "O:AAPL260724P00220000" }));
  assert.equal(second.claimed, true);

  closeOpportunityOnDb(d, { opportunityCaseId: second.opportunityCaseId, nowMs: after + 60_000, exitReason: "stop_hit" });
  const cooldown = findThesisReopenCooldownOnDb(d, second.thesisFingerprint, after + 2 * 60_000);
  assert.ok(cooldown);
  assert.equal(cooldown.closeReason, "stop_hit");
  assert.equal(cooldown.cooldownUntilMs, after + 60_000 + DEFAULT_THESIS_REOPEN_COOLDOWN_MS);
  assert.equal(activeThesisReopenCooldownsOnDb(d, after + 2 * 60_000).length, 1, "one row per thesis, not one per close");
});

test("an explicit zero window disables the gate", () => {
  const d = db();
  const t = ET(11, 0);
  const env = { OPPORTUNITY_THESIS_REOPEN_COOLDOWN_MS: "0" };
  const opened = claimOpportunityOpenOnDb(d, claimArgs(t, { optionSymbol: "O:AAPL260724P00220000" }));
  closeOpportunityOnDb(d, {
    opportunityCaseId: opened.opportunityCaseId,
    nowMs: t + 60_000,
    exitReason: "target_hit",
    env,
  });
  assert.equal(findThesisReopenCooldownOnDb(d, opened.thesisFingerprint, t + 2 * 60_000), null);
  const again = claimOpportunityOpenOnDb(d, claimArgs(t + 2 * 60_000, { optionSymbol: "O:AAPL260724P00220000" }));
  assert.equal(again.claimed, true);
});

test("a database without the cooldown table still closes and re-claims (additive migration)", () => {
  const d = db();
  d.exec("DROP TABLE opportunity_thesis_reopen_cooldown");
  const t = ET(11, 0);
  const opened = claimOpportunityOpenOnDb(d, claimArgs(t, { optionSymbol: "O:AAPL260724P00220000" }));
  closeOpportunityOnDb(d, { opportunityCaseId: opened.opportunityCaseId, nowMs: t + 60_000, exitReason: "target_hit" });
  const again = claimOpportunityOpenOnDb(d, claimArgs(t + 2 * 60_000, { optionSymbol: "O:AAPL260724P00220000" }));
  assert.equal(again.claimed, true, "pre-migration deployments keep their old behaviour rather than crashing");
});

// ── Delivery path (the reported bug) ────────────────────────────────────────
test("no second AAPL PUT opening alert is sent after the first one closed at T1", async () => {
  const d = db();
  const t = ET(11, 0);
  let sends = 0;
  const send = async () => {
    sends += 1;
    return { ok: true, status: 204, messageId: `m${sends}`, latencyMs: 2, ambiguous: false, error: null };
  };

  const first = await deliverOptionsCallout(aaplPut(t), { getDb: () => d, send, now: () => t }, BEARISH_ENV);
  assert.equal(first.state, "SENT", JSON.stringify(first));
  assert.equal(sends, 1);

  // The play reaches T1 and the case closes.
  closeOpportunityOnDb(d, {
    opportunityCaseId: first.opportunityCaseId,
    nowMs: t + 8 * 60_000,
    exitReason: "target_hit",
    returnPct: 18.75,
    currentMark: 3.8,
  });

  // The scanner re-detects the same breakdown a few minutes later.
  const t2 = t + 12 * 60_000;
  const second = await deliverOptionsCallout(aaplPut(t2), { getDb: () => d, send, now: () => t2 }, BEARISH_ENV);
  assert.equal(second.state, "REJECTED");
  assert.equal(second.reason, "thesis_reopen_cooldown");
  assert.equal(second.suppressedDuplicate, true);
  assert.equal(sends, 1, "the subscriber gets exactly one opening alert for this play");

  const logged = d.prepare(
    "SELECT reason, decision, existing_opportunity_case_id FROM opportunity_suppression_log ORDER BY id DESC LIMIT 1",
  ).get();
  assert.equal(logged.reason, "THESIS_REOPEN_COOLDOWN");
  assert.equal(logged.decision, "SUPPRESSED_REOPEN");
  assert.equal(logged.existing_opportunity_case_id, first.opportunityCaseId);
});
