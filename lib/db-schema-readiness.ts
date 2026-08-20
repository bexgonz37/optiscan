/**
 * Enterprise / Phase-2+ schema readiness — explicit, repeat-safe DDL for tables that
 * may be missing on long-lived production SQLite volumes when the monolithic SCHEMA
 * exec did not reach the tail on an earlier deploy. Additive only; never drops data.
 */
import fs from "node:fs";
import path from "node:path";
import {
  LEGACY_COLUMN_CHECKS,
  listMissingLegacyColumns,
  listMissingShadowSoakTables,
  hasSqliteColumn as legacyHasSqliteColumn,
  hasSqliteTable as legacyHasSqliteTable,
  SUBSCRIBER_PIPELINE_INSTRUMENTATION_CHECKS,
} from "./db-legacy-columns.ts";

export const ENTERPRISE_REQUIRED_TABLES = [
  "opportunity_cases",
  "opportunity_active_index",
  "opportunity_milestones",
  "opportunity_evidence_events",
  "opportunity_content_events",
  "opportunity_suppression_log",
  "evidence_learning_examples",
  "evidence_learning_patterns",
  "evidence_learning_runs",
  "setup_episodes",
  "episode_labels",
  "episode_actions",
  "episode_outcome_labels_v2",
  "forward_label_worker_runs",
  "forward_label_coverage_snapshots",
  "forward_label_dataset_versions",
  "forward_label_dataset_members",
  "forward_label_dataset_episodes",
  "forward_label_dataset_state",
  "historical_evidence_inventory",
  "contract_funnel_evidence",
  "storage_health_samples",
  "storage_warning_events",
  "backup_restore_verifications",
  "options_live_latency_traces",
] as const;

export type EnterpriseRequiredTable = (typeof ENTERPRISE_REQUIRED_TABLES)[number];

export interface DbLocationInfo {
  directory: string;
  file: string;
  walFile: string;
  shmFile: string;
  directoryExists: boolean;
  fileExists: boolean;
  directoryWritable: boolean | null;
}

export interface SchemaReadinessReport {
  ok: boolean;
  missing: EnterpriseRequiredTable[];
  present: EnterpriseRequiredTable[];
  missingLegacyColumns: Array<{ table: string; column: string }>;
  presentLegacyColumns: Array<{ table: string; column: string }>;
  missingShadowSoakTables: string[];
  missingInstrumentationColumns: Array<{ table: string; column: string }>;
  tablesSample: string[];
  db: DbLocationInfo;
  repaired: EnterpriseRequiredTable[];
  error: string | null;
}

interface SqliteDb {
  prepare(sql: string): {
    get: (...args: any[]) => any;
    all: (...args: any[]) => any[];
    run: (...args: any[]) => { changes: number };
  };
  exec(sql: string): void;
}

