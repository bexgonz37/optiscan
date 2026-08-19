/**
 * db.ts — SQLite storage for Alert Lab (better-sqlite3).
 *
 * One local file: data/optiscan.db (override dir with ALERT_DB_DIR). WAL mode
 * for safe concurrent reads while the tracker writes. The handle is cached on
 * globalThis so Next.js dev-mode module reloads don't leak connections.
 *
 * Like the scan cache, this is process-local by design — single-instance
 * `next start`/`next dev` is the supported deployment (see README).
 *
 * Migrations: CREATE TABLE IF NOT EXISTS for new tables, plus guarded ALTERs
 * so existing databases pick up new alert columns without data loss.
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { ensureEnterpriseSchemaOnDb, inspectSchemaReadiness } from "@/lib/db-schema-readiness";
import {
  ensureOptionsDeliveryDecisionsColumns,
  ensureOptionsShadowDecisionsColumns,
  ensureOptionsShadowOutcomesColumns,
  ensureSubscriberPipelineInstrumentationColumns,
  OPTIONS_ALERTS_INSTRUMENTATION_MIGRATIONS,
  OPTIONS_CANDIDATES_INSTRUMENTATION_MIGRATIONS,
} from "@/lib/db-legacy-columns";
import { ensureBrokerSchemaOnDb } from "@/lib/broker/schema-migrate";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  source TEXT NOT NULL,               -- 'momentum' | 'unusual' | 'manual'
  direction TEXT,                     -- 'bullish' | 'bearish' | 'neutral'
  option_symbol TEXT,
  option_side TEXT,                   -- 'call' | 'put'
  strike REAL,
  expiration TEXT,
  dte INTEGER,
  alert_time TEXT NOT NULL,           -- ISO UTC
  trading_day TEXT NOT NULL,          -- YYYY-MM-DD in US/Eastern
  price_at_alert REAL,
  percent_move_at_alert REAL,
  volume REAL,                        -- underlying share volume at alert
  relative_volume REAL,
  catalyst_type TEXT,
  catalyst_quality TEXT,
  catalyst_summary TEXT,
  catalyst_source TEXT,
  signal_score REAL,                  -- setup score (0-100)
  risk_score REAL,
  options_liquidity_score REAL,
  scanner_score REAL,                 -- raw score from the scanner tab
  status TEXT NOT NULL DEFAULT 'tracking',  -- 'tracking' | 'complete'
  is_false_positive INTEGER,          -- null until EOD checkpoint decides
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_dedup_lookup
  ON alerts(ticker, source, trading_day, alert_time);
CREATE INDEX IF NOT EXISTS idx_alerts_day ON alerts(trading_day);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);

CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  ticker TEXT NOT NULL,
  option_symbol TEXT,
  option_type TEXT NOT NULL,            -- 'call' | 'put'
  strike REAL,
  expiration TEXT,                      -- YYYY-MM-DD
  dte_at_entry INTEGER,
  contracts INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'READY', -- WATCHING/READY/ENTERED/EXITED/STOPPED_OUT/TAKE_PROFIT/CANCELLED/EXPIRED
  thesis TEXT,
  confidence REAL,
  entry_limit REAL,
  entry_price REAL,
  entry_at_ms INTEGER,
  stop_loss_pct REAL,
  take_profit_pct REAL,
  exit_price REAL,
  exit_at_ms INTEGER,
  exit_reason TEXT,
  mfe_pct REAL,
  mae_pct REAL,
  opportunity_peak_pct REAL,            -- lifetime peak favorable %, tracked past exit to expiration
  last_mark REAL,
  last_mark_at_ms INTEGER,
  short_rate_entry REAL,                -- thesis snapshot for smart exits
  above_vwap_entry INTEGER,
  rel_vol_entry REAL,
  lessons TEXT,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_paper_status ON paper_trades(status);
CREATE INDEX IF NOT EXISTS idx_paper_ticker ON paper_trades(ticker);

CREATE TABLE IF NOT EXISTS alert_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  checkpoint TEXT NOT NULL,           -- '5m' | '15m' | '30m' | '1h' | 'eod'
  checked_at TEXT NOT NULL,
  price_at_checkpoint REAL,
  percent_move_from_alert REAL,       -- FAVORABLE-signed: + = moved with the signal
  max_price_after_alert REAL,         -- most favorable price seen so far
  max_percent_move_after_alert REAL,  -- favorable-signed extreme move so far
  drawdown_after_alert REAL,          -- worst adverse move so far (<= 0)
  is_false_positive INTEGER,          -- set on 'eod' rows only
  UNIQUE(alert_id, checkpoint)
);
CREATE INDEX IF NOT EXISTS idx_perf_alert ON alert_performance(alert_id);

CREATE TABLE IF NOT EXISTS trade_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  ticker TEXT NOT NULL,
  side TEXT,                          -- 'call' | 'put' | 'shares' | 'spread' | 'no trade'
  contract TEXT,                      -- contract selected (option symbol)
  entry_price REAL,
  exit_price REAL,
  quantity REAL,
  opened_at TEXT,
  closed_at TEXT,
  outcome_pct REAL,
  pnl REAL,
  entry_reason TEXT,
  exit_reason TEXT,
  mistake_notes TEXT,
  screenshot_url TEXT,
  emotion_tag TEXT,
  lesson TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_journal_alert ON trade_journal(alert_id);

CREATE TABLE IF NOT EXISTS options_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  taken_at TEXT NOT NULL,
  checkpoint TEXT NOT NULL DEFAULT 'alert',
  option_symbol TEXT,
  bid REAL, ask REAL, mid REAL,
  spread_pct REAL,
  volume REAL,
  open_interest REAL,
  iv REAL,
  delta REAL
);
CREATE INDEX IF NOT EXISTS idx_snap_alert ON options_snapshots(alert_id);

CREATE TABLE IF NOT EXISTS catalyst_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  headline TEXT,
  publisher TEXT,
  published_at TEXT,
  url TEXT,
  catalyst_type TEXT,
  quality TEXT,
  matched_keywords TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cat_alert ON catalyst_records(alert_id);

CREATE TABLE IF NOT EXISTS scanner_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS score_breakdowns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  breakdown_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_breakdown_alert ON score_breakdowns(alert_id);

CREATE TABLE IF NOT EXISTS popup_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  ticker TEXT,
  action TEXT NOT NULL,               -- 'shown'|'watch'|'journal'|'trade_taken'|'snooze'|'ignore'|'open_chain'|'open_details'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS alert_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_feedback TEXT NOT NULL,
  feedback_reason TEXT,
  notes TEXT,
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_alert_feedback_alert ON alert_feedback(alert_id);

CREATE TABLE IF NOT EXISTS notification_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  browser_popup_enabled INTEGER NOT NULL DEFAULT 1,
  desktop_notification_enabled INTEGER NOT NULL DEFAULT 1,
  sound_enabled INTEGER NOT NULL DEFAULT 1,
  discord_enabled INTEGER NOT NULL DEFAULT 1,
  discord_requires_manual_confirm INTEGER NOT NULL DEFAULT 0,
  public_mode_required_for_discord INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
);
INSERT OR IGNORE INTO notification_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,              -- 'browser_popup'|'browser_desktop_notification'|'sound_alert'|'discord_webhook'|'email_later'|'sms_later'
  status TEXT NOT NULL,               -- 'sent'|'pending_confirm'|'failed'|'skipped'
  payload_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_status ON notification_events(status);

CREATE TABLE IF NOT EXISTS discord_deliveries (
  delivery_id TEXT PRIMARY KEY,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  channel_type TEXT NOT NULL,
  webhook_name TEXT NOT NULL,
  payload_type TEXT NOT NULL,
  payload_preview TEXT,
  payload_json TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  attempted_at TEXT,
  sent_at TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  response_body_safe TEXT,
  failure_reason TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  opportunity_case_id TEXT,
  thesis_fingerprint TEXT,
  lifecycle_state TEXT,
  delivery_context_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_discord_deliveries_status ON discord_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_discord_deliveries_alert ON discord_deliveries(alert_id);

CREATE TABLE IF NOT EXISTS recap_delivery_claims (
  idempotency_key TEXT PRIMARY KEY,
  payload_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  next_retry_at_ms INTEGER,
  suppression_reason TEXT,
  discord_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_recap_delivery_claims_window
  ON recap_delivery_claims(created_at_ms, status);

CREATE TABLE IF NOT EXISTS momentum_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  eval_at_ms INTEGER NOT NULL,
  trading_day TEXT NOT NULL,
  session TEXT,
  price REAL,
  move_pct REAL,
  velocity_pct_min REAL,
  instant_pct_min REAL,
  acceleration REAL,
  rel_vol REAL,
  volume_surge REAL,
  vwap_dist_pct REAL,
  quote_age_ms INTEGER,
  candidate_rank INTEGER,
  classification TEXT,
  dominant_reason TEXT,
  first_seen_ms INTEGER,
  first_ranked_ms INTEGER,
  first_promoted_ms INTEGER,
  first_seen_move_pct REAL,
  first_ranked_move_pct REAL,
  first_promoted_move_pct REAL,
  first_actionable_move_pct REAL,
  discord_move_pct REAL,
  ret_5s_pct REAL,
  ret_10s_pct REAL,
  ret_30s_pct REAL,
  ret_60s_pct REAL,
  volume_rate REAL,
  volume_acceleration REAL,
  rank_delta INTEGER,
  score REAL,
  confidence REAL,
  entry_state TEXT,
  actionable INTEGER NOT NULL DEFAULT 0,
  decision TEXT NOT NULL,
  reason TEXT,
  latch_state TEXT,
  first_detected_ms INTEGER,
  first_actionable_ms INTEGER,
  discord_delivered_ms INTEGER,
  trigger_to_discord_ms INTEGER,
  strategy_version TEXT,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_momentum_diag_day ON momentum_diagnostics(trading_day, eval_at_ms);
CREATE INDEX IF NOT EXISTS idx_momentum_diag_ticker ON momentum_diagnostics(ticker, eval_at_ms);

-- Options-alert funnel diagnostics: ONE row per authoritative supervisor cycle
-- (never per tick). Records how the bounded ticker universe flowed through the
-- pipeline — chains fetched → canonical callouts → emitted → delivered — plus the
-- delivery-stage skip counts and, critically, the CONFIG-GATE reason when a callout
-- became actionable/emittable but could not be delivered (e.g. AGENT_CALLOUT_DISCORD
-- off). Makes a "no options alerts" day diagnosable after the fact and lets the
-- nightly AI narrate it. Bounded retention; only verified deterministic counts.
CREATE TABLE IF NOT EXISTS options_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_at_ms INTEGER NOT NULL,
  trading_day TEXT NOT NULL,
  session TEXT,
  tickers_considered INTEGER NOT NULL DEFAULT 0,
  chains_ok INTEGER NOT NULL DEFAULT 0,
  chains_failed INTEGER NOT NULL DEFAULT 0,
  tickers_with_canonical INTEGER NOT NULL DEFAULT 0,
  canonical INTEGER NOT NULL DEFAULT 0,
  portfolio_suppressed INTEGER NOT NULL DEFAULT 0,
  dedup_suppressed INTEGER NOT NULL DEFAULT 0,
  emitted INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  not_actionable_now INTEGER NOT NULL DEFAULT 0,
  contract_incomplete INTEGER NOT NULL DEFAULT 0,
  contract_mismatch INTEGER NOT NULL DEFAULT 0,
  discord_auto_send INTEGER NOT NULL DEFAULT 0,   -- 1 when supervisor path may send
  delivery_gate_reason TEXT,                      -- non-null when emitted>0 but blocked by config
  top_reason TEXT,
  duration_ms INTEGER,
  strategy_version TEXT,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_options_diag_day ON options_diagnostics(trading_day, cycle_at_ms);

CREATE TABLE IF NOT EXISTS paper_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER REFERENCES paper_trades(id) ON DELETE SET NULL,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  ticker TEXT,
  decision TEXT NOT NULL,              -- auto_entry_created | risk_refused | entry_filled | exit | sweep_note
  allowed INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  risk_json TEXT,
  snapshot_json TEXT,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_paper_decisions_created ON paper_decisions(created_at_ms);
CREATE INDEX IF NOT EXISTS idx_paper_decisions_trade ON paper_decisions(trade_id);

-- Typed, idempotent paper lifecycle event stream (rebuild). One row per
-- transition; idempotency_key is UNIQUE so a duplicate scanner cycle is a
-- no-op (INSERT OR IGNORE). Clean substrate for later outcome tracking — no
-- statistics are computed here. paper_decisions is kept for compatibility.
CREATE TABLE IF NOT EXISTS paper_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER REFERENCES paper_trades(id) ON DELETE SET NULL,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  ticker TEXT,
  event_type TEXT NOT NULL,            -- candidate_created | validation_* | order_submitted | fill | no_fill | ...
  event_seq INTEGER NOT NULL DEFAULT 0,
  from_state TEXT,
  to_state TEXT,
  payload_json TEXT,
  idempotency_key TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_events_idem ON paper_events(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_paper_events_trade ON paper_events(trade_id, event_seq);

-- Opportunity lifecycle memory (docs/ALERT-RANKING-PLAN.md §1). One row evolves
-- per (ticker, setup_type, trading_day); repeated scans UPDATE it. Hysteresis
-- bookkeeping (demote_streak, status_since) keeps cards from jumping.
CREATE TABLE IF NOT EXISTS opportunities (
  opportunity_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  setup_type TEXT NOT NULL,
  trading_day TEXT NOT NULL,
  first_detected_at TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  highest_score REAL NOT NULL DEFAULT 0,
  current_score REAL NOT NULL DEFAULT 0,
  previous_status TEXT,
  current_status TEXT NOT NULL,
  trigger_level REAL,
  entry_zone TEXT,
  invalidation_level REAL,
  expiration_time TEXT,
  demote_streak INTEGER NOT NULL DEFAULT 0,
  status_since TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_key ON opportunities(ticker, setup_type, trading_day);
CREATE INDEX IF NOT EXISTS idx_opportunities_day ON opportunities(trading_day, current_status);
CREATE INDEX IF NOT EXISTS idx_opportunities_updated ON opportunities(last_updated_at);

-- Setup fingerprinting (Phase 1). setup_fingerprints owns the IMMUTABLE
-- canonical dimension dictionary; paper_trade_outcomes owns the authoritative,
-- fee-aware completed outcome + grading. Distinct from the legacy quant
-- trade_outcomes table (which stays operational until the statistics phase
-- reconciles it). One row per distinct fingerprint / per filled+terminal trade.
CREATE TABLE IF NOT EXISTS setup_fingerprints (
  fingerprint_id TEXT PRIMARY KEY,
  fingerprint_version INTEGER NOT NULL,
  strategy TEXT,
  strategy_version INTEGER,
  dimensions_json TEXT NOT NULL,       -- canonical, sorted, human+machine readable
  human_summary TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_setup_fp_strategy ON setup_fingerprints(strategy, strategy_version);

CREATE TABLE IF NOT EXISTS paper_trade_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_trade_id INTEGER NOT NULL UNIQUE REFERENCES paper_trades(id) ON DELETE CASCADE,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  opportunity_id TEXT,
  fingerprint_id TEXT,
  fingerprint_version INTEGER,
  strategy TEXT,
  strategy_version INTEGER,
  instrument_type TEXT,                 -- 'option' | 'stock'
  direction TEXT,                       -- 'CALL' | 'PUT' | 'LONG'
  selector_profile TEXT,
  option_symbol TEXT,
  strike REAL,
  expiration TEXT,
  dte_at_entry INTEGER,
  entry_time_ms INTEGER,
  exit_time_ms INTEGER,
  hold_minutes REAL,
  entry_price REAL,
  exit_price REAL,
  quantity REAL,
  gross_pnl REAL,
  entry_fees REAL,
  exit_fees REAL,
  entry_slippage REAL,                  -- recorded for transparency (already in fill price)
  exit_slippage REAL,
  net_pnl REAL,                         -- gross − fees (slippage already embedded)
  return_pct REAL,                      -- net return on entry notional
  risk_amount REAL,                     -- immutable risk recorded at entry
  r_multiple REAL,                      -- net_pnl / risk_amount
  mfe_pct REAL,
  mae_pct REAL,
  opportunity_grade TEXT,               -- HIT | NONE | UNGRADABLE (peak favorable ≥ threshold to expiration)
  peak_favorable_pct REAL,              -- lifetime peak favorable % (held window extended to expiration)
  opportunity_threshold_pct REAL,       -- the profit-opportunity threshold applied
  opportunity_window TEXT,              -- held | to_expiration | none
  terminal_kind TEXT,                   -- STOP | TARGET | TIMEOUT | EXPIRATION | MANUAL | SMART | EXITED
  exit_reason TEXT,
  close_reason TEXT,
  entry_session TEXT,
  exit_session TEXT,
  grade TEXT NOT NULL,                  -- WIN | LOSS | BREAKEVEN | UNGRADABLE
  grading_status TEXT NOT NULL,         -- GRADED | UNGRADABLE
  data_quality_status TEXT NOT NULL,    -- OK | LEGACY_LIMITED | INCOMPLETE
  data_quality_reasons_json TEXT,
  snapshot_version INTEGER,
  outcome_version INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pto_fingerprint ON paper_trade_outcomes(fingerprint_id);
CREATE INDEX IF NOT EXISTS idx_pto_strategy ON paper_trade_outcomes(strategy, strategy_version);
CREATE INDEX IF NOT EXISTS idx_pto_grade ON paper_trade_outcomes(grade);

-- Authoritative statistics cache (Phase 2). Materialized from
-- paper_trade_outcomes ONLY (never the legacy gross-P&L trade_outcomes). One row
-- per (group_kind, group_key) at a statistics_version; idempotent refresh keyed
-- by a source-outcome watermark. Legacy setup_statistics stays for the old quant
-- explanation path until it is safely reconciled.
CREATE TABLE IF NOT EXISTS authoritative_statistics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_kind TEXT NOT NULL,            -- overall | fingerprint | strategy | session | ...
  group_key TEXT NOT NULL,
  statistics_version INTEGER NOT NULL,
  fingerprint_version INTEGER,
  strategy_version INTEGER,
  graded_sample_size INTEGER NOT NULL DEFAULT 0,
  ungradable_count INTEGER NOT NULL DEFAULT 0,
  evidence_state TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  source_watermark INTEGER NOT NULL DEFAULT 0,  -- max paper_trade_outcomes.id included
  last_refresh_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(group_kind, group_key, statistics_version)
);
CREATE INDEX IF NOT EXISTS idx_authstats_kind ON authoritative_statistics(group_kind, graded_sample_size);

-- Market context snapshots (Phase 3). The EXACT versioned context used by a
-- callout / prediction is persisted here (never back-filled onto old rows).
CREATE TABLE IF NOT EXISTS market_context_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_version INTEGER NOT NULL,
  session TEXT,
  risk_state TEXT NOT NULL,
  structure TEXT NOT NULL,
  volatility TEXT NOT NULL,
  freshness TEXT NOT NULL,
  spy_trend TEXT,
  qqq_trend TEXT,
  vwap_state TEXT,
  conflict_flags TEXT,
  context_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_ctx_created ON market_context_snapshots(created_at_ms);

-- Probability-model registry (Phase 4). Versioned models + evaluation history +
-- prediction audit. A model is a calibrated EVIDENCE score only; it can never
-- override a hard gate. Champion/challenger with rollback; no model activates
-- until the data thresholds pass (status INACTIVE_INSUFFICIENT_DATA otherwise).
CREATE TABLE IF NOT EXISTS model_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,
  model_version INTEGER NOT NULL,
  feature_schema_version INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- CHAMPION | CHALLENGER | RETIRED | REJECTED
  config_json TEXT NOT NULL,
  model_json TEXT NOT NULL,
  metrics_json TEXT,
  training_watermark INTEGER NOT NULL DEFAULT 0,
  n_train INTEGER NOT NULL DEFAULT 0,
  base_rate REAL,
  health TEXT,                          -- HEALTHY | WARNING | DEGRADED (Phase 7 drift flag)
  tier TEXT,                            -- VALIDATED | EXPERIMENTAL (Phase 8)
  trained_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(model_name, model_version)
);
CREATE INDEX IF NOT EXISTS idx_model_registry_status ON model_registry(model_name, status);

CREATE TABLE IF NOT EXISTS model_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_registry_id INTEGER REFERENCES model_registry(id) ON DELETE CASCADE,
  eval_kind TEXT NOT NULL,              -- holdout | walkforward
  metrics_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_model_evals_model ON model_evaluations(model_registry_id);

CREATE TABLE IF NOT EXISTS model_prediction_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_trade_id INTEGER,
  fingerprint_id TEXT,
  model_name TEXT NOT NULL,
  model_version INTEGER NOT NULL,
  feature_schema_version INTEGER NOT NULL,
  proba REAL NOT NULL,
  features_json TEXT,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_model_pred_audit_fp ON model_prediction_audit(fingerprint_id);

-- Continuous learning + drift audit (Phase 7). Every retrain attempt, skip,
-- promotion, rejection, and drift snapshot is recorded. The learning loop is
-- bounded/versioned/reversible and NEVER changes source code or trading rules.
CREATE TABLE IF NOT EXISTS learning_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                   -- SKIPPED | PROMOTION | REJECTION
  watermark INTEGER NOT NULL DEFAULT 0,
  new_graded INTEGER NOT NULL DEFAULT 0,
  drift_state TEXT,
  decision_json TEXT,
  result_json TEXT,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_learning_runs_created ON learning_runs(created_at_ms);

CREATE TABLE IF NOT EXISTS drift_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drift_state TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  reasons_json TEXT,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_drift_snapshots_created ON drift_snapshots(created_at_ms);

-- Controlled code-improvement agent (Phase 9). IMMUTABLE, write-once improvement
-- proposals. The agent NEVER edits code or trading rules autonomously; it records
-- classified proposals and their disposition. A row is never mutated after insert
-- (INSERT OR IGNORE by the deterministic content id) so history is never rewritten.
CREATE TABLE IF NOT EXISTS improvement_proposals (
  id TEXT PRIMARY KEY,                  -- deterministic content id (impN_<hex>)
  version INTEGER NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  target_paths_json TEXT NOT NULL,
  risk TEXT NOT NULL,                   -- LOW | MEDIUM | HIGH
  forbidden INTEGER NOT NULL DEFAULT 0,
  forbidden_reasons_json TEXT,
  branch_name TEXT NOT NULL,
  disposition TEXT NOT NULL,            -- AUTO_MERGE_ELIGIBLE | HUMAN_REVIEW_REQUIRED | READY_FOR_CODING_AGENT | BLOCKED
  disposition_reasons_json TEXT,
  source_recommendation TEXT,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_improvement_proposals_created ON improvement_proposals(created_at_ms);

-- Canonical multi-horizon callout lifecycle/dedup state (live runtime wiring).
-- ONE row per canonical opportunity (ticker|direction|horizon). Persisting this
-- means dedup, cooldowns, and lifecycle transitions survive process/worker
-- restarts and horizontal scaling — a restart never resends an unchanged callout.
CREATE TABLE IF NOT EXISTS callout_state (
  callout_key TEXT PRIMARY KEY,         -- ticker|direction|horizon
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL,
  horizon TEXT NOT NULL,
  last_status TEXT NOT NULL,
  last_material_hash TEXT,
  last_emit_at_ms INTEGER,
  last_idempotency_key TEXT,
  last_delivery_id TEXT,
  last_delivery_status TEXT,
  updated_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_callout_state_updated ON callout_state(updated_at_ms);

-- Supervisor→paper bridge (additive). ONE auditable row per Supervisor canonical
-- callout that was eligible to become a paper candidate. Freezes the alert-time
-- facts (contract, quotes, confidence, timing) and links to the paper_trades row it
-- created. idempotency_key is UNIQUE so cycles/restarts/retries never duplicate a
-- candidate for the same setup identity + status + trading day.
CREATE TABLE IF NOT EXISTS paper_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  setup_identity TEXT NOT NULL,          -- ticker|direction|horizon (stable identity)
  source TEXT NOT NULL DEFAULT 'SUPERVISOR',
  callout_key TEXT,
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL,
  strategy TEXT,
  horizon TEXT,
  option_symbol TEXT,
  strike REAL,
  expiration TEXT,
  dte INTEGER,
  underlying_price REAL,
  option_bid REAL,
  option_ask REAL,
  option_mid REAL,
  estimated_entry REAL,
  quote_asof_ms INTEGER,
  entry_state TEXT,
  confidence_tier TEXT,
  setup_score REAL,
  contract_score REAL,
  risk_ok INTEGER,
  lifecycle_status TEXT,
  callout_ts_ms INTEGER,
  trigger_ts_ms INTEGER,
  model_state TEXT,
  evidence_state TEXT,
  status TEXT NOT NULL DEFAULT 'ELIGIBLE',  -- ELIGIBLE | CREATED | REJECTED
  reject_reason TEXT,
  paper_trade_id INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_candidates_created ON paper_candidates(created_at_ms);
CREATE INDEX IF NOT EXISTS idx_paper_candidates_identity ON paper_candidates(setup_identity);

-- Named worker leases (live runtime wiring). Single-owner guarantee for background
-- schedulers so two hosted replicas never run the same jobs / double-send. A
-- crashed owner stops heartbeating and its lease expires on its own.
CREATE TABLE IF NOT EXISTS worker_leases (
  name TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  hostname TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS historical_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT UNIQUE,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  ticker TEXT NOT NULL,
  asset_class TEXT NOT NULL DEFAULT 'options',
  setup_type TEXT NOT NULL,
  direction TEXT,
  option_symbol TEXT,
  option_side TEXT,
  strike REAL,
  expiration TEXT,
  dte INTEGER,
  alert_time TEXT NOT NULL,
  trading_day TEXT,
  session TEXT,
  time_bucket TEXT,
  market_regime TEXT,
  ticker_type TEXT,
  price_at_alert REAL,
  percent_move_at_alert REAL,
  volume REAL,
  relative_volume REAL,
  iv REAL,
  delta REAL,
  gamma REAL,
  open_interest REAL,
  option_volume REAL,
  spread_pct REAL,
  source TEXT,
  score_snapshot_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_hist_alerts_setup ON historical_alerts(setup_type, alert_time);
CREATE INDEX IF NOT EXISTS idx_hist_alerts_ticker ON historical_alerts(ticker, alert_time);

CREATE TABLE IF NOT EXISTS trade_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  historical_alert_id INTEGER REFERENCES historical_alerts(id) ON DELETE SET NULL,
  paper_trade_id INTEGER REFERENCES paper_trades(id) ON DELETE SET NULL,
  journal_id INTEGER REFERENCES trade_journal(id) ON DELETE SET NULL,
  ticker TEXT NOT NULL,
  asset_class TEXT NOT NULL DEFAULT 'options',
  setup_type TEXT NOT NULL,
  side TEXT,
  option_symbol TEXT,
  entry_price REAL,
  exit_price REAL,
  quantity REAL,
  entry_time TEXT,
  exit_time TEXT,
  hold_minutes REAL,
  pnl REAL,
  return_pct REAL,
  mfe_pct REAL,
  mae_pct REAL,
  market_regime TEXT,
  session TEXT,
  entry_reason TEXT,
  exit_reason TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(alert_id, paper_trade_id, journal_id, source)
);
CREATE INDEX IF NOT EXISTS idx_trade_outcomes_setup ON trade_outcomes(setup_type, entry_time);
CREATE INDEX IF NOT EXISTS idx_trade_outcomes_ticker ON trade_outcomes(ticker, entry_time);

CREATE TABLE IF NOT EXISTS setup_statistics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setup_type TEXT NOT NULL,
  asset_class TEXT NOT NULL DEFAULT 'options',
  market_regime TEXT NOT NULL DEFAULT 'all',
  time_bucket TEXT NOT NULL DEFAULT 'all',
  sample_size INTEGER NOT NULL DEFAULT 0,
  win_rate REAL,
  average_gain REAL,
  average_loss REAL,
  profit_factor REAL,
  expectancy REAL,
  max_drawdown REAL,
  average_hold_minutes REAL,
  best_time_of_day TEXT,
  best_market_regime TEXT,
  best_ticker_types TEXT,
  best_volume_condition TEXT,
  best_iv_condition TEXT,
  recent_expectancy REAL,
  confidence_score REAL,
  grade TEXT NOT NULL DEFAULT 'D',
  recommendation TEXT NOT NULL DEFAULT 'watch_only',
  data_quality TEXT NOT NULL DEFAULT 'limited',
  warning TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(setup_type, asset_class, market_regime, time_bucket)
);
CREATE INDEX IF NOT EXISTS idx_setup_stats_grade ON setup_statistics(grade, confidence_score);

CREATE TABLE IF NOT EXISTS backtest_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  strategy_version_id INTEGER,
  filters_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  total_trades INTEGER NOT NULL DEFAULT 0,
  win_rate REAL,
  expectancy REAL,
  max_drawdown REAL,
  sharpe_like REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS strategy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  config_json TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS model_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  historical_alert_id INTEGER REFERENCES historical_alerts(id) ON DELETE SET NULL,
  setup_type TEXT NOT NULL,
  model_name TEXT NOT NULL DEFAULT 'quant-statistics-v1',
  prediction_json TEXT NOT NULL,
  grade TEXT,
  confidence_score REAL,
  recommendation TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_model_predictions_alert ON model_predictions(alert_id);

-- ── Advisory AI layer (offline, scheduled, human-approved) ──────────────────
-- These four tables back the nightly miss-diagnosis, minimal lessons memory,
-- weekly strategy-improvement proposals, and AI cost/audit log. The AI layer is
-- a READER/NARRATOR of deterministic data + a PROPOSER into a human-approved
-- workflow. It never edits code, merges, deploys, or touches the live signal
-- path. Every numeric claim in a stored narrative traces to the deterministic
-- summary_json stored alongside it.

-- Nightly (and weekly) reports: the deterministic summary is ALWAYS stored; the
-- validated AI narrative is stored when the model ran and passed validation (null
-- when AI is disabled/skipped/over-budget). UNIQUE(report_type, period_key) makes
-- the job idempotent and restart-safe (a re-run for the same day/week is a no-op).
CREATE TABLE IF NOT EXISTS ai_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL,             -- 'nightly' | 'weekly'
  period_key TEXT NOT NULL,              -- ET trading day (nightly) or ISO year-week (weekly)
  period_start_ms INTEGER,
  period_end_ms INTEGER,
  summary_json TEXT NOT NULL,            -- deterministic statistics (never fabricated)
  narrative_json TEXT,                   -- validated AI narrative (null when model skipped)
  narrative_status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | OK | SKIPPED | VALIDATION_FAILED | ERROR
  model TEXT,
  ai_job_run_id INTEGER,
  diagnostic_json TEXT,                  -- bounded provider/validation diagnostic, never secrets/raw key
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(report_type, period_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_reports_type ON ai_reports(report_type, created_at_ms);

-- Minimal lessons memory (relational; NOT a vector store). One durable lesson per
-- row with its evidence, sample size, decision state, and post-implementation
-- result. dedup_key is UNIQUE so a repeated nightly finding updates the existing
-- lesson instead of creating a near-duplicate every night.
CREATE TABLE IF NOT EXISTS ai_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,        -- deterministic identity (finding_type|strategy|session|duration|...)
  finding_type TEXT NOT NULL,            -- e.g. 'late_callout' | 'liquidity_reject' | 'exit_management' | 'crossing_rescue'
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,           -- structured deterministic evidence
  sample_size INTEGER NOT NULL DEFAULT 0,
  affected_ticker TEXT,
  affected_strategy TEXT,
  affected_session TEXT,
  affected_duration TEXT,                -- '0DTE' | 'longer' | null
  date_range_start TEXT,
  date_range_end TEXT,
  source_report_id INTEGER REFERENCES ai_reports(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN | ACCEPTED | REJECTED | NEEDS_MORE_DATA
  confidence TEXT NOT NULL DEFAULT 'LOW',-- LOW | MEDIUM | HIGH (deterministic tier)
  decision_state TEXT NOT NULL DEFAULT 'NEEDS_MORE_DATA', -- accepted|rejected|needs-more-data
  decision_notes TEXT,
  linked_proposal_id INTEGER REFERENCES ai_proposals(id) ON DELETE SET NULL,
  strategy_version TEXT,
  result_after_implementation TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_lessons_status ON ai_lessons(status, updated_at_ms);

-- Weekly strategy-improvement proposals with a HUMAN approval workflow. Distinct
-- from the immutable deterministic improvement_proposals ledger (which cannot
-- hold an approval lifecycle): these are advisory, mutable-status, and PENDING
-- until a human accepts/rejects. The AI never applies, merges, or deploys them.
CREATE TABLE IF NOT EXISTS ai_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,        -- period_key|affected_strategy|title-slug
  period_key TEXT NOT NULL,              -- ISO year-week the proposal was generated for
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  affected_strategy TEXT,
  affected_session TEXT,
  affected_config TEXT,
  proposed_change TEXT NOT NULL,
  relevant_files_json TEXT,
  change_level TEXT,                     -- 'config-only' | 'code-level'
  expected_benefit TEXT,
  downside_risk TEXT,
  overfitting_risk TEXT,
  required_tests TEXT,
  backtest_plan TEXT,
  shadow_test_plan TEXT,
  paper_test_plan TEXT,
  rollback_plan TEXT,
  suggested_patch TEXT,
  confidence TEXT NOT NULL DEFAULT 'LOW',
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL', -- PENDING_APPROVAL | ACCEPTED | REJECTED
  decision_notes TEXT,
  source_report_id INTEGER REFERENCES ai_reports(id) ON DELETE SET NULL,
  model TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_proposals_status ON ai_proposals(status, created_at_ms);

CREATE TABLE IF NOT EXISTS ai_evidence_packets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  packet_id TEXT NOT NULL UNIQUE,
  period_start_ms INTEGER NOT NULL,
  period_end_ms INTEGER NOT NULL,
  packet_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_evidence_packets_created ON ai_evidence_packets(created_at_ms);

-- Advisory chatbot conversations. ADVISORY ONLY: these rows are a record of an
-- explanation, never an instruction — nothing here can influence scanning,
-- delivery, grading, or any live behaviour.
-- Deliberately stores NO secrets, tokens, webhook URLs, or raw market payloads;
-- evidence is referenced by canonical metric id, not copied.
CREATE TABLE IF NOT EXISTS ai_chat_conversations (
  conversation_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL,
  report_id TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_conversations_updated
  ON ai_chat_conversations(deleted_at_ms, updated_at_ms);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,                    -- 'user' | 'assistant'
  mode TEXT,
  content TEXT NOT NULL,
  evidence_ids_json TEXT,                -- canonical metric ids cited
  report_id TEXT,
  model TEXT,
  validation_status TEXT,                -- VALID | REJECTED_UNSUPPORTED_NUMBERS | AI_UNAVAILABLE | ...
  validation_failures_json TEXT,
  fix_prompt TEXT,                       -- export-only investigation prompt
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  feedback TEXT,                         -- 'up' | 'down' | null
  feedback_note TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_conv
  ON ai_chat_messages(conversation_id, created_at_ms);

-- AI cost + audit log. ONE row per provider job attempt-set (including skips), so
-- monthly spend, latency, retries, and failures are fully auditable. month_key
-- (YYYY-MM in ET) powers the soft/hard monthly limit checks.
CREATE TABLE IF NOT EXISTS ai_job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,                -- 'nightly_diagnosis' | 'weekly_proposals' | 'recap'
  model TEXT,
  status TEXT NOT NULL,                  -- SUCCESS | ERROR | TIMEOUT | VALIDATION_FAILED | SKIPPED_DISABLED | SKIPPED_HARD_LIMIT | SKIPPED_NO_KEY
  error_category TEXT,                   -- timeout | http | validation | network | disabled | budget | none
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  diagnostic_json TEXT,                  -- bounded provider status/validation metadata, no secrets
  month_key TEXT NOT NULL,               -- YYYY-MM (ET) for spend rollups
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_job_runs_month ON ai_job_runs(month_key, status);
CREATE INDEX IF NOT EXISTS idx_ai_job_runs_type ON ai_job_runs(job_type, created_at_ms);

-- Multi-lane research rebuild (Phase 1). Normalized SetupCandidate capture — one row
-- per (strategy agent, ticker, contract/direction, trading day). PURELY ADDITIVE and
-- only WRITTEN when SETUP_CANDIDATE_CAPTURE_ENABLED=1; nothing reads it in the
-- production Discord/paper path. Complex sub-objects are stored as bounded JSON.
CREATE TABLE IF NOT EXISTS setup_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setup_id TEXT NOT NULL UNIQUE,          -- deterministic identity (agent|ticker|contract|day)
  trading_day TEXT NOT NULL,
  strategy_agent TEXT NOT NULL,
  strategy_family TEXT,
  strategy_version INTEGER,
  agent_version INTEGER,
  ticker TEXT NOT NULL,
  direction TEXT,                         -- bullish | bearish
  asset_class TEXT,                       -- stock | option
  option_symbol TEXT,
  expiration TEXT,
  strike REAL,
  side TEXT,                              -- call | put | null
  horizon TEXT,
  session TEXT,                           -- premarket | regular | afterhours | closed
  setup_tier TEXT NOT NULL,              -- PRODUCTION_QUALITY | EXPERIMENTAL_VALID | NEAR_MISS_VALID | REJECTED_INVALID
  confidence REAL,
  candidate_status TEXT,
  actionability TEXT,                     -- ACTIONABLE | RESEARCH_ONLY | WATCH | BLOCKED
  freshness_state TEXT,
  liquidity REAL,
  spread_pct REAL,
  volume REAL,
  open_interest REAL,
  greeks_json TEXT,                       -- {delta,gamma,theta,vega,iv,available}; null when not provided
  entry_thesis TEXT,
  invalidation_thesis TEXT,
  gate_results_json TEXT,                 -- {gate:{passed,score,reason}} snapshot for convenience
  rejection_reasons_json TEXT,
  feature_snapshot_json TEXT,
  market_regime_json TEXT,
  consumer_lanes_json TEXT,               -- ["RESEARCH", ...]
  experiment_id TEXT,
  model_version INTEGER,
  outcome_json TEXT,                      -- {status,mfePct,maePct,returnPct,win,exitReason}; null until graded
  originating_ts_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_setup_candidates_day ON setup_candidates(trading_day, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_setup_candidates_tier ON setup_candidates(setup_tier, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_setup_candidates_agent ON setup_candidates(strategy_agent, created_at_ms);

-- One row per named deterministic gate per candidate — powers counterfactual
-- gate-effectiveness analytics ("which gate rejects the most eventual winners").
CREATE TABLE IF NOT EXISTS setup_gate_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setup_id TEXT NOT NULL,
  gate_name TEXT NOT NULL,
  passed INTEGER NOT NULL,                -- 1 | 0
  score REAL,
  reason TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_setup_gate_results_setup ON setup_gate_results(setup_id);
CREATE INDEX IF NOT EXISTS idx_setup_gate_results_gate ON setup_gate_results(gate_name, passed);

-- Multi-lane research rebuild (Phase 2). Persisted lane-routing decisions — one row
-- per (setup, lane) with an explicit reason code. Written only when
-- LANE_ROUTER_ENABLED=1; the router never controls Production Discord (that stays
-- governed by lib/callouts/eligibility.ts). PURELY ADDITIVE. UNIQUE(setup_id,lane)
-- makes re-routing within a day idempotent.
CREATE TABLE IF NOT EXISTS lane_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setup_id TEXT NOT NULL,
  lane TEXT NOT NULL,                     -- PRIMARY_PAPER | CHALLENGE_PAPER | RESEARCH | ...
  routed INTEGER NOT NULL,                -- 1 | 0
  reason_code TEXT NOT NULL,
  reason TEXT,
  setup_tier TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(setup_id, lane)
);
CREATE INDEX IF NOT EXISTS idx_lane_routes_lane ON lane_routes(lane, routed, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_lane_routes_setup ON lane_routes(setup_id);

-- Multi-lane research rebuild (Phase 5). Research experiment ledger + counterfactuals.
-- PURELY ADDITIVE. Fills/outcomes reuse paper_trades (Phase 3, portfolio RESEARCH/
-- CHALLENGE) so there is ONE execution model, never a second incompatible one.
CREATE TABLE IF NOT EXISTS research_experiments (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  hypothesis TEXT,
  status TEXT NOT NULL,                   -- DRAFT | ACTIVE | PAUSED | COMPLETED | INACTIVE_MISSING_DATA
  config_json TEXT,                       -- accepted tiers/lanes/symbols/horizons/session/data-quality/entry/exit/sizing/fill/metrics
  strategy_agents_json TEXT,
  min_sample_target INTEGER NOT NULL DEFAULT 0,
  missing_requirements_json TEXT,         -- non-empty ⇒ INACTIVE_MISSING_DATA
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (id, version)
);

-- One row per (experiment, version, setup). Idempotent via the UNIQUE key. fill_status
-- distinguishes an honest fill from an observed-but-unfilled candidate and a
-- rejected-invalid that must NEVER be filled.
CREATE TABLE IF NOT EXISTS research_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL,
  experiment_version INTEGER NOT NULL,
  setup_id TEXT NOT NULL,
  lane TEXT, portfolio TEXT, strategy_agent TEXT, strategy_version INTEGER, strategy_family TEXT,
  setup_tier TEXT, ticker TEXT, asset_class TEXT, direction TEXT, horizon TEXT,
  option_symbol TEXT, expiration TEXT, strike REAL, call_put TEXT, market_session TEXT, regime TEXT,
  fill_status TEXT NOT NULL,              -- FILLED | OBSERVED_UNFILLED | NOT_FILLABLE_REJECTED
  non_fill_reason TEXT,
  paper_trade_id INTEGER,                 -- the reused paper_trades fill (when FILLED)
  entry_quote_source TEXT, quote_ts_ms INTEGER, data_quality TEXT,
  gate_results_json TEXT, feature_snapshot_json TEXT, provider_limitations TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(experiment_id, experiment_version, setup_id)
);
CREATE INDEX IF NOT EXISTS idx_research_enroll_exp ON research_enrollments(experiment_id, experiment_version);
CREATE INDEX IF NOT EXISTS idx_research_enroll_setup ON research_enrollments(setup_id);
CREATE INDEX IF NOT EXISTS idx_research_enroll_agent ON research_enrollments(strategy_agent, created_at_ms);

-- Counterfactual grading. Two SEPARATE concepts, never conflated:
--   executable_counterfactual  — only when a defensible real entry price/path existed.
--   market_movement_observation — what the underlying/contract later did; NEVER trade P&L.
CREATE TABLE IF NOT EXISTS counterfactual_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setup_id TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- 'executable_counterfactual' | 'market_movement_observation'
  setup_tier TEXT, strategy_agent TEXT, lane TEXT, ticker TEXT, horizon TEXT, session TEXT, regime TEXT,
  entry_price REAL, exit_price REAL, return_pct REAL, win INTEGER, reached_target INTEGER,
  underlying_move_pct REAL, contract_move_pct REAL, observation_note TEXT,
  defensible_entry INTEGER NOT NULL,      -- 1 only for executable_counterfactual
  gate_results_json TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(setup_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_counterfactual_setup ON counterfactual_outcomes(setup_id);
CREATE INDEX IF NOT EXISTS idx_counterfactual_kind ON counterfactual_outcomes(kind, created_at_ms);

-- Multi-lane research rebuild (Phase 6). Research-only AI pipeline: runs, findings,
-- human-review proposals, and normalized training rows. ADVISORY ONLY — nothing here
-- changes production; an APPROVED proposal never auto-applies. PURELY ADDITIVE.
CREATE TABLE IF NOT EXISTS ai_research_runs (
  run_id TEXT PRIMARY KEY,
  pipeline TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  status TEXT NOT NULL,                   -- RUNNING | COMPLETED | ERROR
  stages_json TEXT,                       -- per-stage status + counts + errors (failure-isolated)
  error TEXT
);

CREATE TABLE IF NOT EXISTS ai_research_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,                    -- trade_review | counterfactual_review | pattern_discovery | strategy_evaluation | portfolio_allocation
  finding_type TEXT NOT NULL,
  subject TEXT,                           -- the thing evaluated (agent id, gate, cohort, …)
  strategy_agent TEXT, strategy_version INTEGER, lane TEXT, tier TEXT, regime TEXT, session TEXT, horizon TEXT,
  metrics_json TEXT,
  sample_size INTEGER NOT NULL DEFAULT 0,
  sufficiency TEXT NOT NULL,              -- SUFFICIENT | EXPLORATORY | INSUFFICIENT
  confidence TEXT,                        -- uncertainty marker (never fabricated)
  observation_only INTEGER NOT NULL DEFAULT 0,  -- 1 ⇒ based only on market-movement observations
  evidence_refs_json TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(run_id, stage, subject)
);
CREATE INDEX IF NOT EXISTS idx_ai_findings_run ON ai_research_findings(run_id, stage);

CREATE TABLE IF NOT EXISTS research_proposals (
  proposal_id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  created_by_pipeline TEXT,
  proposal_type TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  affected_strategy TEXT, affected_strategy_version INTEGER, affected_lane TEXT, affected_tier TEXT,
  evidence_summary TEXT NOT NULL,
  evidence_refs_json TEXT,
  sample_size INTEGER NOT NULL,
  wins INTEGER, losses INTEGER, expectancy REAL,
  confidence TEXT,
  expected_effect TEXT NOT NULL,
  risks TEXT NOT NULL,
  rollback_plan TEXT NOT NULL,
  validation_plan TEXT NOT NULL,
  minimum_validation_sample INTEGER NOT NULL,
  model_version INTEGER,
  observation_only INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',  -- DRAFT|PENDING_REVIEW|APPROVED|REJECTED|EXPIRED|INVALIDATED (never defaults APPROVED)
  reviewed_by TEXT, reviewed_at_ms INTEGER, review_notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_proposals_status ON research_proposals(status, created_at_ms);

-- Normalized training rows. source_kind keeps executed trades, executable
-- counterfactuals, market observations, and rejected-invalid records DISTINCT so a
-- non-executed row can never be mislabeled as an executed-return example.
CREATE TABLE IF NOT EXISTS ai_training_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setup_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,             -- EXECUTED_TRADE | EXECUTABLE_COUNTERFACTUAL | MARKET_OBSERVATION | REJECTED_INVALID
  executed INTEGER NOT NULL,             -- 1 only for real fills
  experiment_id TEXT, experiment_version INTEGER,
  lane TEXT, portfolio TEXT, strategy_agent TEXT, strategy_version INTEGER, strategy_family TEXT,
  setup_tier TEXT, direction TEXT, asset_class TEXT, horizon TEXT, ticker TEXT,
  option_symbol TEXT, expiration TEXT, strike REAL, call_put TEXT,
  feature_snapshot_json TEXT, gate_results_json TEXT, data_quality TEXT, market_session TEXT, regime TEXT,
  fill_status TEXT,
  label TEXT,                            -- WIN|LOSS for executed/executable; REACHED_TARGET/NOT for observation; null for rejected
  return_pct REAL, mfe_pct REAL, mae_pct REAL,
  entry_ts_ms INTEGER, exit_ts_ms INTEGER,
  provider_limitations TEXT, source_table TEXT,
  model_eligibility TEXT NOT NULL,       -- ELIGIBLE_EXECUTED | RESEARCH_ONLY | ANALYSIS_ONLY
  created_at_ms INTEGER NOT NULL,
  UNIQUE(setup_id, source_kind)
);
CREATE INDEX IF NOT EXISTS idx_ai_training_kind ON ai_training_rows(source_kind, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_ai_training_agent ON ai_training_rows(strategy_agent, strategy_version);

-- Multi-lane research rebuild (Phase 7). Bounded, point-in-time historical replay.
-- PURELY ADDITIVE. STOCK replay uses real /v2/aggs OHLCV. OPTIONS replay ships INACTIVE
-- (INACTIVE_MISSING_PROVIDER) — the current plan/integration does not supply historical
-- option quotes/Greeks/NBBO/OI/spreads, and none are ever fabricated.
CREATE TABLE IF NOT EXISTS replay_runs (
  run_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,            -- deterministic hash of (symbols,range,strategy,config) — reproducible
  asset_class TEXT NOT NULL,              -- stock | option
  symbols_json TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  timespan TEXT NOT NULL,                 -- minute | day | ...
  strategy_version INTEGER NOT NULL,
  config_json TEXT,
  status TEXT NOT NULL,                   -- PENDING | RUNNING | COMPLETED | PAUSED | ERROR | INACTIVE_MISSING_PROVIDER
  checkpoint_json TEXT,                   -- last completed symbol (resume-safe)
  provider_calls INTEGER NOT NULL DEFAULT 0,
  provider_call_budget INTEGER NOT NULL DEFAULT 0,
  provider_limitations TEXT,
  error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

-- One row per replayed trade/observation. kind distinguishes an EXECUTABLE stock
-- simulation from a mere CONTRACT-PRICE OBSERVATION (options, where only OHLCV exists).
CREATE TABLE IF NOT EXISTS replay_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  strategy_version INTEGER,
  kind TEXT NOT NULL,                     -- executable_stock | contract_price_observation
  entry_ts_ms INTEGER, exit_ts_ms INTEGER,
  entry_price REAL, exit_price REAL, return_pct REAL, mfe_pct REAL, mae_pct REAL,
  bars_used INTEGER, slippage_bps REAL, fees REAL, exit_reason TEXT, note TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(run_id, symbol, entry_ts_ms)
);
CREATE INDEX IF NOT EXISTS idx_replay_outcomes_run ON replay_outcomes(run_id);
CREATE INDEX IF NOT EXISTS idx_replay_outcomes_exp ON replay_outcomes(experiment_id, symbol);

-- Analog Engine — Phase A. The Setup Episode: the unit of historical memory.
-- ZONE A (decision-time context) ONLY lives here — every feature block is computed
-- at/<= t0_ms, and max_feature_as_of_ms MUST be <= t0_ms (the leakage guard). Forward
-- outcomes live in episode_labels (Zone B); executions reuse paper_trades (Zone C);
-- counterfactual/observation reuse counterfactual_outcomes (Zone D). PURELY ADDITIVE.
CREATE TABLE IF NOT EXISTS setup_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_key TEXT NOT NULL UNIQUE,       -- deterministic: source|symbol|t0_ms|schema_version
  source TEXT NOT NULL,                    -- replay | live_scanner | live_supervisor
  symbol TEXT NOT NULL,
  t0_ms INTEGER NOT NULL,                  -- decision time (the ONLY time Zone-A may reference)
  trading_day TEXT NOT NULL,
  session TEXT NOT NULL,                   -- premarket | regular | afterhours | closed
  tod_bucket TEXT,
  asset_class TEXT NOT NULL DEFAULT 'stock',
  direction TEXT,                          -- thesis side bullish | bearish | null
  regime_label TEXT, regime_model_version INTEGER,
  liquidity_tier TEXT,
  validity_tier TEXT,                      -- deterministic comparability/validity tier
  -- Zone-A feature blocks (each JSON block carries its own asOfMs, all <= t0_ms):
  price_structure_json TEXT, momentum_json TEXT, volume_json TEXT, volatility_json TEXT,
  regime_json TEXT, sector_json TEXT, breadth_json TEXT, options_context_json TEXT,
  catalyst_json TEXT, liquidity_json TEXT, data_quality_json TEXT, missing_json TEXT,
  gate_results_json TEXT,
  feature_schema_version INTEGER NOT NULL,
  max_feature_as_of_ms INTEGER NOT NULL,   -- leakage guard: must be <= t0_ms
  provenance_json TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_setup_episodes_sym ON setup_episodes(symbol, t0_ms);
CREATE INDEX IF NOT EXISTS idx_setup_episodes_day ON setup_episodes(trading_day);
CREATE INDEX IF NOT EXISTS idx_setup_episodes_src ON setup_episodes(source, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_setup_episodes_regime ON setup_episodes(regime_label);

-- Forward outcome labels (Zone B). Computed strictly from data timestamped AFTER t0
-- (label_as_of_ms MUST be > t0_ms). One row per (episode, horizon, target construct).
-- Option outcomes are MODELED (outcome_kind=MODELED_OPTION) and never a real fill.
CREATE TABLE IF NOT EXISTS episode_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_key TEXT NOT NULL,
  horizon TEXT NOT NULL,                   -- 15m | 30m | 1h | EOD | 1d | 3d | 5d | 10d
  target_kind TEXT NOT NULL,               -- UNDERLYING | OPTION_ATM_CALL | OPTION_OTM_CALL | OPTION_ATM_PUT | OPTION_OTM_PUT
  outcome_kind TEXT NOT NULL,              -- REAL_UNDERLYING | MODELED_OPTION
  return_pct REAL, mfe_pct REAL, mae_pct REAL,
  target_before_stop TEXT,                 -- TARGET | STOP | NEITHER | null
  time_to_target_ms INTEGER, time_to_invalidation_ms INTEGER,
  realized_vol REAL, gap_pct REAL, gap_filled INTEGER,
  model_assumptions_json TEXT,             -- only for MODELED_OPTION
  label_as_of_ms INTEGER NOT NULL,         -- last bar used; MUST be > t0_ms
  computed_at_ms INTEGER NOT NULL,
  UNIQUE(episode_key, horizon, target_kind)
);
CREATE INDEX IF NOT EXISTS idx_episode_labels_ep ON episode_labels(episode_key);
CREATE INDEX IF NOT EXISTS idx_episode_labels_h ON episode_labels(horizon, target_kind);

-- Analog Engine — Phase B. The evaluation harness ledger. Records strictly out-of-sample,
-- walk-forward / purged-CV results per scorer, plus lift-over-baseline with confidence
-- intervals. PURELY ADDITIVE. This ledger is the arbiter of Phase D's go/no-go gate.
CREATE TABLE IF NOT EXISTS eval_runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                     -- walk_forward | purged_cv
  dataset TEXT NOT NULL,
  scorer TEXT NOT NULL,
  baseline TEXT,                          -- baseline compared against (e.g. random)
  splits INTEGER NOT NULL,
  n_oos INTEGER NOT NULL,
  oos_expectancy REAL, oos_hit_rate REAL, oos_brier REAL, oos_ece REAL,
  lift_vs_baseline REAL, lift_ci_low REAL, lift_ci_high REAL, significant INTEGER,
  config_json TEXT, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_scorer ON eval_runs(scorer, created_at_ms);

CREATE TABLE IF NOT EXISTS eval_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, scorer TEXT NOT NULL, split_idx INTEGER NOT NULL,
  n INTEGER NOT NULL, expectancy REAL, hit_rate REAL, brier REAL, ece REAL, coverage REAL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(run_id, scorer, split_idx)
);
CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results(run_id);

-- Analog Engine — Phase D. Durable, versioned go/no-go reports. A survivorship-biased or
-- synthetic dataset can never carry a GO verdict (enforced in report.ts). PURELY ADDITIVE.
CREATE TABLE IF NOT EXISTS analog_eval_reports (
  report_id TEXT PRIMARY KEY,
  report_version INTEGER NOT NULL,
  dataset_kind TEXT NOT NULL,             -- real_seeded | survivorship_fallback | synthetic
  verdict TEXT NOT NULL,                   -- GO | REMEDIATE | STOP | EXPLORATORY_ONLY
  verdict_reason TEXT,
  universe_source TEXT, survivorship_bias INTEGER NOT NULL DEFAULT 1,
  date_from TEXT, date_to TEXT, episode_count INTEGER,
  report_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analog_reports_verdict ON analog_eval_reports(verdict, created_at_ms);

-- Analog Engine — Phase E. Recommendation cards (paper research only; NO live execution).
-- A row may be an abstention/rejection (recommend=0) with its reason. PURELY ADDITIVE.
CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rec_id TEXT NOT NULL UNIQUE,
  ticker TEXT NOT NULL, side TEXT,
  recommend INTEGER NOT NULL, production_eligible INTEGER NOT NULL, research_only INTEGER NOT NULL,
  option_symbol TEXT, strike REAL, expiration TEXT, dte INTEGER, bid REAL, ask REAL, spread_pct REAL,
  confidence REAL, analog_count INTEGER, effective_sample INTEGER, median_outcome REAL, dispersion REAL, win_rate REAL,
  abstain_reason TEXT, rejection_reason TEXT, outcome_basis TEXT,
  card_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recommendations_ticker ON recommendations(ticker, created_at_ms);

-- Analog Engine — Phase F. Forward paper validation + two-speed alerts. PURELY ADDITIVE.
-- forward_recommendations is IMMUTABLE (captured before the outcome; never updated); outcomes and
-- alert lifecycle live in separate tables. NO real-money execution; puts stay RESEARCH_ONLY.
CREATE TABLE IF NOT EXISTS forward_recommendations (
  rec_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  captured_at_ms INTEGER NOT NULL, trading_day TEXT NOT NULL, symbol TEXT NOT NULL,
  strategy_key TEXT NOT NULL, direction TEXT NOT NULL, side TEXT NOT NULL,
  production_eligible INTEGER NOT NULL, research_only INTEGER NOT NULL,
  underlying_price REAL NOT NULL, observed_at_ms INTEGER NOT NULL,
  contract_json TEXT, entry_zone_json TEXT, max_chase_pct REAL,
  confidence REAL, analog_count INTEGER, effective_sample INTEGER,
  catalyst TEXT, technical_state_json TEXT, gates_passed_json TEXT,
  rejection_reason TEXT, abstain_reason TEXT, outcome_basis TEXT, provenance_json TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forward_recs_day ON forward_recommendations(trading_day, strategy_key);

CREATE TABLE IF NOT EXISTS forward_outcomes (
  rec_id TEXT NOT NULL, horizon TEXT NOT NULL,
  label_as_of_ms INTEGER NOT NULL, return_pct REAL, win INTEGER, mfe_pct REAL, mae_pct REAL,
  outcome_kind TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  UNIQUE(rec_id, horizon)
);

CREATE TABLE IF NOT EXISTS two_speed_alerts (
  alert_id TEXT PRIMARY KEY,
  rec_id TEXT, symbol TEXT NOT NULL, direction TEXT, side TEXT,
  state TEXT NOT NULL,                 -- EARLY_WATCH | CONFIRMED | CANCELED | TOO_LATE | EXPIRED
  production_eligible INTEGER NOT NULL DEFAULT 0, research_only INTEGER NOT NULL DEFAULT 1,
  market_event_ms INTEGER NOT NULL,
  latency_json TEXT,                  -- LatencyRecord: one-clock stage stamps
  discord_message_id TEXT, discord_failures INTEGER NOT NULL DEFAULT 0, discord_retries INTEGER NOT NULL DEFAULT 0,
  late_entry INTEGER NOT NULL DEFAULT 0, reason TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_two_speed_state ON two_speed_alerts(state, created_at_ms);

-- Broad Discovery + Analog Shadow Bridge. SHADOW-ONLY: records candidates / analog evidence /
-- market context; sends NO alerts, changes NO thresholds. PURELY ADDITIVE. Flags default OFF.
CREATE TABLE IF NOT EXISTS discovery_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL, sources_json TEXT, price REAL, change_pct REAL, rel_volume REAL, dollar_volume REAL,
  eligible INTEGER NOT NULL, exclusions_json TEXT, options_checked INTEGER NOT NULL DEFAULT 0,
  observed_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_shadow_sym ON discovery_shadow(symbol, observed_at_ms);

CREATE TABLE IF NOT EXISTS analog_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL, t0_ms INTEGER NOT NULL, tag TEXT NOT NULL DEFAULT 'ANALOG_SHADOW_ONLY',
  abstain INTEGER NOT NULL, abstain_reason TEXT, comparable_count INTEGER, effective_sample INTEGER,
  confidence REAL, win_rate REAL, dispersion REAL, contradiction REAL,
  fwd_p10 REAL, fwd_p50 REAL, fwd_p90 REAL, nearest_distance REAL,
  agrees_with_live INTEGER, agreement TEXT, lookup_ms INTEGER, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analog_shadow_sym ON analog_shadow(symbol, t0_ms);

CREATE TABLE IF NOT EXISTS market_context_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT, as_of_ms INTEGER NOT NULL, regime TEXT, vol_regime TEXT,
  spy_trend TEXT, qqq_trend TEXT, iwm_trend TEXT, sector TEXT, industry TEXT, sector_rel_strength REAL,
  breadth REAL, catalyst_category TEXT, earnings_in_days INTEGER, session TEXT,
  missing_json TEXT, context_json TEXT, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_context_shadow ON market_context_shadow(as_of_ms);

-- Earnings + options-activity discovery sources (shadow) and the AI_SHADOW_ONLY enrichment.
-- PURELY ADDITIVE; SHADOW-ONLY (no alerts, not actionable). Flags default OFF.
CREATE TABLE IF NOT EXISTS earnings_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, categories_json TEXT,
  expected_at_ms INTEGER, session TEXT, timing_confirmed INTEGER, provenance TEXT, hours_until REAL,
  gap_pct REAL, rel_volume REAL, options_available INTEGER, eligible INTEGER NOT NULL,
  exclusions_json TEXT, rejection_reason TEXT, observed_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_earnings_shadow_sym ON earnings_shadow(symbol, observed_at_ms);

CREATE TABLE IF NOT EXISTS options_activity_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, abstain INTEGER NOT NULL, reasons_json TEXT,
  flow_classification TEXT NOT NULL, call_put_vol_ratio REAL, directional_imbalance REAL, direction TEXT,
  total_option_volume REAL, vol_vs_baseline REAL, liquid_unusual_contracts INTEGER,
  strikes_involved INTEGER, expirations_involved INTEGER, max_contract_vol_oi REAL,
  observed_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_activity_shadow_sym ON options_activity_shadow(symbol, observed_at_ms);

CREATE TABLE IF NOT EXISTS ai_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tag TEXT NOT NULL DEFAULT 'AI_SHADOW_ONLY',
  classification TEXT, catalyst_class TEXT, agrees_with_scanner INTEGER, agrees_with_analog INTEGER,
  abstained INTEGER NOT NULL DEFAULT 0, schema_ok INTEGER NOT NULL DEFAULT 0, hallucination INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, error TEXT,
  output_json TEXT, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_shadow_sym ON ai_shadow(symbol, created_at_ms);

-- Independent Options Opportunity Scanner (separate from the Stock Momentum Radar). SHADOW/PAPER-ONLY;
-- no real-money execution, nothing auto-actionable. PURELY ADDITIVE. Flags default OFF.
CREATE TABLE IF NOT EXISTS options_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tier INTEGER, session TEXT,
  selected_strategy TEXT, direction TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0, score REAL,
  considered_json TEXT, state TEXT NOT NULL, why TEXT, option_symbol TEXT,
  chain_fetch_ms INTEGER, freshness_state TEXT, callout_message TEXT, latency_json TEXT,
  earliness_phase TEXT, escalated_by TEXT, feature_snapshot_json TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_candidates ON options_candidates(symbol, created_at_ms);
-- PERFORMANCE (2026-08-18 audit): the paper lifecycle resolves the READY/SELECTED
-- candidate behind EVERY alert, once per alert, with
--   WHERE symbol=? AND UPPER(COALESCE(state,'')) IN ('READY','SELECTED')
--     AND created_at_ms <= ? ORDER BY id DESC LIMIT 1
-- The UPPER(COALESCE(state,'')) call is not sargable against the plain index above, and
-- ORDER BY id DESC cannot be served by it either, so SQLite read every candidate row
-- for the symbol -- SELECT *, so including the feature/market-structure JSON blobs --
-- and sorted them, on a 92k-row table, for each of several hundred alerts. That was the
-- single largest cost behind the homepage and the paper-chain diagnostic.
--
-- An index ON THE EXPRESSION is used deliberately in preference to rewriting the
-- predicate: the query keeps its exact current semantics, so no row it selects and no
-- lifecycle stage it reports can change. Additive index only.
--
-- Verified with EXPLAIN QUERY PLAN, not assumed. The seek becomes
-- SEARCH ... (symbol=? AND <expr>=? AND created_at_ms<?). The temp B-tree for
-- ORDER BY id DESC survives -- an IN() over two state values cannot be walked in one
-- ordered pass -- but it now sorts only the matching READY/SELECTED rows for that
-- symbol instead of every candidate row the symbol ever had.
CREATE INDEX IF NOT EXISTS idx_options_candidates_state_lookup
  ON options_candidates(symbol, UPPER(COALESCE(state,'')), created_at_ms, id);

CREATE TABLE IF NOT EXISTS options_paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, option_symbol TEXT NOT NULL, side TEXT, strike REAL, expiration TEXT, dte INTEGER,
  result_class TEXT NOT NULL, bid REAL, ask REAL, mid REAL, spread_pct REAL, entry_fill REAL,
  volume REAL, open_interest REAL, iv REAL, delta REAL, underlying_price REAL,
  strategy TEXT, target REAL, invalidation REAL, provenance TEXT, status TEXT NOT NULL,
  exit_fill REAL, pnl REAL, return_pct REAL, mfe_pct REAL, mae_pct REAL, last_mark_return_pct REAL,
  exit_reason TEXT, entered_at_ms INTEGER, exit_at_ms INTEGER,
  session TEXT, core_broad TEXT, feature_snapshot_json TEXT,
  -- AI Research Lab data foundation: paper_kind is the STRUCTURAL audience separator. DELIVERED_ALERT_PAPER
  -- = the exact mirror of a Discord alert that was actually delivered (linked by alert_id); RESEARCH_ONLY_PAPER
  -- = shadow/experimental trades subscribers never see; LEGACY_UNCLASSIFIED = pre-foundation rows (quarantined
  -- from BOTH subscriber stats and research learning). Subscriber performance reads ONLY the delivered view.
  paper_kind TEXT, alert_id TEXT, entry_source TEXT, experiment_id TEXT, experiment_variant TEXT,
  thesis_fingerprint TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_paper_strategy ON options_paper_trades(strategy, side, dte);

CREATE TABLE IF NOT EXISTS options_paper_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL,
  option_symbol TEXT NOT NULL,
  mark_at_ms INTEGER NOT NULL,
  bid REAL,
  ask REAL,
  exit_fill REAL,
  return_pct REAL,
  quote_age_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(trade_id, mark_at_ms)
);
CREATE INDEX IF NOT EXISTS idx_options_paper_marks_trade ON options_paper_marks(trade_id, mark_at_ms);
-- PERFORMANCE (2026-08-18 audit): the ranked-setups premium series falls back to
-- a WHERE option_symbol=? ORDER BY mark_at_ms read when a trade id is not resolvable.
-- options_paper_marks is the largest live table (320k rows in production) and had no
-- index on option_symbol, so that fallback scanned and sorted the whole table once per
-- ranked callout. Additive index only: no mark, return, excursion or statistic changes.
CREATE INDEX IF NOT EXISTS idx_options_paper_marks_contract ON options_paper_marks(option_symbol, mark_at_ms);

-- Prospective-only audit evidence. This table never authorizes a scan, delivery, paper entry, or exit.
CREATE TABLE IF NOT EXISTS options_research_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_key TEXT NOT NULL UNIQUE, observed_at_ms INTEGER NOT NULL, session_date TEXT NOT NULL, symbol TEXT NOT NULL,
  direction TEXT, thesis_fingerprint TEXT, opportunity_case_id TEXT, alert_id TEXT, strategy_family TEXT,
  scanner_lane TEXT, candidate_state TEXT, readiness_state TEXT, authority_state TEXT, blockers_json TEXT,
  underlying_price REAL, vwap REAL, vwap_relationship TEXT, support_level REAL, resistance_level REAL, trigger_level REAL,
  structure_state TEXT, momentum_state TEXT, relative_state TEXT, option_symbol TEXT, option_type TEXT,
  strike REAL, expiration TEXT, option_bid REAL, option_ask REAL, spread_pct REAL, quote_timestamp_ms INTEGER,
  quote_age_ms INTEGER, volume REAL, open_interest REAL, delta REAL, dte INTEGER, contract_quality_state TEXT,
  source TEXT NOT NULL, freshness_state TEXT, created_at_ms INTEGER NOT NULL,
  frozen_entry REAL, target_t1 REAL, target_t2 REAL, target_stop REAL,
  paper_trade_id INTEGER, discord_message_id TEXT, delivery_proof_state TEXT
);
CREATE INDEX IF NOT EXISTS idx_options_research_observations_session ON options_research_observations(session_date, observed_at_ms);

CREATE TABLE IF NOT EXISTS options_lifecycle_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_trade_id INTEGER,
  alert_id TEXT,
  option_symbol TEXT NOT NULL,
  event_type TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  quote_ts_ms INTEGER,
  observed_at_ms INTEGER NOT NULL,
  bid REAL,
  ask REAL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_lifecycle_observations_trade
  ON options_lifecycle_observations(paper_trade_id, observed_at_ms);

-- NOTE: idx_options_paper_kind (references paper_kind) is created in the migration block AFTER the
-- guarded ALTER adds paper_kind — never here, or it would fail on an existing pre-foundation DB.

-- Gated private-beta options Discord delivery. Honest send states; SENT only after a successful
-- webhook response. PURELY ADDITIVE; no webhook secret is ever stored here. Flag default OFF.
CREATE TABLE IF NOT EXISTS options_alerts (
  alert_id TEXT PRIMARY KEY, candidate_symbol TEXT NOT NULL, strategy TEXT, option_symbol TEXT, side TEXT,
  research_only INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, message_hash TEXT, message TEXT,
  delivered_bid REAL, delivered_ask REAL, delivered_underlying REAL, paper_linked INTEGER NOT NULL DEFAULT 0,
  discord_status INTEGER, latency_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, failure_reason TEXT,
  attempted_at_ms INTEGER, sent_at_ms INTEGER,
  -- frozen decision-time entry + deterministic targets shown to the subscriber (persisted verbatim), plus
  -- the session state the alert fired in. Grading uses these exact values.
  session_state TEXT, entry_mid REAL, delivered_spread_pct REAL, quote_ts_ms INTEGER,
  target_t1 REAL, target_t2 REAL, target_stop REAL, target_method TEXT,
  thesis_fingerprint TEXT, paper_trade_id INTEGER, paper_reservation_state TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_alerts_state ON options_alerts(state, created_at_ms);
-- PERFORMANCE (2026-08-18 audit): the homepage sparkline reads recent prints per
-- symbol (WHERE candidate_symbol=?) and the paper-chain window reads SENT alerts by
-- send time. Neither had a supporting index. Additive only.
CREATE INDEX IF NOT EXISTS idx_options_alerts_symbol ON options_alerts(candidate_symbol, updated_at_ms);
CREATE INDEX IF NOT EXISTS idx_options_alerts_sent ON options_alerts(state, sent_at_ms);

-- Autonomous-runtime state for the options scanner (persistent heartbeat, boot self-check, daily-summary
-- dedup). Small key/value store; survives restart/deploy so runtime status needs no manual endpoint call.
CREATE TABLE IF NOT EXISTS options_runtime (
  key TEXT PRIMARY KEY, value TEXT, updated_at_ms INTEGER NOT NULL
);

-- Autonomous AI Research Queue: high-value COMPLETED work only (closed trades, TOO_LATE alerts),
-- harvested from the DB after the fact — the AI is never on the live alert path. Priority 1=highest.
-- Budget-aware processing pauses at the monthly hard limit; tasks stay QUEUED. PURELY ADDITIVE.
CREATE TABLE IF NOT EXISTS ai_research_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, priority INTEGER NOT NULL, ref_id TEXT NOT NULL,
  payload_json TEXT, status TEXT NOT NULL DEFAULT 'QUEUED', attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT, error TEXT, lease_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  UNIQUE(kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_research_queue_claim ON ai_research_queue(status, priority, created_at_ms);

-- Portfolio-level delivery decisions: every READY candidate's ranked outcome (DELIVER_TO_DISCORD /
-- RESEARCH_ONLY / REJECT) with quality, rank, cluster, threshold, and competing candidates — the full
-- "why did this deserve interrupting a subscriber" audit trail. PURELY ADDITIVE.
CREATE TABLE IF NOT EXISTS options_delivery_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL, symbol TEXT NOT NULL, strategy TEXT, side TEXT, tier INTEGER,
  outcome TEXT NOT NULL, reason TEXT, quality REAL, rank INTEGER, batch_size INTEGER,
  components_json TEXT, cluster_key TEXT, threshold REAL, session_state TEXT,
  alert_id TEXT, would_deliver_solo INTEGER, competing_json TEXT,
  delivery_attempted INTEGER NOT NULL DEFAULT 0, delivery_sent INTEGER NOT NULL DEFAULT 0,
  delivery_state TEXT, final_delivery_outcome TEXT NOT NULL DEFAULT 'SKIPPED',
  delivery_failure_category TEXT, final_delivery_reason TEXT,
  delivery_attempted_at_ms INTEGER, delivery_completed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_delivery_decisions ON options_delivery_decisions(outcome, created_at_ms);
-- idx_options_delivery_final_outcome is created after additive column migrations (legacy DBs may lack final_delivery_outcome until then).

-- The frozen experiment registry. One row per (experiment, version), written ONCE and never
-- updated: definition_hash pins the gate behaviour so a retuned rule cannot inherit the
-- prospective sample of the rule it replaced. A changed rule is a NEW version, not an update.
-- Status moves through the lifecycle in options_experiment_status; this table is the identity.
CREATE TABLE IF NOT EXISTS options_experiment_registry (
  experiment_id TEXT NOT NULL,
  experiment_version INTEGER NOT NULL,
  mode TEXT NOT NULL,                     -- SHADOW_PAPER_ONLY
  hypothesis TEXT NOT NULL,
  gates_json TEXT NOT NULL,               -- id/label/rationale per gate, as frozen
  definition_hash TEXT NOT NULL,          -- content hash of gate BEHAVIOUR at freeze
  creation_sha TEXT NOT NULL,             -- commit that introduced the rule; never recomputed
  prospective_start_date TEXT NOT NULL,
  activation_at_ms INTEGER NOT NULL,
  source_cohort_id TEXT NOT NULL,
  development_sessions_json TEXT NOT NULL,
  validation_sessions_json TEXT NOT NULL,
  historical_result_json TEXT NOT NULL,
  robustness_caveats_json TEXT NOT NULL,  -- the framings under which it is NOT profitable
  would_be_disproven_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (experiment_id, experiment_version)
);

-- Experiment lifecycle. Append-only: every status change is a row, so a demotion cannot erase
-- the evidence that promoted it. There is deliberately no SUBSCRIBER_APPROVED status.
CREATE TABLE IF NOT EXISTS options_experiment_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL,
  experiment_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  previous_status TEXT,
  reason TEXT NOT NULL,
  evidence_json TEXT,                     -- the counts/metrics that justified the move
  actor TEXT NOT NULL,                    -- 'deterministic' | 'ai_proposal' | human actor id
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_experiment_status ON options_experiment_status(experiment_id, experiment_version, created_at_ms);

-- The prospective shadow arm: baseline and experiment decided on the SAME opportunity, written
-- BEFORE the outcome is known. BOTH_REJECT rows are kept so the denominator is real, and
-- BASELINE_ONLY rows are what put the experiment's rejections on trial. Nothing here authorizes
-- a send: the baseline columns record a decision that was already made elsewhere.
-- NOTE: distinct from options_shadow_decisions (the gate-comparison shadow runner) below.
CREATE TABLE IF NOT EXISTS options_experiment_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_key TEXT NOT NULL,             -- deterministic; makes a repeated batch idempotent
  experiment_id TEXT NOT NULL,
  experiment_version INTEGER NOT NULL,
  session_date TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  side TEXT,
  direction TEXT,
  option_symbol TEXT NOT NULL,
  opportunity_case_id TEXT,
  alert_id TEXT,
  -- arm
  baseline_admitted INTEGER NOT NULL,
  baseline_outcome TEXT,
  baseline_reason TEXT,
  baseline_quality REAL,
  experiment_admitted INTEGER NOT NULL,
  experiment_blocked_by_json TEXT,
  experiment_unavailable_json TEXT,
  experiment_score REAL,
  experiment_components_json TEXT,
  experiment_reason TEXT,
  arm TEXT NOT NULL,                      -- BOTH_ADMIT | BASELINE_ONLY | EXPERIMENT_ONLY | BOTH_REJECT
  -- inputs the decision was made on, so it can be re-derived without the provider
  features_json TEXT,
  confirmation_json TEXT,
  attribution_json TEXT,
  -- outcome linkage, filled LATER by the mirror/grader. Never written at decision time.
  paper_trade_id INTEGER,
  outcome_status TEXT,                    -- OPEN | CLOSED | UNGRADABLE
  return_pct REAL,
  exit_reason TEXT,
  closed_at_ms INTEGER,
  same_contract_marks INTEGER,
  peak_pct REAL,
  trough_pct REAL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(decision_key)
);
CREATE INDEX IF NOT EXISTS idx_options_experiment_decisions_session ON options_experiment_decisions(experiment_id, session_date);
CREATE INDEX IF NOT EXISTS idx_options_experiment_decisions_arm ON options_experiment_decisions(experiment_id, arm, outcome_status);
CREATE INDEX IF NOT EXISTS idx_options_experiment_decisions_paper ON options_experiment_decisions(paper_trade_id);

-- Persisted Evidence Learning findings. A finding is a NAMED, checkable claim with its
-- limitations attached: limitations_json is NOT NULL because a finding quoted without its
-- limitations is how "PF 1.24" becomes "it works".
CREATE TABLE IF NOT EXISTS options_learning_findings (
  finding_id TEXT PRIMARY KEY,
  strategy TEXT,
  strategy_version TEXT,
  population TEXT,
  evidence_cohort_id TEXT,
  sessions_json TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  baseline_metric_json TEXT,
  experimental_metric_json TEXT,
  evidence_strength TEXT NOT NULL,        -- STRONG | MODERATE | WEAK | INSUFFICIENT
  limitations_json TEXT NOT NULL,
  affected_opportunity_ids_json TEXT,
  recommended_experiment TEXT,
  experiment_id TEXT,
  experiment_status TEXT,
  must_not_be_summarized_as TEXT,
  deployment_sha TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_learning_findings ON options_learning_findings(strategy, created_at_ms);

-- Legacy bearish detections that were suppressed by the legacy Discord owner are kept as audit/escalation
-- evidence for the independent bearish authority. These rows never authorize subscriber SEND by themselves.
CREATE TABLE IF NOT EXISTS options_bearish_escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legacy_alert_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  occ TEXT,
  side TEXT,
  strategy_family TEXT,
  signal_score REAL,
  liquidity_score REAL,
  bid REAL,
  ask REAL,
  mid REAL,
  spread_pct REAL,
  volume REAL,
  open_interest REAL,
  delta REAL,
  alert_time TEXT NOT NULL,
  suppression_reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at_ms INTEGER NOT NULL,
  UNIQUE(legacy_alert_id, occ)
);
CREATE INDEX IF NOT EXISTS idx_options_bearish_escalations_pending ON options_bearish_escalations(symbol, status, created_at_ms);

-- Shadow-mode comparison: proposed gates vs actual paths (never sends Discord).
CREATE TABLE IF NOT EXISTS options_shadow_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_session_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  strategy TEXT,
  side TEXT,
  path TEXT NOT NULL,
  would_send INTEGER NOT NULL DEFAULT 0,
  entry_quality_verdict TEXT,
  session_guard_state TEXT,
  reasons_json TEXT,
  metrics_json TEXT,
  underlying_returns_json TEXT,
  option_returns_json TEXT,
  alert_fingerprint TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_shadow_decisions ON options_shadow_decisions(trading_session_date, created_at_ms);
-- PERFORMANCE (2026-08-18 audit): the Quant Lab counts supervisor observations with
-- COUNT(*) WHERE path='supervisor'. This table holds 3.7M supervisor rows in
-- production and had no index on path, so that one number cost a full table scan --
-- on a volume-backed disk -- every time the page loaded. Additive index only.
CREATE INDEX IF NOT EXISTS idx_options_shadow_decisions_path ON options_shadow_decisions(path);

-- Shadow soak forward outcomes — isolated from DELIVERED_ALERT_PAPER / claims / social.
CREATE TABLE IF NOT EXISTS options_shadow_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shadow_decision_id INTEGER,
  candidate_symbol TEXT NOT NULL,
  strategy TEXT,
  side TEXT,
  trading_session_date TEXT NOT NULL,
  path TEXT NOT NULL,
  would_send INTEGER NOT NULL DEFAULT 0,
  option_symbol TEXT,
  frozen_entry REAL,
  frozen_t1 REAL,
  frozen_t2 REAL,
  frozen_stop REAL,
  underlying_at_decision REAL,
  option_at_decision REAL,
  entry_quality_verdict TEXT,
  entry_quality_dimensions_json TEXT,
  session_guard_state TEXT,
  decision_at_ms INTEGER NOT NULL,
  return_1m REAL,
  return_5m REAL,
  return_15m REAL,
  return_30m REAL,
  return_60m REAL,
  underlying_return_1m REAL,
  underlying_return_5m REAL,
  underlying_return_15m REAL,
  underlying_return_30m REAL,
  underlying_return_60m REAL,
  option_return_1m REAL,
  option_return_5m REAL,
  option_return_15m REAL,
  option_return_30m REAL,
  option_return_60m REAL,
  bid_at_decision REAL,
  ask_at_decision REAL,
  spread_pct_at_decision REAL,
  dte_at_decision INTEGER,
  strike_at_decision REAL,
  expiration_at_decision TEXT,
  quality_score REAL,
  block_reasons_json TEXT,
  mfe_pct REAL,
  mae_pct REAL,
  mfe_at_ms INTEGER,
  mae_at_ms INTEGER,
  missing_data_reason TEXT,
  final_result TEXT,
  t1_hit INTEGER,
  t2_hit INTEGER,
  stop_hit INTEGER,
  underlying_direction_correct INTEGER,
  data_status TEXT NOT NULL DEFAULT 'PENDING',
  marks_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_shadow_outcomes ON options_shadow_outcomes(trading_session_date, decision_at_ms);
CREATE INDEX IF NOT EXISTS idx_options_shadow_outcomes_decision ON options_shadow_outcomes(shadow_decision_id);
-- PERFORMANCE (2026-08-18 audit): measured, and the measurement overturned the first
-- guess. Per-lane timing showed the two shadow lanes cost 34.3s and 7.1s of the Quant
-- Lab's total -- while returning 145 and 89 rows. The cost was never the rows; it was
-- scanning a table whose proposed/independent rows are a rounding error beside its
-- supervisor rows, to find them.
--
-- Leading with the path column because that is the selective one: with production's mix
-- an index on (would_send, path) would still walk half the table. Benchmarked at
-- production selectivity: SCAN 262ms -> SEARCH 1ms in memory, and the production
-- figure is far larger because the scan is real disk I/O. Additive index only; the
-- query, its filters and every statistic it feeds are unchanged.
CREATE INDEX IF NOT EXISTS idx_options_shadow_outcomes_path ON options_shadow_outcomes(path, would_send);

-- Subscriber-readiness state machine (owner-only launch gate). SINGLE row (id=1): the current
-- NOT_READY / SUBSCRIBER_READY status, the exact evidence snapshot at the last transition, and the
-- notification-delivery bookkeeping that makes the READY / REVOKED message fire exactly once per edge
-- (persisted BEFORE the Discord send, so a restart never resends). Nothing here changes trading,
-- billing, roles, or code — it only records that the measurable launch bar was met.
CREATE TABLE IF NOT EXISTS options_subscriber_readiness_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'NOT_READY',        -- NOT_READY | SUBSCRIBER_READY
  transition_id INTEGER NOT NULL DEFAULT 0,        -- monotonic; increments on every real edge
  last_evaluated_at_ms INTEGER,
  last_transition_at_ms INTEGER,
  last_failing_gate TEXT,                          -- gate id that caused the most recent REVOKE
  evidence_snapshot_json TEXT,                     -- frozen report at the last transition
  ready_notified_transition_id INTEGER,            -- transition_id whose READY message was sent
  revoked_notified_transition_id INTEGER,          -- transition_id whose REVOKED message was sent
  last_notification_kind TEXT,                     -- READY | REVOKED
  last_notification_status TEXT,                   -- PENDING | SENT | FAILED | SKIPPED_NO_WEBHOOK
  last_notification_error TEXT,
  last_notification_message_id TEXT,
  last_notification_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

-- Owner attestations for the non-measurable launch gates (billing/cancellation/failed-payment/
-- role-revocation tested, legal & licensing checklist, no unresolved Critical issues). Code cannot
-- observe that a flow was TESTED, so readiness requires an explicit persisted owner sign-off with
-- who + when. Clearing a row (attested=0) immediately makes that gate fail again.
CREATE TABLE IF NOT EXISTS options_subscriber_readiness_attestations (
  attestation_key TEXT PRIMARY KEY,                -- e.g. billing_flows_tested, legal_checklist_complete
  attested INTEGER NOT NULL DEFAULT 0,             -- 1 = signed off
  attested_by TEXT,                                -- owner-supplied label (never a secret)
  note TEXT,
  attested_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

-- Durable Massive/Polygon request accounting (Gate B6). The in-process meter lives on
-- globalThis and zeroes on every deploy, so it can never be the daily meter of record.
-- Rolled up per minute (not per request) so a 280/min day costs ~thousands of rows
-- instead of ~168k; every per-day / per-consumer ratio is recoverable by summation.
CREATE TABLE IF NOT EXISTS provider_request_minute (
  trading_date TEXT NOT NULL,             -- ET trading date
  minute_bucket_ms INTEGER NOT NULL,      -- floor(atMs / 60000) * 60000
  deployment_id TEXT NOT NULL,            -- short commit; proves totals survive restarts
  consumer TEXT NOT NULL,                 -- scanner | options_paper_mark | ... | unattributed
  category TEXT NOT NULL,                 -- scanner | mark | discovery | research | enrichment | diagnostic
  endpoint TEXT NOT NULL,                 -- normalized path, symbols collapsed to :sym / :occ
  historical INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,    -- calls that actually reached the provider
  cache_hits INTEGER NOT NULL DEFAULT 0,
  dedup_avoided INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  http_429 INTEGER NOT NULL DEFAULT 0,
  provider_errors INTEGER NOT NULL DEFAULT 0,
  quota_blocks INTEGER NOT NULL DEFAULT 0, -- refused by our own budget, NOT missing data
  paginated INTEGER NOT NULL DEFAULT 0,
  records_returned INTEGER NOT NULL DEFAULT 0,
  latency_ms_total INTEGER NOT NULL DEFAULT 0,
  latency_ms_max INTEGER NOT NULL DEFAULT 0,
  accounting_version INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (trading_date, minute_bucket_ms, deployment_id, consumer, endpoint, historical)
);
CREATE INDEX IF NOT EXISTS idx_provider_request_minute_day ON provider_request_minute(trading_date, consumer);
CREATE INDEX IF NOT EXISTS idx_provider_request_minute_bucket ON provider_request_minute(minute_bucket_ms);

-- Per-symbol / per-OCC spend, day-grained (symbol cardinality makes minute grain unsafe).
CREATE TABLE IF NOT EXISTS provider_request_symbol_day (
  trading_date TEXT NOT NULL,
  consumer TEXT NOT NULL,
  symbol TEXT NOT NULL,
  option_symbol TEXT NOT NULL DEFAULT '',  -- '' when the call is not OCC-specific
  requests INTEGER NOT NULL DEFAULT 0,
  records_returned INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (trading_date, consumer, symbol, option_symbol)
);
CREATE INDEX IF NOT EXISTS idx_provider_request_symbol_day_top
  ON provider_request_symbol_day(trading_date, requests DESC);

-- Canonical Opportunity Case (Enterprise Phase 2). Append-friendly audit record for delivered AND rejected paths.
CREATE TABLE IF NOT EXISTS opportunity_cases (
  opportunity_id TEXT PRIMARY KEY,
  underlying_symbol TEXT NOT NULL,
  direction TEXT,
  setup_family TEXT,
  detected_at_ms INTEGER NOT NULL,
  market_session TEXT,
  source_path TEXT NOT NULL,
  acceptance_decision TEXT NOT NULL,
  delivery_decision TEXT NOT NULL,
  rejection_reason_codes_json TEXT,
  alert_id TEXT,
  case_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunity_cases_detected ON opportunity_cases(detected_at_ms);
CREATE INDEX IF NOT EXISTS idx_opportunity_cases_symbol ON opportunity_cases(underlying_symbol, detected_at_ms);
CREATE INDEX IF NOT EXISTS idx_opportunity_cases_delivery ON opportunity_cases(delivery_decision, detected_at_ms);
-- Case lookup by alert. Measured: without this, selecting opportunity_id by
-- alert_id is a full SCAN of ~20.6k rows plus a temp B-tree, and the paper-chain
-- diagnostic runs it once per SENT alert (~460x per /api/now). That single
-- statement was 23.9s of a 28.5s request.
CREATE INDEX IF NOT EXISTS idx_opportunity_cases_alert ON opportunity_cases(alert_id);

-- Living Opportunity Case lifecycle (additive). One active opportunity per fingerprint.
CREATE TABLE IF NOT EXISTS opportunity_active_index (
  opportunity_fingerprint TEXT PRIMARY KEY,
  opportunity_case_id TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  session_date TEXT NOT NULL,
  strategy_key TEXT,
  lifecycle_status TEXT NOT NULL,
  opened_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunity_active_symbol ON opportunity_active_index(symbol, session_date, lifecycle_status);

-- Session thesis owns the one opening Discord message. Exact contract identity remains separate.
CREATE TABLE IF NOT EXISTS opportunity_thesis_active_index (
  thesis_fingerprint TEXT PRIMARY KEY,
  opportunity_case_id TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  option_type TEXT NOT NULL,
  session_date TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  opening_source TEXT NOT NULL,
  discord_message_id TEXT,
  opened_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunity_thesis_symbol
  ON opportunity_thesis_active_index(symbol, direction, option_type, session_date, lifecycle_status);

-- Closing a case deletes its thesis active-index row, which also re-arms the outward
-- opening path. Without this, the same symbol+direction could send a SECOND opening
-- alert minutes after the subscriber was told the first one hit T1. One row per closed
-- thesis; the claim path refuses a re-open until cooldown_until_ms passes.
CREATE TABLE IF NOT EXISTS opportunity_thesis_reopen_cooldown (
  thesis_fingerprint TEXT PRIMARY KEY,
  opportunity_case_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  option_type TEXT NOT NULL,
  session_date TEXT NOT NULL,
  closed_at_ms INTEGER NOT NULL,
  close_reason TEXT,
  return_percent REAL,
  cooldown_until_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunity_thesis_cooldown_until
  ON opportunity_thesis_reopen_cooldown(cooldown_until_ms);
CREATE INDEX IF NOT EXISTS idx_opportunity_thesis_cooldown_symbol
  ON opportunity_thesis_reopen_cooldown(symbol, direction, option_type, session_date);

-- Subscriber eligibility used to be IMPLIED: a strategy reached subscribers because it won
-- selection and cleared a quality bar, never because anything established it was worth
-- sending. Expectancy -7.2% / profit factor 0.49 is what that produced. Readiness is now
-- explicit and REQUIRED, and absence of a row means RESEARCH_ONLY - absence of a record is
-- absence of permission, so a legacy database fails closed rather than open.
CREATE TABLE IF NOT EXISTS strategy_readiness_state (
  strategy_key TEXT PRIMARY KEY,            -- "<strategy>@<version>"
  strategy TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  state TEXT NOT NULL,
  classification TEXT,
  reason TEXT NOT NULL,
  sample_size INTEGER,
  expectancy_pct REAL,
  profit_factor REAL,
  evidence_snapshot_json TEXT,
  actor TEXT NOT NULL,
  deployment_sha TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_strategy_readiness_state ON strategy_readiness_state(state);

-- Every promotion and demotion, with the evidence that motivated it, so a later reader can
-- audit not just WHAT changed but on what basis and by whom.
CREATE TABLE IF NOT EXISTS strategy_readiness_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_key TEXT NOT NULL,
  strategy TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  prior_state TEXT,
  new_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  classification TEXT,
  sample_size INTEGER,
  metrics_json TEXT,
  evidence_snapshot_json TEXT,
  actor TEXT NOT NULL,
  deployment_sha TEXT,
  at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_strategy_readiness_transitions_key
  ON strategy_readiness_transitions(strategy_key, at_ms);

-- The persisted ranking breakdown. Opportunity cases recorded rank=null,
-- rankExplanation=null and rejectedContracts=[] , so "why did 774P beat 770P" was
-- structurally unanswerable from stored evidence. One row per ranked candidate per
-- decision, winner and runners-up alike.
CREATE TABLE IF NOT EXISTS opportunity_rank_breakdown (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL,
  ranking_version TEXT NOT NULL,
  symbol TEXT NOT NULL,
  session_date TEXT,
  strategy TEXT,
  direction TEXT,
  option_symbol TEXT,
  rank INTEGER NOT NULL,
  is_selected INTEGER NOT NULL DEFAULT 0,
  total_score REAL,
  components_json TEXT,
  penalties_json TEXT,
  unavailable_json TEXT,
  hard_blockers_json TEXT,
  outranked_reason TEXT,
  rejected_reason TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunity_rank_decision
  ON opportunity_rank_breakdown(decision_id, rank);
CREATE INDEX IF NOT EXISTS idx_opportunity_rank_symbol
  ON opportunity_rank_breakdown(symbol, created_at_ms);

CREATE TABLE IF NOT EXISTS opportunity_contract_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thesis_fingerprint TEXT NOT NULL,
  opportunity_case_id TEXT NOT NULL,
  opportunity_fingerprint TEXT NOT NULL,
  option_symbol TEXT NOT NULL,
  previous_option_symbol TEXT,
  side TEXT NOT NULL,
  strike REAL NOT NULL,
  expiration TEXT NOT NULL,
  strategy_key TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  bid REAL,
  ask REAL,
  spread_pct REAL,
  delta REAL,
  open_interest REAL,
  volume REAL,
  reason TEXT NOT NULL,
  expiration_difference_days INTEGER,
  strike_difference REAL,
  previous_liquidity_json TEXT,
  new_liquidity_json TEXT,
  previous_spread_pct REAL,
  previous_delta REAL,
  original_contract_remains_valid INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(opportunity_case_id, opportunity_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_opportunity_contract_candidates_case
  ON opportunity_contract_candidates(opportunity_case_id, observed_at_ms);

CREATE TABLE IF NOT EXISTS opportunity_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_case_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  milestone_percent REAL,
  label TEXT NOT NULL,
  reached_at_ms INTEGER NOT NULL,
  contract_mark REAL,
  return_percent REAL,
  delivered_at_ms INTEGER,
  claim_token TEXT,
  discord_message_id TEXT,
  details_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(opportunity_case_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_opportunity_milestones_case ON opportunity_milestones(opportunity_case_id, delivered_at_ms);

CREATE TABLE IF NOT EXISTS opportunity_evidence_events (
  id TEXT PRIMARY KEY,
  opportunity_case_id TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  score REAL,
  details_json TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunity_evidence_case ON opportunity_evidence_events(opportunity_case_id, observed_at_ms);

-- Excursion corrections. An AUDIT record, not an edit: opportunity_cases keeps its
-- original summary.maxReturnPct verbatim so a wrong number that was once published
-- stays visible, and this table records what the frozen contract actually printed,
-- which evidence state condemned the original, and the SHA that computed it.
-- corrected_max_return_pct is NULL whenever no value is provable — that null means
-- "unknown" and must never be rendered as the original.
CREATE TABLE IF NOT EXISTS opportunity_excursion_corrections (
  opportunity_case_id TEXT PRIMARY KEY,
  original_max_return_pct REAL,
  original_source TEXT NOT NULL,
  evidence_state TEXT NOT NULL,
  corrected_max_return_pct REAL,
  corrected_mae_pct REAL,
  frozen_option_symbol TEXT,
  marks_on_frozen INTEGER NOT NULL DEFAULT 0,
  correction_sha TEXT,
  corrected_at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_excursion_corrections_state
  ON opportunity_excursion_corrections(evidence_state);

-- PRE_MOVE_DISCOVERY_V1 — the prospective record of WHERE IN THE MOVE an opportunity was
-- found. One row per opportunity case, progressively completed as the case advances
-- through detection -> eligibility -> contract selection -> alert.
--
-- The detection-stage columns are WRITE-ONCE (filled with COALESCE, never overwritten).
-- That is the whole point of the table: "the underlying when we first saw it" stops being
-- true the moment a later scan overwrites it, and a discovery stage computed from an
-- overwritten detection price would report every alert as perfectly early. Historical
-- cases have no prospective capture and none is invented for them — a row exists only
-- for a case observed after this table shipped.
--
-- Diagnostic only. No gate, threshold, ranking weight or exit reads any column here.
CREATE TABLE IF NOT EXISTS opportunity_pre_move_discovery (
  opportunity_case_id TEXT PRIMARY KEY,
  session_date TEXT,
  symbol TEXT,
  direction TEXT,
  option_side TEXT,
  option_symbol TEXT,
  strategy_key TEXT,
  model_version TEXT NOT NULL,
  deployment_sha TEXT,
  lane TEXT,

  first_detected_at_ms INTEGER,
  first_eligible_at_ms INTEGER,
  confirmation_started_at_ms INTEGER,
  confirmation_completed_at_ms INTEGER,
  contract_selected_at_ms INTEGER,
  owner_notified_at_ms INTEGER,

  underlying_at_detection REAL,
  underlying_at_eligible REAL,
  underlying_at_alert REAL,

  option_at_detection REAL,
  option_at_eligible REAL,
  option_at_alert REAL,

  -- The DELIBERATE opposite of the write-once rule above: these track the most recent
  -- decision-time observation and are overwritten on every scan. They are the honest
  -- "current" endpoint for a case that never alerted — most of the research and shadow
  -- population. Without them such a case would measure detection against detection,
  -- score 0% of the move consumed, and read as maximally early forever: a metric that
  -- always flatters us. They are never used when an alert exists.
  underlying_at_latest REAL,
  option_at_latest REAL,
  latest_observed_at_ms INTEGER,

  trigger_level REAL,
  trigger_taken INTEGER,
  compression_pct REAL,
  volume_acceleration REAL,
  session_high REAL,
  session_low REAL,
  vwap REAL,
  above_vwap INTEGER,
  breakout_state TEXT,
  market_alignment TEXT,
  regime TEXT,
  dte INTEGER,
  delta REAL,
  iv REAL,
  spread_pct REAL,
  open_interest INTEGER,
  contract_volume INTEGER,
  moneyness_pct REAL,

  discovery_stage TEXT,
  underlying_move_consumed_pct REAL,
  premium_expansion_consumed_pct REAL,
  move_consumed_fraction REAL,
  reward_remaining_fraction REAL,
  reward_remaining_band TEXT,
  evidence_quality TEXT,
  missing_fields_json TEXT,
  classification_reason TEXT,

  -- ── PRE_MOVE_DISCOVERY_V2 (additive, measurement only) ────────────────────
  -- The V1 columns above cannot answer the earliness question and are left exactly
  -- as they are: V1 rows keep their V1 stage forever and nothing here rewrites one.
  --
  -- These are the ALERT-INSTANT snapshot. V2 refuses to classify against
  -- session_high/session_low above because those are a running MAX/MIN that keeps
  -- WIDENING AFTER THE ALERT — using them would let the rest of the day enlarge the
  -- denominator of a decision made hours earlier, and every callout would drift
  -- earlier the longer its session ran. Write-once, captured at the send.
  --
  -- A row with v2_captured = 0 is UNGRADABLE in V2 forever. That is the prospective
  -- rule: nothing is back-filled and no post-alert observation is admitted as though
  -- it had been in hand at the time.
  v2_captured INTEGER NOT NULL DEFAULT 0,
  session_high_at_alert REAL,
  session_low_at_alert REAL,
  session_open_at_alert REAL,
  vwap_at_alert REAL,
  trigger_level_at_alert REAL,
  trigger_taken_at_alert INTEGER,
  first_partial_confirmation_at_ms INTEGER,
  first_expansion_at_ms INTEGER,
  entry_premium REAL,
  target1_premium REAL,
  target2_premium REAL,
  stop_premium REAL,
  v2_model_version TEXT,
  v2_definition_hash TEXT,
  v2_discovery_stage TEXT,
  v2_trigger_state TEXT,
  v2_session_move_consumed_fraction REAL,
  v2_reward_remaining_fraction REAL,
  v2_underlying_move_consumed_pct REAL,
  v2_premium_expansion_consumed_pct REAL,
  v2_distance_to_trigger_pct REAL,
  v2_extension_from_vwap_pct REAL,
  v2_evidence_quality TEXT,
  v2_missing_fields_json TEXT,
  v2_reason TEXT,

  observations INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pre_move_discovery_session
  ON opportunity_pre_move_discovery(session_date, discovery_stage);
CREATE INDEX IF NOT EXISTS idx_pre_move_discovery_lane
  ON opportunity_pre_move_discovery(lane, first_detected_at_ms);

-- ───────────────────────────────────────────────────────────────────────────
-- DURABLE HISTORICAL STORE
--
-- Until now every historical fetch was answered from the provider and thrown
-- away: bars were consumed by computeOptionsFeatures per scan and discarded,
-- and the historical option fetchers cached in memory only. That is why
-- "provider has it" kept being mistaken for "OptiScan has it" — nothing was
-- ever possessed.
--
-- Three rules hold across every table here.
--
-- 1. IDENTITY IS THE PRIMARY KEY, so re-ingesting the same window is a no-op
--    rather than a duplicate. Every ingestion path must be safe to re-run after
--    a crash, and dedupe belongs in the schema rather than in each caller.
-- 2. SOURCE AND QUALITY TRAVEL WITH THE ROW. A trade print and an executable
--    NBBO answer different questions, and a row that cannot say which it is
--    will eventually be read as the other one.
-- 3. NOTHING HERE IS DERIVED. These tables hold what the provider returned,
--    normalized. Anything computed from them is computed at read time by the
--    replay engine, so a change to our reasoning never requires rewriting
--    history.
--
-- Additive and inert: no live scanner, gate, alert, stop or exit reads any of
-- these tables.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS historical_underlying_bars (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,          -- '1m' | '5m' | '1d'
  ts_ms INTEGER NOT NULL,           -- bar OPEN time, epoch ms, UTC
  open REAL, high REAL, low REAL, close REAL,
  volume REAL,
  vwap REAL,
  trade_count INTEGER,
  source TEXT NOT NULL,             -- provider + endpoint family
  ingest_version TEXT NOT NULL,
  quality TEXT NOT NULL,            -- OK | PARTIAL
  ingested_at_ms INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe, ts_ms)
);
CREATE INDEX IF NOT EXISTS idx_hist_bars_symbol_time
  ON historical_underlying_bars(symbol, timeframe, ts_ms);

-- Executable NBBO. The ONLY table that can answer "what could have been paid".
CREATE TABLE IF NOT EXISTS historical_option_quotes (
  occ TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  bid REAL, ask REAL,
  bid_size REAL, ask_size REAL,
  source TEXT NOT NULL,
  ingest_version TEXT NOT NULL,
  ingested_at_ms INTEGER NOT NULL,
  PRIMARY KEY (occ, ts_ms)
);
CREATE INDEX IF NOT EXISTS idx_hist_opt_quotes_occ_time
  ON historical_option_quotes(occ, ts_ms);

-- Trade prints. Deliberately a SEPARATE table from quotes rather than one table
-- with a kind column: a trade is where the contract traded, an NBBO is what
-- could have been paid, and the whole failure this store exists to prevent is
-- one being substituted for the other. Two tables cannot be conflated by a
-- forgotten filter.
CREATE TABLE IF NOT EXISTS historical_option_trades (
  occ TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,   -- disambiguates prints sharing a timestamp
  price REAL,
  size REAL,
  source TEXT NOT NULL,
  ingest_version TEXT NOT NULL,
  ingested_at_ms INTEGER NOT NULL,
  PRIMARY KEY (occ, ts_ms, seq)
);
CREATE INDEX IF NOT EXISTS idx_hist_opt_trades_occ_time
  ON historical_option_trades(occ, ts_ms);

-- Expired-contract reference. An expired OCC cannot be resolved any other way,
-- and without it the historical universe is limited to contracts still listed
-- today — a survivorship-biased sample of exactly the wrong kind.
CREATE TABLE IF NOT EXISTS historical_contract_reference (
  occ TEXT PRIMARY KEY,
  underlying TEXT NOT NULL,
  side TEXT NOT NULL,
  strike REAL,
  expiration TEXT,
  expired INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  ingest_version TEXT NOT NULL,
  ingested_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_contract_ref_underlying
  ON historical_contract_reference(underlying, expiration);

-- Ingestion progress. The row that makes a job RESUMABLE rather than
-- restartable: a run that dies halfway leaves its cursor, and the next run
-- continues from it instead of re-spending the provider budget on windows
-- already stored.
CREATE TABLE IF NOT EXISTS historical_ingestion_progress (
  job_key TEXT PRIMARY KEY,         -- dataset|symbol-or-occ|timeframe
  dataset TEXT NOT NULL,
  subject TEXT NOT NULL,
  timeframe TEXT,
  cursor_ms INTEGER,                -- next window start; null = not started
  completed_through_ms INTEGER,     -- everything at or before this is stored
  rows_ingested INTEGER NOT NULL DEFAULT 0,
  requests_spent INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,             -- PENDING | IN_PROGRESS | COMPLETE | BLOCKED | FAILED
  last_note TEXT,
  last_run_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_ingestion_status
  ON historical_ingestion_progress(dataset, status);

-- Market context DERIVED from stored bars, kept apart from anything observed
-- live. A derived row states the bars it was computed from; presenting it as a
-- live observation would make a reconstruction indistinguishable from a
-- measurement.
CREATE TABLE IF NOT EXISTS historical_market_context (
  session_date TEXT NOT NULL,
  as_of_ms INTEGER NOT NULL,
  context_version TEXT NOT NULL,
  origin TEXT NOT NULL,             -- DERIVED_FROM_HISTORICAL_BARS | OBSERVED_LIVE
  broad_direction TEXT,
  spy_trend TEXT, qqq_trend TEXT,
  spy_change_pct REAL, qqq_change_pct REAL,
  spy_above_vwap INTEGER, qqq_above_vwap INTEGER,
  volatility_state TEXT,
  trend_state TEXT,
  session_state TEXT,
  bars_used INTEGER NOT NULL DEFAULT 0,
  missing_fields_json TEXT,
  quality TEXT NOT NULL,
  ingest_version TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_date, as_of_ms, origin)
);
CREATE INDEX IF NOT EXISTS idx_hist_market_context_date
  ON historical_market_context(session_date, as_of_ms);

-- Replay-derived pre-move discovery. A RECONSTRUCTION, never a measurement.
--
-- The origin is in the PRIMARY KEY, not merely a column. A live discovery row is
-- something the scanner really saw; a replay row is an inference from whatever a
-- backfill happened to fetch, and its coverage moves as the store grows. Sharing
-- one identity space would let a reconstruction of the past satisfy a lookup for
-- a forward observation, and every prospective statistic would be quietly
-- contaminated by history. The replay version is in the key for the same reason:
-- re-running a NEW version must add rows, while re-running the SAME version must
-- update in place rather than duplicate.
--
-- Component evidence and missing fields are stored, not just the verdict. A stage
-- with four missing inputs and a stage with none are different claims, and a row
-- that cannot say which it was will eventually be read as the confident one.
CREATE TABLE IF NOT EXISTS historical_pre_move_replay (
  occ TEXT NOT NULL,
  decision_at_ms INTEGER NOT NULL,
  replay_version TEXT NOT NULL,
  origin TEXT NOT NULL,             -- REPLAY_DERIVED (never OBSERVED_LIVE)
  opportunity_case_id TEXT,
  event_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT,
  session_date TEXT,
  detected_at_ms INTEGER,
  stage TEXT NOT NULL,
  underlying_move_consumed_pct REAL,
  premium_expansion_consumed_pct REAL,
  move_consumed_fraction REAL,
  reward_remaining_fraction REAL,
  reward_remaining_band TEXT,
  entry_ask REAL,
  spread_pct REAL,
  dte INTEGER,
  moneyness_pct REAL,
  regime TEXT,
  market_alignment TEXT,
  underlying_bars_used INTEGER NOT NULL DEFAULT 0,
  missing_fields_json TEXT,
  evidence_quality TEXT NOT NULL,   -- COMPLETE | PARTIAL | INSUFFICIENT
  -- Which store the reconstruction rested on, so a row's coverage is auditable
  -- after the store has grown past it.
  source_quote_rows INTEGER,
  source_bar_rows INTEGER,
  reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (occ, decision_at_ms, replay_version, origin)
);
CREATE INDEX IF NOT EXISTS idx_hist_pre_move_replay_session
  ON historical_pre_move_replay(session_date, decision_at_ms);
CREATE INDEX IF NOT EXISTS idx_hist_pre_move_replay_stage
  ON historical_pre_move_replay(stage, evidence_quality);
CREATE INDEX IF NOT EXISTS idx_hist_pre_move_replay_case
  ON historical_pre_move_replay(opportunity_case_id);

CREATE TABLE IF NOT EXISTS opportunity_content_events (
  id TEXT PRIMARY KEY,
  opportunity_case_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  symbol TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  frozen_entry REAL,
  current_mark REAL,
  return_percent REAL,
  milestone_percent REAL,
  max_return_percent REAL,
  direction TEXT,
  option_type TEXT,
  strike REAL,
  expiration TEXT,
  original_thesis_json TEXT,
  evidence_summary_json TEXT,
  strategy_key TEXT,
  content_status TEXT NOT NULL DEFAULT 'PENDING',
  label TEXT,
  payload_json TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunity_content_status ON opportunity_content_events(content_status, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_opportunity_content_case ON opportunity_content_events(opportunity_case_id, occurred_at_ms);

-- Individual Content Event Engine drafts (owner-only Twitter/X suggestions). Never auto-posted.
CREATE TABLE IF NOT EXISTS content_drafts (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  content_event_id TEXT NOT NULL,
  opportunity_case_id TEXT,
  alert_id TEXT,
  claim_packet_id TEXT,
  category TEXT NOT NULL,
  template_family TEXT NOT NULL,
  template_version TEXT NOT NULL DEFAULT 'v1',
  platform TEXT NOT NULL DEFAULT 'twitter',
  draft_text TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  hashtags_json TEXT,
  screenshot_suggestion TEXT,
  chart_annotation TEXT,
  cta_type TEXT NOT NULL DEFAULT 'NONE',
  result_type TEXT,
  frozen_entry REAL,
  mark_used REAL,
  original_alert_at_ms INTEGER,
  trading_session_date TEXT,
  status TEXT NOT NULL DEFAULT 'GENERATED',
  discord_delivery_status TEXT NOT NULL DEFAULT 'PENDING',
  discord_message_id TEXT,
  final_copy TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  approved_at_ms INTEGER,
  rejected_at_ms INTEGER,
  manually_posted_at_ms INTEGER,
  -- Delivery evidence: WHY a draft reached its status, and whether that reason
  -- can change. Mirrored in CONTENT_DRAFT_COLUMN_MIGRATIONS for existing files.
  discord_delivery_reason TEXT,
  discord_delivery_explanation TEXT,
  discord_delivery_retryable INTEGER,
  discord_delivery_detail TEXT,
  discord_attempt_count INTEGER NOT NULL DEFAULT 0,
  discord_last_attempt_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_content_drafts_event ON content_drafts(content_event_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_content_drafts_status ON content_drafts(status, discord_delivery_status);
CREATE INDEX IF NOT EXISTS idx_content_drafts_symbol_cat ON content_drafts(category, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_content_drafts_case ON content_drafts(opportunity_case_id, created_at_ms);

-- Historical learning digests: the CONSUMER for drafts held under
-- HELD_FOR_HISTORICAL_DIGEST. One row per generated digest. Nothing here
-- replaces a draft — the drafts stay exactly where they are, and these rows
-- record which canonical outcomes a digest covered and which it deliberately
-- left out, so "held" can be distinguished from "consumed" and an exclusion can
-- never read as "no data".
CREATE TABLE IF NOT EXISTS content_digests (
  id TEXT PRIMARY KEY,
  generated_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER,
  discord_message_id TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'GENERATED',
  delivery_reason TEXT,
  trigger_source TEXT NOT NULL DEFAULT 'SCHEDULED',
  evidence_version TEXT NOT NULL DEFAULT 'v1',
  covered_from_ms INTEGER,
  covered_to_ms INTEGER,
  included_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  duplicates_collapsed INTEGER NOT NULL DEFAULT 0,
  messages_prevented INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT,
  rendered_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_content_digests_generated ON content_digests(generated_at_ms);

-- One row per canonical outcome considered for a digest, included or not.
-- Exclusions are persisted WITH their reason: an outcome that was left out
-- because it already reached Discord is a different fact from one deferred by
-- the size cap, and only the second is owed a later digest.
CREATE TABLE IF NOT EXISTS content_digest_members (
  digest_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  included INTEGER NOT NULL DEFAULT 1,
  exclusion_reason TEXT,
  opportunity_case_id TEXT,
  symbol TEXT,
  occ TEXT,
  result TEXT,
  return_percent REAL,
  cause_code TEXT,
  cause_provable INTEGER,
  evidence_quality TEXT,
  collapsed_variants INTEGER NOT NULL DEFAULT 0,
  representative_draft_id TEXT,
  draft_ids_json TEXT,
  content_event_ids_json TEXT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (digest_id, outcome_id)
);
CREATE INDEX IF NOT EXISTS idx_content_digest_members_outcome ON content_digest_members(outcome_id, included);

CREATE TABLE IF NOT EXISTS opportunity_suppression_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  strategy TEXT,
  fingerprint TEXT,
  existing_opportunity_case_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  latest_return_percent REAL,
  next_undelivered_milestone REAL,
  details_json TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunity_suppression_symbol ON opportunity_suppression_log(symbol, created_at_ms);

-- Paid Discord subscribers (Stripe + Discord role sync). Owner-only ops; subscribers never access the web app.
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  discord_user_id TEXT UNIQUE,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'inactive',
  plan_id TEXT,
  current_period_end_ms INTEGER,
  grace_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status, updated_at_ms);

CREATE TABLE IF NOT EXISTS subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  processed_ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscription_events_type ON subscription_events(event_type, created_at_ms);

CREATE TABLE IF NOT EXISTS discord_role_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discord_role_sync_user ON discord_role_sync_log(discord_user_id, created_at_ms);

CREATE TABLE IF NOT EXISTS discord_send_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id TEXT,
  opportunity_case_id TEXT,
  kind TEXT NOT NULL,
  ambiguous INTEGER NOT NULL DEFAULT 0,
  discord_message_id TEXT,
  error TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discord_send_attempts_alert ON discord_send_attempts(alert_id, created_at_ms);

-- Evidence Learning Engine: durable completed-candidate evidence + deterministic aggregate patterns.
-- This is ADVISORY ONLY. It is never read by live gates, thresholds, strategy selection, or Discord
-- delivery. AI may summarize these rows into PENDING human-review recommendations, but nothing here
-- can automatically change production trading behavior.
CREATE TABLE IF NOT EXISTS evidence_learning_examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_ref TEXT,
  audience TEXT NOT NULL,
  symbol TEXT,
  sector TEXT,
  strategy TEXT,
  side TEXT,
  time_bucket TEXT,
  market_regime TEXT,
  spy_direction TEXT,
  qqq_direction TEXT,
  relative_volume REAL,
  vwap_distance_pct REAL,
  level_interactions_json TEXT,
  quality_score REAL,
  quality_band TEXT,
  trigger_reason TEXT,
  trigger_components_json TEXT,
  feature_json TEXT,
  option_spread_pct REAL,
  liquidity REAL,
  contract_symbol TEXT,
  entry_price REAL,
  target_price REAL,
  stop_price REAL,
  mfe_pct REAL,
  mae_pct REAL,
  final_return_pct REAL,
  final_outcome TEXT,
  time_to_outcome_ms INTEGER,
  grading_basis TEXT NOT NULL,
  missing_fields_json TEXT,
  completed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_evidence_learning_examples_strategy ON evidence_learning_examples(strategy, completed_at_ms);
CREATE INDEX IF NOT EXISTS idx_evidence_learning_examples_audience ON evidence_learning_examples(audience, completed_at_ms);

CREATE TABLE IF NOT EXISTS evidence_learning_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_key TEXT NOT NULL UNIQUE,
  pattern_kind TEXT NOT NULL,
  label TEXT NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  delivered_sample_size INTEGER NOT NULL DEFAULT 0,
  research_sample_size INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  win_rate REAL,
  avg_return_pct REAL,
  expectancy_pct REAL,
  delivered_win_rate REAL,
  research_win_rate REAL,
  delivered_vs_research_lift REAL,
  confidence TEXT NOT NULL DEFAULT 'LOW',
  statistical_support_json TEXT,
  overfitting_risk TEXT NOT NULL DEFAULT 'HIGH',
  recommendation TEXT,
  recommendation_type TEXT NOT NULL DEFAULT 'OBSERVE',
  evidence_refs_json TEXT,
  source_watermark INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_learning_patterns_kind ON evidence_learning_patterns(pattern_kind, sample_size);

CREATE TABLE IF NOT EXISTS evidence_learning_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  examples_materialized INTEGER NOT NULL DEFAULT 0,
  patterns_materialized INTEGER NOT NULL DEFAULT 0,
  skipped_reason TEXT,
  source_watermark INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

-- Options Historical Replay Lab (Phase 1): deterministic replay of the PRODUCTION detection over
-- historical stock bars. Outcomes are UNDERLYING forward returns (grading_basis stamped) — no option
-- premiums/contracts are simulated (historical option quotes not entitled). PURELY ADDITIVE.
CREATE TABLE IF NOT EXISTS options_replay_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbols TEXT NOT NULL, from_day TEXT NOT NULL, to_day TEXT NOT NULL,
  status TEXT NOT NULL, candidates INTEGER, summary_json TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS options_replay_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, t_ms INTEGER NOT NULL,
  symbol TEXT NOT NULL, strategy TEXT, side TEXT, research_only INTEGER NOT NULL DEFAULT 0,
  quality REAL, strategy_score REAL, matched_signals INTEGER, required_signals INTEGER,
  fraction_move REAL, hour_et INTEGER, fwd30_pct REAL, fwd60_pct REAL, fwd_eod_pct REAL,
  grading_basis TEXT NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_replay_candidates ON options_replay_candidates(run_id, quality);
`;

/** Columns added after the first Alert Lab release — guarded ALTERs. */
const ALERT_COLUMN_MIGRATIONS: [string, string][] = [
  // Base-column backfill for long-lived production SQLite files created before
  // the current alerts schema. Nullable additions preserve audit rows; proof SQL
  // still fails closed when required delivery fields are missing.
  ["source", "ALTER TABLE alerts ADD COLUMN source TEXT NOT NULL DEFAULT 'scanner'"],
  ["direction", "ALTER TABLE alerts ADD COLUMN direction TEXT NOT NULL DEFAULT 'neutral'"],
  ["option_symbol", "ALTER TABLE alerts ADD COLUMN option_symbol TEXT"],
  ["option_side", "ALTER TABLE alerts ADD COLUMN option_side TEXT"],
  ["strike", "ALTER TABLE alerts ADD COLUMN strike REAL"],
  ["expiration", "ALTER TABLE alerts ADD COLUMN expiration TEXT"],
  ["dte", "ALTER TABLE alerts ADD COLUMN dte INTEGER"],
  ["alert_time", "ALTER TABLE alerts ADD COLUMN alert_time TEXT"],
  ["trading_day", "ALTER TABLE alerts ADD COLUMN trading_day TEXT"],
  ["price_at_alert", "ALTER TABLE alerts ADD COLUMN price_at_alert REAL"],
  ["percent_move_at_alert", "ALTER TABLE alerts ADD COLUMN percent_move_at_alert REAL"],
  ["volume", "ALTER TABLE alerts ADD COLUMN volume INTEGER"],
  ["relative_volume", "ALTER TABLE alerts ADD COLUMN relative_volume REAL"],
  ["catalyst_type", "ALTER TABLE alerts ADD COLUMN catalyst_type TEXT"],
  ["catalyst_quality", "ALTER TABLE alerts ADD COLUMN catalyst_quality REAL"],
  ["catalyst_summary", "ALTER TABLE alerts ADD COLUMN catalyst_summary TEXT"],
  ["catalyst_source", "ALTER TABLE alerts ADD COLUMN catalyst_source TEXT"],
  ["signal_score", "ALTER TABLE alerts ADD COLUMN signal_score INTEGER"],
  ["risk_score", "ALTER TABLE alerts ADD COLUMN risk_score INTEGER"],
  ["options_liquidity_score", "ALTER TABLE alerts ADD COLUMN options_liquidity_score INTEGER"],
  ["scanner_score", "ALTER TABLE alerts ADD COLUMN scanner_score REAL"],
  ["status", "ALTER TABLE alerts ADD COLUMN status TEXT NOT NULL DEFAULT 'tracking'"],
  ["is_false_positive", "ALTER TABLE alerts ADD COLUMN is_false_positive INTEGER"],
  ["false_positive_reason", "ALTER TABLE alerts ADD COLUMN false_positive_reason TEXT"],
  ["created_at", "ALTER TABLE alerts ADD COLUMN created_at TEXT"],
  ["alert_type", "ALTER TABLE alerts ADD COLUMN alert_type TEXT"],
  ["score_breakdown_json", "ALTER TABLE alerts ADD COLUMN score_breakdown_json TEXT"],
  ["ai_explanation", "ALTER TABLE alerts ADD COLUMN ai_explanation TEXT"],
  ["public_explanation", "ALTER TABLE alerts ADD COLUMN public_explanation TEXT"],
  ["private_label", "ALTER TABLE alerts ADD COLUMN private_label TEXT"],
  ["public_label", "ALTER TABLE alerts ADD COLUMN public_label TEXT"],
  // 0DTE pivot fields
  ["trade_bias", "ALTER TABLE alerts ADD COLUMN trade_bias TEXT"],
  ["move_status", "ALTER TABLE alerts ADD COLUMN move_status TEXT"],
  ["option_worth_score", "ALTER TABLE alerts ADD COLUMN option_worth_score REAL"],
  ["worth_verdict", "ALTER TABLE alerts ADD COLUMN worth_verdict TEXT"],
  ["chase_risk", "ALTER TABLE alerts ADD COLUMN chase_risk TEXT"],
  ["iv_risk", "ALTER TABLE alerts ADD COLUMN iv_risk TEXT"],
  ["spread_risk", "ALTER TABLE alerts ADD COLUMN spread_risk TEXT"],
  ["continuation_score", "ALTER TABLE alerts ADD COLUMN continuation_score REAL"],
  ["exhaustion_score", "ALTER TABLE alerts ADD COLUMN exhaustion_score REAL"],
  ["long_call_score", "ALTER TABLE alerts ADD COLUMN long_call_score REAL"],
  ["long_put_score", "ALTER TABLE alerts ADD COLUMN long_put_score REAL"],
  ["zero_dte_contract_score", "ALTER TABLE alerts ADD COLUMN zero_dte_contract_score REAL"],
  ["risk_flags", "ALTER TABLE alerts ADD COLUMN risk_flags TEXT"],
  // options pressure confirmation + measured outcomes
  ["options_pressure_label", "ALTER TABLE alerts ADD COLUMN options_pressure_label TEXT"],
  ["options_pressure_json", "ALTER TABLE alerts ADD COLUMN options_pressure_json TEXT"],
  ["call_side_worked", "ALTER TABLE alerts ADD COLUMN call_side_worked INTEGER"],
  ["put_side_worked", "ALTER TABLE alerts ADD COLUMN put_side_worked INTEGER"],
  ["spread_widened", "ALTER TABLE alerts ADD COLUMN spread_widened INTEGER"],
  ["reversed", "ALTER TABLE alerts ADD COLUMN reversed INTEGER"],
  ["short_rate_at_alert", "ALTER TABLE alerts ADD COLUMN short_rate_at_alert REAL"],
  ["volume_surge_at_alert", "ALTER TABLE alerts ADD COLUMN volume_surge_at_alert REAL"],
  // 'trade' = live 1s loop with speed proof; 'research' = slow scan / no speed, never TRADE
  ["alert_tier", "ALTER TABLE alerts ADD COLUMN alert_tier TEXT"],
  // option contract P&L: entry mid -> best mid after alert (set at EOD finalize)
  ["option_return_pct", "ALTER TABLE alerts ADD COLUMN option_return_pct REAL"],
  ["option_outcome_win", "ALTER TABLE alerts ADD COLUMN option_outcome_win INTEGER"],
  ["capture_action", "ALTER TABLE alerts ADD COLUMN capture_action TEXT"],
  ["capture_confidence", "ALTER TABLE alerts ADD COLUMN capture_confidence INTEGER"],
  // stocks mode: 'options' (default) | 'stock', plus the session the alert fired in
  ["asset_class", "ALTER TABLE alerts ADD COLUMN asset_class TEXT NOT NULL DEFAULT 'options'"],
  ["session", "ALTER TABLE alerts ADD COLUMN session TEXT"],
  ["move_classification", "ALTER TABLE alerts ADD COLUMN move_classification TEXT"],
  ["signal_detected_at", "ALTER TABLE alerts ADD COLUMN signal_detected_at TEXT"],
  ["last_confirmed_at", "ALTER TABLE alerts ADD COLUMN last_confirmed_at TEXT"],
  ["move_began_at", "ALTER TABLE alerts ADD COLUMN move_began_at TEXT"],
  ["data_timestamp", "ALTER TABLE alerts ADD COLUMN data_timestamp TEXT"],
  ["expires_at", "ALTER TABLE alerts ADD COLUMN expires_at TEXT"],
  ["last_validated_at", "ALTER TABLE alerts ADD COLUMN last_validated_at TEXT"],
  ["last_trigger_event_at", "ALTER TABLE alerts ADD COLUMN last_trigger_event_at TEXT"],
  ["invalidation_reason", "ALTER TABLE alerts ADD COLUMN invalidation_reason TEXT"],
  ["vwap_at_alert", "ALTER TABLE alerts ADD COLUMN vwap_at_alert REAL"],
  ["vwap_dist_pct_at_alert", "ALTER TABLE alerts ADD COLUMN vwap_dist_pct_at_alert REAL"],
  ["above_vwap", "ALTER TABLE alerts ADD COLUMN above_vwap INTEGER"],
  // VWAP provenance. Historical rows stay NULL — an unknown past VWAP is never back-filled.
  ["vwap_evidence_state", "ALTER TABLE alerts ADD COLUMN vwap_evidence_state TEXT"],
  ["vwap_freshness", "ALTER TABLE alerts ADD COLUMN vwap_freshness TEXT"],
  ["vwap_session", "ALTER TABLE alerts ADD COLUMN vwap_session TEXT"],
  ["vwap_source", "ALTER TABLE alerts ADD COLUMN vwap_source TEXT"],
  ["vwap_as_of_ms", "ALTER TABLE alerts ADD COLUMN vwap_as_of_ms INTEGER"],
  ["underlying_price_at_alert", "ALTER TABLE alerts ADD COLUMN underlying_price_at_alert REAL"],
];
const JOURNAL_COLUMN_MIGRATIONS: [string, string][] = [
  ["contract", "ALTER TABLE trade_journal ADD COLUMN contract TEXT"],
  ["pnl", "ALTER TABLE trade_journal ADD COLUMN pnl REAL"],
  ["entry_reason", "ALTER TABLE trade_journal ADD COLUMN entry_reason TEXT"],
  ["exit_reason", "ALTER TABLE trade_journal ADD COLUMN exit_reason TEXT"],
  ["mistake_notes", "ALTER TABLE trade_journal ADD COLUMN mistake_notes TEXT"],
  ["screenshot_url", "ALTER TABLE trade_journal ADD COLUMN screenshot_url TEXT"],
  ["emotion_tag", "ALTER TABLE trade_journal ADD COLUMN emotion_tag TEXT"],
  ["lesson", "ALTER TABLE trade_journal ADD COLUMN lesson TEXT"],
  ["source", "ALTER TABLE trade_journal ADD COLUMN source TEXT"],
  ["import_batch_id", "ALTER TABLE trade_journal ADD COLUMN import_batch_id INTEGER"],
  ["dedup_key", "ALTER TABLE trade_journal ADD COLUMN dedup_key TEXT"],
];

