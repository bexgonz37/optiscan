/**
 * Durable Massive/Polygon request accounting.
 *
 * The in-process meter (`getCallStats`) is a live gauge, not a meter of record: it lives
 * on `globalThis`, so every deploy or restart silently zeroes the day's spend. This
 * module persists the same events to SQLite so the authoritative daily total survives
 * deployment, and so spend can be attributed per consumer, per symbol, and per OCC.
 *
 * Volume safety: at the 280/min cap a per-request table would add ~168k rows a day, so
 * requests roll up into per-minute buckets keyed by (day, minute, consumer, endpoint,
 * status). Every ratio the roadmap asks for is recoverable by summation; only individual
 * request IDs are not, and those are not needed for a budget decision.
 *
 * This module NEVER makes a provider call. Reporting reads persisted rows only.
 */
import {
  providerCategoryFor,
  type ProviderCategory,
  type ProviderConsumer,
} from "./provider-context.ts";

export type ProviderRequestStatus =
  | "ok"
  | "cache_hit"
  | "dedup_avoided"
  | "http_429"
  | "provider_error"
  | "quota_block"
  | "timeout";

export interface ProviderRequestEvent {
  consumer: ProviderConsumer;
  endpoint: string;
  status: ProviderRequestStatus;
  atMs: number;
  historical?: boolean;
  latencyMs?: number | null;
  recordsReturned?: number | null;
  retry?: boolean;
  paginated?: boolean;
  symbol?: string | null;
  optionSymbol?: string | null;
}

interface AccountingDb {
  prepare(sql: string): {
    get: (...a: any[]) => any;
    all: (...a: any[]) => any[];
    run: (...a: any[]) => { changes: number };
  };
}

export const PROVIDER_ACCOUNTING_VERSION = 1;

function hasTable(db: AccountingDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

/**
 * Normalise a Polygon path into a low-cardinality endpoint label: symbols and OCC codes
 * become `:sym`, so `/v3/snapshot/options/AAPL/O:AAPL...` collapses to one bucket.
 *
 * PERCENT-DECODING IS LOAD-BEARING. Callers build these paths with
 * `encodeURIComponent(occ)`, and `URL.pathname` hands the encoding back verbatim, so the
 * segment that arrives here is `O%3ANVDA260807C00200000` — which `/^O:/` does not match.
 * Every exact-OCC read therefore became its OWN endpoint bucket. Production on
 * 2026-08-03 showed 21 separate per-contract rows of 15-16 requests each crowding the
 * top-25 report, and that was with exact-OCC reads at only 0.7% of spend. Once marking
 * moved onto the exact-OCC path (a5f5976) the report would have fragmented into
 * thousands of one-request rows and become unreadable exactly when it mattered most.
 */
export function normalizeEndpoint(pathname: string): string {
  const raw = String(pathname || "").split("?")[0].replace(/\/+$/, "");
  // decodeURIComponent throws on a malformed escape; a bad label must never break metering.
  let trimmed = raw;
  try {
    trimmed = decodeURIComponent(raw);
  } catch { /* keep the raw form */ }
  if (!trimmed) return "unknown";
  return trimmed
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^O:/i.test(seg)) return ":occ";
      if (/^\d{4}-\d{2}-\d{2}$/.test(seg)) return ":date";
      if (/^\d+$/.test(seg)) return ":n";
      if (/^[A-Z][A-Z0-9.]{0,5}$/.test(seg) && !/^v\d$/i.test(seg)) return ":sym";
      return seg;
    })
    .join("/");
}

/** ET trading date for a timestamp, matching the provider meter's day boundary. */
export function accountingTradingDate(atMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(atMs));
}

export function deploymentIdFrom(env: NodeJS.ProcessEnv = process.env): string {
  const commit = env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT || env.SOURCE_COMMIT || "";
  return commit ? String(commit).slice(0, 7) : "local";
}