/** Explicit tail DDL — kept separate from the monolithic SCHEMA so production can repair safely. */
const ENTERPRISE_SCHEMA_DDL = `
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

-- Living Opportunity Case lifecycle (additive repair for long-lived production volumes).
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

-- Canonical Phase-1 market memory. setup_episodes remains the single episode
-- table; episode_version=2 rows use the additive identity/Zone-A columns below.
CREATE TABLE IF NOT EXISTS setup_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL, symbol TEXT NOT NULL,
  t0_ms INTEGER NOT NULL, trading_day TEXT NOT NULL, session TEXT NOT NULL,
  tod_bucket TEXT, asset_class TEXT NOT NULL DEFAULT 'stock', direction TEXT,
  regime_label TEXT, regime_model_version INTEGER, liquidity_tier TEXT, validity_tier TEXT,
  price_structure_json TEXT, momentum_json TEXT, volume_json TEXT, volatility_json TEXT,
  regime_json TEXT, sector_json TEXT, breadth_json TEXT, options_context_json TEXT,
  catalyst_json TEXT, liquidity_json TEXT, data_quality_json TEXT, missing_json TEXT,
  gate_results_json TEXT, feature_schema_version INTEGER NOT NULL,
  max_feature_as_of_ms INTEGER NOT NULL, provenance_json TEXT, created_at_ms INTEGER NOT NULL,
  episode_version INTEGER NOT NULL DEFAULT 1, population TEXT, zone_a_json TEXT,
  config_digest TEXT, production_sha TEXT, strategy_version TEXT, feature_version TEXT,
  selected_strategy TEXT, selection_strength REAL, disposition TEXT, rejection_reason TEXT,
  candidate_id INTEGER, opportunity_case_id TEXT, thesis_fingerprint TEXT, selected_occ TEXT,
  source_lane TEXT, entry_convention TEXT,
  -- Phase 2A four-clock instrumentation. Written at INSERT only (the V2 rows are
  -- immutable by trigger). t0_ms keeps its existing meaning and Zone-A validation
  -- is unchanged; these record WHICH instant each timestamp actually belongs to.
  observation_started_at_ms INTEGER,   -- LOCAL: scanner evaluation start (monitor n0)
  decision_at_ms INTEGER,              -- LOCAL: disposition fixed
  quote_event_at_ms INTEGER,           -- FOREIGN: provider/exchange/SIP NBBO event time
  quote_received_at_ms INTEGER,        -- LOCAL: chain response carrying that quote completed
  timestamp_relation TEXT              -- diagnostic classification, no acceptance authority
);
CREATE INDEX IF NOT EXISTS idx_setup_episodes_sym ON setup_episodes(symbol,t0_ms);
-- V2 indexes are intentionally created by ensureCanonicalEvidenceColumnsOnDb
-- after legacy production tables receive their additive V2 columns.

CREATE TABLE IF NOT EXISTS episode_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, episode_key TEXT NOT NULL, horizon TEXT NOT NULL,
  target_kind TEXT NOT NULL, outcome_kind TEXT NOT NULL, return_pct REAL, mfe_pct REAL, mae_pct REAL,
  target_before_stop TEXT, time_to_target_ms INTEGER, time_to_invalidation_ms INTEGER,
  realized_vol REAL, gap_pct REAL, gap_filled INTEGER, model_assumptions_json TEXT,
  label_as_of_ms INTEGER NOT NULL, computed_at_ms INTEGER NOT NULL,
  UNIQUE(episode_key,horizon,target_kind)
);

CREATE TABLE IF NOT EXISTS episode_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_key TEXT NOT NULL, action_kind TEXT NOT NULL, action_ref TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL, exact_occ TEXT, entry_convention TEXT,
  defensible_entry INTEGER NOT NULL DEFAULT 0, metadata_json TEXT, created_at_ms INTEGER NOT NULL,
  UNIQUE(episode_key,action_kind,action_ref)
);
CREATE INDEX IF NOT EXISTS idx_episode_actions_episode ON episode_actions(episode_key,action_kind);

CREATE TABLE IF NOT EXISTS episode_outcome_labels_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label_id TEXT NOT NULL UNIQUE, episode_key TEXT NOT NULL, label_kind TEXT NOT NULL,
  horizon TEXT NOT NULL, exact_occ TEXT, entry_convention TEXT,
  terminal_return_pct REAL, mfe_pct REAL, mae_pct REAL,
  hit_10 INTEGER, hit_25 INTEGER, hit_50 INTEGER, hit_100 INTEGER, hit_200 INTEGER,
  hit_neg_10 INTEGER, hit_neg_20 INTEGER, hit_stop INTEGER,
  time_to_10_ms INTEGER, time_to_25_ms INTEGER, time_to_50_ms INTEGER, time_to_100_ms INTEGER, time_to_200_ms INTEGER,
  time_to_neg_10_ms INTEGER, time_to_neg_20_ms INTEGER, time_to_stop_ms INTEGER,
  time_to_mfe_ms INTEGER, time_to_mae_ms INTEGER,
  plus_10_before_neg_10 INTEGER, plus_25_before_neg_20 INTEGER,
  plus_50_before_stop INTEGER, stop_before_plus_25 INTEGER, plus_100_before_stop INTEGER,
  plus_10_vs_neg_10_order TEXT, plus_25_vs_neg_20_order TEXT,
  plus_50_vs_stop_order TEXT, stop_vs_plus_25_order TEXT, plus_100_vs_stop_order TEXT,
  coverage TEXT NOT NULL, censored INTEGER NOT NULL DEFAULT 0, missing_reason TEXT,
  quote_count INTEGER, first_evidence_at_ms INTEGER, last_evidence_at_ms INTEGER,
  requested_end_at_ms INTEGER, evidence_coverage_ms INTEGER, largest_gap_ms INTEGER,
  entry_price REAL, entry_quote_at_ms INTEGER, entry_quote_age_ms INTEGER, entry_spread_pct REAL,
  exit_price REAL, evidence_source TEXT, evidence_version TEXT, production_sha TEXT,
  evidence_quality TEXT NOT NULL, intrabar_status TEXT NOT NULL, label_version TEXT NOT NULL DEFAULT 'FORWARD_LABEL_V1',
  label_as_of_ms INTEGER NOT NULL, config_digest TEXT NOT NULL, computed_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episode_outcomes_v2_episode ON episode_outcome_labels_v2(episode_key,label_kind,horizon);
-- The label-version index is created only after the additive legacy-column
-- upgrades below. Long-lived volumes can already have this table without
-- label_version, and indexing it here would abort the entire repair.

-- Bounded slow-path progress and deterministic research snapshots. None of
-- these tables is read by scanner, selection, delivery, targets, stops, or exits.
CREATE TABLE IF NOT EXISTS forward_label_worker_runs (
  run_id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL, finished_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL, batch_limit INTEGER NOT NULL, episodes_examined INTEGER NOT NULL,
  labels_attempted INTEGER NOT NULL, labels_inserted INTEGER NOT NULL,
  underlying_inserted INTEGER NOT NULL, exact_option_inserted INTEGER NOT NULL,
  provider_calls INTEGER NOT NULL DEFAULT 0, timed_out INTEGER NOT NULL DEFAULT 0,
  db_busy_errors INTEGER NOT NULL DEFAULT 0, dataset_version TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_forward_label_worker_finished ON forward_label_worker_runs(finished_at_ms DESC);

CREATE TABLE IF NOT EXISTS forward_label_coverage_snapshots (
  snapshot_id TEXT PRIMARY KEY, cohort_date TEXT NOT NULL, dataset_version TEXT,
  report_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forward_label_coverage_date ON forward_label_coverage_snapshots(cohort_date,created_at_ms DESC);

CREATE TABLE IF NOT EXISTS forward_label_dataset_versions (
  dataset_version TEXT PRIMARY KEY, label_version TEXT NOT NULL,
  episode_count INTEGER NOT NULL, label_count INTEGER NOT NULL,
  date_from TEXT, date_to TEXT, rows_digest TEXT NOT NULL,
  snapshot_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forward_label_dataset_created ON forward_label_dataset_versions(created_at_ms DESC);

-- Incremental, order-independent dataset identity. These compact membership
-- indexes prevent the one-minute worker from re-reading the full label corpus.
CREATE TABLE IF NOT EXISTS forward_label_dataset_members (
  label_id TEXT PRIMARY KEY, label_version TEXT NOT NULL, episode_key TEXT NOT NULL,
  membership_digest TEXT NOT NULL, registered_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forward_dataset_members_version ON forward_label_dataset_members(label_version,label_id);

CREATE TABLE IF NOT EXISTS forward_label_dataset_episodes (
  label_version TEXT NOT NULL, episode_key TEXT NOT NULL, trading_day TEXT NOT NULL,
  feature_version TEXT NOT NULL, config_digest TEXT NOT NULL, population TEXT,
  registered_at_ms INTEGER NOT NULL, PRIMARY KEY(label_version,episode_key)
);

CREATE TABLE IF NOT EXISTS forward_label_dataset_state (
  label_version TEXT PRIMARY KEY, xor_digest TEXT NOT NULL, label_count INTEGER NOT NULL,
  episode_count INTEGER NOT NULL, date_from TEXT, date_to TEXT,
  feature_versions_json TEXT NOT NULL, config_digests_json TEXT NOT NULL,
  populations_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS historical_evidence_inventory (
  dataset TEXT PRIMARY KEY, row_count INTEGER NOT NULL,
  distinct_symbols INTEGER, distinct_occs INTEGER, session_count INTEGER,
  earliest_ms INTEGER, latest_ms INTEGER, sources_json TEXT NOT NULL,
  provenance TEXT NOT NULL, point_in_time_trust TEXT NOT NULL,
  limitations_json TEXT NOT NULL, measured_at_ms INTEGER NOT NULL,
  query_duration_ms REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS contract_funnel_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_date TEXT NOT NULL, at_ms INTEGER NOT NULL,
  symbol TEXT NOT NULL, direction TEXT, requested_side TEXT NOT NULL, strategy_key TEXT NOT NULL,
  discovery_version TEXT NOT NULL, selection_version TEXT NOT NULL,
  contracts_received INTEGER NOT NULL DEFAULT 0, calls_received INTEGER NOT NULL DEFAULT 0,
  puts_received INTEGER NOT NULL DEFAULT 0, passed_side INTEGER NOT NULL DEFAULT 0,
  passed_dte INTEGER NOT NULL DEFAULT 0, two_sided INTEGER NOT NULL DEFAULT 0,
  with_delta INTEGER NOT NULL DEFAULT 0, delta_coverage REAL, passed_delta_band INTEGER NOT NULL DEFAULT 0,
  ranked_count INTEGER NOT NULL DEFAULT 0, delta_source TEXT, selected_occ TEXT,
  terminal_reason TEXT NOT NULL, greeks_missing_on_side INTEGER NOT NULL DEFAULT 0,
  page_limit_reached INTEGER NOT NULL DEFAULT 0
);

-- Bounded operational evidence. Samples are written by the detached maintenance
-- beat, never by the System Health page and never by the live alert path.
CREATE TABLE IF NOT EXISTS storage_health_samples (
  sampled_at_ms INTEGER PRIMARY KEY,
  db_bytes INTEGER NOT NULL,
  wal_bytes INTEGER NOT NULL,
  shm_bytes INTEGER NOT NULL,
  volume_total_bytes INTEGER,
  volume_available_bytes INTEGER,
  volume_used_bytes INTEGER,
  volume_used_pct REAL,
  write_latency_ms REAL,
  checkpoint_busy INTEGER,
  checkpoint_log_pages INTEGER,
  checkpointed_pages INTEGER,
  monitor_busy_events_total INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_storage_health_samples_time ON storage_health_samples(sampled_at_ms);

CREATE TABLE IF NOT EXISTS storage_warning_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL,
  previous_state TEXT,
  volume_used_pct REAL,
  message TEXT NOT NULL,
  transitioned_at_ms INTEGER NOT NULL,
  owner_notified_at_ms INTEGER,
  owner_notify_result TEXT
);
CREATE INDEX IF NOT EXISTS idx_storage_warning_events_time ON storage_warning_events(transitioned_at_ms);

CREATE TABLE IF NOT EXISTS backup_restore_verifications (
  verification_id TEXT PRIMARY KEY,
  backup_file TEXT NOT NULL,
  backup_created_at_ms INTEGER NOT NULL,
  backup_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL,
  temporary_destination TEXT NOT NULL,
  quick_check_result TEXT NOT NULL,
  production_overwritten INTEGER NOT NULL DEFAULT 0,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_backup_restore_verifications_time ON backup_restore_verifications(verified_at_ms);

CREATE TABLE IF NOT EXISTS options_live_latency_traces (
  trace_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  tier INTEGER NOT NULL,
  strategy TEXT,
  evaluation_outcome TEXT,
  observation_received_at_ms INTEGER NOT NULL,
  candidate_created_at_ms INTEGER,
  strategy_evaluation_completed_at_ms INTEGER,
  chain_started_at_ms INTEGER,
  chain_completed_at_ms INTEGER,
  contract_selected_at_ms INTEGER,
  delivery_decision_at_ms INTEGER,
  discord_send_started_at_ms INTEGER,
  discord_accepted_at_ms INTEGER,
  provider_quote_timestamp_ms INTEGER,
  provider_quote_age_ms INTEGER,
  alert_id TEXT,
  final_delivery_outcome TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_latency_created ON options_live_latency_traces(created_at_ms);
CREATE INDEX IF NOT EXISTS idx_options_latency_delivery ON options_live_latency_traces(final_delivery_outcome,discord_accepted_at_ms);
`;

