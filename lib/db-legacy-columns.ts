/**
 * Legacy SQLite column migrations that must run BEFORE db.exec(SCHEMA).
 *
 * Production databases may already have base tables from an earlier release while
 * missing columns that the monolithic SCHEMA assumes when CREATE TABLE IF NOT EXISTS
 * is skipped. Any index/view/backfill referencing those columns must not run until
 * the additive ALTERs below have been applied.
 */

export const OPTIONS_DELIVERY_DECISIONS_COLUMN_MIGRATIONS: ReadonlyArray<[string, string]> = [
  ["delivery_attempted", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_attempted INTEGER NOT NULL DEFAULT 0"],
  ["delivery_sent", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_sent INTEGER NOT NULL DEFAULT 0"],
  ["delivery_state", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_state TEXT"],
  ["final_delivery_outcome", "ALTER TABLE options_delivery_decisions ADD COLUMN final_delivery_outcome TEXT NOT NULL DEFAULT 'SKIPPED'"],
  ["delivery_failure_category", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_failure_category TEXT"],
  ["final_delivery_reason", "ALTER TABLE options_delivery_decisions ADD COLUMN final_delivery_reason TEXT"],
  ["delivery_attempted_at_ms", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_attempted_at_ms INTEGER"],
  ["delivery_completed_at_ms", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_completed_at_ms INTEGER"],
];

export const LEGACY_COLUMN_CHECKS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "options_delivery_decisions", column: "final_delivery_outcome" },
];

type ColumnDb = {
  prepare(sql: string): {
    get: (...args: any[]) => any;
    all: (...args: any[]) => any[];
    run: (...args: any[]) => { changes: number };
  };
  exec(sql: string): void;
};

function tableColumns(db: ColumnDb, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

export function hasSqliteColumn(db: ColumnDb, table: string, column: string): boolean {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return false;
    return tableColumns(db, table).has(column);
  } catch {
    return false;
  }
}

/** Repeat-safe additive columns + backfill + dependent index for legacy production DBs. */
export function ensureOptionsDeliveryDecisionsColumns(db: ColumnDb): string[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='options_delivery_decisions'").get()) {
    return [];
  }
  const odd = tableColumns(db, "options_delivery_decisions");
  const added: string[] = [];
  for (const [col, sql] of OPTIONS_DELIVERY_DECISIONS_COLUMN_MIGRATIONS) {
    if (!odd.has(col)) {
      db.exec(sql);
      odd.add(col);
      added.push(col);
    }
  }
  if (added.includes("final_delivery_outcome")) {
    db.exec(
      "UPDATE options_delivery_decisions SET final_delivery_outcome=CASE WHEN outcome='REJECT' THEN 'REJECTED' ELSE 'SKIPPED' END",
    );
  } else if (odd.has("final_delivery_outcome")) {
    db.exec(
      "UPDATE options_delivery_decisions SET final_delivery_outcome=CASE WHEN outcome='REJECT' THEN 'REJECTED' ELSE 'SKIPPED' END WHERE final_delivery_outcome IS NULL OR final_delivery_outcome=''",
    );
  }
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_options_delivery_final_outcome ON options_delivery_decisions(final_delivery_outcome, created_at_ms)",
  ).run();
  return added;
}

export function listMissingLegacyColumns(db: ColumnDb): Array<{ table: string; column: string }> {
  return LEGACY_COLUMN_CHECKS.filter(({ table, column }) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return false;
    return !hasSqliteColumn(db, table, column);
  });
}