// Paper realism (2026-07-09): full market snapshot at entry/exit so paper
// trades carry everything a broker fill would — greeks, IV, OI, volume,
// bid/ask — and the future broker adapter changes nothing about the schema.
const PAPER_COLUMN_MIGRATIONS: Array<[string, string]> = [
  ["entry_bid", "ALTER TABLE paper_trades ADD COLUMN entry_bid REAL"],
  ["entry_ask", "ALTER TABLE paper_trades ADD COLUMN entry_ask REAL"],
  ["entry_spread_pct", "ALTER TABLE paper_trades ADD COLUMN entry_spread_pct REAL"],
  ["entry_iv", "ALTER TABLE paper_trades ADD COLUMN entry_iv REAL"],
  ["entry_delta", "ALTER TABLE paper_trades ADD COLUMN entry_delta REAL"],
  ["entry_gamma", "ALTER TABLE paper_trades ADD COLUMN entry_gamma REAL"],
  ["entry_theta", "ALTER TABLE paper_trades ADD COLUMN entry_theta REAL"],
  ["entry_vega", "ALTER TABLE paper_trades ADD COLUMN entry_vega REAL"],
  ["entry_oi", "ALTER TABLE paper_trades ADD COLUMN entry_oi REAL"],
  ["entry_volume", "ALTER TABLE paper_trades ADD COLUMN entry_volume REAL"],
  ["entry_reason", "ALTER TABLE paper_trades ADD COLUMN entry_reason TEXT"],
  ["exit_bid", "ALTER TABLE paper_trades ADD COLUMN exit_bid REAL"],
  ["exit_ask", "ALTER TABLE paper_trades ADD COLUMN exit_ask REAL"],
  ["exit_spread_pct", "ALTER TABLE paper_trades ADD COLUMN exit_spread_pct REAL"],
  // Rebuild (additive): explicit order/position states derived from `status`
  // (legacy status preserved), immutable alert-time + pre-entry snapshots,
  // fill/fee/slippage assumptions, revalidation + drift, and a snapshot version.
  ["order_state", "ALTER TABLE paper_trades ADD COLUMN order_state TEXT"],
  ["position_state", "ALTER TABLE paper_trades ADD COLUMN position_state TEXT"],
  ["close_reason", "ALTER TABLE paper_trades ADD COLUMN close_reason TEXT"],
  ["strategy", "ALTER TABLE paper_trades ADD COLUMN strategy TEXT"],
  ["opportunity_id", "ALTER TABLE paper_trades ADD COLUMN opportunity_id TEXT"],
  ["selector_profile", "ALTER TABLE paper_trades ADD COLUMN selector_profile TEXT"],
  ["selection_score", "ALTER TABLE paper_trades ADD COLUMN selection_score REAL"],
  ["passed_gates", "ALTER TABLE paper_trades ADD COLUMN passed_gates TEXT"],
  ["failed_gates", "ALTER TABLE paper_trades ADD COLUMN failed_gates TEXT"],
  ["alert_time_contract_json", "ALTER TABLE paper_trades ADD COLUMN alert_time_contract_json TEXT"],
  ["preentry_snapshot_json", "ALTER TABLE paper_trades ADD COLUMN preentry_snapshot_json TEXT"],
  ["preentry_drift_json", "ALTER TABLE paper_trades ADD COLUMN preentry_drift_json TEXT"],
  ["entry_slippage", "ALTER TABLE paper_trades ADD COLUMN entry_slippage REAL"],
  ["entry_fees", "ALTER TABLE paper_trades ADD COLUMN entry_fees REAL"],
  ["exit_slippage", "ALTER TABLE paper_trades ADD COLUMN exit_slippage REAL"],
  ["exit_fees", "ALTER TABLE paper_trades ADD COLUMN exit_fees REAL"],
  ["fill_assumptions_json", "ALTER TABLE paper_trades ADD COLUMN fill_assumptions_json TEXT"],
  ["underlying_at_entry", "ALTER TABLE paper_trades ADD COLUMN underlying_at_entry REAL"],
  ["session_at_entry", "ALTER TABLE paper_trades ADD COLUMN session_at_entry TEXT"],
  ["freshness_at_entry", "ALTER TABLE paper_trades ADD COLUMN freshness_at_entry TEXT"],
  ["risk_amount", "ALTER TABLE paper_trades ADD COLUMN risk_amount REAL"],
  ["snapshot_version", "ALTER TABLE paper_trades ADD COLUMN snapshot_version INTEGER"],
  // Phase 1 (setup fingerprinting): immutable fingerprint reference frozen at fill.
  ["fingerprint_id", "ALTER TABLE paper_trades ADD COLUMN fingerprint_id TEXT"],
  ["fingerprint_version", "ALTER TABLE paper_trades ADD COLUMN fingerprint_version INTEGER"],
  ["fingerprint_dimensions_json", "ALTER TABLE paper_trades ADD COLUMN fingerprint_dimensions_json TEXT"],
  ["strategy_version", "ALTER TABLE paper_trades ADD COLUMN strategy_version INTEGER"],
  // Opportunity tracking (2026-07-14): lifetime peak favorable %, continued PAST
  // the paper exit until the contract's expiration (best-effort, sampled from
  // chains the sweep already fetches). Answers "did the call/put ever go green
  // enough to book a profit before expiration?" — distinct from realized P&L.
  ["opportunity_peak_pct", "ALTER TABLE paper_trades ADD COLUMN opportunity_peak_pct REAL"],
  // Risk-based sizing (2026-07-15): the deterministic position-sizer calculation
  // (profile, risk budget, every cap, the binding constraint) frozen at creation
  // so the trade detail page shows exactly why this size was chosen or refused.
  ["sizing_json", "ALTER TABLE paper_trades ADD COLUMN sizing_json TEXT"],
  // Portfolio isolation (2026-07-15): PRIMARY (default) vs the independent
  // AGGRESSIVE_CHALLENGE $10k→$100k paper-only options portfolio. Same signals +
  // exact OCC contracts, fully separate balance / positions / P&L / drawdown.
  ["portfolio", "ALTER TABLE paper_trades ADD COLUMN portfolio TEXT NOT NULL DEFAULT 'PRIMARY'"],
  // Multi-lane research rebuild (Phase 3): setup/lane/strategy/tier attribution frozen
  // on the paper trade so provenance persists through fill, exit, grading, and training.
  ["setup_id", "ALTER TABLE paper_trades ADD COLUMN setup_id TEXT"],
  ["strategy_agent", "ALTER TABLE paper_trades ADD COLUMN strategy_agent TEXT"],
  ["setup_tier", "ALTER TABLE paper_trades ADD COLUMN setup_tier TEXT"],
  ["lane", "ALTER TABLE paper_trades ADD COLUMN lane TEXT"],
];