function statusColumns(status: ProviderRequestStatus): {
  requests: number;
  cacheHits: number;
  dedupAvoided: number;
  http429: number;
  providerErrors: number;
  quotaBlocks: number;
} {
  // A cache hit or a deduplicated call never reached the provider, so it must not be
  // counted as a request — otherwise cache savings would inflate apparent spend.
  return {
    requests: status === "cache_hit" || status === "dedup_avoided" || status === "quota_block" ? 0 : 1,
    cacheHits: status === "cache_hit" ? 1 : 0,
    dedupAvoided: status === "dedup_avoided" ? 1 : 0,
    http429: status === "http_429" ? 1 : 0,
    providerErrors: status === "provider_error" || status === "timeout" ? 1 : 0,
    quotaBlocks: status === "quota_block" ? 1 : 0,
  };
}

/**
 * A minute bucket's accumulated counters. Buffering these in memory keeps the hot path
 * write-free: one upsert per (minute, consumer, endpoint) instead of one per request.
 */
export interface ProviderMinuteAggregate {
  tradingDate: string;
  minuteBucketMs: number;
  deploymentId: string;
  consumer: ProviderConsumer;
  category: ProviderCategory;
  endpoint: string;
  historical: boolean;
  requests: number;
  cacheHits: number;
  dedupAvoided: number;
  retries: number;
  http429: number;
  providerErrors: number;
  quotaBlocks: number;
  paginated: number;
  recordsReturned: number;
  latencyMsTotal: number;
  latencyMsMax: number;
  atMs: number;
}

/** Stable key for a minute aggregate — matches the table's primary key. */
export function providerMinuteKey(a: {
  tradingDate: string; minuteBucketMs: number; deploymentId: string;
  consumer: string; endpoint: string; historical: boolean;
}): string {
  return [a.tradingDate, a.minuteBucketMs, a.deploymentId, a.consumer, a.endpoint, a.historical ? 1 : 0].join("|");
}

/** Fold one event into an aggregate, creating it when absent. Pure bookkeeping. */
export function foldProviderEvent(
  into: Map<string, ProviderMinuteAggregate>,
  event: ProviderRequestEvent,
  env: NodeJS.ProcessEnv = process.env,
): ProviderMinuteAggregate {
  const consumer = event.consumer;
  const historical = Boolean(event.historical);
  const base = {
    tradingDate: accountingTradingDate(event.atMs),
    minuteBucketMs: Math.floor(event.atMs / 60_000) * 60_000,
    deploymentId: deploymentIdFrom(env),
    consumer,
    endpoint: normalizeEndpoint(event.endpoint),
    historical,
  };
  const key = providerMinuteKey(base);
  let agg = into.get(key);
  if (!agg) {
    agg = {
      ...base,
      category: providerCategoryFor(consumer),
      requests: 0, cacheHits: 0, dedupAvoided: 0, retries: 0, http429: 0,
      providerErrors: 0, quotaBlocks: 0, paginated: 0, recordsReturned: 0,
      latencyMsTotal: 0, latencyMsMax: 0, atMs: event.atMs,
    };
    into.set(key, agg);
  }
  const c = statusColumns(event.status);
  const latency = Number.isFinite(event.latencyMs as number) ? Math.max(0, Math.floor(event.latencyMs as number)) : 0;
  const records = Number.isFinite(event.recordsReturned as number) ? Math.max(0, Math.floor(event.recordsReturned as number)) : 0;
  agg.requests += c.requests;
  agg.cacheHits += c.cacheHits;
  agg.dedupAvoided += c.dedupAvoided;
  agg.retries += event.retry ? 1 : 0;
  agg.http429 += c.http429;
  agg.providerErrors += c.providerErrors;
  agg.quotaBlocks += c.quotaBlocks;
  agg.paginated += event.paginated ? 1 : 0;
  agg.recordsReturned += records;
  agg.latencyMsTotal += latency;
  agg.latencyMsMax = Math.max(agg.latencyMsMax, latency);
  agg.atMs = Math.max(agg.atMs, event.atMs);
  return agg;
}

