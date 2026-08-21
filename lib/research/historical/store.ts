/**
 * store.ts — the durable historical record. Writes only; no provider access.
 *
 * WHY THIS EXISTS. Every historical fetch OptiScan made was answered from the
 * provider and then thrown away. Bars were consumed by `computeOptionsFeatures` per
 * scan and discarded; the historical option fetchers cached in memory only. That is
 * the whole reason "the provider has 2023 NBBO" kept being mistaken for "we can build
 * a 2023 cohort" — nothing was ever possessed, so every study was one process restart
 * from having no data at all.
 *
 * ── The three rules ──────────────────────────────────────────────────────────
 *
 * IDENTITY IS THE PRIMARY KEY. Re-ingesting a window is a no-op, not a duplicate.
 * Dedupe lives in the schema so no caller can forget it, and every writer here is
 * safe to re-run after a crash mid-window.
 *
 * SOURCE AND QUALITY TRAVEL WITH THE ROW. Quotes and trades are separate TABLES, not
 * one table with a `kind` column. A trade print says where the contract traded; an
 * NBBO says what could have been paid. Substituting one for the other manufactures
 * fills that never existed, and two tables cannot be conflated by a forgotten filter.
 *
 * NOTHING HERE IS DERIVED. These tables hold what the provider returned, normalized.
 * Everything computed from them is computed at read time, so changing how we reason
 * never requires rewriting history.
 */

export const HISTORICAL_INGEST_VERSION = "HIST_STORE_V1" as const;

export interface StoreDb {
  prepare(sql: string): {
    run?: (...a: any[]) => { changes: number };
    get?: (...a: any[]) => any;
    all?: (...a: any[]) => any[];
  };
  transaction?: (fn: (...a: any[]) => any) => (...a: any[]) => any;
}

export type Timeframe = "1m" | "5m" | "1d";

export interface BarRow {
  symbol: string;
  timeframe: Timeframe;
  tsMs: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  vwap?: number | null;
  tradeCount?: number | null;
}

export interface OptionQuoteRow {
  occ: string;
  tsMs: number;
  bid: number | null;
  ask: number | null;
  bidSize?: number | null;
  askSize?: number | null;
}

export interface OptionTradeRow {
  occ: string;
  tsMs: number;
  seq?: number;
  price: number | null;
  size: number | null;
}

export interface ContractRefRow {
  occ: string;
  underlying: string;
  side: "call" | "put";
  strike: number | null;
  expiration: string | null;
  expired?: boolean;
}

function hasTable(db: StoreDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get?.(name));
  } catch {
    return false;
  }
}

const num = (v: unknown): number | null => {
  const x = Number(v);
  return v == null || v === "" || !Number.isFinite(x) ? null : x;
};

const occOf = (v: unknown): string | null => {
  const s = String(v ?? "").trim().toUpperCase();
  return s || null;
};

/**
 * Run `fn` inside a transaction when the driver offers one.
 *
 * Batched ingestion without a transaction is not merely slow — a crash halfway
 * through leaves a window partly stored, and the progress cursor then either
 * re-fetches it (wasted budget) or skips it (a silent hole). Wrapping the batch makes
 * "stored" and "recorded as stored" the same event.
 */
function inTx<T>(db: StoreDb, fn: () => T): T {
  if (typeof db.transaction === "function") {
    return db.transaction(fn)();
  }
  return fn();
}

export interface WriteResult {
  attempted: number;
  written: number;
  skipped: number;
}

/**
 * Bars, keyed (symbol, timeframe, ts). `INSERT OR IGNORE`, not upsert: a settled
 * historical bar is immutable, so a second copy is either identical or wrong, and
 * silently overwriting the first with the second would hide a provider disagreement
 * that is worth knowing about.
 */
