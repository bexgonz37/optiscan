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
  next_retry_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_discord_deliveries_status ON discord_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_discord_deliveries_alert ON discord_deliveries(alert_id);

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
  month_key TEXT NOT NULL,               -- YYYY-MM (ET) for spend rollups
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_job_runs_month ON ai_job_runs(month_key, status);
CREATE INDEX IF NOT EXISTS idx_ai_job_runs_type ON ai_job_runs(job_type, created_at_ms);
`;

/** Columns added after the first Alert Lab release — guarded ALTERs. */
const ALERT_COLUMN_MIGRATIONS: [string, string][] = [
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
];

/** Opportunity-grade columns on the authoritative outcomes table (additive). */
const PAPER_OUTCOME_COLUMN_MIGRATIONS: Array<[string, string]> = [
  ["opportunity_grade", "ALTER TABLE paper_trade_outcomes ADD COLUMN opportunity_grade TEXT"],
  ["peak_favorable_pct", "ALTER TABLE paper_trade_outcomes ADD COLUMN peak_favorable_pct REAL"],
  ["opportunity_threshold_pct", "ALTER TABLE paper_trade_outcomes ADD COLUMN opportunity_threshold_pct REAL"],
  ["opportunity_window", "ALTER TABLE paper_trade_outcomes ADD COLUMN opportunity_window TEXT"],
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
  db.exec(SCHEMA);
  const paperCols = cols("paper_trades");
  for (const [col, sql] of PAPER_COLUMN_MIGRATIONS) if (!paperCols.has(col)) db.exec(sql);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_trade_outcomes'").get()) {
    const outcomeCols = cols("paper_trade_outcomes");
    for (const [col, sql] of PAPER_OUTCOME_COLUMN_MIGRATIONS) if (!outcomeCols.has(col)) db.exec(sql);
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
}

type G = typeof globalThis & { __optiscanDb?: Database.Database };

export function getDb(): Database.Database {
  const g = globalThis as G;
  if (g.__optiscanDb) return g.__optiscanDb;
  const dir = process.env.ALERT_DB_DIR || path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "optiscan.db"));
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

export { tradingDay, etCloseMs, minutesToClose } from "@/lib/trading-session";