/** Phase 3: captured two-sided quote on setup_candidates so an independent lane can
 *  fill honestly off the real routed quote (additive; the table itself is Phase 1). */
const SETUP_CANDIDATE_COLUMN_MIGRATIONS: Array<[string, string]> = [
  ["option_bid", "ALTER TABLE setup_candidates ADD COLUMN option_bid REAL"],
  ["option_ask", "ALTER TABLE setup_candidates ADD COLUMN option_ask REAL"],
  ["option_mid", "ALTER TABLE setup_candidates ADD COLUMN option_mid REAL"],
];

/** Opportunity-grade columns on the authoritative outcomes table (additive). */
const PAPER_OUTCOME_COLUMN_MIGRATIONS: Array<[string, string]> = [
  ["opportunity_grade", "ALTER TABLE paper_trade_outcomes ADD COLUMN opportunity_grade TEXT"],
  ["peak_favorable_pct", "ALTER TABLE paper_trade_outcomes ADD COLUMN peak_favorable_pct REAL"],
  ["opportunity_threshold_pct", "ALTER TABLE paper_trade_outcomes ADD COLUMN opportunity_threshold_pct REAL"],
  ["opportunity_window", "ALTER TABLE paper_trade_outcomes ADD COLUMN opportunity_window TEXT"],
];

