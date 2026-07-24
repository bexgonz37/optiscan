import { brokerId } from "./id.ts";
import { roundMoney } from "./ledger.ts";
import { BROKER_RECORD_SCHEMA_VERSION } from "./types.ts";
import type { BrokerDb } from "./audit.ts";

export type ParityCheckKind =
  | "fill_price"
  | "realized_pnl"
  | "return_pct"
  | "position_lifecycle"
  | "audit_chain";

export interface ParityCheckInput {
  accountId?: string | null;
  legacyTable: string;
  legacyId: string | number;
  brokerEntityKind?: string | null;
  brokerEntityId?: string | null;
  checkKind: ParityCheckKind;
  expected: unknown;
  actual: unknown;
  tolerance?: number;
  detail?: Record<string, unknown>;
}

function normalizeNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function valuesMatch(expected: unknown, actual: unknown, tolerance = 0.01): boolean {
  const e = normalizeNumber(expected);
  const a = normalizeNumber(actual);
  if (e != null && a != null) return Math.abs(e - a) <= tolerance;
  return String(expected ?? "") === String(actual ?? "");
}

export function recordParityEvent(db: BrokerDb, input: ParityCheckInput): { matched: boolean; id: string } {
  const matched = valuesMatch(input.expected, input.actual, input.tolerance ?? 0.01);
  const id = brokerId("bpar");
  db.prepare(
    `INSERT INTO broker_parity_events
      (id, account_id, legacy_table, legacy_id, broker_entity_kind, broker_entity_id,
       check_kind, expected_value, actual_value, matched, detail_json, record_schema_version, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.accountId ?? null,
    input.legacyTable,
    String(input.legacyId),
    input.brokerEntityKind ?? null,
    input.brokerEntityId ?? null,
    input.checkKind,
    JSON.stringify(input.expected ?? null),
    JSON.stringify(input.actual ?? null),
    matched ? 1 : 0,
    input.detail ? JSON.stringify(input.detail) : null,
    BROKER_RECORD_SCHEMA_VERSION,
    Date.now(),
  );
  if (!matched) {
    console.warn(
      `[broker-parity] mismatch ${input.legacyTable}:${input.legacyId} ${input.checkKind} expected=${JSON.stringify(input.expected)} actual=${JSON.stringify(input.actual)}`,
    );
  }
  return { matched, id };
}

export function verifyNumericParity(
  db: BrokerDb,
  checks: ParityCheckInput[],
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  for (const c of checks) {
    const r = recordParityEvent(db, c);
    if (!r.matched) mismatches.push(c.checkKind);
  }
  return { ok: mismatches.length === 0, mismatches };
}

export function brokerReturnPct(entryPrice: number, exitPrice: number): number {
  if (!(entryPrice > 0)) return 0;
  return roundMoney(((exitPrice - entryPrice) / entryPrice) * 100);
}

export function brokerOptionPnl(entryFill: number, exitFill: number, contracts = 1): number {
  return roundMoney((exitFill - entryFill) * 100 * contracts);
}
