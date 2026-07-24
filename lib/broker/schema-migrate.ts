import {
  BROKER_COLUMN_MIGRATIONS,
  BROKER_REQUIRED_TABLES,
  BROKER_SCHEMA_DDL,
  type BrokerRequiredTable,
} from "./schema-ddl.ts";

interface SqliteDb {
  prepare(sql: string): {
    get: (...args: any[]) => any;
    all?: (...args: any[]) => any[];
    run: (...args: any[]) => { changes: number };
  };
  exec(sql: string): void;
}

function tableColumns(db: SqliteDb, table: string): Set<string> {
  try {
    return new Set(
      ((db.prepare(`PRAGMA table_info(${table})`).all?.() ?? []) as Array<{ name: string }>).map((c) => c.name),
    );
  } catch {
    return new Set();
  }
}

export function listMissingBrokerTables(db: SqliteDb): BrokerRequiredTable[] {
  const missing: BrokerRequiredTable[] = [];
  for (const table of BROKER_REQUIRED_TABLES) {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!row) missing.push(table);
  }
  return missing;
}

export function ensureBrokerColumnMigrations(db: SqliteDb): string[] {
  const applied: string[] = [];
  for (const [table, column, sql] of BROKER_COLUMN_MIGRATIONS) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    const cols = tableColumns(db, table);
    if (cols.has(column)) continue;
    db.exec(sql);
    applied.push(`${table}.${column}`);
  }
  return applied;
}

/** Repeat-safe repair for brokerage foundation tables on long-lived SQLite volumes. */
export function ensureBrokerSchemaOnDb(db: SqliteDb): string[] {
  const repaired: string[] = [];
  const missingBefore = listMissingBrokerTables(db);
  if (missingBefore.length > 0) {
    db.exec(BROKER_SCHEMA_DDL);
    repaired.push(...missingBefore);
  }
  repaired.push(...ensureBrokerColumnMigrations(db));
  return repaired;
}

export { BROKER_REQUIRED_TABLES };
