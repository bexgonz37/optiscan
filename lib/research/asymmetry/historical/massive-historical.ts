/**
 * massive-historical.ts — historical exact-OCC market data from Massive.
 *
 * PROVENANCE OF THE ENTITLEMENT CLAIM. Every endpoint below was probed against
 * the live key on 2026-07-31 and returned HTTP 200 with real rows. The results
 * are recorded in capability-matrix.ts and are re-checkable by
 * scripts/massive-capability-probe.mjs. Nothing here is assumed.
 *
 * This corrects a documented mistake. lib/research/replay-provider.ts and
 * lib/research/asymmetry/source-priority.ts both asserted that historical
 * option quotes/NBBO were "not integrated or entitled". The first half was
 * true — nothing was integrated. The second half was false: /v3/quotes/{OCC}
 * returns full NBBO with sizes back to at least 2023-07-31 on this plan. That
 * error is why the radar could only ever grade contracts going forward.
 *
 * DISCIPLINE:
 *   - Entry is the ASK, marks are the BID. Never mid. Enforced by the callers
 *     that build cohorts; this module returns both sides untouched.
 *   - A missing quote stays missing. No interpolation, no nearest-neighbour
 *     across a gap larger than the caller's tolerance, no synthetic midpoint.
 *   - Every request passes the RequestAccountant first. A capped request
 *     returns PROVIDER_BUDGET_BLOCKED and no value.
 *   - Timestamps arrive in NANOSECONDS on /v3/quotes and /v3/trades and in
 *     MILLISECONDS on /v2/aggs. They are normalized at this boundary, once.
 */
import {
  RequestAccountant, PROVIDER_BUDGET_BLOCKED, type RequestKind,
} from "./request-accounting.ts";
import {
  HistoricalCache, historicalCacheKey, windowKey, isSettledWindow,
  type HistoricalDataType,
} from "./cache.ts";

const BASE = process.env.POLYGON_API_URL || "https://api.polygon.io";
const REQUEST_TIMEOUT_MS = 20_000;

function apiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.POLYGON_API_KEY || env.MASSIVE_API_KEY || "";
}

export function historicalAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(apiKey(env));
}

/** One NBBO observation for an exact contract. Sizes included — thin quotes matter. */
export interface HistoricalQuote {
  /** Epoch MILLISECONDS, normalized from the provider's nanosecond SIP stamp. */
  atMs: number;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
}

export interface HistoricalTrade {
  atMs: number;
  price: number;
  size: number;
}

export interface HistoricalBar {
  t: number; o: number; h: number; l: number; c: number; v: number;
  /** Volume-weighted average price for the bar, when the provider supplies it. */
  vw: number | null;
  /** Trade count in the bar. Distinguishes one print from real participation. */
  n: number | null;
}

export type FetchOutcome =
  | { ok: true; blocked: false; cached: boolean; note: string }
  | { ok: false; blocked: boolean; cached: false; note: string };

export interface HistoricalResult<T> {
  rows: T[];
  outcome: FetchOutcome;
  /** True only when the provider confirmed there are no rows in the window. */
  confirmedEmpty: boolean;
  /**
   * True when the provider returned exactly the requested limit, so the window
   * is NOT fully covered. A truncated window must never be treated as complete:
   * on a liquid contract, 5,000 NBBO rows can span under a minute, and the
   * "peak premium" of a truncated window is the peak of an arbitrary prefix.
   */
  truncated: boolean;
}

export interface HistoricalDeps {
  accountant: RequestAccountant;
  cache?: HistoricalCache;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected clock so settle/backoff logic is deterministic under test. */
  nowMs?: () => number;
  /** Injected sleep so retry backoff does not stall tests. */
  sleep?: (ms: number) => Promise<void>;
}

const NS_PER_MS = 1_000_000;

/** Provider stamps are nanoseconds on v3 endpoints. Normalize once, here. */
export function nsToMs(ns: unknown): number | null {
  const v = Number(ns);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.floor(v / NS_PER_MS);
}

const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The provider's `results` array, typed. Without this the ternary yields `any`
 * and every downstream `.filter` predicate loses its parameter type.
 */
const results = (body: unknown): unknown[] => {
  const r = (body as { results?: unknown })?.results;
  return Array.isArray(r) ? r : [];
};

/**
 * Issue one accounted, retried, circuit-broken provider request.
 * Returns null when blocked or exhausted — never a partial or invented body.
 */