const AI_REPORT_COLUMN_MIGRATIONS: Array<[string, string]> = [
  ["diagnostic_json", "ALTER TABLE ai_reports ADD COLUMN diagnostic_json TEXT"],
];

const AI_JOB_RUN_COLUMN_MIGRATIONS: Array<[string, string]> = [
  ["diagnostic_json", "ALTER TABLE ai_job_runs ADD COLUMN diagnostic_json TEXT"],
];

const REPLAY_RUNS_COLUMN_MIGRATIONS: Array<[string, string]> = [
  ["provider_calls_attempted", "ALTER TABLE replay_runs ADD COLUMN provider_calls_attempted INTEGER NOT NULL DEFAULT 0"],
  ["symbols_with_data", "ALTER TABLE replay_runs ADD COLUMN symbols_with_data INTEGER NOT NULL DEFAULT 0"],
  ["per_symbol_json", "ALTER TABLE replay_runs ADD COLUMN per_symbol_json TEXT"],
  // Async job model (Phase E.3): progress fields so a background worker can persist after every
  // chunk and GET can report progress without loading the whole run.
  ["episodes_captured", "ALTER TABLE replay_runs ADD COLUMN episodes_captured INTEGER NOT NULL DEFAULT 0"],
  ["labels_captured", "ALTER TABLE replay_runs ADD COLUMN labels_captured INTEGER NOT NULL DEFAULT 0"],
  ["symbols_total", "ALTER TABLE replay_runs ADD COLUMN symbols_total INTEGER NOT NULL DEFAULT 0"],
  ["symbols_done", "ALTER TABLE replay_runs ADD COLUMN symbols_done INTEGER NOT NULL DEFAULT 0"],
  ["chunks_completed", "ALTER TABLE replay_runs ADD COLUMN chunks_completed INTEGER NOT NULL DEFAULT 0"],
  ["current_symbol", "ALTER TABLE replay_runs ADD COLUMN current_symbol TEXT"],
  ["cancel_requested", "ALTER TABLE replay_runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0"],
  ["started_at_ms", "ALTER TABLE replay_runs ADD COLUMN started_at_ms INTEGER"],
  // Out-of-process worker lease (Phase E.4): a background worker process claims a run and renews
  // a lease heartbeat; an expired lease (crashed/restarted worker) is reclaimable by the next poll.
  ["lease_owner", "ALTER TABLE replay_runs ADD COLUMN lease_owner TEXT"],
  ["lease_until_ms", "ALTER TABLE replay_runs ADD COLUMN lease_until_ms INTEGER"],
  ["heartbeat_ms", "ALTER TABLE replay_runs ADD COLUMN heartbeat_ms INTEGER"],
];
/**
 * Content-draft delivery evidence (additive). The pipeline persisted only the
 * final status, so a transient rate limit and a genuine duplicate were the same
 * row. All nullable: existing drafts keep their status and simply carry no
 * reason, which is honest — no reason was recorded for them.
 */