/** Upsert pre-aggregated minute rows. Never throws. Returns rows written. */
export function flushProviderMinuteAggregatesOnDb(
  db: AccountingDb,
  aggregates: Iterable<ProviderMinuteAggregate>,
): number {
  if (!hasTable(db, "provider_request_minute")) return 0;
  let written = 0;
  for (const a of aggregates) {
    try {
      db.prepare(
        `INSERT INTO provider_request_minute
          (trading_date, minute_bucket_ms, deployment_id, consumer, category, endpoint, historical,
           requests, cache_hits, dedup_avoided, retries, http_429, provider_errors, quota_blocks,
           paginated, records_returned, latency_ms_total, latency_ms_max,
           accounting_version, created_at_ms, updated_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(trading_date, minute_bucket_ms, deployment_id, consumer, endpoint, historical)
         DO UPDATE SET
           requests=provider_request_minute.requests+excluded.requests,
           cache_hits=provider_request_minute.cache_hits+excluded.cache_hits,
           dedup_avoided=provider_request_minute.dedup_avoided+excluded.dedup_avoided,
           retries=provider_request_minute.retries+excluded.retries,
           http_429=provider_request_minute.http_429+excluded.http_429,
           provider_errors=provider_request_minute.provider_errors+excluded.provider_errors,
           quota_blocks=provider_request_minute.quota_blocks+excluded.quota_blocks,
           paginated=provider_request_minute.paginated+excluded.paginated,
           records_returned=provider_request_minute.records_returned+excluded.records_returned,
           latency_ms_total=provider_request_minute.latency_ms_total+excluded.latency_ms_total,
           latency_ms_max=MAX(provider_request_minute.latency_ms_max, excluded.latency_ms_max),
           updated_at_ms=excluded.updated_at_ms`,
      ).run(
        a.tradingDate, a.minuteBucketMs, a.deploymentId, a.consumer, a.category, a.endpoint,
        a.historical ? 1 : 0, a.requests, a.cacheHits, a.dedupAvoided, a.retries, a.http429,
        a.providerErrors, a.quotaBlocks, a.paginated, a.recordsReturned,
        a.latencyMsTotal, a.latencyMsMax, PROVIDER_ACCOUNTING_VERSION, a.atMs, a.atMs,
      );
      written += 1;
    } catch { /* isolated — one bad row must not drop the rest of the flush */ }
  }
  return written;
}

/**
 * Persist one provider request event into its minute bucket. Never throws — accounting
 * must not be able to break a market-data path.
 */
export function recordProviderRequestOnDb(
  db: AccountingDb,
  event: ProviderRequestEvent,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!hasTable(db, "provider_request_minute")) return false;
  const consumer = event.consumer;
  const category: ProviderCategory = providerCategoryFor(consumer);
  const endpoint = normalizeEndpoint(event.endpoint);
  const tradingDate = accountingTradingDate(event.atMs);
  const minuteBucketMs = Math.floor(event.atMs / 60_000) * 60_000;
  const deploymentId = deploymentIdFrom(env);
  const c = statusColumns(event.status);
  const latency = Number.isFinite(event.latencyMs as number) ? Math.max(0, Math.floor(event.latencyMs as number)) : 0;
  const records = Number.isFinite(event.recordsReturned as number) ? Math.max(0, Math.floor(event.recordsReturned as number)) : 0;
  try {
    db.prepare(
      `INSERT INTO provider_request_minute
        (trading_date, minute_bucket_ms, deployment_id, consumer, category, endpoint, historical,
         requests, cache_hits, dedup_avoided, retries, http_429, provider_errors, quota_blocks,
         paginated, records_returned, latency_ms_total, latency_ms_max,
         accounting_version, created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trading_date, minute_bucket_ms, deployment_id, consumer, endpoint, historical)
       DO UPDATE SET
         requests=provider_request_minute.requests+excluded.requests,
         cache_hits=provider_request_minute.cache_hits+excluded.cache_hits,
         dedup_avoided=provider_request_minute.dedup_avoided+excluded.dedup_avoided,
         retries=provider_request_minute.retries+excluded.retries,
         http_429=provider_request_minute.http_429+excluded.http_429,
         provider_errors=provider_request_minute.provider_errors+excluded.provider_errors,
         quota_blocks=provider_request_minute.quota_blocks+excluded.quota_blocks,
         paginated=provider_request_minute.paginated+excluded.paginated,
         records_returned=provider_request_minute.records_returned+excluded.records_returned,
         latency_ms_total=provider_request_minute.latency_ms_total+excluded.latency_ms_total,
         latency_ms_max=MAX(provider_request_minute.latency_ms_max, excluded.latency_ms_max),
         updated_at_ms=excluded.updated_at_ms`,
    ).run(
      tradingDate,
      minuteBucketMs,
      deploymentId,
      consumer,
      category,
      endpoint,
      event.historical ? 1 : 0,
      c.requests,
      c.cacheHits,
      c.dedupAvoided,
      event.retry ? 1 : 0,
      c.http429,
      c.providerErrors,
      c.quotaBlocks,
      event.paginated ? 1 : 0,
      records,
      latency,
      latency,
      PROVIDER_ACCOUNTING_VERSION,
      event.atMs,
      event.atMs,
    );
  } catch {
    return false;
  }

  recordProviderSymbolSpendOnDb(db, event);
  return true;
}