async function request(
  deps: HistoricalDeps,
  kind: RequestKind,
  path: string,
  params: Record<string, string | number>,
  attribution: { symbol?: string | null; occ?: string | null; windowKey?: string | null },
): Promise<{ body: any | null; note: string; blocked: boolean }> {
  const env = deps.env ?? process.env;
  const now = deps.nowMs ?? Date.now;
  const key = apiKey(env);
  if (!key) return { body: null, note: "NO_PROVIDER_KEY", blocked: false };

  const admission = deps.accountant.admit({ kind, ...attribution }, now());
  if (!admission.admitted) {
    return { body: null, note: `${PROVIDER_BUDGET_BLOCKED}:${admission.reason}`, blocked: true };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = deps.accountant.caps.maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set("apiKey", key);
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429) {
        deps.accountant.recordFailure({ rateLimited: true }, now());
        if (attempt < maxAttempts) {
          deps.accountant.recordRetry();
          await sleep(deps.accountant.backoffMs(attempt));
          continue;
        }
        return { body: null, note: "RATE_LIMITED_429", blocked: false };
      }
      if (!res.ok) {
        deps.accountant.recordFailure({}, now());
        if (attempt < maxAttempts && res.status >= 500) {
          deps.accountant.recordRetry();
          await sleep(deps.accountant.backoffMs(attempt));
          continue;
        }
        return { body: null, note: `PROVIDER_${res.status}`, blocked: false };
      }
      const body = await res.json();
      deps.accountant.recordSuccess();
      return { body, note: "OK", blocked: false };
    } catch (err: any) {
      deps.accountant.recordFailure({}, now());
      if (attempt < maxAttempts) {
        deps.accountant.recordRetry();
        await sleep(deps.accountant.backoffMs(attempt));
        continue;
      }
      return { body: null, note: sanitize(`PROVIDER_ERROR:${err?.message ?? err}`), blocked: false };
    }
  }
  return { body: null, note: "PROVIDER_EXHAUSTED", blocked: false };
}

/** Never echo a key back into a log line or a persisted note. */
export function sanitize(s: unknown): string {
  return String(s ?? "").replace(/apiKey=[^&\s]+/gi, "apiKey=***").slice(0, 200);
}

async function cachedFetch<T>(
  deps: HistoricalDeps,
  spec: {
    kind: RequestKind; dataType: HistoricalDataType;
    occ: string; fromMs: number; toMs: number;
    symbol?: string | null;
    path: string; params: Record<string, string | number>;
    parse: (body: any) => T[];
    /** Requested row cap. Returning exactly this many means truncation. */
    limit?: number;
    /** Distinguishes otherwise-identical windows, e.g. ascending vs descending. */
    cacheSuffix?: string;
  },
): Promise<HistoricalResult<T>> {
  const now = (deps.nowMs ?? Date.now)();
  const cache = deps.cache;
  const ck = historicalCacheKey({ occ: spec.occ, fromMs: spec.fromMs, toMs: spec.toMs, dataType: spec.dataType })
    + (spec.cacheSuffix ? `|${spec.cacheSuffix}` : "");

  if (cache) {
    const hit = cache.get<{ rows: T[]; truncated: boolean }>(ck, now);
    if (hit) {
      deps.accountant.recordCacheHit();
      return {
        rows: hit.rows, truncated: hit.truncated,
        outcome: { ok: true, blocked: false, cached: true, note: "CACHE_HIT" },
        confirmedEmpty: hit.rows.length === 0,
      };
    }
    deps.accountant.recordCacheMiss();
  }

  const { body, note, blocked } = await request(deps, spec.kind, spec.path, spec.params, {
    symbol: spec.symbol ?? null,
    occ: spec.occ,
    windowKey: windowKey(spec.fromMs, spec.toMs) + (spec.cacheSuffix ? `|${spec.cacheSuffix}` : ""),
  });
  if (!body) {
    return { rows: [], truncated: false, outcome: { ok: false, blocked, cached: false, note }, confirmedEmpty: false };
  }
  const rawCount = Array.isArray(body?.results) ? body.results.length : 0;
  const rows = spec.parse(body);
  const truncated = spec.limit != null && rawCount >= spec.limit;
  if (cache) cache.put(ck, { rows, truncated }, isSettledWindow(spec.toMs, now), now);
  return {
    rows, truncated,
    outcome: {
      ok: true, blocked: false, cached: false,
      note: truncated ? `OK_TRUNCATED_AT_${spec.limit}` : "OK",
    },
    confirmedEmpty: rows.length === 0 && !truncated,
  };
}