const CANONICAL_EVIDENCE_COLUMNS = [
  ["setup_episodes", "episode_version", "INTEGER NOT NULL DEFAULT 1"],
  ["setup_episodes", "population", "TEXT"],
  ["setup_episodes", "zone_a_json", "TEXT"],
  ["setup_episodes", "config_digest", "TEXT"],
  ["setup_episodes", "production_sha", "TEXT"],
  ["setup_episodes", "strategy_version", "TEXT"],
  ["setup_episodes", "feature_version", "TEXT"],
  ["setup_episodes", "selected_strategy", "TEXT"],
  ["setup_episodes", "selection_strength", "REAL"],
  ["setup_episodes", "disposition", "TEXT"],
  ["setup_episodes", "rejection_reason", "TEXT"],
  ["setup_episodes", "candidate_id", "INTEGER"],
  ["setup_episodes", "opportunity_case_id", "TEXT"],
  ["setup_episodes", "thesis_fingerprint", "TEXT"],
  ["setup_episodes", "selected_occ", "TEXT"],
  ["setup_episodes", "source_lane", "TEXT"],
  ["setup_episodes", "entry_convention", "TEXT"],
  // Phase 2A four-clock columns. Listed here so a long-lived production DB gets
  // them via ALTER TABLE BEFORE ensureCanonicalEvidenceColumnsOnDb creates any
  // index — the ordering the Phase-1 incident violated.
  ["setup_episodes", "observation_started_at_ms", "INTEGER"],
  ["setup_episodes", "decision_at_ms", "INTEGER"],
  ["setup_episodes", "quote_event_at_ms", "INTEGER"],
  ["setup_episodes", "quote_received_at_ms", "INTEGER"],
  ["setup_episodes", "timestamp_relation", "TEXT"],
  ["episode_outcome_labels_v2", "hit_200", "INTEGER"],
  ["episode_outcome_labels_v2", "time_to_200_ms", "INTEGER"],
  ["episode_outcome_labels_v2", "time_to_mfe_ms", "INTEGER"],
  ["episode_outcome_labels_v2", "time_to_mae_ms", "INTEGER"],
  ["episode_outcome_labels_v2", "plus_100_before_stop", "INTEGER"],
  ["episode_outcome_labels_v2", "plus_10_vs_neg_10_order", "TEXT"],
  ["episode_outcome_labels_v2", "plus_25_vs_neg_20_order", "TEXT"],
  ["episode_outcome_labels_v2", "plus_50_vs_stop_order", "TEXT"],
  ["episode_outcome_labels_v2", "stop_vs_plus_25_order", "TEXT"],
  ["episode_outcome_labels_v2", "plus_100_vs_stop_order", "TEXT"],
  ["episode_outcome_labels_v2", "requested_end_at_ms", "INTEGER"],
  ["episode_outcome_labels_v2", "evidence_coverage_ms", "INTEGER"],
  ["episode_outcome_labels_v2", "largest_gap_ms", "INTEGER"],
  ["episode_outcome_labels_v2", "entry_price", "REAL"],
  ["episode_outcome_labels_v2", "entry_quote_at_ms", "INTEGER"],
  ["episode_outcome_labels_v2", "entry_quote_age_ms", "INTEGER"],
  ["episode_outcome_labels_v2", "entry_spread_pct", "REAL"],
  ["episode_outcome_labels_v2", "exit_price", "REAL"],
  ["episode_outcome_labels_v2", "evidence_source", "TEXT"],
  ["episode_outcome_labels_v2", "evidence_version", "TEXT"],
  ["episode_outcome_labels_v2", "production_sha", "TEXT"],
  ["episode_outcome_labels_v2", "label_version", "TEXT NOT NULL DEFAULT 'FORWARD_LABEL_V1'"],
  ["contract_funnel_evidence", "terminal_stage", "TEXT NOT NULL DEFAULT 'OTHER_EXPLICIT_TERMINAL_REASON'"],
  ["contract_funnel_evidence", "with_bid", "INTEGER NOT NULL DEFAULT 0"],
  ["contract_funnel_evidence", "with_ask", "INTEGER NOT NULL DEFAULT 0"],
  ["contract_funnel_evidence", "requested_min_strike", "REAL"],
  ["contract_funnel_evidence", "requested_max_strike", "REAL"],
  ["contract_funnel_evidence", "returned_min_strike", "REAL"],
  ["contract_funnel_evidence", "returned_max_strike", "REAL"],
  ["contract_funnel_evidence", "fallback_used", "INTEGER NOT NULL DEFAULT 0"],
  ["contract_funnel_evidence", "fallback_reason", "TEXT"],
  ["contract_funnel_evidence", "provider_timestamp_ms", "INTEGER"],
  ["contract_funnel_evidence", "observation_timestamp_ms", "INTEGER"],
  ["contract_funnel_evidence", "provider_requests", "INTEGER NOT NULL DEFAULT 0"],
] as const;

