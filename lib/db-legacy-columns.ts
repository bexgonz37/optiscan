/**

 * Legacy SQLite column migrations that must run BEFORE db.exec(SCHEMA).

 *

 * Production databases may already have base tables from an earlier release while

 * missing columns that the monolithic SCHEMA assumes when CREATE TABLE IF NOT EXISTS

 * is skipped. Any index/view/backfill referencing those columns must not run until

 * the additive ALTERs below have been applied.

 */



export const OPTIONS_CANDIDATES_INSTRUMENTATION_MIGRATIONS: ReadonlyArray<[string, string]> = [

  ["first_detected_at_ms", "ALTER TABLE options_candidates ADD COLUMN first_detected_at_ms INTEGER"],

  ["first_ready_at_ms", "ALTER TABLE options_candidates ADD COLUMN first_ready_at_ms INTEGER"],

  ["batch_entered_at_ms", "ALTER TABLE options_candidates ADD COLUMN batch_entered_at_ms INTEGER"],

  ["underlying_at_first_detection", "ALTER TABLE options_candidates ADD COLUMN underlying_at_first_detection REAL"],

  ["option_at_first_detection", "ALTER TABLE options_candidates ADD COLUMN option_at_first_detection REAL"],

  ["underlying_at_ready", "ALTER TABLE options_candidates ADD COLUMN underlying_at_ready REAL"],

  ["option_at_ready", "ALTER TABLE options_candidates ADD COLUMN option_at_ready REAL"],

  ["market_structure_snapshot_json", "ALTER TABLE options_candidates ADD COLUMN market_structure_snapshot_json TEXT"],

  ["session_state_at_detection", "ALTER TABLE options_candidates ADD COLUMN session_state_at_detection TEXT"],

  ["trading_session_date", "ALTER TABLE options_candidates ADD COLUMN trading_session_date TEXT"],

  ["ready_expires_at_ms", "ALTER TABLE options_candidates ADD COLUMN ready_expires_at_ms INTEGER"],

];



export const OPTIONS_ALERTS_INSTRUMENTATION_MIGRATIONS: ReadonlyArray<[string, string]> = [

  ["delivered_at_ms", "ALTER TABLE options_alerts ADD COLUMN delivered_at_ms INTEGER"],

  ["underlying_at_delivery", "ALTER TABLE options_alerts ADD COLUMN underlying_at_delivery REAL"],

  ["option_at_delivery", "ALTER TABLE options_alerts ADD COLUMN option_at_delivery REAL"],

  ["evidence_snapshot_json", "ALTER TABLE options_alerts ADD COLUMN evidence_snapshot_json TEXT"],

  ["session_state_at_delivery", "ALTER TABLE options_alerts ADD COLUMN session_state_at_delivery TEXT"],

  ["delivery_latency_ms", "ALTER TABLE options_alerts ADD COLUMN delivery_latency_ms INTEGER"],

  ["entry_quality_verdict", "ALTER TABLE options_alerts ADD COLUMN entry_quality_verdict TEXT"],

  ["entry_quality_reasons_json", "ALTER TABLE options_alerts ADD COLUMN entry_quality_reasons_json TEXT"],

  ["first_detected_at_ms", "ALTER TABLE options_alerts ADD COLUMN first_detected_at_ms INTEGER"],

  ["underlying_at_first_detection", "ALTER TABLE options_alerts ADD COLUMN underlying_at_first_detection REAL"],

  ["option_at_first_detection", "ALTER TABLE options_alerts ADD COLUMN option_at_first_detection REAL"],

  ["trading_session_date", "ALTER TABLE options_alerts ADD COLUMN trading_session_date TEXT"],

];