/**
 * Historical NBBO for an exact OCC across [fromMs, toMs).
 * ENTITLED — probed 2026-07-31: /v3/quotes/{OCC} returned bid_price, ask_price,
 * bid_size, ask_size and sip_timestamp for NVDA contracts back to 2023-07-31.
 */
export async function fetchHistoricalOptionQuotes(
  occ: string,
  fromMs: number,
  toMs: number,
  deps: HistoricalDeps,
  opts: { limit?: number; symbol?: string | null } = {},
): Promise<HistoricalResult<HistoricalQuote>> {
  const limit = Math.max(1, Math.min(50_000, opts.limit ?? 5_000));
  return cachedFetch<HistoricalQuote>(deps, {
    kind: "HIST_QUOTE", dataType: "QUOTES", occ, fromMs, toMs, symbol: opts.symbol, limit,
    path: `/v3/quotes/${encodeURIComponent(occ)}`,
    params: {
      "timestamp.gte": String(fromMs * NS_PER_MS),
      "timestamp.lt": String(toMs * NS_PER_MS),
      order: "asc", sort: "timestamp", limit,
    },
    parse: (body) => results(body)
      .map((r: any): HistoricalQuote | null => {
        const atMs = nsToMs(r?.sip_timestamp);
        if (atMs == null) return null;
        return {
          atMs,
          bid: numOrNull(r?.bid_price),
          ask: numOrNull(r?.ask_price),
          bidSize: numOrNull(r?.bid_size),
          askSize: numOrNull(r?.ask_size),
        };
      })
      .filter((q): q is HistoricalQuote => q != null),
  });
}

/**
 * Historical trades for an exact OCC. Used to tell "the contract printed at
 * this level" from "the quote merely showed this level" — a distinction that
 * decides whether a hypothetical entry was ever executable.
 * ENTITLED — probed 2026-07-31.
 */
export async function fetchHistoricalOptionTrades(
  occ: string,
  fromMs: number,
  toMs: number,
  deps: HistoricalDeps,
  opts: { limit?: number; symbol?: string | null } = {},
): Promise<HistoricalResult<HistoricalTrade>> {
  const limit = Math.max(1, Math.min(50_000, opts.limit ?? 5_000));
  return cachedFetch<HistoricalTrade>(deps, {
    kind: "HIST_TRADE", dataType: "TRADES", occ, fromMs, toMs, symbol: opts.symbol, limit,
    path: `/v3/trades/${encodeURIComponent(occ)}`,
    params: {
      "timestamp.gte": String(fromMs * NS_PER_MS),
      "timestamp.lt": String(toMs * NS_PER_MS),
      order: "asc", sort: "timestamp", limit,
    },
    parse: (body) => results(body)
      .map((r: any): HistoricalTrade | null => {
        const atMs = nsToMs(r?.sip_timestamp);
        const price = numOrNull(r?.price);
        if (atMs == null || price == null) return null;
        return { atMs, price, size: numOrNull(r?.size) ?? 0 };
      })
      .filter((t): t is HistoricalTrade => t != null),
  });
}

/**
 * Historical 1-minute bars for an exact OCC or an underlying symbol.
 * ENTITLED — probed 2026-07-31 for both O: tickers and plain symbols.
 * NOTE: option aggregate bars are TRADE-derived. They cannot substitute for
 * NBBO when the question is "what could have been paid" — use quotes for that.
 */
export async function fetchHistoricalBars(
  ticker: string,
  fromMs: number,
  toMs: number,
  deps: HistoricalDeps,
  opts: { multiplier?: number; timespan?: string; limit?: number; symbol?: string | null } = {},
): Promise<HistoricalResult<HistoricalBar>> {
  const mult = Math.max(1, Math.floor(opts.multiplier ?? 1));
  const span = opts.timespan ?? "minute";
  const fromDay = new Date(fromMs).toISOString().slice(0, 10);
  const toDay = new Date(toMs).toISOString().slice(0, 10);
  const limit = Math.max(1, Math.min(50_000, opts.limit ?? 50_000));
  return cachedFetch<HistoricalBar>(deps, {
    kind: "HIST_AGG", dataType: "AGGS_1M", occ: ticker, fromMs, toMs, symbol: opts.symbol ?? ticker,
    limit, cacheSuffix: `${mult}${span}`,
    path: `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${mult}/${span}/${fromDay}/${toDay}`,
    params: { adjusted: "true", sort: "asc", limit },
    parse: (body) => results(body)
      .map((b: any): HistoricalBar | null => {
        const t = numOrNull(b?.t);
        const c = numOrNull(b?.c);
        if (t == null || c == null) return null;
        return {
          t, o: numOrNull(b?.o) ?? c, h: numOrNull(b?.h) ?? c, l: numOrNull(b?.l) ?? c, c,
          v: numOrNull(b?.v) ?? 0, vw: numOrNull(b?.vw), n: numOrNull(b?.n),
        };
      })
      .filter((b): b is HistoricalBar => b != null)
      // The provider returns whole days; trim to the requested window so a
      // caller can never accidentally read a bar from outside its own window.
      .filter((b) => b.t >= fromMs && b.t < toMs),
  });
}