/**
 * Per-symbol / per-OCC spend, only for calls that name a target. Day-grained: symbol
 * cardinality is high and minute grain would explode the table. Never throws — the
 * minute bucket remains the authoritative total if this write fails.
 */
export function recordProviderSymbolSpendOnDb(db: AccountingDb, event: ProviderRequestEvent): boolean {
  if (!event.symbol && !event.optionSymbol) return false;
  const c = statusColumns(event.status);
  if (c.requests <= 0) return false;
  if (!hasTable(db, "provider_request_symbol_day")) return false;
  const records = Number.isFinite(event.recordsReturned as number)
    ? Math.max(0, Math.floor(event.recordsReturned as number))
    : 0;
  try {
    db.prepare(
      `INSERT INTO provider_request_symbol_day
        (trading_date, consumer, symbol, option_symbol, requests, records_returned, created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(trading_date, consumer, symbol, option_symbol) DO UPDATE SET
         requests=provider_request_symbol_day.requests+excluded.requests,
         records_returned=provider_request_symbol_day.records_returned+excluded.records_returned,
         updated_at_ms=excluded.updated_at_ms`,
    ).run(
      accountingTradingDate(event.atMs),
      event.consumer,
      String(event.symbol ?? "").toUpperCase() || "UNKNOWN",
      String(event.optionSymbol ?? "") || "",
      c.requests,
      records,
      event.atMs,
      event.atMs,
    );
    return true;
  } catch {
    return false;
  }
}

export interface ConsumerUsageRow {
  consumer: string;
  category: string;
  requests: number;
  cacheHits: number;
  dedupAvoided: number;
  retries: number;
  http429: number;
  providerErrors: number;
  quotaBlocks: number;
  recordsReturned: number;
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
  pctOfRequests: number | null;
}

export interface ProviderUsageReport {
  tradingDate: string;
  accountingVersion: number;
  /**
   * The narrowing applied, echoed back. A scoped and an unscoped report are the
   * same shape and wildly different numbers; without this a reader cannot tell
   * which one they have, which is the confusion the scope exists to end.
   */
  scope: { deploymentId: string | null; sinceMs: number | null; untilMs: number | null };
  /** Deployments that contributed to this report — proves the total survived restarts. */
  deployments: string[];
  totalRequests: number;
  totalCacheHits: number;
  totalDedupAvoided: number;
  totalRetries: number;
  total429: number;
  totalProviderErrors: number;
  totalQuotaBlocks: number;
  minutesObserved: number;
  peakRequestsPerMinute: number;
  peakMinuteBucketMs: number | null;
  avgRequestsPerActiveMinute: number | null;
  byConsumer: ConsumerUsageRow[];
  byEndpoint: { endpoint: string; requests: number; pctOfRequests: number | null }[];
  cacheHitRate: number | null;
  retryRate: number | null;
  quotaBlockRate: number | null;
  errorRate: number | null;
}

const pct = (part: number, whole: number): number | null =>
  whole > 0 ? +((part / whole) * 100).toFixed(2) : null;

