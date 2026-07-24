import { BROKER_REQUIRED_TABLES, BROKER_SCHEMA_DDL, type BrokerRequiredTable } from "./schema-ddl.ts";

interface SqliteDb {
  prepare(sql: string): {
    get: (...args: any[]) => any;
    all?: (...args: any[]) => any[];
    run: (...args: any[]) => { changes: number };
  };
  exec(sql: string): void;
}

export function listMissingBrokerTables(db: SqliteDb): BrokerRequiredTable[] {
  const missing: BrokerRequiredTable[] = [];
  for (const table of BROKER_REQUIRED_TABLES) {
    const row = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    if (!row) missing.push(table);
  }
  return missing;
}

/** Repeat-safe repair for brokerage foundation tables on long-lived SQLite volumes. */
export function ensureBrokerSchemaOnDb(db: SqliteDb): BrokerRequiredTable[] {
  const missingBefore = listMissingBrokerTables(db);
  if (missingBefore.length === 0) return [];
  db.exec(BROKER_SCHEMA_DDL);
  return missingBefore;
}

export { BROKER_REQUIRED_TABLES };