/**
 * The NBBO in force AT ONE INSTANT, fetched directly.
 *
 * WHY THIS EXISTS RATHER THAN SLICING A BULK WINDOW. A liquid contract quotes
 * thousands of times a minute: a 5,000-row ascending request over a two-hour
 * window returns the first ~40 seconds of it and nothing else. Reconstructing
 * "the ask at the alert" from that prefix silently yields the wrong number, or
 * more often no number at all.
 *
 * Instead this asks the provider a narrow DESCENDING question — the last quote
 * strictly before `atMs`, limit 1 — which is exact, costs one request, and
 * cannot be truncated into a wrong answer. Returns null when no quote exists
 * within `toleranceMs`, because a contract with no quote near the instant was
 * not executable then.
 */
export async function fetchQuoteAtInstant(
  occ: string,
  atMs: number,
  deps: HistoricalDeps,
  opts: { toleranceMs?: number; symbol?: string | null } = {},
): Promise<{ quote: HistoricalQuote | null; outcome: FetchOutcome }> {
  const tolerance = Math.max(1_000, opts.toleranceMs ?? 120_000);
  const fromMs = atMs - tolerance;
  const res = await cachedFetch<HistoricalQuote>(deps, {
    kind: "HIST_QUOTE", dataType: "QUOTES", occ, fromMs, toMs: atMs,
    symbol: opts.symbol, limit: 1, cacheSuffix: "at-instant-desc",
    path: `/v3/quotes/${encodeURIComponent(occ)}`,
    params: {
      "timestamp.gte": String(fromMs * NS_PER_MS),
      "timestamp.lte": String(atMs * NS_PER_MS),
      order: "desc", sort: "timestamp", limit: 1,
    },
    parse: (body) => results(body)
      .map((r: any): HistoricalQuote | null => {
        const t = nsToMs(r?.sip_timestamp);
        if (t == null) return null;
        return {
          atMs: t, bid: numOrNull(r?.bid_price), ask: numOrNull(r?.ask_price),
          bidSize: numOrNull(r?.bid_size), askSize: numOrNull(r?.ask_size),
        };
      })
      .filter((q): q is HistoricalQuote => q != null),
  });
  return { quote: res.rows[0] ?? null, outcome: res.outcome };
}

/** One contract in the historical universe. Reference data only, no prices. */
export interface ContractRef {
  occ: string;
  underlying: string;
  side: "call" | "put";
  strike: number;
  expiration: string;
}

/**
 * Enumerate contracts that existed for an underlying, INCLUDING EXPIRED ONES.
 *
 * This is the only way to find a contract that no longer exists, and therefore
 * the entry point to any historical cohort: without it the universe is limited
 * to contracts still listed today, which is a survivorship-biased sample of
 * exactly the wrong kind.
 *
 * PROBED 2026-08-02: `expired=true` with an expiration_date range returns 200
 * with full pages back to 2010 expirations. NOTE: combining `as_of` WITH an
 * expiration_date range returned zero rows — use the date range alone.
 */