export function writeBarsOnDb(
  db: StoreDb,
  rows: readonly BarRow[],
  opts: { source: string; nowMs: number; quality?: string },
): WriteResult {
  if (!hasTable(db, "historical_underlying_bars") || !rows.length) {
    return { attempted: rows.length, written: 0, skipped: rows.length };
  }
  const quality = opts.quality ?? "OK";
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO historical_underlying_bars
       (symbol, timeframe, ts_ms, open, high, low, close, volume, vwap, trade_count,
        source, ingest_version, quality, ingested_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let written = 0;
  inTx(db, () => {
    for (const r of rows) {
      const sym = String(r.symbol ?? "").trim().toUpperCase();
      const ts = num(r.tsMs);
      if (!sym || ts == null) continue;
      const res = stmt.run?.(
        sym, r.timeframe, ts,
        num(r.open), num(r.high), num(r.low), num(r.close), num(r.volume),
        num(r.vwap), num(r.tradeCount),
        opts.source, HISTORICAL_INGEST_VERSION, quality, opts.nowMs,
      );
      if (res && res.changes > 0) written += 1;
    }
  });
  return { attempted: rows.length, written, skipped: rows.length - written };
}

export function writeOptionQuotesOnDb(
  db: StoreDb,
  rows: readonly OptionQuoteRow[],
  opts: { source: string; nowMs: number },
): WriteResult {
  if (!hasTable(db, "historical_option_quotes") || !rows.length) {
    return { attempted: rows.length, written: 0, skipped: rows.length };
  }
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO historical_option_quotes
       (occ, ts_ms, bid, ask, bid_size, ask_size, source, ingest_version, ingested_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  let written = 0;
  inTx(db, () => {
    for (const r of rows) {
      const occ = occOf(r.occ);
      const ts = num(r.tsMs);
      if (!occ || ts == null) continue;
      const res = stmt.run?.(
        occ, ts, num(r.bid), num(r.ask), num(r.bidSize), num(r.askSize),
        opts.source, HISTORICAL_INGEST_VERSION, opts.nowMs,
      );
      if (res && res.changes > 0) written += 1;
    }
  });
  return { attempted: rows.length, written, skipped: rows.length - written };
}

export function writeOptionTradesOnDb(
  db: StoreDb,
  rows: readonly OptionTradeRow[],
  opts: { source: string; nowMs: number },
): WriteResult {
  if (!hasTable(db, "historical_option_trades") || !rows.length) {
    return { attempted: rows.length, written: 0, skipped: rows.length };
  }
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO historical_option_trades
       (occ, ts_ms, seq, price, size, source, ingest_version, ingested_at_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  let written = 0;
  inTx(db, () => {
    // Several prints can share a millisecond. `seq` disambiguates them, and it is
    // assigned per (occ, ts) within THIS batch so a re-ingested window produces the
    // same keys and collides instead of duplicating.
    const perKey = new Map<string, number>();
    for (const r of rows) {
      const occ = occOf(r.occ);
      const ts = num(r.tsMs);
      if (!occ || ts == null) continue;
      const k = `${occ}|${ts}`;
      const seq = r.seq ?? (perKey.get(k) ?? 0);
      perKey.set(k, seq + 1);
      const res = stmt.run?.(
        occ, ts, seq, num(r.price), num(r.size),
        opts.source, HISTORICAL_INGEST_VERSION, opts.nowMs,
      );
      if (res && res.changes > 0) written += 1;
    }
  });
  return { attempted: rows.length, written, skipped: rows.length - written };
}

/**
 * Contract reference. This one IS an upsert: reference metadata is a description of a
 * contract rather than an observation at an instant, and a later read of the same OCC
 * carrying a corrected strike or expiration should win.
 */
export function writeContractReferenceOnDb(
  db: StoreDb,
  rows: readonly ContractRefRow[],
  opts: { source: string; nowMs: number },
): WriteResult {
  if (!hasTable(db, "historical_contract_reference") || !rows.length) {
    return { attempted: rows.length, written: 0, skipped: rows.length };
  }
  const stmt = db.prepare(
    `INSERT INTO historical_contract_reference
       (occ, underlying, side, strike, expiration, expired, source, ingest_version, ingested_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(occ) DO UPDATE SET
       underlying=excluded.underlying, side=excluded.side, strike=excluded.strike,
       expiration=excluded.expiration, expired=excluded.expired,
       source=excluded.source, ingest_version=excluded.ingest_version,
       ingested_at_ms=excluded.ingested_at_ms`,
  );
  let written = 0;
  inTx(db, () => {
    for (const r of rows) {
      const occ = occOf(r.occ);
      if (!occ) continue;
      const res = stmt.run?.(
        occ, String(r.underlying ?? "").toUpperCase(), r.side,
        num(r.strike), r.expiration ?? null, r.expired === false ? 0 : 1,
        opts.source, HISTORICAL_INGEST_VERSION, opts.nowMs,
      );
      if (res && res.changes > 0) written += 1;
    }
  });
  return { attempted: rows.length, written, skipped: rows.length - written };
}

/** Resolve an expired OCC from the local store. Null means NOT INGESTED, not "no such contract". */
export function resolveContractOnDb(db: StoreDb, occ: string): ContractRefRow | null {
  if (!hasTable(db, "historical_contract_reference")) return null;
  const key = occOf(occ);
  if (!key) return null;
  try {
    const r = db.prepare("SELECT * FROM historical_contract_reference WHERE occ=?").get?.(key);
    if (!r) return null;
    return {
      occ: String(r.occ),
      underlying: String(r.underlying),
      side: String(r.side) === "put" ? "put" : "call",
      strike: num(r.strike),
      expiration: r.expiration == null ? null : String(r.expiration),
      expired: Number(r.expired ?? 1) === 1,
    };
  } catch {
    return null;
  }
}

export function listContractsForUnderlyingOnDb(
  db: StoreDb,
  underlying: string,
  opts: { expirationFrom?: string | null; expirationTo?: string | null; limit?: number } = {},
): ContractRefRow[] {
  if (!hasTable(db, "historical_contract_reference")) return [];
  const where = ["underlying=?"];
  const params: any[] = [String(underlying).toUpperCase()];
  if (opts.expirationFrom) { where.push("expiration >= ?"); params.push(opts.expirationFrom); }
  if (opts.expirationTo) { where.push("expiration <= ?"); params.push(opts.expirationTo); }
  const limit = Math.max(1, Math.min(20_000, opts.limit ?? 2000));
  try {
    const rows = (db.prepare(
      `SELECT * FROM historical_contract_reference WHERE ${where.join(" AND ")}
        ORDER BY expiration ASC, strike ASC LIMIT ?`,
    ).all?.(...params, limit) ?? []) as any[];
    return rows.map((r) => ({
      occ: String(r.occ),
      underlying: String(r.underlying),
      side: String(r.side) === "put" ? "put" : "call",
      strike: num(r.strike),
      expiration: r.expiration == null ? null : String(r.expiration),
      expired: Number(r.expired ?? 1) === 1,
    }));
  } catch {
    return [];
  }
}

// ── ingestion progress ───────────────────────────────────────────────────────

/**
 * Where one ingestion job stands.
 *
 * COMPLETE and EXHAUSTED are both TERMINAL and both mean "stop asking", but they are not
 * the same fact and collapsing them is what made the quote lane spend for ever:
 *
 *   COMPLETE  — the stored rows reach the end of the window. Full coverage.
 *   EXHAUSTED — the whole span was EXAMINED and the provider had nothing further to give,
 *               so the rows stop short and always will: a window running past the closing
 *               bell, or a contract that stopped quoting. Absence of data, not absence of
 *               effort.
 *
 * The distinction has to be readable, because the coverage repair reopens a terminal job
 * whose rows fall short of its window. Told only "COMPLETE", it cannot tell a truncated
 * download from a market that had nothing to print, so it reopened the second kind on
 * every pass for ever. Anything that treats a job as finished must accept BOTH; only the
 * repair distinguishes them, and it does so by never looking at EXHAUSTED.
 */
export type IngestStatus = "PENDING" | "IN_PROGRESS" | "COMPLETE" | "EXHAUSTED" | "BLOCKED" | "FAILED";

/** The statuses that mean "this job is finished; do not spend another request on it". */
export const TERMINAL_INGEST_STATUSES: readonly IngestStatus[] = Object.freeze(["COMPLETE", "EXHAUSTED"]);

export function isTerminalIngestStatus(status: string | null | undefined): boolean {
  return status === "COMPLETE" || status === "EXHAUSTED";
}

export interface IngestProgress {
  jobKey: string;
  dataset: string;
  subject: string;
  timeframe: string | null;
  cursorMs: number | null;
  completedThroughMs: number | null;
  rowsIngested: number;
  requestsSpent: number;
  runs: number;
  status: IngestStatus;
  lastNote: string | null;
  lastRunAtMs: number | null;
}

export function ingestJobKey(dataset: string, subject: string, timeframe?: string | null): string {
  return `${dataset}|${String(subject).toUpperCase()}|${timeframe ?? "-"}`;
}

export function readIngestProgressOnDb(db: StoreDb, jobKey: string): IngestProgress | null {
  if (!hasTable(db, "historical_ingestion_progress")) return null;
  try {
    const r = db.prepare("SELECT * FROM historical_ingestion_progress WHERE job_key=?").get?.(jobKey);
    if (!r) return null;
    return {
      jobKey: String(r.job_key),
      dataset: String(r.dataset),
      subject: String(r.subject),
      timeframe: r.timeframe == null ? null : String(r.timeframe),
      cursorMs: num(r.cursor_ms),
      completedThroughMs: num(r.completed_through_ms),
      rowsIngested: Number(r.rows_ingested ?? 0),
      requestsSpent: Number(r.requests_spent ?? 0),
      runs: Number(r.runs ?? 0),
      status: String(r.status) as IngestStatus,
      lastNote: r.last_note == null ? null : String(r.last_note),
      lastRunAtMs: num(r.last_run_at_ms),
    };
  } catch {
    return null;
  }
}

/**
 * Advance a job's progress. Counters ACCUMULATE, the cursor MOVES.
 *
 * `completed_through_ms` only ever moves forward (MAX). A resumed run that re-reads an
 * earlier window must not be able to walk the watermark backwards — that would make a
 * later run re-fetch data already stored, and the budget is the scarce resource this
 * whole lane is bounded by.
 */
export function advanceIngestProgressOnDb(
  db: StoreDb,
  p: {
    jobKey: string; dataset: string; subject: string; timeframe?: string | null;
    cursorMs?: number | null; completedThroughMs?: number | null;
    rowsIngested?: number; requestsSpent?: number;
    status: IngestStatus; note?: string | null; nowMs: number;
  },
): boolean {
  if (!hasTable(db, "historical_ingestion_progress")) return false;
  try {
    db.prepare(
      `INSERT INTO historical_ingestion_progress
         (job_key, dataset, subject, timeframe, cursor_ms, completed_through_ms,
          rows_ingested, requests_spent, runs, status, last_note, last_run_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)
       ON CONFLICT(job_key) DO UPDATE SET
         cursor_ms=COALESCE(excluded.cursor_ms, historical_ingestion_progress.cursor_ms),
         completed_through_ms=MAX(
           COALESCE(historical_ingestion_progress.completed_through_ms, -1),
           COALESCE(excluded.completed_through_ms, -1)
         ),
         rows_ingested=historical_ingestion_progress.rows_ingested + excluded.rows_ingested,
         requests_spent=historical_ingestion_progress.requests_spent + excluded.requests_spent,
         runs=historical_ingestion_progress.runs + 1,
         status=excluded.status,
         last_note=excluded.last_note,
         last_run_at_ms=excluded.last_run_at_ms,
         updated_at_ms=excluded.updated_at_ms`,
    ).run?.(
      p.jobKey, p.dataset, String(p.subject).toUpperCase(), p.timeframe ?? null,
      p.cursorMs ?? null, p.completedThroughMs ?? null,
      Math.max(0, p.rowsIngested ?? 0), Math.max(0, p.requestsSpent ?? 0),
      p.status, p.note ?? null, p.nowMs, p.nowMs,
    );
    return true;
  } catch {
    return false;
  }
}

export function listIngestProgressOnDb(
  db: StoreDb,
  opts: { dataset?: string | null; status?: IngestStatus | null; limit?: number } = {},
): IngestProgress[] {
  if (!hasTable(db, "historical_ingestion_progress")) return [];
  const where: string[] = [];
  const params: any[] = [];
  if (opts.dataset) { where.push("dataset=?"); params.push(opts.dataset); }
  if (opts.status) { where.push("status=?"); params.push(opts.status); }
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 500));
  try {
    const rows = (db.prepare(
      `SELECT * FROM historical_ingestion_progress
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY updated_at_ms DESC LIMIT ?`,
    ).all?.(...params, limit) ?? []) as any[];
    return rows.map((r) => ({
      jobKey: String(r.job_key),
      dataset: String(r.dataset),
      subject: String(r.subject),
      timeframe: r.timeframe == null ? null : String(r.timeframe),
      cursorMs: num(r.cursor_ms),
      completedThroughMs: num(r.completed_through_ms),
      rowsIngested: Number(r.rows_ingested ?? 0),
      requestsSpent: Number(r.requests_spent ?? 0),
      runs: Number(r.runs ?? 0),
      status: String(r.status) as IngestStatus,
      lastNote: r.last_note == null ? null : String(r.last_note),
      lastRunAtMs: num(r.last_run_at_ms),
    }));
  } catch {
    return [];
  }
}

// ── coverage ─────────────────────────────────────────────────────────────────

export interface HistoricalCoverage {
  bars: { rows: number; symbols: number; earliestMs: number | null; latestMs: number | null };
  optionQuotes: { rows: number; contracts: number; earliestMs: number | null; latestMs: number | null };
  optionTrades: { rows: number; contracts: number; earliestMs: number | null; latestMs: number | null };
  contractReference: { rows: number; underlyings: number };
  marketContext: { rows: number; derived: number; sessions: number };
}

function agg(db: StoreDb, table: string, timeCol: string, idCol: string | null): {
  rows: number; ids: number; earliestMs: number | null; latestMs: number | null;
} {
  if (!hasTable(db, table)) return { rows: 0, ids: 0, earliestMs: null, latestMs: null };
  try {
    const r = db.prepare(
      `SELECT COUNT(*) n, MIN(${timeCol}) lo, MAX(${timeCol}) hi
         ${idCol ? `, COUNT(DISTINCT ${idCol}) ids` : ""} FROM ${table}`,
    ).get?.() as any;
    return {
      rows: Number(r?.n ?? 0),
      ids: Number(r?.ids ?? 0),
      earliestMs: num(r?.lo),
      latestMs: num(r?.hi),
    };
  } catch {
    return { rows: 0, ids: 0, earliestMs: null, latestMs: null };
  }
}

export function historicalCoverageOnDb(db: StoreDb): HistoricalCoverage {
  const bars = agg(db, "historical_underlying_bars", "ts_ms", "symbol");
  const q = agg(db, "historical_option_quotes", "ts_ms", "occ");
  const t = agg(db, "historical_option_trades", "ts_ms", "occ");
  const ref = agg(db, "historical_contract_reference", "ingested_at_ms", "underlying");
  let ctxRows = 0; let ctxDerived = 0; let ctxSessions = 0;
  if (hasTable(db, "historical_market_context")) {
    try {
      const r = db.prepare(
        `SELECT COUNT(*) n,
                SUM(CASE WHEN origin='DERIVED_FROM_HISTORICAL_BARS' THEN 1 ELSE 0 END) d,
                COUNT(DISTINCT session_date) s
           FROM historical_market_context`,
      ).get?.() as any;
      ctxRows = Number(r?.n ?? 0);
      ctxDerived = Number(r?.d ?? 0);
      ctxSessions = Number(r?.s ?? 0);
    } catch { /* absent stays zero */ }
  }
  return {
    bars: { rows: bars.rows, symbols: bars.ids, earliestMs: bars.earliestMs, latestMs: bars.latestMs },
    optionQuotes: { rows: q.rows, contracts: q.ids, earliestMs: q.earliestMs, latestMs: q.latestMs },
    optionTrades: { rows: t.rows, contracts: t.ids, earliestMs: t.earliestMs, latestMs: t.latestMs },
    contractReference: { rows: ref.rows, underlyings: ref.ids },
    marketContext: { rows: ctxRows, derived: ctxDerived, sessions: ctxSessions },
  };
}