function listMissingCanonicalEvidenceColumns(db: SqliteDb): Array<{ table: string; column: string }> {
  return CANONICAL_EVIDENCE_COLUMNS
    .filter(([table, column]) => hasSqliteTable(db, table) && !legacyHasSqliteColumn(db, table, column))
    .map(([table, column]) => ({ table, column }));
}

function ensureCanonicalEvidenceColumnsOnDb(db: SqliteDb): void {
  for (const [table, column, ddl] of CANONICAL_EVIDENCE_COLUMNS) {
    if (hasSqliteTable(db, table) && !legacyHasSqliteColumn(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_setup_episodes_v2_population ON setup_episodes(episode_version,population,t0_ms);
    CREATE INDEX IF NOT EXISTS idx_setup_episodes_v2_case ON setup_episodes(opportunity_case_id);
    CREATE INDEX IF NOT EXISTS idx_setup_episodes_v2_ts_relation ON setup_episodes(timestamp_relation,t0_ms);
    CREATE INDEX IF NOT EXISTS idx_episode_outcomes_v2_version ON episode_outcome_labels_v2(label_version,computed_at_ms);
    CREATE INDEX IF NOT EXISTS idx_contract_funnel_stage ON contract_funnel_evidence(session_date,terminal_stage);
    CREATE TRIGGER IF NOT EXISTS trg_setup_episode_v2_immutable_update BEFORE UPDATE ON setup_episodes
      WHEN OLD.episode_version >= 2 BEGIN SELECT RAISE(ABORT,'SetupEpisodeV2 is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_setup_episode_v2_immutable_delete BEFORE DELETE ON setup_episodes
      WHEN OLD.episode_version >= 2 BEGIN SELECT RAISE(ABORT,'SetupEpisodeV2 is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_episode_actions_append_only_update BEFORE UPDATE ON episode_actions
      BEGIN SELECT RAISE(ABORT,'episode actions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_episode_actions_append_only_delete BEFORE DELETE ON episode_actions
      BEGIN SELECT RAISE(ABORT,'episode actions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_episode_outcomes_v2_append_only_update BEFORE UPDATE ON episode_outcome_labels_v2
      BEGIN SELECT RAISE(ABORT,'episode outcome labels are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_episode_outcomes_v2_append_only_delete BEFORE DELETE ON episode_outcome_labels_v2
      BEGIN SELECT RAISE(ABORT,'episode outcome labels are append-only'); END;
  `);
}

export function resolveDbLocation(env: NodeJS.ProcessEnv = process.env): DbLocationInfo {
  const directory = env.ALERT_DB_DIR || path.join(process.cwd(), "data");
  const file = path.join(directory, "optiscan.db");
  let directoryWritable: boolean | null = null;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.W_OK);
    directoryWritable = true;
  } catch {
    directoryWritable = false;
  }
  return {
    directory,
    file,
    walFile: `${file}-wal`,
    shmFile: `${file}-shm`,
    directoryExists: fs.existsSync(directory),
    fileExists: fs.existsSync(file),
    directoryWritable,
  };
}

export function hasSqliteTable(db: { prepare(sql: string): { get: (...args: any[]) => any } }, name: string): boolean {
  try {
    return Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name),
    );
  } catch {
    return false;
  }
}

export function listMissingEnterpriseTables(db: SqliteDb): EnterpriseRequiredTable[] {
  return ENTERPRISE_REQUIRED_TABLES.filter((t) => !hasSqliteTable(db, t));
}

/** Apply explicit enterprise DDL. Repeat-safe; additive only. */
export function ensureEnterpriseSchemaOnDb(db: SqliteDb): EnterpriseRequiredTable[] {
  const before = listMissingEnterpriseTables(db);
  db.exec(ENTERPRISE_SCHEMA_DDL);
  ensureCanonicalEvidenceColumnsOnDb(db);
  const after = listMissingEnterpriseTables(db);
  if (after.length > 0) {
    throw new Error(`enterprise schema repair incomplete; still missing: ${after.join(", ")}`);
  }
  return before;
}

export function listKnownTables(db: { prepare(sql: string): { all: (...args: any[]) => any[] } }): string[] {
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name)
      .slice(0, 40);
  } catch {
    return [];
  }
}

function buildReadinessCore(
  db: SqliteDb,
  env: NodeJS.ProcessEnv,
  extra: Partial<SchemaReadinessReport> = {},
): SchemaReadinessReport {
  const missing = listMissingEnterpriseTables(db);
  const present = ENTERPRISE_REQUIRED_TABLES.filter((t) => !missing.includes(t));
  const missingLegacyColumns = listMissingLegacyColumns(db);
  missingLegacyColumns.push(...listMissingCanonicalEvidenceColumns(db));
  const presentLegacyColumns = LEGACY_COLUMN_CHECKS.filter(
    (c) => !missingLegacyColumns.some((m) => m.table === c.table && m.column === c.column),
  );
  const missingShadowSoakTables = listMissingShadowSoakTables(db);
  const missingInstrumentationColumns = SUBSCRIBER_PIPELINE_INSTRUMENTATION_CHECKS.filter(({ table, column }) => {
    if (!legacyHasSqliteTable(db, table)) return false;
    return !legacyHasSqliteColumn(db, table, column);
  });
  const hasOptionsPipeline = legacyHasSqliteTable(db, "options_candidates")
    || legacyHasSqliteTable(db, "options_shadow_decisions")
    || legacyHasSqliteTable(db, "options_alerts");
  const soakReady = !hasOptionsPipeline
    || (missingShadowSoakTables.length === 0 && missingInstrumentationColumns.length === 0);
  return {
    ok: missing.length === 0 && missingLegacyColumns.length === 0 && soakReady,
    missing,
    present,
    missingLegacyColumns,
    presentLegacyColumns,
    missingShadowSoakTables,
    missingInstrumentationColumns,
    tablesSample: listKnownTables(db),
    db: resolveDbLocation(env),
    repaired: [],
    error: null,
    ...extra,
  };
}

/** Read-only snapshot when migrate/getDb fails — never mutates the database. */
export function inspectPartialDatabaseState(env: NodeJS.ProcessEnv = process.env): SchemaReadinessReport {
  const dbInfo = resolveDbLocation(env);
  if (!dbInfo.fileExists) {
    return {
      ok: false,
      missing: [...ENTERPRISE_REQUIRED_TABLES],
      present: [],
      missingLegacyColumns: [...LEGACY_COLUMN_CHECKS],
      presentLegacyColumns: [],
      missingShadowSoakTables: ["options_shadow_decisions", "options_shadow_outcomes"],
      missingInstrumentationColumns: [...SUBSCRIBER_PIPELINE_INSTRUMENTATION_CHECKS],
      tablesSample: [],
      db: dbInfo,
      repaired: [],
      error: "database file not found",
    };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const db = new Database(dbInfo.file, { readonly: true, fileMustExist: true });
    try {
      return buildReadinessCore(db, env);
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      ok: false,
      missing: [...ENTERPRISE_REQUIRED_TABLES],
      present: [],
      missingLegacyColumns: [...LEGACY_COLUMN_CHECKS],
      presentLegacyColumns: [],
      missingShadowSoakTables: ["options_shadow_decisions", "options_shadow_outcomes"],
      missingInstrumentationColumns: [...SUBSCRIBER_PIPELINE_INSTRUMENTATION_CHECKS],
      tablesSample: [],
      db: dbInfo,
      repaired: [],
      error: String((err as Error)?.message ?? err).slice(0, 240),
    };
  }
}

export function inspectSchemaReadiness(
  db: SqliteDb,
  env: NodeJS.ProcessEnv = process.env,
): SchemaReadinessReport {
  return buildReadinessCore(db, env);
}

export function repairAndInspectSchemaReadiness(
  db: SqliteDb,
  env: NodeJS.ProcessEnv = process.env,
): SchemaReadinessReport {
  const base = inspectSchemaReadiness(db, env);
  if (base.ok) return base;
  try {
    const repaired = ensureEnterpriseSchemaOnDb(db);
    const after = inspectSchemaReadiness(db, env);
    return { ...after, repaired };
  } catch (err) {
    return {
      ...base,
      error: String((err as Error)?.message ?? err).slice(0, 240),
    };
  }
}