export async function fetchContractUniverse(
  underlying: string,
  expirationFromDay: string,
  expirationToDay: string,
  deps: HistoricalDeps,
  opts: { side?: "call" | "put"; maxPages?: number; limit?: number } = {},
): Promise<{ contracts: ContractRef[]; outcome: FetchOutcome; pages: number }> {
  const sym = String(underlying).toUpperCase();
  const maxPages = Math.max(1, Math.min(20, opts.maxPages ?? 4));
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 250));
  const out: ContractRef[] = [];
  let pages = 0;
  let lastOutcome: FetchOutcome = { ok: true, blocked: false, cached: false, note: "OK" };

  // Pagination uses an explicit strike cursor rather than next_url so every
  // page is an independently accounted, independently cacheable request.
  let strikeCursor: number | null = null;
  for (let p = 0; p < maxPages; p++) {
    const params: Record<string, string | number> = {
      underlying_ticker: sym, expired: "true", limit,
      "expiration_date.gte": expirationFromDay, "expiration_date.lte": expirationToDay,
      sort: "strike_price", order: "asc",
    };
    if (opts.side) params.contract_type = opts.side;
    if (strikeCursor != null) params["strike_price.gt"] = strikeCursor;

    const { body, note, blocked } = await request(deps, "REFERENCE", "/v3/reference/options/contracts", params, {
      symbol: sym, occ: null, windowKey: `ref-${expirationFromDay}-${expirationToDay}-p${p}`,
    });
    if (!body) { lastOutcome = { ok: false, blocked, cached: false, note }; break; }
    pages += 1;
    const rows = results(body);
    if (rows.length === 0) break;
    for (const r of rows) {
      const rec = r as Record<string, unknown>;
      const occ = String(rec.ticker ?? "").toUpperCase();
      const strike = numOrNull(rec.strike_price);
      const side = String(rec.contract_type ?? "").toLowerCase();
      if (!occ || strike == null || (side !== "call" && side !== "put")) continue;
      out.push({ occ, underlying: sym, side, strike, expiration: String(rec.expiration_date ?? "") });
    }
    const maxStrike = out.length ? out[out.length - 1].strike : null;
    if (rows.length < limit || maxStrike == null || maxStrike === strikeCursor) break;
    strikeCursor = maxStrike;
  }
  // The same strike can carry several expirations, so dedupe on the OCC itself.
  const seen = new Set<string>();
  const unique = out.filter((c) => (seen.has(c.occ) ? false : (seen.add(c.occ), true)));
  return { contracts: unique, outcome: lastOutcome, pages };
}

/**
 * The premium curve for a contract, from 1-minute aggregates.
 *
 * Aggregates are TRADE-derived, so this answers "where did the contract trade"
 * — the right question for peak/trough shape — at one request per contract per
 * day. It is NOT a substitute for NBBO at a decision instant; use
 * fetchQuoteAtInstant for "what could have been paid".
 */
export async function fetchPremiumCurve(
  occ: string, fromMs: number, toMs: number, deps: HistoricalDeps,
  opts: { symbol?: string | null } = {},
): Promise<HistoricalResult<HistoricalBar>> {
  return fetchHistoricalBars(occ, fromMs, toMs, deps, { multiplier: 1, timespan: "minute", symbol: opts.symbol ?? null });
}

/**
 * The NBBO in force at an instant: the last quote at or before `atMs`, subject
 * to a maximum staleness tolerance.
 *
 * Returns null rather than the nearest quote when the gap exceeds tolerance.
 * That is the whole point — a contract with no quote near the instant was not
 * executable then, and pretending otherwise manufactures fills that never
 * existed.
 */
export function quoteAsOf(
  quotes: readonly HistoricalQuote[],
  atMs: number,
  maxStalenessMs = 120_000,
): HistoricalQuote | null {
  let best: HistoricalQuote | null = null;
  for (const q of quotes) {
    if (q.atMs > atMs) break;
    best = q;
  }
  if (!best) return null;
  if (atMs - best.atMs > maxStalenessMs) return null;
  return best;
}

/** Highest ask and highest bid observed in a window. Null when nothing usable. */
export function extremes(quotes: readonly HistoricalQuote[]): {
  peakAsk: number | null; peakAskAtMs: number | null;
  peakBid: number | null; peakBidAtMs: number | null;
  lowBid: number | null; lowBidAtMs: number | null;
} {
  let peakAsk: number | null = null, peakAskAtMs: number | null = null;
  let peakBid: number | null = null, peakBidAtMs: number | null = null;
  let lowBid: number | null = null, lowBidAtMs: number | null = null;
  for (const q of quotes) {
    if (q.ask != null && q.ask > 0 && (peakAsk == null || q.ask > peakAsk)) { peakAsk = q.ask; peakAskAtMs = q.atMs; }
    if (q.bid != null && q.bid > 0) {
      if (peakBid == null || q.bid > peakBid) { peakBid = q.bid; peakBidAtMs = q.atMs; }
      if (lowBid == null || q.bid < lowBid) { lowBid = q.bid; lowBidAtMs = q.atMs; }
    }
  }
  return { peakAsk, peakAskAtMs, peakBid, peakBidAtMs, lowBid, lowBidAtMs };
}