const CONTENT_DRAFT_COLUMN_MIGRATIONS: Array<[string, string]> = [
  ["discord_delivery_reason", "ALTER TABLE content_drafts ADD COLUMN discord_delivery_reason TEXT"],
  ["discord_delivery_explanation", "ALTER TABLE content_drafts ADD COLUMN discord_delivery_explanation TEXT"],
  ["discord_delivery_retryable", "ALTER TABLE content_drafts ADD COLUMN discord_delivery_retryable INTEGER"],
  ["discord_delivery_detail", "ALTER TABLE content_drafts ADD COLUMN discord_delivery_detail TEXT"],
  ["discord_attempt_count", "ALTER TABLE content_drafts ADD COLUMN discord_attempt_count INTEGER NOT NULL DEFAULT 0"],
  ["discord_last_attempt_at_ms", "ALTER TABLE content_drafts ADD COLUMN discord_last_attempt_at_ms INTEGER"],
  // Content-worthiness (additive, all nullable). Every draft written before the
  // worthiness filter existed carries NULL rather than a backfilled score —
  // those drafts were never scored, and inventing a number for them would make
  // the "what did the filter change" comparison meaningless.
  ["content_worthiness", "ALTER TABLE content_drafts ADD COLUMN content_worthiness REAL"],
  ["content_angle", "ALTER TABLE content_drafts ADD COLUMN content_angle TEXT"],
  ["worthiness_json", "ALTER TABLE content_drafts ADD COLUMN worthiness_json TEXT"],
  ["is_alternate", "ALTER TABLE content_drafts ADD COLUMN is_alternate INTEGER NOT NULL DEFAULT 0"],
];
/**
 * PRE_MOVE_DISCOVERY_V2 columns on an existing `opportunity_pre_move_discovery`.
 *
 * Purely additive and all nullable except the capture flag, which defaults to 0 so
 * every pre-existing row is correctly UNGRADABLE in V2 rather than silently adopting
 * a stage it was never measured for.
 */
