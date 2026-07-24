/**
 * Brokerage foundation DDL (B0). Kept in one module so db.ts and schema-readiness
 * can share the same additive definitions.
 */

export const BROKER_REQUIRED_TABLES = [
  "broker_accounts",
  "broker_evidence_chains",
  "broker_orders",
  "broker_fills",
  "broker_ledger_entries",
  "broker_position_snapshots",
  "broker_equity_snapshots",
  "broker_marks",
  "broker_audit_events",
] as const;

export type BrokerRequiredTable = (typeof BROKER_REQUIRED_TABLES)[number];

export const BROKER_SCHEMA_DDL = `
-- Brokerage simulation foundation (B0). Ledger-first, append-only financial events.
-- Generic across account types and asset classes; execution adapters wire in at B1+.
CREATE TABLE IF NOT EXISTS broker_accounts (
  id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL UNIQUE,
  account_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  adapter_kind TEXT NOT NULL DEFAULT 'PAPER_SIM',
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_broker_accounts_type ON broker_accounts(account_type, status);

CREATE TABLE IF NOT EXISTS broker_evidence_chains (
  id TEXT PRIMARY KEY,
  market_observation_ref TEXT,
  strategy_evaluation_ref TEXT,
  candidate_ref TEXT,
  delivery_decision_ref TEXT,
  alert_id INTEGER,
  opportunity_case_id TEXT,
  options_candidate_id INTEGER,
  setup_candidate_id INTEGER,
  chain_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broker_evidence_alert ON broker_evidence_chains(alert_id);
CREATE INDEX IF NOT EXISTS idx_broker_evidence_opportunity ON broker_evidence_chains(opportunity_case_id);

CREATE TABLE IF NOT EXISTS broker_orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES broker_accounts(id),
  client_order_key TEXT NOT NULL,
  evidence_chain_id TEXT REFERENCES broker_evidence_chains(id),
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  filled_quantity REAL NOT NULL DEFAULT 0,
  order_type TEXT NOT NULL DEFAULT 'LIMIT',
  limit_price REAL,
  time_in_force TEXT NOT NULL DEFAULT 'DAY',
  contract_multiplier REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING',
  status_reason TEXT,
  reserved_amount REAL NOT NULL DEFAULT 0,
  submitted_at_ms INTEGER,
  closed_at_ms INTEGER,
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(account_id, client_order_key)
);
CREATE INDEX IF NOT EXISTS idx_broker_orders_account ON broker_orders(account_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_broker_orders_evidence ON broker_orders(evidence_chain_id);

CREATE TABLE IF NOT EXISTS broker_fills (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES broker_accounts(id),
  order_id TEXT NOT NULL REFERENCES broker_orders(id),
  fill_key TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  gross_notional REAL NOT NULL,
  commission REAL NOT NULL DEFAULT 0,
  fees REAL NOT NULL DEFAULT 0,
  contract_multiplier REAL NOT NULL DEFAULT 1,
  filled_at_ms INTEGER NOT NULL,
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(account_id, fill_key)
);
CREATE INDEX IF NOT EXISTS idx_broker_fills_order ON broker_fills(order_id, filled_at_ms);

CREATE TABLE IF NOT EXISTS broker_ledger_entries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES broker_accounts(id),
  sequence_num INTEGER NOT NULL,
  entry_kind TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT,
  quantity_delta REAL NOT NULL DEFAULT 0,
  cash_delta REAL NOT NULL DEFAULT 0,
  reserved_delta REAL NOT NULL DEFAULT 0,
  price REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  description TEXT,
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(account_id, idempotency_key),
  UNIQUE(account_id, sequence_num)
);
CREATE INDEX IF NOT EXISTS idx_broker_ledger_account ON broker_ledger_entries(account_id, sequence_num);

CREATE TABLE IF NOT EXISTS broker_position_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES broker_accounts(id),
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  average_cost REAL NOT NULL DEFAULT 0,
  cost_basis REAL NOT NULL DEFAULT 0,
  market_price REAL,
  market_value REAL NOT NULL DEFAULT 0,
  unrealized_pnl REAL NOT NULL DEFAULT 0,
  realized_pnl_delta REAL NOT NULL DEFAULT 0,
  evidence_chain_id TEXT REFERENCES broker_evidence_chains(id),
  ledger_sequence_through INTEGER NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  snapshot_at_ms INTEGER NOT NULL,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_broker_position_account ON broker_position_snapshots(account_id, asset_class, symbol, snapshot_at_ms DESC);

CREATE TABLE IF NOT EXISTS broker_equity_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES broker_accounts(id),
  snapshot_at_ms INTEGER NOT NULL,
  cash_balance REAL NOT NULL,
  reserved_balance REAL NOT NULL,
  buying_power REAL NOT NULL,
  gross_position_value REAL NOT NULL,
  net_equity REAL NOT NULL,
  unrealized_pnl REAL NOT NULL,
  realized_pnl_cumulative REAL NOT NULL,
  ledger_sequence_through INTEGER NOT NULL,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_broker_equity_account ON broker_equity_snapshots(account_id, snapshot_at_ms DESC);

CREATE TABLE IF NOT EXISTS broker_marks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES broker_accounts(id),
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  mark_price REAL NOT NULL,
  mark_source TEXT NOT NULL,
  position_snapshot_id TEXT REFERENCES broker_position_snapshots(id),
  ledger_entry_id TEXT REFERENCES broker_ledger_entries(id),
  marked_at_ms INTEGER NOT NULL,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_broker_marks_account ON broker_marks(account_id, asset_class, symbol, marked_at_ms DESC);

CREATE TABLE IF NOT EXISTS broker_audit_events (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES broker_accounts(id),
  event_kind TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'SYSTEM',
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broker_audit_account ON broker_audit_events(account_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_broker_audit_entity ON broker_audit_events(entity_kind, entity_id);
`;
