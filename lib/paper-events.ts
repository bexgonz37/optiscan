/**
 * paper-events.ts — the typed, idempotent lifecycle event stream (rebuild).
 *
 * Every meaningful paper-trade transition emits ONE typed event with a
 * deterministic idempotency key, written to the `paper_events` table with
 * INSERT OR IGNORE so a duplicate scanner cycle can never double-record. This
 * is the clean substrate later phases (setup fingerprints, outcome tracking,
 * statistics) will read — but NO statistics are computed here.
 *
 * The pure helpers (event-type validation + idempotency key) are runtime-tested;
 * the DB writes use a lazy `@/lib/db` require so this module stays importable by
 * the node test runner without resolving the alias.
 */

export const PAPER_EVENT_TYPES = [
  "candidate_created",
  "validation_started",
  "validation_passed",
  "validation_failed",
  "order_submitted",
  "fill",
  "no_fill",
  "position_opened",
  "mark_updated",
  "mark_stale",
  "mark_missing",
  "stop_triggered",
  "target_triggered",
  "timeout",
  "expiration",
  "manual_close",
  "system_close",
  "invalidated",
  "final_outcome",
  "rejected",
  "error",
] as const;

export type PaperEventType = (typeof PAPER_EVENT_TYPES)[number];

const EVENT_SET: ReadonlySet<string> = new Set(PAPER_EVENT_TYPES);

export function isPaperEventType(v: string): v is PaperEventType {
  return EVENT_SET.has(v);
}

export interface PaperEventInput {
  tradeId: number | null;
  alertId?: number | null;
  ticker?: string | null;
  eventType: PaperEventType;
  fromState?: string | null;
  toState?: string | null;
  payload?: unknown;
  /** Disambiguates repeated events of the same type on the same trade (e.g. a mark timestamp bucket). */
  discriminator?: string | number | null;
  nowMs?: number;
}

/**
 * Deterministic idempotency key. Same (trade, event, discriminator) → same key,
 * so re-processing a sweep is a no-op at the DB layer (INSERT OR IGNORE).
 */
export function makeIdempotencyKey(
  tradeId: number | null,
  eventType: PaperEventType,
  discriminator?: string | number | null,
): string {
  const disc = discriminator == null || discriminator === "" ? "-" : String(discriminator);
  return `pe:${tradeId ?? "none"}:${eventType}:${disc}`;
}

/**
 * Record one lifecycle event idempotently. Returns true when a NEW row was
 * written, false when the idempotency key already existed (duplicate ignored)
 * or the write failed (never throws into the engine).
 */
export function recordPaperEvent(input: PaperEventInput): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    const db = getDb();
    const key = makeIdempotencyKey(input.tradeId, input.eventType, input.discriminator);
    const nowMs = input.nowMs ?? Date.now();
    const seqRow: any = db
      .prepare("SELECT COALESCE(MAX(event_seq), 0) AS m FROM paper_events WHERE trade_id IS ?")
      .get(input.tradeId ?? null);
    const nextSeq = Number(seqRow?.m ?? 0) + 1;
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO paper_events
           (trade_id, alert_id, ticker, event_type, event_seq, from_state, to_state, payload_json, idempotency_key, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.tradeId ?? null,
        input.alertId ?? null,
        input.ticker ?? null,
        input.eventType,
        nextSeq,
        input.fromState ?? null,
        input.toState ?? null,
        input.payload == null ? null : JSON.stringify(input.payload),
        key,
        nowMs,
      );
    return res.changes > 0;
  } catch (err: any) {
    console.warn("[paper] event record skipped:", err?.message);
    return false;
  }
}

export interface PaperEventRow {
  id: number;
  tradeId: number | null;
  alertId: number | null;
  ticker: string | null;
  eventType: string;
  eventSeq: number;
  fromState: string | null;
  toState: string | null;
  payload: unknown;
  idempotencyKey: string;
  createdAtMs: number;
}

export function listPaperEvents(tradeId: number, limit = 200): PaperEventRow[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    const rows = getDb()
      .prepare("SELECT * FROM paper_events WHERE trade_id = ? ORDER BY event_seq ASC LIMIT ?")
      .all(tradeId, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      tradeId: r.trade_id ?? null,
      alertId: r.alert_id ?? null,
      ticker: r.ticker ?? null,
      eventType: r.event_type,
      eventSeq: r.event_seq,
      fromState: r.from_state ?? null,
      toState: r.to_state ?? null,
      payload: r.payload_json ? safeParse(r.payload_json) : null,
      idempotencyKey: r.idempotency_key,
      createdAtMs: r.created_at_ms,
    }));
  } catch {
    return [];
  }
}

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}