const PRE_MOVE_V2_COLUMN_MIGRATIONS: Array<[string, string]> = [
  ["v2_captured", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_captured INTEGER NOT NULL DEFAULT 0"],
  ["session_high_at_alert", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN session_high_at_alert REAL"],
  ["session_low_at_alert", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN session_low_at_alert REAL"],
  ["session_open_at_alert", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN session_open_at_alert REAL"],
  ["vwap_at_alert", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN vwap_at_alert REAL"],
  ["trigger_level_at_alert", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN trigger_level_at_alert REAL"],
  ["trigger_taken_at_alert", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN trigger_taken_at_alert INTEGER"],
  ["first_partial_confirmation_at_ms", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN first_partial_confirmation_at_ms INTEGER"],
  ["first_expansion_at_ms", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN first_expansion_at_ms INTEGER"],
  ["entry_premium", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN entry_premium REAL"],
  ["target1_premium", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN target1_premium REAL"],
  ["target2_premium", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN target2_premium REAL"],
  ["stop_premium", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN stop_premium REAL"],
  ["v2_model_version", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_model_version TEXT"],
  ["v2_definition_hash", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_definition_hash TEXT"],
  ["v2_discovery_stage", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_discovery_stage TEXT"],
  ["v2_trigger_state", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_trigger_state TEXT"],
  ["v2_session_move_consumed_fraction", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_session_move_consumed_fraction REAL"],
  ["v2_reward_remaining_fraction", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_reward_remaining_fraction REAL"],
  ["v2_underlying_move_consumed_pct", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_underlying_move_consumed_pct REAL"],
  ["v2_premium_expansion_consumed_pct", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_premium_expansion_consumed_pct REAL"],
  ["v2_distance_to_trigger_pct", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_distance_to_trigger_pct REAL"],
  ["v2_extension_from_vwap_pct", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_extension_from_vwap_pct REAL"],
  ["v2_evidence_quality", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_evidence_quality TEXT"],
  ["v2_missing_fields_json", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_missing_fields_json TEXT"],
  ["v2_reason", "ALTER TABLE opportunity_pre_move_discovery ADD COLUMN v2_reason TEXT"],
];

const MOMENTUM_DIAGNOSTIC_COLUMN_MIGRATIONS: Array<[string, string]> = [
  ["classification", "ALTER TABLE momentum_diagnostics ADD COLUMN classification TEXT"],
  ["dominant_reason", "ALTER TABLE momentum_diagnostics ADD COLUMN dominant_reason TEXT"],
  ["first_seen_ms", "ALTER TABLE momentum_diagnostics ADD COLUMN first_seen_ms INTEGER"],
  ["first_ranked_ms", "ALTER TABLE momentum_diagnostics ADD COLUMN first_ranked_ms INTEGER"],
  ["first_promoted_ms", "ALTER TABLE momentum_diagnostics ADD COLUMN first_promoted_ms INTEGER"],
  ["first_seen_move_pct", "ALTER TABLE momentum_diagnostics ADD COLUMN first_seen_move_pct REAL"],
  ["first_ranked_move_pct", "ALTER TABLE momentum_diagnostics ADD COLUMN first_ranked_move_pct REAL"],
  ["first_promoted_move_pct", "ALTER TABLE momentum_diagnostics ADD COLUMN first_promoted_move_pct REAL"],
  ["first_actionable_move_pct", "ALTER TABLE momentum_diagnostics ADD COLUMN first_actionable_move_pct REAL"],
  ["discord_move_pct", "ALTER TABLE momentum_diagnostics ADD COLUMN discord_move_pct REAL"],
  ["ret_5s_pct", "ALTER TABLE momentum_diagnostics ADD COLUMN ret_5s_pct REAL"],
  ["ret_10s_pct", "ALTER TABLE momentum_diagnostics ADD COLUMN ret_10s_pct REAL"],
  ["ret_30s_pct", "ALTER TABLE momentum_diagnostics ADD COLUMN ret_30s_pct REAL"],
  ["ret_60s_pct", "ALTER TABLE momentum_diagnostics ADD COLUMN ret_60s_pct REAL"],
  ["volume_rate", "ALTER TABLE momentum_diagnostics ADD COLUMN volume_rate REAL"],
  ["volume_acceleration", "ALTER TABLE momentum_diagnostics ADD COLUMN volume_acceleration REAL"],
  ["rank_delta", "ALTER TABLE momentum_diagnostics ADD COLUMN rank_delta INTEGER"],
  // Directional evidence (2026-07-15, META fix): baseline type, session return,
  // velocity/accel sign+value, intended direction, delivery-time direction status +
  // quote age, final channel/result, suppression reason — one JSON blob so the
  // diagnostics UI and nightly AI can see WHY a bullish alert did or didn't fire.
  ["direction_json", "ALTER TABLE momentum_diagnostics ADD COLUMN direction_json TEXT"],
  // Observability sprint Phases 1–3: persistOk sub-reasons + firstFailedGate (never affects live gates).
  ["gate_diagnostics_json", "ALTER TABLE momentum_diagnostics ADD COLUMN gate_diagnostics_json TEXT"],
];

function migrate(db: Database.Database) {
  // Column migrations must run before SCHEMA: idx_alerts_dedup references the
  // 'session' column, which pre-stocks-mode databases don't have yet.
  const cols = (table: string) =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name));
  const hasAlerts = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alerts'").get());
  if (hasAlerts) {
    const alertColsPre = cols("alerts");
    for (const [col, sql] of ALERT_COLUMN_MIGRATIONS) if (!alertColsPre.has(col)) db.exec(sql);
    // Stocks mode: dedup is per-session so premarket + after-hours can each
    // call out the same ticker once per day (options rows keep contract dedup).
    const dedupSql: any = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_alerts_dedup'").get();
    if (dedupSql?.sql && !String(dedupSql.sql).includes("session")) db.exec("DROP INDEX idx_alerts_dedup");
  }
  // Legacy production DBs may already have options_delivery_decisions without newer columns.
  // Add columns BEFORE SCHEMA so CREATE INDEX statements in SCHEMA cannot fail on missing columns.
  ensureOptionsDeliveryDecisionsColumns(db);
  db.exec(SCHEMA);
  const paperCols = cols("paper_trades");
  for (const [col, sql] of PAPER_COLUMN_MIGRATIONS) if (!paperCols.has(col)) db.exec(sql);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_candidates'").get()) {
    const scCols = cols("setup_candidates");
    for (const [col, sql] of SETUP_CANDIDATE_COLUMN_MIGRATIONS) if (!scCols.has(col)) db.exec(sql);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_trade_outcomes'").get()) {
    const outcomeCols = cols("paper_trade_outcomes");
    for (const [col, sql] of PAPER_OUTCOME_COLUMN_MIGRATIONS) if (!outcomeCols.has(col)) db.exec(sql);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_reports'").get()) {
    const aiReportCols = cols("ai_reports");
    for (const [col, sql] of AI_REPORT_COLUMN_MIGRATIONS) if (!aiReportCols.has(col)) db.exec(sql);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_job_runs'").get()) {
    const aiJobCols = cols("ai_job_runs");
    for (const [col, sql] of AI_JOB_RUN_COLUMN_MIGRATIONS) if (!aiJobCols.has(col)) db.exec(sql);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_proposals'").get()) {
    const propCols = cols("ai_proposals");
    if (!propCols.has("workflow_json")) db.exec("ALTER TABLE ai_proposals ADD COLUMN workflow_json TEXT");
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='momentum_diagnostics'").get()) {
    const momentumDiagCols = cols("momentum_diagnostics");
    for (const [col, sql] of MOMENTUM_DIAGNOSTIC_COLUMN_MIGRATIONS) if (!momentumDiagCols.has(col)) db.exec(sql);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='content_drafts'").get()) {
    const contentDraftCols = cols("content_drafts");
    for (const [col, sql] of CONTENT_DRAFT_COLUMN_MIGRATIONS) if (!contentDraftCols.has(col)) db.exec(sql);
    // MUST be created here, not in SCHEMA. On an existing production table
    // `CREATE TABLE IF NOT EXISTS` is a no-op, so a SCHEMA-level index over
    // discord_delivery_reason runs BEFORE the ALTERs that add that column and
    // throws "no such column" — which aborts db.exec(SCHEMA) and takes the whole
    // database init down with it. An index on a migrated column belongs after
    // the migration that creates the column.
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_content_drafts_delivery_reason ON content_drafts(discord_delivery_status, discord_delivery_reason)",
    );
    // The queue's default sort is highest-worthiness first within a session.
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_content_drafts_worthiness ON content_drafts(trading_session_date, content_worthiness DESC)",
    );
  }
  // PRE_MOVE_DISCOVERY_V2 (additive, measurement only): the alert-instant snapshot the
  // V2 stage is computed from. Existing rows keep v2_captured = 0 and stay UNGRADABLE.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opportunity_pre_move_discovery'").get()) {
    const preMoveCols = cols("opportunity_pre_move_discovery");
    for (const [col, sql] of PRE_MOVE_V2_COLUMN_MIGRATIONS) if (!preMoveCols.has(col)) db.exec(sql);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_pre_move_v2_stage ON opportunity_pre_move_discovery(v2_captured, v2_discovery_stage)",
    );
  }
  // Analog Engine (additive): replay-seed observability — attempted-vs-succeeded calls + per-symbol status.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='replay_runs'").get()) {
    const replayCols = cols("replay_runs");
    for (const [col, sql] of REPLAY_RUNS_COLUMN_MIGRATIONS) if (!replayCols.has(col)) db.exec(sql);
  }
  // Options enrichment (additive): earliness + decision-time feature snapshot (detail in the JSON).
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_candidates'").get()) {
    const oc = cols("options_candidates");
    for (const [col, sql] of [
      ["earliness_phase", "ALTER TABLE options_candidates ADD COLUMN earliness_phase TEXT"],
      ["escalated_by", "ALTER TABLE options_candidates ADD COLUMN escalated_by TEXT"],
      ["feature_snapshot_json", "ALTER TABLE options_candidates ADD COLUMN feature_snapshot_json TEXT"],
      ...OPTIONS_CANDIDATES_INSTRUMENTATION_MIGRATIONS,
    ] as [string, string][]) if (!oc.has(col)) db.exec(sql);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discord_deliveries'").get()) {
    const dd = cols("discord_deliveries");
    for (const [col, sql] of [
      ["opportunity_case_id", "ALTER TABLE discord_deliveries ADD COLUMN opportunity_case_id TEXT"],
      ["thesis_fingerprint", "ALTER TABLE discord_deliveries ADD COLUMN thesis_fingerprint TEXT"],
      ["lifecycle_state", "ALTER TABLE discord_deliveries ADD COLUMN lifecycle_state TEXT"],
      ["delivery_context_json", "ALTER TABLE discord_deliveries ADD COLUMN delivery_context_json TEXT"],
    ] as [string, string][]) if (!dd.has(col)) db.exec(sql);
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_discord_deliveries_thesis ON discord_deliveries(thesis_fingerprint, lifecycle_state, status)",
    ).run();
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_paper_trades'").get()) {
    const op = cols("options_paper_trades");
    for (const [col, sql] of [
      ["session", "ALTER TABLE options_paper_trades ADD COLUMN session TEXT"],
      ["core_broad", "ALTER TABLE options_paper_trades ADD COLUMN core_broad TEXT"],
      ["feature_snapshot_json", "ALTER TABLE options_paper_trades ADD COLUMN feature_snapshot_json TEXT"],
      // AI Research Lab data foundation (additive, repeat-safe).
      ["paper_kind", "ALTER TABLE options_paper_trades ADD COLUMN paper_kind TEXT"],
      ["alert_id", "ALTER TABLE options_paper_trades ADD COLUMN alert_id TEXT"],
      ["entry_source", "ALTER TABLE options_paper_trades ADD COLUMN entry_source TEXT"],
      ["experiment_id", "ALTER TABLE options_paper_trades ADD COLUMN experiment_id TEXT"],
      ["experiment_variant", "ALTER TABLE options_paper_trades ADD COLUMN experiment_variant TEXT"],
      ["mfe_pct", "ALTER TABLE options_paper_trades ADD COLUMN mfe_pct REAL"],
      ["mae_pct", "ALTER TABLE options_paper_trades ADD COLUMN mae_pct REAL"],
      ["last_mark_return_pct", "ALTER TABLE options_paper_trades ADD COLUMN last_mark_return_pct REAL"],
      // Aggressive 0DTE Research ledger (additive; never used by delivered/readiness paths).
      ["strategy_family", "ALTER TABLE options_paper_trades ADD COLUMN strategy_family TEXT"],
      ["exit_policy_version", "ALTER TABLE options_paper_trades ADD COLUMN exit_policy_version TEXT"],
      ["time_bucket", "ALTER TABLE options_paper_trades ADD COLUMN time_bucket TEXT"],
      ["market_regime", "ALTER TABLE options_paper_trades ADD COLUMN market_regime TEXT"],
      ["contract_moneyness", "ALTER TABLE options_paper_trades ADD COLUMN contract_moneyness TEXT"],
      ["delta_band", "ALTER TABLE options_paper_trades ADD COLUMN delta_band TEXT"],
      ["account_risk_usd", "ALTER TABLE options_paper_trades ADD COLUMN account_risk_usd REAL"],
      ["fingerprint", "ALTER TABLE options_paper_trades ADD COLUMN fingerprint TEXT"],
      ["contract_alts_json", "ALTER TABLE options_paper_trades ADD COLUMN contract_alts_json TEXT"],
      ["thesis_fingerprint", "ALTER TABLE options_paper_trades ADD COLUMN thesis_fingerprint TEXT"],
    ] as [string, string][]) if (!op.has(col)) db.exec(sql);
    // Backfill legacy rows to a QUARANTINE kind: pre-foundation trades cannot be proven as delivered
    // mirrors, so they must never count as subscriber performance — and they aren't Lab experiments
    // either, so they stay out of research learning too. Idempotent (only touches NULL rows).
    db.exec("UPDATE options_paper_trades SET paper_kind='LEGACY_UNCLASSIFIED', entry_source=COALESCE(entry_source,'pre_foundation') WHERE paper_kind IS NULL");
    db.prepare("CREATE INDEX IF NOT EXISTS idx_options_paper_kind ON options_paper_trades(paper_kind, alert_id)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_options_paper_kind_status ON options_paper_trades(paper_kind, status)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_options_paper_kind_fp ON options_paper_trades(paper_kind, fingerprint)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_options_paper_kind_entered ON options_paper_trades(paper_kind, entered_at_ms)").run();
    // PERFORMANCE (2026-08-18 audit): the read paths look a paper trade up by
    // `alert_id` ALONE (paper-chain builds one row per SENT alert; ranked-setups
    // resolves a premium series per callout). `idx_options_paper_kind` leads with
    // `paper_kind`, so SQLite cannot use it for a bare `WHERE alert_id=?` and every
    // such lookup fell back to a full table scan — once per alert, on every homepage
    // load. Additive index only: no query, threshold, statistic or row is changed by it.
    db.prepare("CREATE INDEX IF NOT EXISTS idx_options_paper_alert ON options_paper_trades(alert_id)").run();
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_options_paper_one_active_thesis ON options_paper_trades(thesis_fingerprint) WHERE status='ENTERED' AND thesis_fingerprint IS NOT NULL",
    ).run();
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_options_paper_one_live_thesis ON options_paper_trades(thesis_fingerprint) WHERE status IN ('PENDING_DELIVERY','ENTERED') AND thesis_fingerprint IS NOT NULL",
    ).run();
    // STRUCTURAL separation: subscriber stats read ONLY the delivered view; the (future) Research Lab
    // reads ONLY the research view. A view physically cannot return the other kind — mixing is impossible.
    // Created here (after the ALTER) so paper_kind is guaranteed to exist. Repeat-safe.
    db.exec("CREATE VIEW IF NOT EXISTS options_paper_delivered AS SELECT * FROM options_paper_trades WHERE paper_kind='DELIVERED_ALERT_PAPER'");
    db.exec("CREATE VIEW IF NOT EXISTS options_paper_research AS SELECT * FROM options_paper_trades WHERE paper_kind='RESEARCH_ONLY_PAPER'");
    db.exec("CREATE VIEW IF NOT EXISTS options_paper_zero_dte_research AS SELECT * FROM options_paper_trades WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER'");
    db.exec("CREATE VIEW IF NOT EXISTS options_paper_bearish_research AS SELECT * FROM options_paper_trades WHERE paper_kind='BEARISH_RESEARCH_PAPER'");
    db.exec(`CREATE TABLE IF NOT EXISTS paper_0dte_account_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      equity_usd REAL NOT NULL,
      cash_usd REAL NOT NULL,
      starting_balance_usd REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`);
  }
  // Compact-alert foundation (additive, repeat-safe): frozen entry midpoint + deterministic targets +
  // session state persisted on each alert.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_alerts'").get()) {
    const oa = cols("options_alerts");
    for (const [col, sql] of [
      ["session_state", "ALTER TABLE options_alerts ADD COLUMN session_state TEXT"],
      ["entry_mid", "ALTER TABLE options_alerts ADD COLUMN entry_mid REAL"],
      ["delivered_spread_pct", "ALTER TABLE options_alerts ADD COLUMN delivered_spread_pct REAL"],
      ["quote_ts_ms", "ALTER TABLE options_alerts ADD COLUMN quote_ts_ms INTEGER"],
      ["target_t1", "ALTER TABLE options_alerts ADD COLUMN target_t1 REAL"],
      ["target_t2", "ALTER TABLE options_alerts ADD COLUMN target_t2 REAL"],
      ["target_stop", "ALTER TABLE options_alerts ADD COLUMN target_stop REAL"],
      ["target_method", "ALTER TABLE options_alerts ADD COLUMN target_method TEXT"],
      ["opportunity_case_id", "ALTER TABLE options_alerts ADD COLUMN opportunity_case_id TEXT"],
      ["opportunity_fingerprint", "ALTER TABLE options_alerts ADD COLUMN opportunity_fingerprint TEXT"],
      ["thesis_fingerprint", "ALTER TABLE options_alerts ADD COLUMN thesis_fingerprint TEXT"],
      ["discord_message_id", "ALTER TABLE options_alerts ADD COLUMN discord_message_id TEXT"],
      ["paper_trade_id", "ALTER TABLE options_alerts ADD COLUMN paper_trade_id INTEGER"],
      ["paper_reservation_state", "ALTER TABLE options_alerts ADD COLUMN paper_reservation_state TEXT"],
      ...OPTIONS_ALERTS_INSTRUMENTATION_MIGRATIONS,
    ] as [string, string][]) if (!oa.has(col)) db.exec(sql);
    db.prepare("CREATE INDEX IF NOT EXISTS idx_options_alerts_opportunity ON options_alerts(opportunity_case_id, state)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_options_alerts_fingerprint ON options_alerts(opportunity_fingerprint, state)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_options_alerts_thesis ON options_alerts(thesis_fingerprint, state)").run();
  }
  // Prospective research observations remain additive even when the first evidence migration ran earlier.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_research_observations'").get()) {
    const ro = cols("options_research_observations");
    for (const [col, sql] of [
      ["frozen_entry", "ALTER TABLE options_research_observations ADD COLUMN frozen_entry REAL"],
      ["target_t1", "ALTER TABLE options_research_observations ADD COLUMN target_t1 REAL"],
      ["target_t2", "ALTER TABLE options_research_observations ADD COLUMN target_t2 REAL"],
      ["target_stop", "ALTER TABLE options_research_observations ADD COLUMN target_stop REAL"],
      ["paper_trade_id", "ALTER TABLE options_research_observations ADD COLUMN paper_trade_id INTEGER"],
      ["discord_message_id", "ALTER TABLE options_research_observations ADD COLUMN discord_message_id TEXT"],
      ["delivery_proof_state", "ALTER TABLE options_research_observations ADD COLUMN delivery_proof_state TEXT"],
    ] as [string, string][]) if (!ro.has(col)) db.exec(sql);
  }
  // Living Opportunity Case columns (additive, repeat-safe).
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opportunity_cases'").get()) {
    const ocCols = cols("opportunity_cases");
    for (const [col, sql] of [
      ["opportunity_fingerprint", "ALTER TABLE opportunity_cases ADD COLUMN opportunity_fingerprint TEXT"],
      ["session_date", "ALTER TABLE opportunity_cases ADD COLUMN session_date TEXT"],
      ["lifecycle_status", "ALTER TABLE opportunity_cases ADD COLUMN lifecycle_status TEXT"],
      ["summary_json", "ALTER TABLE opportunity_cases ADD COLUMN summary_json TEXT"],
      ["discord_channel_id", "ALTER TABLE opportunity_cases ADD COLUMN discord_channel_id TEXT"],
      ["discord_message_id", "ALTER TABLE opportunity_cases ADD COLUMN discord_message_id TEXT"],
      ["discord_thread_id", "ALTER TABLE opportunity_cases ADD COLUMN discord_thread_id TEXT"],
      ["opening_delivered_at_ms", "ALTER TABLE opportunity_cases ADD COLUMN opening_delivered_at_ms INTEGER"],
      ["thesis_fingerprint", "ALTER TABLE opportunity_cases ADD COLUMN thesis_fingerprint TEXT"],
      ["opening_source", "ALTER TABLE opportunity_cases ADD COLUMN opening_source TEXT"],
    ] as [string, string][]) if (!ocCols.has(col)) db.exec(sql);
    db.prepare("CREATE INDEX IF NOT EXISTS idx_opportunity_cases_fingerprint ON opportunity_cases(lifecycle_status, opportunity_fingerprint, session_date)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_opportunity_cases_thesis ON opportunity_cases(lifecycle_status, thesis_fingerprint, session_date)").run();
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_delivery_decisions'").get()) {
    ensureOptionsDeliveryDecisionsColumns(db);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_shadow_decisions'").get()) {
    ensureOptionsShadowDecisionsColumns(db);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_shadow_outcomes'").get()) {
    ensureOptionsShadowOutcomesColumns(db);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_candidates'").get()
    || db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_alerts'").get()) {
    ensureSubscriberPipelineInstrumentationColumns(db);
  }
  // Phase 7 (additive): drift-health flag on an existing model_registry table.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_registry'").get()) {
    const mcols = cols("model_registry");
    if (!mcols.has("health")) db.exec("ALTER TABLE model_registry ADD COLUMN health TEXT");
    if (!mcols.has("tier")) db.exec("ALTER TABLE model_registry ADD COLUMN tier TEXT"); // Phase 8
  }
  const alertCols = cols("alerts");
  for (const [col, sql] of ALERT_COLUMN_MIGRATIONS) if (!alertCols.has(col)) db.exec(sql);
  const journalCols = cols("trade_journal");
  for (const [col, sql] of JOURNAL_COLUMN_MIGRATIONS) if (!journalCols.has(col)) db.exec(sql);

  // v3: day-long unique dedup blocked re-callouts on the same ticker; use time-window dedup instead.
  const dedupV3: any = db.prepare("SELECT value FROM scanner_settings WHERE key='alerts_dedup_v3'").get();
  if (!dedupV3) {
    db.exec("DROP INDEX IF EXISTS idx_alerts_dedup");
    db.exec("CREATE INDEX IF NOT EXISTS idx_alerts_dedup_lookup ON alerts(ticker, source, trading_day, alert_time)");
    db.prepare(
      `INSERT INTO scanner_settings (key, value) VALUES ('alerts_dedup_v3', '1')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run();
  }

  db.exec(`
CREATE TABLE IF NOT EXISTS broker_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broker TEXT NOT NULL DEFAULT 'robinhood',
  filename TEXT,
  period_start TEXT,
  period_end TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_journal_dedup ON trade_journal(dedup_key);
`);
  // One-time: enable automatic Discord TRADE alerts (BUY CALL/PUT only at capture).
  const autoDiscord: any = db.prepare("SELECT value FROM scanner_settings WHERE key='discord_auto_defaults_v1'").get();
  if (!autoDiscord) {
    db.prepare("UPDATE notification_settings SET discord_enabled=1, discord_requires_manual_confirm=0 WHERE id=1").run();
    db.prepare(
      `INSERT INTO scanner_settings (key, value) VALUES ('discord_auto_defaults_v1', '1')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run();
  }

  // One-time: drop backlog from when manual confirmation was enabled.
  const discardPending: any = db.prepare("SELECT value FROM scanner_settings WHERE key='discord_discard_stale_pending_v1'").get();
  if (!discardPending) {
    db.prepare(
      `UPDATE notification_events SET status='skipped', error='superseded: auto-send enabled'
       WHERE channel='discord_webhook' AND status='pending_confirm'`,
    ).run();
    db.prepare(
      `INSERT INTO scanner_settings (key, value) VALUES ('discord_discard_stale_pending_v1', '1')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run();
  }

  // One-time: re-lock Discord to auto-send (manual confirm kept getting re-enabled).
  const forceAutoV2: any = db.prepare("SELECT value FROM scanner_settings WHERE key='discord_force_auto_v2'").get();
  if (!forceAutoV2) {
    db.prepare("UPDATE notification_settings SET discord_enabled=1, discord_requires_manual_confirm=0 WHERE id=1").run();
    db.prepare(
      `UPDATE notification_events SET status='skipped', error='superseded: auto-send enforced v2'
       WHERE channel='discord_webhook' AND status='pending_confirm'`,
    ).run();
    db.prepare(
      `INSERT INTO scanner_settings (key, value) VALUES ('discord_force_auto_v2', '1')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run();
  }

  // One-time: product intent is stock Discord during premarket/AH when the
  // stocks webhook exists. Older installs defaulted this off, making the tape
  // look alive while Discord stayed quiet.
  const stockExtV1: any = db.prepare("SELECT value FROM scanner_settings WHERE key='stock_extended_notify_default_v1'").get();
  if (!stockExtV1) {
    db.prepare(
      `INSERT INTO scanner_settings (key, value) VALUES ('extended_stock_notify', '1')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run();
    db.prepare(
      `INSERT INTO scanner_settings (key, value) VALUES ('stock_extended_notify_default_v1', '1')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run();
  }

  // Enterprise tail tables: explicit repair pass for long-lived production DBs where the
  // monolithic SCHEMA exec may not have created Phase-2+ tables on an earlier deploy.
  const repaired = ensureEnterpriseSchemaOnDb(db);
  if (repaired.length > 0) {
    console.info(`[db] enterprise schema repair applied: ${repaired.join(", ")}`);
  }
  const brokerRepaired = ensureBrokerSchemaOnDb(db);
  if (brokerRepaired.length > 0) {
    console.info(`[db] broker schema repair applied: ${brokerRepaired.join(", ")}`);
  }
  // Overnight next-session watchlist (additive, repeat-safe).
  db.exec(`
    CREATE TABLE IF NOT EXISTS overnight_watchlist (
      trading_day TEXT NOT NULL,
      symbol TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      rank INTEGER NOT NULL,
      plan_version TEXT NOT NULL,
      built_at_ms INTEGER NOT NULL,
      PRIMARY KEY (trading_day, symbol)
    );
  `);
  db.prepare("CREATE INDEX IF NOT EXISTS idx_overnight_watchlist_day ON overnight_watchlist(trading_day, rank)").run();
  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist_versions (
      version_id TEXT PRIMARY KEY,
      trading_day TEXT NOT NULL,
      kind TEXT NOT NULL,
      built_at_ms INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      source_window TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'BUILT',
      sent_at_ms INTEGER,
      failure_reason TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_versions_day_kind ON watchlist_versions(trading_day, kind, built_at_ms);
    CREATE TABLE IF NOT EXISTS watchlist_version_symbols (
      version_id TEXT NOT NULL,
      trading_day TEXT NOT NULL,
      kind TEXT NOT NULL,
      rank INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      setup_family TEXT,
      trigger TEXT,
      invalidation TEXT,
      confidence_band TEXT,
      catalyst TEXT,
      status TEXT,
      preferred_dte TEXT,
      preferred_moneyness TEXT,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (version_id, symbol)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_research_notify_log (
      trading_day TEXT NOT NULL,
      kind TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      sent_at_ms INTEGER NOT NULL,
      PRIMARY KEY (trading_day, kind, symbol)
    );
  `);
  // Quant add-ons (Freqtrade/Alphalens-inspired): protections + research trial log.
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      reason TEXT NOT NULL,
      locked_until_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alert_locks_ticker_until ON alert_locks(ticker, locked_until_ms);
    CREATE TABLE IF NOT EXISTS research_trials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trial_key TEXT NOT NULL,
      hypothesis TEXT NOT NULL,
      factor TEXT,
      horizon TEXT,
      metric_name TEXT NOT NULL,
      metric_value REAL,
      p_raw REAL,
      p_adj REAL,
      n_trials_family INTEGER NOT NULL DEFAULT 1,
      sample_days INTEGER NOT NULL DEFAULT 0,
      sample_alerts INTEGER NOT NULL DEFAULT 0,
      split_method TEXT NOT NULL DEFAULT 'trading_day',
      train_days_json TEXT,
      test_days_json TEXT,
      notes TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_research_trials_key ON research_trials(trial_key, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_research_trials_factor ON research_trials(factor, horizon, created_at_ms);
  `);
  // EDGAR context columns on catalyst_records (additive; never gate signals).
  try { db.exec("ALTER TABLE catalyst_records ADD COLUMN filing_type TEXT"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE catalyst_records ADD COLUMN filing_url TEXT"); } catch { /* exists */ }
  // Local greeks / IV premium on options_snapshots for divergence alarms.
  try { db.exec("ALTER TABLE options_snapshots ADD COLUMN local_iv REAL"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE options_snapshots ADD COLUMN local_delta REAL"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE options_snapshots ADD COLUMN local_gamma REAL"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE options_snapshots ADD COLUMN local_theta REAL"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE options_snapshots ADD COLUMN local_vega REAL"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE options_snapshots ADD COLUMN realized_vol REAL"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE options_snapshots ADD COLUMN iv_premium REAL"); } catch { /* exists */ }
  const readiness = inspectSchemaReadiness(db);
  if (!readiness.ok) {
    const parts = [
      readiness.missing.length ? `tables: ${readiness.missing.join(", ")}` : "",
      readiness.missingLegacyColumns.length
        ? `columns: ${readiness.missingLegacyColumns.map((c) => `${c.table}.${c.column}`).join(", ")}`
        : "",
    ].filter(Boolean);
    throw new Error(`schema incomplete after migrate: ${parts.join("; ")}`);
  }
}

type G = typeof globalThis & { __optiscanDb?: Database.Database };

/**
 * Build the EXACT production schema on an arbitrary database handle.
 *
 * `SCHEMA` alone is not the production shape — `migrate()` layers guarded ALTERs on
 * top of it, and columns like `opportunity_cases.session_date` exist only after
 * those run. A fixture built from half the shape is a fixture that tests a database
 * production does not have.
 *
 * This is deliberately the only way out: `SCHEMA` stays private so no test can pick
 * up the incomplete half by accident. Hand-copied `CREATE TABLE` fixtures are how a
 * query for `discord_deliveries.option_side` — a column production has never had —
 * passed its test and would have silenced Monday's recap.
 *
 * Intended for tests and offline tooling. `getDb()` remains the only production path.
 */
export function applyProductionSchemaOnDb(db: Database.Database): void {
  migrate(db);
}

export function getDb(): Database.Database {
  const g = globalThis as G;
  if (g.__optiscanDb) return g.__optiscanDb;
  const dir = process.env.ALERT_DB_DIR || path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "optiscan.db");
  const db = new Database(dbPath);
  // Concurrency hardening (audit P1-2). The 1s loop, the tracker sweep, and
  // API reads all share this file from one process:
  //  - WAL: readers never block the writer.
  //  - busy_timeout 5000: a colliding write waits instead of throwing
  //    "database is locked".
  //  - synchronous NORMAL: safe with WAL, much faster than FULL.
  //  - wal_autocheckpoint 1000 pages: keeps the -wal file bounded on a
  //    long-running VPS (audit found a -wal larger than the DB itself).
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("wal_autocheckpoint = 1000");
  migrate(db);
  g.__optiscanDb = db;
  return db;
}

export { inspectSchemaReadiness, repairAndInspectSchemaReadiness, resolveDbLocation, inspectPartialDatabaseState } from "@/lib/db-schema-readiness";
export {
  ensureOptionsDeliveryDecisionsColumns,
  ensureOptionsShadowDecisionsColumns,
  ensureOptionsShadowOutcomesColumns,
  ensureSubscriberPipelineInstrumentationColumns,
  listMissingShadowSoakTables,
  readInstrumentationFallbackInserts,
  incrementInstrumentationFallbackInserts,
} from "@/lib/db-legacy-columns";

export { tradingDay, etCloseMs, minutesToClose } from "@/lib/trading-session";
