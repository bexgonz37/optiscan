/**
 * Read helpers shared by engine / equity / buying-power (no write-side imports).
 */
import type { BrokerDb } from "./audit.ts";
import type { LedgerEntryRow } from "./types.ts";

export function listLedgerEntries(db: BrokerDb, accountId: string): LedgerEntryRow[] {
  return (db
    .prepare(
      `SELECT * FROM broker_ledger_entries WHERE account_id = ? ORDER BY sequence_num ASC`,
    )
    .all?.(accountId) ?? []) as LedgerEntryRow[];
}