/**
 * Narrows a usage report to part of a trading date.
 *
 * WHY. A trading date is not a measurement window. On 2026-08-03 four deployments
 * metered into the same date, and Gate B7's entire question — did a reserve change
 * who got served — is unanswerable against a total that sums the sessions before
 * the reserve existed with the session after. The rows have always carried
 * `deployment_id` and `minute_bucket_ms`; only the report refused to use them, so
 * every post-deploy conclusion was being drawn from mixed evidence.
 *
 * Scoping is read-side only: no counter changes, and an unscoped call behaves
 * exactly as before.
 */
export interface ProviderUsageScope {
  /** Short commit SHA, as recorded by `deploymentIdFrom`. */
  deploymentId?: string;
  /** Inclusive lower bound on `minute_bucket_ms`. */
  sinceMs?: number;
  /** Inclusive upper bound on `minute_bucket_ms`. */
  untilMs?: number;
}

/** `WHERE trading_date=? …` plus the scope's clauses, and the bound parameters in order. */
function scopeClause(tradingDate: string, scope: ProviderUsageScope = {}): {
  where: string;
  params: (string | number)[];
} {
  const params: (string | number)[] = [tradingDate];
  let where = "trading_date=?";
  if (scope.deploymentId) {
    where += " AND deployment_id=?";
    params.push(scope.deploymentId);
  }
  if (Number.isFinite(scope.sinceMs)) {
    where += " AND minute_bucket_ms>=?";
    params.push(Number(scope.sinceMs));
  }
  if (Number.isFinite(scope.untilMs)) {
    where += " AND minute_bucket_ms<=?";
    params.push(Number(scope.untilMs));
  }
  return { where, params };
}

