/**
 * content-delivery-census.ts — what the content-draft pipeline has actually
 * delivered, counted from persisted rows only.
 *
 * The 2026-08-03 outage was not a delivery failure. `DISCORD_RECAP_ENABLED=0`
 * deferred 336 drafts to `SKIPPED_NO_WEBHOOK`, and once the switch was cleared
 * there was no way to answer the only question that mattered — "is the recovery
 * sweep moving them?" — because `/api/content-drafts` returns at most 200 rows
 * ordered `created_at_ms DESC` while recovery drains oldest-first. The recovered
 * rows were, by construction, in the part of the table the list endpoint could
 * not show. Counting 200 undelivered rows and concluding "recovery is broken"
 * was a measurement artifact, not an observation.
 *
 * This module counts the WHOLE table with SQL aggregates, so no page window can
 * hide the tail. It issues zero provider calls and writes nothing.
 *
 * A note on `SKIPPED_NO_WEBHOOK`: it is a RETRY BUCKET, not a diagnosis. It
 * means "undelivered, eligible for a later sweep" and says nothing about why.
 * For the reason, read `recapDelivery` on /api/discord/health.
 */

export interface CensusDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

export type ContentDeliveryStateKind =
  /** The table was read and holds rows. Counts are real measurements. */
  | "DATA_PRESENT"
  /** The table could not be read. NOT a zero — nothing was counted. */
  | "READ_FAILED"
  /** The table does not exist yet: the engine has never persisted a draft. */
  | "NOT_INITIALIZED"
  /** The table exists and is empty. A true empty set. */
  | "GENUINELY_EMPTY";

export interface ContentDeliveryCensus {
  state: ContentDeliveryStateKind;
  headline: string;
  /** Null whenever the state is not DATA_PRESENT — never coerced to 0. */
  total: number | null;
  byDeliveryStatus: Record<string, number> | null;
  /** Undelivered rows a recovery sweep is entitled to pick up. */
  eligibleForRecovery: number | null;
  /** Distinct content events still holding undelivered drafts. */
  eventsAwaitingRecovery: number | null;
  delivered: number | null;
  deliveredWithMessageId: number | null;
  failed: number | null;
  suppressed: number | null;
  /** Oldest undelivered draft — the one the next sweep will take. */
  oldestUndeliveredAtMs: number | null;
  newestDeliveredAtMs: number | null;
  /**
   * At one event per scan, how many scans until the backlog drains. Null when
   * nothing is pending; this is arithmetic on the cap, not a promise.
   */
  scansToDrainBacklog: number | null;
}

const UNDELIVERED = ["PENDING", "FAILED", "SKIPPED_NO_WEBHOOK"] as const;
const UNDELIVERED_SQL = UNDELIVERED.map((s) => `'${s}'`).join(",");

function tableExists(db: CensusDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function unavailable(state: ContentDeliveryStateKind, headline: string): ContentDeliveryCensus {
  return {
    state,
    headline,
    total: null,
    byDeliveryStatus: null,
    eligibleForRecovery: null,
    eventsAwaitingRecovery: null,
    delivered: null,
    deliveredWithMessageId: null,
    failed: null,
    suppressed: null,
    oldestUndeliveredAtMs: null,
    newestDeliveredAtMs: null,
    scansToDrainBacklog: null,
  };
}

/**
 * Count every content draft by delivery status.
 *
 * `eventsPerScan` mirrors the scan cap so the drain estimate stays honest if the
 * cap ever moves; it is not a knob that changes behaviour.
 */
export function buildContentDeliveryCensus(db: CensusDb, eventsPerScan = 1): ContentDeliveryCensus {
  if (!tableExists(db, "content_drafts")) {
    return unavailable("NOT_INITIALIZED", "No content_drafts table — the engine has never persisted a draft.");
  }

  let rows: { s: string; n: number }[];
  try {
    rows = db.prepare(
      "SELECT discord_delivery_status AS s, COUNT(*) AS n FROM content_drafts GROUP BY discord_delivery_status",
    ).all() as { s: string; n: number }[];
  } catch (e: unknown) {
    return unavailable("READ_FAILED", `content_drafts could not be read: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }

  const by: Record<string, number> = {};
  for (const r of rows) by[r.s ?? "<null>"] = Number(r.n) || 0;
  const total = Object.values(by).reduce((a, b) => a + b, 0);

  if (total === 0) {
    return { ...unavailable("GENUINELY_EMPTY", "content_drafts exists and is empty."), total: 0, byDeliveryStatus: {} };
  }

  const num = (sql: string): number | null => {
    try {
      const r = db.prepare(sql).get() as Record<string, unknown> | undefined;
      const v = r ? Number(Object.values(r)[0]) : NaN;
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };

  const eligibleForRecovery = UNDELIVERED.reduce((a, s) => a + (by[s] ?? 0), 0);
  const eventsAwaitingRecovery = num(
    `SELECT COUNT(*) n FROM (SELECT content_event_id FROM content_drafts
      WHERE discord_delivery_status IN (${UNDELIVERED_SQL}) GROUP BY content_event_id)`,
  );
  const delivered = by.SENT ?? 0;

  return {
    state: "DATA_PRESENT",
    headline:
      eligibleForRecovery > 0
        ? `${delivered} delivered · ${eligibleForRecovery} awaiting delivery across ${eventsAwaitingRecovery ?? "?"} events.`
        : `${delivered} delivered · nothing awaiting delivery.`,
    total,
    byDeliveryStatus: by,
    eligibleForRecovery,
    eventsAwaitingRecovery,
    delivered,
    deliveredWithMessageId: num(
      "SELECT COUNT(*) n FROM content_drafts WHERE discord_delivery_status='SENT' AND discord_message_id IS NOT NULL",
    ),
    failed: by.FAILED ?? 0,
    suppressed: by.SUPPRESSED ?? 0,
    oldestUndeliveredAtMs: num(
      `SELECT MIN(created_at_ms) n FROM content_drafts WHERE discord_delivery_status IN (${UNDELIVERED_SQL})`,
    ),
    newestDeliveredAtMs: num(
      "SELECT MAX(updated_at_ms) n FROM content_drafts WHERE discord_delivery_status='SENT'",
    ),
    scansToDrainBacklog:
      eventsAwaitingRecovery && eventsPerScan > 0 ? Math.ceil(eventsAwaitingRecovery / eventsPerScan) : null,
  };
}