export const OPTIONS_DELIVERY_DECISIONS_COLUMN_MIGRATIONS: ReadonlyArray<[string, string]> = [

  ["delivery_attempted", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_attempted INTEGER NOT NULL DEFAULT 0"],

  ["delivery_sent", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_sent INTEGER NOT NULL DEFAULT 0"],

  ["delivery_state", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_state TEXT"],

  ["final_delivery_outcome", "ALTER TABLE options_delivery_decisions ADD COLUMN final_delivery_outcome TEXT NOT NULL DEFAULT 'SKIPPED'"],

  ["delivery_failure_category", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_failure_category TEXT"],

  ["final_delivery_reason", "ALTER TABLE options_delivery_decisions ADD COLUMN final_delivery_reason TEXT"],

  ["delivery_attempted_at_ms", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_attempted_at_ms INTEGER"],

  ["delivery_completed_at_ms", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_completed_at_ms INTEGER"],

  ["entry_quality_verdict", "ALTER TABLE options_delivery_decisions ADD COLUMN entry_quality_verdict TEXT"],

  ["delivery_latency_ms", "ALTER TABLE options_delivery_decisions ADD COLUMN delivery_latency_ms INTEGER"],

  ["batch_entered_at_ms", "ALTER TABLE options_delivery_decisions ADD COLUMN batch_entered_at_ms INTEGER"],

];



export const OPTIONS_SHADOW_OUTCOMES_COLUMN_MIGRATIONS: ReadonlyArray<[string, string]> = [
  ["bid_at_decision", "ALTER TABLE options_shadow_outcomes ADD COLUMN bid_at_decision REAL"],
  ["ask_at_decision", "ALTER TABLE options_shadow_outcomes ADD COLUMN ask_at_decision REAL"],
  ["spread_pct_at_decision", "ALTER TABLE options_shadow_outcomes ADD COLUMN spread_pct_at_decision REAL"],
  ["dte_at_decision", "ALTER TABLE options_shadow_outcomes ADD COLUMN dte_at_decision INTEGER"],
  ["strike_at_decision", "ALTER TABLE options_shadow_outcomes ADD COLUMN strike_at_decision REAL"],
  ["expiration_at_decision", "ALTER TABLE options_shadow_outcomes ADD COLUMN expiration_at_decision TEXT"],
  ["quality_score", "ALTER TABLE options_shadow_outcomes ADD COLUMN quality_score REAL"],
  ["block_reasons_json", "ALTER TABLE options_shadow_outcomes ADD COLUMN block_reasons_json TEXT"],
  ["underlying_return_1m", "ALTER TABLE options_shadow_outcomes ADD COLUMN underlying_return_1m REAL"],
  ["underlying_return_5m", "ALTER TABLE options_shadow_outcomes ADD COLUMN underlying_return_5m REAL"],
  ["underlying_return_15m", "ALTER TABLE options_shadow_outcomes ADD COLUMN underlying_return_15m REAL"],
  ["underlying_return_30m", "ALTER TABLE options_shadow_outcomes ADD COLUMN underlying_return_30m REAL"],
  ["underlying_return_60m", "ALTER TABLE options_shadow_outcomes ADD COLUMN underlying_return_60m REAL"],
  ["option_return_1m", "ALTER TABLE options_shadow_outcomes ADD COLUMN option_return_1m REAL"],
  ["option_return_5m", "ALTER TABLE options_shadow_outcomes ADD COLUMN option_return_5m REAL"],
  ["option_return_15m", "ALTER TABLE options_shadow_outcomes ADD COLUMN option_return_15m REAL"],
  ["option_return_30m", "ALTER TABLE options_shadow_outcomes ADD COLUMN option_return_30m REAL"],
  ["option_return_60m", "ALTER TABLE options_shadow_outcomes ADD COLUMN option_return_60m REAL"],
  ["mfe_at_ms", "ALTER TABLE options_shadow_outcomes ADD COLUMN mfe_at_ms INTEGER"],
  ["mae_at_ms", "ALTER TABLE options_shadow_outcomes ADD COLUMN mae_at_ms INTEGER"],
  ["missing_data_reason", "ALTER TABLE options_shadow_outcomes ADD COLUMN missing_data_reason TEXT"],
  ["final_result", "ALTER TABLE options_shadow_outcomes ADD COLUMN final_result TEXT"],
];

export const OPTIONS_SHADOW_DECISIONS_COLUMN_MIGRATIONS: ReadonlyArray<[string, string]> = [

  ["actual_action", "ALTER TABLE options_shadow_decisions ADD COLUMN actual_action TEXT"],

  ["would_allow_session", "ALTER TABLE options_shadow_decisions ADD COLUMN would_allow_session INTEGER"],

  ["block_reasons_json", "ALTER TABLE options_shadow_decisions ADD COLUMN block_reasons_json TEXT"],

  ["entry_quality_dimensions_json", "ALTER TABLE options_shadow_decisions ADD COLUMN entry_quality_dimensions_json TEXT"],

  ["candidate_id", "ALTER TABLE options_shadow_decisions ADD COLUMN candidate_id INTEGER"],

  ["actually_delivered", "ALTER TABLE options_shadow_decisions ADD COLUMN actually_delivered INTEGER NOT NULL DEFAULT 0"],

];



/** Required for subscriber shadow soak — monitor must not start in strict mode if any are missing. */

export const SUBSCRIBER_PIPELINE_INSTRUMENTATION_CHECKS: ReadonlyArray<{ table: string; column: string }> = [

  ...OPTIONS_CANDIDATES_INSTRUMENTATION_MIGRATIONS.map(([column]) => ({ table: "options_candidates", column })),

  ...OPTIONS_ALERTS_INSTRUMENTATION_MIGRATIONS.map(([column]) => ({ table: "options_alerts", column })),

  ...OPTIONS_DELIVERY_DECISIONS_COLUMN_MIGRATIONS.map(([column]) => ({ table: "options_delivery_decisions", column })),

  ...OPTIONS_SHADOW_DECISIONS_COLUMN_MIGRATIONS.map(([column]) => ({ table: "options_shadow_decisions", column })),

];



export const LEGACY_COLUMN_CHECKS: ReadonlyArray<{ table: string; column: string }> = [

  { table: "options_delivery_decisions", column: "final_delivery_outcome" },

  ...SUBSCRIBER_PIPELINE_INSTRUMENTATION_CHECKS,

];



export const REQUIRED_SHADOW_SOAK_TABLES = [

  "options_shadow_decisions",

  "options_shadow_outcomes",

] as const;



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



export function hasSqliteTable(db: ColumnDb, table: string): boolean {

  try {

    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

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



export function ensureSubscriberPipelineInstrumentationColumns(db: ColumnDb): string[] {
  const added: string[] = [];
  if (hasSqliteTable(db, "options_candidates")) {
    const oc = tableColumns(db, "options_candidates");
    for (const [col, sql] of OPTIONS_CANDIDATES_INSTRUMENTATION_MIGRATIONS) {
      if (!oc.has(col)) { db.exec(sql); oc.add(col); added.push(`options_candidates.${col}`); }
    }
  }
  if (hasSqliteTable(db, "options_alerts")) {
    const oa = tableColumns(db, "options_alerts");
    for (const [col, sql] of OPTIONS_ALERTS_INSTRUMENTATION_MIGRATIONS) {
      if (!oa.has(col)) { db.exec(sql); oa.add(col); added.push(`options_alerts.${col}`); }
    }
  }
  ensureOptionsDeliveryDecisionsColumns(db);
  ensureOptionsShadowDecisionsColumns(db);
  ensureOptionsShadowOutcomesColumns(db);
  return added;
}

export function ensureOptionsShadowDecisionsColumns(db: ColumnDb): string[] {
  if (!hasSqliteTable(db, "options_shadow_decisions")) return [];

  const cols = tableColumns(db, "options_shadow_decisions");

  const added: string[] = [];

  for (const [col, sql] of OPTIONS_SHADOW_DECISIONS_COLUMN_MIGRATIONS) {

    if (!cols.has(col)) {

      db.exec(sql);

      cols.add(col);

      added.push(col);

    }

  }

  return added;

}

export function ensureOptionsShadowOutcomesColumns(db: ColumnDb): string[] {
  if (!hasSqliteTable(db, "options_shadow_outcomes")) return [];
  const cols = tableColumns(db, "options_shadow_outcomes");
  const added: string[] = [];
  for (const [col, sql] of OPTIONS_SHADOW_OUTCOMES_COLUMN_MIGRATIONS) {
    if (!cols.has(col)) {
      db.exec(sql);
      cols.add(col);
      added.push(`options_shadow_outcomes.${col}`);
    }
  }
  return added;
}



export function listMissingLegacyColumns(db: ColumnDb): Array<{ table: string; column: string }> {

  return LEGACY_COLUMN_CHECKS.filter(({ table, column }) => {

    if (!hasSqliteTable(db, table)) return false;

    return !hasSqliteColumn(db, table, column);

  });

}



export function listMissingShadowSoakTables(db: ColumnDb): string[] {

  return REQUIRED_SHADOW_SOAK_TABLES.filter((t) => !hasSqliteTable(db, t));

}



let instrumentationFallbackInserts = 0;



export function incrementInstrumentationFallbackInserts(): number {

  instrumentationFallbackInserts += 1;

  return instrumentationFallbackInserts;

}



export function readInstrumentationFallbackInserts(): number {

  return instrumentationFallbackInserts;

}



export function resetInstrumentationFallbackInserts(): void {

  instrumentationFallbackInserts = 0;

}