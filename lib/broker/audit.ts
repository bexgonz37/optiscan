import { brokerId } from "./id.ts";
import type { AuditActor, AuditEntityKind } from "./types.ts";

export interface BrokerDb {
  prepare(sql: string): {
    run: (...args: unknown[]) => { changes: number };
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
  };
}

export function appendAuditEvent(
  db: BrokerDb,
  input: {
    accountId?: string | null;
    eventKind: string;
    entityKind: AuditEntityKind;
    entityId: string;
    actor?: AuditActor;
    payload: Record<string, unknown>;
    createdAtMs?: number;
  },
): string {
  const id = brokerId("baud");
  const now = input.createdAtMs ?? Date.now();
  db.prepare(
    `INSERT INTO broker_audit_events
      (id, account_id, event_kind, entity_kind, entity_id, actor, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.accountId ?? null,
    input.eventKind,
    input.entityKind,
    input.entityId,
    input.actor ?? "SYSTEM",
    JSON.stringify(input.payload),
    now,
  );
  return id;
}

export function listAuditEventsForEntity(
  db: BrokerDb,
  entityKind: AuditEntityKind,
  entityId: string,
): Array<{ event_kind: string; payload_json: string; created_at_ms: number }> {
  return db
    .prepare(
      `SELECT event_kind, payload_json, created_at_ms
       FROM broker_audit_events
       WHERE entity_kind = ? AND entity_id = ?
       ORDER BY created_at_ms ASC`,
    )
    .all(entityKind, entityId) as Array<{
    event_kind: string;
    payload_json: string;
    created_at_ms: number;
  }>;
}
