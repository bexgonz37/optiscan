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
  /**
   * Counts per persisted reason code, split by status. Null on databases
   * predating the reason columns — which is not zero, it is "never recorded".
   */
  byReason: Record<string, number> | null;
  suppressedByReason: Record<string, number> | null;
  failedByReason: Record<string, number> | null;
  /** Rows written before delivery reasons were persisted at all. */
  withoutRecordedReason: number | null;
  retryableFailures: number | null;
  nonRetryableFailures: number | null;
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
    byReason: null,
    suppressedByReason: null,
    failedByReason: null,
    withoutRecordedReason: null,
    retryableFailures: null,
    nonRetryableFailures: null,
  };
}

function columnExists(db: CensusDb, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name?: string }[])
      .some((c) => c.name === column);
  } catch {
    return false;
  }
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

  // A database predating the reason columns must report null, not zero: no
  // reason was recorded for those rows, which is different from "no reason".
  const hasReasons = columnExists(db, "content_drafts", "discord_delivery_reason");
  let byReason: Record<string, number> | null = null;
  let suppressedByReason: Record<string, number> | null = null;
  let failedByReason: Record<string, number> | null = null;
  let withoutRecordedReason: number | null = null;
  let retryableFailures: number | null = null;
  let nonRetryableFailures: number | null = null;
  if (hasReasons) {
    try {
      const pairs = db.prepare(
        `SELECT discord_delivery_status AS st, COALESCE(discord_delivery_reason,'<none recorded>') AS rc,
                COUNT(*) AS n
           FROM content_drafts GROUP BY st, rc`,
      ).all() as { st: string; rc: string; n: number }[];
      byReason = {};
      suppressedByReason = {};
      failedByReason = {};
      withoutRecordedReason = 0;
      for (const p of pairs) {
        const n = Number(p.n) || 0;
        byReason[p.rc] = (byReason[p.rc] ?? 0) + n;
        if (p.rc === "<none recorded>") withoutRecordedReason += n;
        if (p.st === "SUPPRESSED") suppressedByReason[p.rc] = (suppressedByReason[p.rc] ?? 0) + n;
        if (p.st === "FAILED") failedByReason[p.rc] = (failedByReason[p.rc] ?? 0) + n;
      }
      const rt = db.prepare(
        `SELECT COALESCE(discord_delivery_retryable,-1) AS r, COUNT(*) AS n
           FROM content_drafts WHERE discord_delivery_status='FAILED' GROUP BY r`,
      ).all() as { r: number; n: number }[];
      retryableFailures = rt.filter((x) => Number(x.r) === 1).reduce((a, x) => a + Number(x.n), 0);
      nonRetryableFailures = rt.filter((x) => Number(x.r) === 0).reduce((a, x) => a + Number(x.n), 0);
    } catch {
      byReason = null;
      suppressedByReason = null;
      failedByReason = null;
      withoutRecordedReason = null;
      retryableFailures = null;
      nonRetryableFailures = null;
    }
  }

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
    byReason,
    suppressedByReason,
    failedByReason,
    withoutRecordedReason,
    retryableFailures,
    nonRetryableFailures,
  };
}