/** How many distinct endpoint labels the scope has, so the remainder row can name its size. */
function countDistinctEndpoints(
  db: AccountingDb,
  tradingDate: string,
  scope: ProviderUsageScope = {},
): number {
  try {
    const { where, params } = scopeClause(tradingDate, scope);
    const row = db.prepare(
      `SELECT COUNT(DISTINCT endpoint) n FROM provider_request_minute WHERE ${where}`,
    ).get(...params) as Record<string, any> | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Persisted usage for a trading date, optionally narrowed to one deployment or
 * minute range. Read-only and provider-free — safe for diagnostics, dashboards,
 * and health endpoints.
 */
export function buildProviderUsageReportOnDb(
  db: AccountingDb,
  tradingDate: string,
  scope: ProviderUsageScope = {},
): ProviderUsageReport {
  const scopeEcho = {
    deploymentId: scope.deploymentId ?? null,
    sinceMs: Number.isFinite(scope.sinceMs) ? Number(scope.sinceMs) : null,
    untilMs: Number.isFinite(scope.untilMs) ? Number(scope.untilMs) : null,
  };
  const empty: ProviderUsageReport = {
    tradingDate,
    accountingVersion: PROVIDER_ACCOUNTING_VERSION,
    scope: scopeEcho,
    deployments: [],
    totalRequests: 0,
    totalCacheHits: 0,
    totalDedupAvoided: 0,
    totalRetries: 0,
    total429: 0,
    totalProviderErrors: 0,
    totalQuotaBlocks: 0,
    minutesObserved: 0,
    peakRequestsPerMinute: 0,
    peakMinuteBucketMs: null,
    avgRequestsPerActiveMinute: null,
    byConsumer: [],
    byEndpoint: [],
    cacheHitRate: null,
    retryRate: null,
    quotaBlockRate: null,
    errorRate: null,
  };
  if (!hasTable(db, "provider_request_minute")) return empty;

  try {
    const { where, params } = scopeClause(tradingDate, scope);
    const totals = db.prepare(
      `SELECT COALESCE(SUM(requests),0) requests, COALESCE(SUM(cache_hits),0) cacheHits,
              COALESCE(SUM(dedup_avoided),0) dedupAvoided, COALESCE(SUM(retries),0) retries,
              COALESCE(SUM(http_429),0) http429, COALESCE(SUM(provider_errors),0) providerErrors,
              COALESCE(SUM(quota_blocks),0) quotaBlocks
       FROM provider_request_minute WHERE ${where}`,
    ).get(...params) as Record<string, number>;
    const totalRequests = Number(totals?.requests ?? 0);

    const perMinute = db.prepare(
      `SELECT minute_bucket_ms bucket, SUM(requests) n
       FROM provider_request_minute WHERE ${where}
       GROUP BY minute_bucket_ms ORDER BY n DESC LIMIT 1`,
    ).get(...params) as { bucket?: number; n?: number } | undefined;

    const minutes = Number(
      (db.prepare(
        `SELECT COUNT(*) n FROM (
           SELECT minute_bucket_ms FROM provider_request_minute
           WHERE ${where} AND requests>0 GROUP BY minute_bucket_ms)`,
      ).get(...params) as { n?: number } | undefined)?.n ?? 0,
    );

    const deployments = (db.prepare(
      `SELECT DISTINCT deployment_id FROM provider_request_minute WHERE ${where} ORDER BY deployment_id`,
    ).all(...params) as { deployment_id?: string }[]).map((r) => String(r.deployment_id ?? ""));

    const byConsumer = (db.prepare(
      `SELECT consumer, category, SUM(requests) requests, SUM(cache_hits) cacheHits,
              SUM(dedup_avoided) dedupAvoided, SUM(retries) retries, SUM(http_429) http429,
              SUM(provider_errors) providerErrors, SUM(quota_blocks) quotaBlocks,
              SUM(records_returned) recordsReturned, SUM(latency_ms_total) latencyTotal,
              MAX(latency_ms_max) latencyMax
       FROM provider_request_minute WHERE ${where}
       GROUP BY consumer, category ORDER BY requests DESC`,
    ).all(...params) as Record<string, any>[]).map((r) => {
      const requests = Number(r.requests ?? 0);
      return {
        consumer: String(r.consumer ?? "unattributed"),
        category: String(r.category ?? "diagnostic"),
        requests,
        cacheHits: Number(r.cacheHits ?? 0),
        dedupAvoided: Number(r.dedupAvoided ?? 0),
        retries: Number(r.retries ?? 0),
        http429: Number(r.http429 ?? 0),
        providerErrors: Number(r.providerErrors ?? 0),
        quotaBlocks: Number(r.quotaBlocks ?? 0),
        recordsReturned: Number(r.recordsReturned ?? 0),
        avgLatencyMs: requests > 0 ? Math.round(Number(r.latencyTotal ?? 0) / requests) : null,
        maxLatencyMs: r.latencyMax == null ? null : Number(r.latencyMax),
        pctOfRequests: pct(requests, totalRequests),
      };
    });

    // Top 25 by spend, PLUS an explicit remainder row. The bare LIMIT 25 dropped the
    // tail silently, so the endpoint column never summed to the total and a reader had
    // no way to tell truncation from completeness. An accounting report that does not
    // add up is worse than no report.
    const endpointRows = (db.prepare(
      `SELECT endpoint, SUM(requests) requests FROM provider_request_minute
       WHERE ${where} GROUP BY endpoint ORDER BY requests DESC LIMIT 25`,
    ).all(...params) as Record<string, any>[]).map((r) => ({
      endpoint: String(r.endpoint ?? "unknown"),
      requests: Number(r.requests ?? 0),
      pctOfRequests: pct(Number(r.requests ?? 0), totalRequests),
    }));
    const shown = endpointRows.reduce((sum, r) => sum + r.requests, 0);
    const remainder = totalRequests - shown;
    const byEndpoint = remainder > 0
      ? [...endpointRows, {
        endpoint: `(${countDistinctEndpoints(db, tradingDate, scope) - endpointRows.length} more endpoints)`,
        requests: remainder,
        pctOfRequests: pct(remainder, totalRequests),
      }]
      : endpointRows;

    const cacheHits = Number(totals?.cacheHits ?? 0);
    const dedupAvoided = Number(totals?.dedupAvoided ?? 0);
    const avoided = cacheHits + dedupAvoided;
    return {
      tradingDate,
      accountingVersion: PROVIDER_ACCOUNTING_VERSION,
      scope: scopeEcho,
      deployments,
      totalRequests,
      totalCacheHits: cacheHits,
      totalDedupAvoided: dedupAvoided,
      totalRetries: Number(totals?.retries ?? 0),
      total429: Number(totals?.http429 ?? 0),
      totalProviderErrors: Number(totals?.providerErrors ?? 0),
      totalQuotaBlocks: Number(totals?.quotaBlocks ?? 0),
      minutesObserved: minutes,
      peakRequestsPerMinute: Number(perMinute?.n ?? 0),
      peakMinuteBucketMs: perMinute?.bucket == null ? null : Number(perMinute.bucket),
      avgRequestsPerActiveMinute: minutes > 0 ? +(totalRequests / minutes).toFixed(1) : null,
      byConsumer,
      byEndpoint,
      cacheHitRate: pct(avoided, totalRequests + avoided),
      retryRate: pct(Number(totals?.retries ?? 0), totalRequests),
      quotaBlockRate: pct(Number(totals?.quotaBlocks ?? 0), totalRequests + Number(totals?.quotaBlocks ?? 0)),
      errorRate: pct(Number(totals?.providerErrors ?? 0) + Number(totals?.http429 ?? 0), totalRequests),
    };
  } catch {
    return empty;
  }
}

/** Heaviest symbols / OCCs for a trading date. Read-only. */
export function topProviderSymbolsOnDb(
  db: AccountingDb,
  tradingDate: string,
  limit = 25,
): { consumer: string; symbol: string; optionSymbol: string | null; requests: number }[] {
  if (!hasTable(db, "provider_request_symbol_day")) return [];
  try {
    return (db.prepare(
      `SELECT consumer, symbol, option_symbol, requests FROM provider_request_symbol_day
       WHERE trading_date=? ORDER BY requests DESC LIMIT ?`,
    ).all(tradingDate, limit) as Record<string, any>[]).map((r) => ({
      consumer: String(r.consumer ?? "unattributed"),
      symbol: String(r.symbol ?? "UNKNOWN"),
      optionSymbol: r.option_symbol ? String(r.option_symbol) : null,
      requests: Number(r.requests ?? 0),
    }));
  } catch {
    return [];
  }
}

/** Requests per minute over a bounded window, for live saturation inspection. */
export function providerRequestsPerMinuteOnDb(
  db: AccountingDb,
  fromMs: number,
  toMs: number,
): { minuteBucketMs: number; requests: number; quotaBlocks: number }[] {
  if (!hasTable(db, "provider_request_minute")) return [];
  try {
    return (db.prepare(
      `SELECT minute_bucket_ms, SUM(requests) requests, SUM(quota_blocks) quotaBlocks
       FROM provider_request_minute WHERE minute_bucket_ms BETWEEN ? AND ?
       GROUP BY minute_bucket_ms ORDER BY minute_bucket_ms ASC`,
    ).all(Math.floor(fromMs / 60_000) * 60_000, toMs) as Record<string, any>[]).map((r) => ({
      minuteBucketMs: Number(r.minute_bucket_ms ?? 0),
      requests: Number(r.requests ?? 0),
      quotaBlocks: Number(r.quotaBlocks ?? 0),
    }));
  } catch {
    return [];
  }
}

/** Drop accounting older than `keepDays` trading dates. Bounded growth, never throws. */
export function pruneProviderAccountingOnDb(db: AccountingDb, keepDays = 45): number {
  if (!hasTable(db, "provider_request_minute")) return 0;
  try {
    const dates = (db.prepare(
      "SELECT DISTINCT trading_date FROM provider_request_minute ORDER BY trading_date DESC",
    ).all() as { trading_date?: string }[]).map((r) => String(r.trading_date ?? ""));
    if (dates.length <= keepDays || keepDays < 1) return 0;
    // `dates` is newest-first, so the keepDays-th newest is the oldest date we keep.
    const cutoff = dates[keepDays - 1];
    const removed = db.prepare("DELETE FROM provider_request_minute WHERE trading_date<?").run(cutoff);
    try {
      db.prepare("DELETE FROM provider_request_symbol_day WHERE trading_date<?").run(cutoff);
    } catch { /* isolated */ }
    return Number(removed.changes ?? 0);
  } catch {
    return 0;
  }
}
