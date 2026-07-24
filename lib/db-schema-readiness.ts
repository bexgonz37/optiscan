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
} from "./db-legacy-columns.ts";

export const ENTERPRISE_REQUIRED_TABLES = [
  "opportunity_cases",
  "evidence_learning_examples",
  "evidence_learning_patterns",
  "evidence_learning_runs",
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
`;

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
  if (before.length === 0) return [];
  db.exec(ENTERPRISE_SCHEMA_DDL);
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
  const presentLegacyColumns = LEGACY_COLUMN_CHECKS.filter(
    (c) => !missingLegacyColumns.some((m) => m.table === c.table && m.column === c.column),
  );
  return {
    ok: missing.length === 0 && missingLegacyColumns.length === 0,
    missing,
    present,
    missingLegacyColumns,
    presentLegacyColumns,
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
