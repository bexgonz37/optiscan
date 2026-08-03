/**
 * The write side of provider accounting, kept separate from the query side so the
 * provider client can depend on it without pulling the reporting surface (or the db
 * module's import graph) into every market-data path.
 *
 * Every function here is failure-isolated. Accounting is observability: it must never
 * turn a working quote fetch into an error, and it must never make a provider call.
 */
import {
  flushProviderMinuteAggregatesOnDb,
  foldProviderEvent,
  recordProviderSymbolSpendOnDb,
  type ProviderMinuteAggregate,
  type ProviderRequestEvent,
  type ProviderRequestStatus,
} from "./provider-accounting.ts";
import { currentProviderScope } from "./provider-context.ts";

let cachedDb: any = null;
let dbUnavailable = false;

/**
 * Events accumulate in memory and are written once per minute bucket. A synchronous
 * SQLite upsert on every provider call would put an fsync in the hot path of the
 * scanner and the mark runner; since the table is minute-grained anyway, buffering
 * loses no fidelity. At most the current (incomplete) minute is unflushed.
 */
const buffer = new Map<string, ProviderMinuteAggregate>();
let bufferedMinute: number | null = null;

/** Safety valve: flush if a single minute somehow accumulates this many distinct keys. */
const MAX_BUFFER_KEYS = 500;

function accountingDb(): any {
  if (dbUnavailable) return null;
  if (cachedDb) return cachedDb;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    cachedDb = getDb();
    return cachedDb;
  } catch {
    dbUnavailable = true;
    return null;
  }
}

/** Test seam: point accounting at an explicit database (or null to re-resolve). */
export function __setProviderAccountingDb(db: any): void {
  cachedDb = db;
  dbUnavailable = false;
  buffer.clear();
  bufferedMinute = null;
}

/**
 * Write buffered aggregates out. Safe to call at any time (shutdown, before reading a
 * report, on a scheduler tick). Returns the number of minute rows written.
 */
export function flushProviderAccounting(): number {
  if (!buffer.size) return 0;
  const db = accountingDb();
  if (!db) {
    // No database to flush into. Drop the buffer rather than growing it without bound.
    buffer.clear();
    bufferedMinute = null;
    return 0;
  }
  let written = 0;
  try {
    written = flushProviderMinuteAggregatesOnDb(db, buffer.values());
  } catch { /* isolated */ }
  buffer.clear();
  bufferedMinute = null;
  return written;
}

export interface ProviderRequestObservation {
  endpoint: string;
  status: ProviderRequestStatus;
  atMs?: number;
  latencyMs?: number | null;
  recordsReturned?: number | null;
  retry?: boolean;
  paginated?: boolean;
  symbol?: string | null;
  optionSymbol?: string | null;
}

/**
 * Record one provider request against the ambient consumer scope.
 * Returns false when nothing was persisted (no db, no schema, or a write failure).
 */
export function emitProviderRequest(observation: ProviderRequestObservation): boolean {
  const scope = currentProviderScope();
  const atMs = observation.atMs ?? Date.now();
  const event: ProviderRequestEvent = {
    consumer: scope?.consumer ?? "unattributed",
    historical: scope?.historical ?? false,
    endpoint: observation.endpoint,
    status: observation.status,
    atMs,
    latencyMs: observation.latencyMs ?? null,
    recordsReturned: observation.recordsReturned ?? null,
    retry: observation.retry ?? false,
    paginated: observation.paginated ?? false,
    symbol: observation.symbol ?? null,
    optionSymbol: observation.optionSymbol ?? null,
  };
  try {
    const minute = Math.floor(atMs / 60_000);
    if (bufferedMinute != null && minute !== bufferedMinute) flushProviderAccounting();
    bufferedMinute = minute;
    foldProviderEvent(buffer, event);
    if (buffer.size >= MAX_BUFFER_KEYS) flushProviderAccounting();

    // Per-symbol spend is day-grained and comparatively rare (only calls that name a
    // target), so it writes through directly rather than joining the minute buffer.
    if (event.symbol || event.optionSymbol) {
      const db = accountingDb();
      if (db) recordProviderSymbolSpendOnDb(db, event);
    }
    return true;
  } catch {
    return false;
  }
}
