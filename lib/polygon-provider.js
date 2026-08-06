/**
 * polygon-provider.js — Polygon.io / Massive client (stocks + options).
 *
 * Polygon rebranded to Massive (Oct 2025); the api.polygon.io base URL and keys
 * are unchanged. Missing key or plan degrades gracefully (available:false)
 * instead of throwing. parse* helpers are pure (no network) for unit testing.
 */

import {
  recordDataSample,
  recordNoData,
  recordProviderFailure,
  recordProviderSuccess,
} from "./data-freshness.ts";
import { providerTimestampMs } from "./provider-timestamp.js";
import { tradingDay } from "./trading-session.ts";
import { emitProviderRequest } from "./provider-accounting-sink.ts";
import { currentProviderConsumer } from "./provider-context.ts";
import {
  budgetSnapshot,
  commitBudget,
  decideBudget,
  emptyMinuteBudgetState,
} from "./provider-budget.ts";

const POLYGON_BASE = process.env.POLYGON_API_URL || "https://api.polygon.io";

export function getPolygonKey() {
  return process.env.POLYGON_API_KEY || process.env.MASSIVE_API_KEY || "";
}

export function hasPolygon() {
  return Boolean(getPolygonKey());
}

// A non-numeric value is UNKNOWN, not NaN. `Number("n/a")` is NaN, which
// serialises to JSON as `null`, renders as the string "NaN", and compares
// false against every threshold — three different wrong answers from one
// value. Absence and invalidity both resolve to null so consumers have one
// case to handle, and `?? 0` at a call site can no longer be fed a NaN it
// silently passes through.
const numOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Day % change that matches what traders expect on screen.
 * Polygon's todaysChangePerc vs prevDay breaks on spin-offs / listing days when
 * prev close is an accounting stub (e.g. MFP spin-off: prev $6.59, open $35.50).
 * When open and prev are not comparable, use session open → last price instead.
 */
export function normalizeDayChangePercent(q = {}) {
  const price = numOrNull(q.price ?? q.last);
  const dayOpen = numOrNull(q.dayOpen);
  const prevClose = numOrNull(q.prevClose);
  const polygonPct = numOrNull(q.changePercent);

  if (price == null || price <= 0) return polygonPct;

  const fromOpen = dayOpen != null && dayOpen > 0 ? ((price - dayOpen) / dayOpen) * 100 : null;
  const fromPrev = prevClose != null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;

  if (fromOpen != null && prevClose != null && prevClose > 0 && dayOpen != null && dayOpen > 0) {
    const openVsPrev = dayOpen / prevClose;
    // Prev close is stale (spin-off, reverse split, listing) — session move only.
    if (openVsPrev >= 2.5 || openVsPrev <= 0.4) {
      return +fromOpen.toFixed(4);
    }
  }

  if (fromPrev != null) return +fromPrev.toFixed(4);
  if (fromOpen != null) return +fromOpen.toFixed(4);
  return polygonPct;
}

/** Warrants, units, and class shares pollute closed-session recap lists. */
export function isRecapNoiseSymbol(symbol, price = null) {
  const s = String(symbol || "").toUpperCase();
  if (!s) return true;
  if (/\./.test(s)) return true;
  if (/W$/.test(s) && s.length >= 5) return true;
  if (price != null && price > 0 && price < 0.5) return true;
  return false;
}

/** Parse a Polygon stock snapshot ticker array into quote objects. */
export function parseSnapshotTickers(tickers) {
  if (!Array.isArray(tickers)) return [];
  const out = [];
  for (const t of tickers) {
    if (!t || !t.ticker) continue;
    const day = t.day || {};
    const min = t.min || {};
    const dayClose = numOrNull(day.c);
    const last = numOrNull(t.lastTrade?.p) ?? numOrNull(min.c) ?? dayClose;
    // Real NBBO from the snapshot's last quote (p=bid, P=ask, t=SIP ns). Kept
    // additive: consumers that ignore bid/ask are unaffected; the paper stock
    // path uses it for verified conservative fills instead of the tape price.
    const lq = t.lastQuote || {};
    const bid = numOrNull(lq.p);
    const ask = numOrNull(lq.P);
    // Day-to-date CUMULATIVE volume including premarket. Polygon's `day.v` is the
    // regular-session aggregate and reads 0 during premarket, while `min.av` is
    // today's accumulated volume (premarket included). Taking the max gives the
    // true day-to-date figure in every session — a premarket runner is no longer
    // seen as 0 volume just because the 9:30 aggregate hasn't started. (Coalescing
    // `day.v ?? min.av` was wrong: 0 is not null, so min.av was never consulted.)
    const dayToDateVolume = Math.max(numOrNull(day.v) ?? 0, numOrNull(min.av) ?? 0);
    const row = {
      symbol: String(t.ticker).toUpperCase(),
      last,
      price: last,
      change: numOrNull(t.todaysChange),
      volume: dayToDateVolume,
      dayOpen: numOrNull(day.o),
      dayClose,
      dayHigh: numOrNull(day.h),
      dayLow: numOrNull(day.l),
      prevClose: numOrNull(t.prevDay?.c),
      bid,
      ask,
      mid: last,
      quoteProviderTimestamp: numOrNull(lq.t),
      providerTimestamp: providerTimestampMs(t.lastTrade?.t) ?? providerTimestampMs(min.t) ?? providerTimestampMs(day.t),
    };
    // Gain from the previous regular-session close. AFTER-HOURS: `day.c` is a real
    // regular-session close, so day-change reflects the session (not the AH pop).
    // PREMARKET: `day.c` is 0 (no session yet) — coalescing `dayClose ?? last`
    // wrongly kept 0 (0 is not null), forcing a fallback that lost the premarket
    // move; use the fresh `last` print instead so (last - prevClose)/prevClose is
    // the true premarket gain. So: use dayClose only when it is a valid close.
    row.changePercent = normalizeDayChangePercent({
      price: dayClose != null && dayClose > 0 ? dayClose : last,
      dayOpen: row.dayOpen,
      prevClose: row.prevClose,
      changePercent: numOrNull(t.todaysChangePerc),
    });
    out.push(row);
  }
  return out;
}

/** Parse Polygon aggregates (candles) into OHLCV bars. */
export function parseAggregates(raw) {
  const results = raw?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    t: numOrNull(r.t),
    o: numOrNull(r.o),
    h: numOrNull(r.h),
    l: numOrNull(r.l),
    c: numOrNull(r.c),
    v: numOrNull(r.v) ?? 0,
  }));
}

/** Parse a Polygon options-chain snapshot into normalized contracts. */
/**
 * Whole CALENDAR days from today's trading day to an expiration date.
 *
 * WHY NOT A MILLISECOND DELTA. The previous form was
 * `Math.max(0, Math.round((Date.parse(expiration) - nowMs) / 86400000))`, which
 * compares an expiration parsed at UTC MIDNIGHT against a MID-SESSION clock. At
 * 12:24 ET the next day's expiration is 0.32 days away, rounds to 0, and a
 * genuine 1DTE contract reports as 0DTE. Measured on live NVDA and SPY chains:
 * every 2026-08-05 contract came back `dte = 0` on 2026-08-04.
 *
 * That shifted EVERY contract down one band in `dteOkFor`, so a strategy asking
 * for "1-7dte" was scored against contracts labelled "0dte". Expiration is a
 * DATE, not an instant, so the difference must be taken between two dates — in
 * US/Eastern, because that is the day the contract expires in.
 *
 * Both sides are parsed as UTC midnight, so the subtraction is an exact integer
 * number of days and cannot drift across a DST boundary.
 */
function calendarDte(expiration, nowMs) {
  if (!expiration) return null;
  const today = Date.parse(`${tradingDay(nowMs)}T00:00:00Z`);
  const exp = Date.parse(`${expiration}T00:00:00Z`);
  if (!Number.isFinite(today) || !Number.isFinite(exp)) return null;
  return Math.max(0, Math.round((exp - today) / 86400000));
}

export function parseOptionsSnapshot(raw, nowMs = Date.now()) {
  const results = raw?.results;
  if (!Array.isArray(results)) return [];
  const contracts = [];
  for (const r of results) {
    const d = r.details || {};
    const q = r.last_quote || {};
    const day = r.day || {};
    const greeks = r.greeks || {};
    const bid = numOrNull(q.bid);
    const ask = numOrNull(q.ask);
    let mid = numOrNull(q.midpoint);
    if (mid == null && bid != null && ask != null) mid = +(((bid + ask) / 2)).toFixed(4);
    const spreadPct = (bid != null && ask != null && mid && mid > 0)
      ? +(((ask - bid) / mid) * 100).toFixed(2)
      : null;
    const expiration = d.expiration_date || null;
    const dte = calendarDte(expiration, nowMs);
    contracts.push({
      optionSymbol: d.ticker || null,
      side: String(d.contract_type || "").toLowerCase(), // "call" | "put"
      strike: numOrNull(d.strike_price),
      expiration,
      dte,
      bid,
      ask,
      mid,
      last: numOrNull(day.close),
      // NULL IS NOT ZERO.
      //
      // These two carried `?? 0`, which turned "Polygon did not report open
      // interest for this contract" into "this contract has a measured open
      // interest of zero". Those are opposite claims: the first is an absence
      // of evidence, the second is evidence of total illiquidity. Downstream
      // liquidity gates, the alert score, and the owner-facing OI display all
      // read this field, and every one of them was being handed a fabricated
      // measurement it could not distinguish from a real one.
      //
      // Absence now survives to the consumers, which already handle null: the
      // liquidity gates below refuse an unavailable OI rather than passing it,
      // and a real reported 0 still reads as 0.
      volume: numOrNull(day.volume),
      openInterest: numOrNull(r.open_interest),
      iv: numOrNull(r.implied_volatility),
      delta: numOrNull(greeks.delta),
      gamma: numOrNull(greeks.gamma),
      theta: numOrNull(greeks.theta),
      vega: numOrNull(greeks.vega),
      underlyingPrice: numOrNull(r.underlying_asset?.price),
      underlyingProviderTimestamp: providerTimestampMs(r.underlying_asset?.last_updated),
      spreadPct,
      // Polygon returns these in NANOSECONDS (proven from production samples);
      // normalize at the boundary so every downstream consumer gets milliseconds.
      providerTimestamp: providerTimestampMs(q.last_updated) ?? providerTimestampMs(r.last_trade?.sip_timestamp) ?? providerTimestampMs(day.last_updated),
    });
  }
  return contracts;
}

const REQUEST_TIMEOUT_MS = Number(process.env.POLYGON_TIMEOUT_MS ?? 10000);

// ---------------------------------------------------------------------------
// Call meter + hard quota guard (audit P0-2).
// Every provider request passes through recordPolygonCall(). Counts are
// bucketed by ET trading day (mirrors tradingDay() in lib/trading-session.ts —
// kept local so this module stays dependency-free for direct node test
// imports) and by wall-clock minute. When a cap is hit the call is refused
// with a typed `quota_exceeded` error that callers surface like a 429.
// ---------------------------------------------------------------------------

const etDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/** YYYY-MM-DD in US/Eastern — the trading-day bucket key. */
function etTradingDay(ms = Date.now()) {
  return etDayFmt.format(new Date(ms));
}

function dailyCallCap() {
  return Number(process.env.POLYGON_DAILY_CALL_CAP ?? 200000);
}

function minuteCallCap() {
  return Number(process.env.POLYGON_MINUTE_CALL_CAP ?? 280);
}

function graderDailyReserve() {
  const n = Number(process.env.POLYGON_GRADER_DAILY_RESERVE ?? 5000);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5000;
}

/** Daily budget for discovery scans (total cap minus grader reserve). */
function discoveryDailyBudget(dCap) {
  if (dCap <= 0) return Infinity;
  return Math.max(0, dCap - graderDailyReserve());
}

/** Meter lives on globalThis so Next dev hot reloads don't reset the spend. */
function callMeter() {
  const g = globalThis;
  if (!g.__optiscanCallMeter) {
    g.__optiscanCallMeter = {
      day: etTradingDay(),
      callsToday: 0,
      lastMinuteBucket: Math.floor(Date.now() / 60000),
      callsThisMinute: 0,
      quotaExceededCount: 0,
      lastQuotaExceededAt: null,
      // Gate B7 per-minute partition state, rolled with the minute bucket.
      budget: emptyMinuteBudgetState(),
    };
  }
  // A meter created before B7 (or by an older deploy in the same process) has no
  // budget state; give it one rather than throwing on the hot path.
  if (!g.__optiscanCallMeter.budget) g.__optiscanCallMeter.budget = emptyMinuteBudgetState();
  return g.__optiscanCallMeter;
}

/** Roll day/minute buckets forward; resets counters on boundary crossings. */
function rollBuckets(m, nowMs) {
  const day = etTradingDay(nowMs);
  if (m.day !== day) {
    m.day = day;
    m.callsToday = 0;
  }
  const bucket = Math.floor(nowMs / 60000);
  if (m.lastMinuteBucket !== bucket) {
    m.lastMinuteBucket = bucket;
    m.callsThisMinute = 0;
    // Reserves are PER MINUTE: a new bucket restores every lane's guarantee in full.
    m.budget = emptyMinuteBudgetState();
  }
}

export class QuotaExceededError extends Error {
  constructor(kind, count, cap) {
    super(`quota_exceeded (${kind} cap): ${count}/${cap} Polygon calls — refusing request, treat like a 429 and back off`);
    this.name = "QuotaExceededError";
    this.code = "quota_exceeded";
    this.kind = kind; // "daily" | "minute"
  }
}

/**
 * Count one provider call against the day + minute budgets.
 * purpose: "discovery" | "grader" | "default"
 *   discovery — blocked when callsToday >= (dailyCap - POLYGON_GRADER_DAILY_RESERVE)
 *   grader — may use remaining daily cap including reserve bucket
 * Throws QuotaExceededError when a cap is exceeded.
 */
export function recordPolygonCall(nowMs = Date.now(), purpose = "default") {
  const m = callMeter();
  rollBuckets(m, nowMs);
  const dCap = dailyCallCap();
  const mCap = minuteCallCap();
  const discoveryBudget = discoveryDailyBudget(dCap);
  if (dCap > 0 && m.callsToday >= dCap) {
    m.quotaExceededCount += 1;
    m.lastQuotaExceededAt = nowMs;
    throw new QuotaExceededError("daily", m.callsToday, dCap);
  }
  if (purpose === "discovery" && dCap > 0 && m.callsToday >= discoveryBudget) {
    m.quotaExceededCount += 1;
    m.lastQuotaExceededAt = nowMs;
    throw new QuotaExceededError("daily_discovery", m.callsToday, discoveryBudget);
  }
  if (mCap > 0 && m.callsThisMinute >= mCap) {
    m.quotaExceededCount += 1;
    m.lastQuotaExceededAt = nowMs;
    throw new QuotaExceededError("minute", m.callsThisMinute, mCap);
  }
  // Gate B7 — per-minute partition. The global minute cap has room, but this
  // consumer may still be out of budget: it has spent its reserve AND the shared
  // pool is empty. Refusing here is what keeps a reserve reachable for the lanes
  // that have one, and it is deliberately checked LAST so it can never admit a
  // call the global caps have already refused.
  const consumer = currentProviderConsumer();
  const decision = decideBudget(consumer, m.budget, mCap);
  if (!decision.allowed) {
    m.quotaExceededCount += 1;
    m.lastQuotaExceededAt = nowMs;
    throw new QuotaExceededError("minute_partition", m.callsThisMinute, mCap);
  }
  commitBudget(consumer, m.budget, decision);
  m.callsToday += 1;
  m.callsThisMinute += 1;
}

/** Live spend stats for /api/health and the UI status bar. */
export function getCallStats(nowMs = Date.now()) {
  const m = callMeter();
  rollBuckets(m, nowMs);
  const dCap = dailyCallCap();
  const mCap = minuteCallCap();
  const discoveryBudget = discoveryDailyBudget(dCap);
  const discoveryPaused = dCap > 0 && m.callsToday >= discoveryBudget;
  return {
    tradingDay: m.day,
    callsToday: m.callsToday,
    callsThisMinute: m.callsThisMinute,
    lastMinuteBucket: m.lastMinuteBucket,
    dailyCap: dCap,
    minuteCap: mCap,
    graderDailyReserve: graderDailyReserve(),
    discoveryDailyBudget: discoveryBudget,
    discoveryPaused,
    quotaMode: dCap > 0 && m.callsToday >= dCap ? "hard_exhausted" : discoveryPaused ? "discovery_paused" : (mCap > 0 && m.callsThisMinute >= mCap) ? "minute_limited" : "ok",
    quotaExceeded: (dCap > 0 && m.callsToday >= dCap) || (mCap > 0 && m.callsThisMinute >= mCap),
    quotaExceededCount: m.quotaExceededCount,
    lastQuotaExceededAt: m.lastQuotaExceededAt,
    // Gate B7 — who holds what this minute. Exposed so an operator can read the
    // partition directly instead of inferring it from refusal counts, which is how
    // the dead grader reserve went unnoticed for as long as it did.
    minuteBudget: budgetSnapshot(m.budget, mCap),
  };
}

/** Test-only: reset the meter so unit tests are order-independent. */
export function __resetCallStatsForTest() {
  delete globalThis.__optiscanCallMeter;
  delete globalThis.__optiscanExactOptionSnapshots;
}

/** Fetch an absolute Polygon URL (used for pagination next_url too). */
/**
 * Every provider call in the codebase funnels through here, which makes this the only
 * honest place to meter spend. `account()` attributes the call to the ambient consumer
 * scope (lib/provider-context.ts) and persists it durably, so the daily total survives
 * deploys and "who saturated the minute cap" is answerable. Accounting never throws.
 */
/**
 * How many records a response carried.
 *
 * `results` is an ARRAY on list endpoints and a bare OBJECT on single-resource ones —
 * notably `/v3/snapshot/options/{underlying}/{occ}`, the exact-OCC read. Counting only
 * arrays scored every single-contract fetch as zero records, which is why production
 * reported `asymmetry_mark` returning 0 records across 263 requests: the lane was
 * working, the meter was blind. Left uncorrected this would have made the move onto the
 * exact-OCC path (a5f5976) read as "marking stopped returning data".
 */
function countResults(json) {
  const r = json?.results;
  if (Array.isArray(r)) return r.length;
  if (r && typeof r === "object") return 1;
  if (Array.isArray(json?.tickers)) return json.tickers.length;
  return null;
}

async function polyFetch(url) {
  const endpoint = url.pathname;
  const account = (status, extra = {}) => {
    try {
      emitProviderRequest({ endpoint, status, ...extra });
    } catch { /* accounting must never break a market-data path */ }
  };
  try {
    recordPolygonCall();
  } catch (err) {
    // Refused by OUR budget, not by the provider — recorded as a quota block so it is
    // never confused with missing market data.
    account("quota_block");
    throw err;
  }
  url.searchParams.set("apiKey", getPolygonKey());
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const latencyMs = Date.now() - started;
    recordProviderFailure("polygon", err?.message ?? String(err), latencyMs);
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    account(timedOut ? "timeout" : "provider_error", { latencyMs });
    if (timedOut) {
      throw new Error(`polygon timeout after ${REQUEST_TIMEOUT_MS}ms: ${url.pathname}`);
    }
    throw err;
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    recordProviderFailure("polygon", `polygon ${res.status}: ${body.slice(0, 200)}`, latencyMs);
    account(res.status === 429 ? "http_429" : "provider_error", { latencyMs });
    const hint = res.status === 429 ? " (rate limited — slow the poll interval or shrink RADAR_SHORTLIST)" : "";
    throw new Error(`polygon ${res.status}${hint}: ${body.slice(0, 200)}`);
  }
  recordProviderSuccess("polygon", latencyMs);
  const json = await res.json();
  account("ok", {
    latencyMs,
    recordsReturned: countResults(json),
    paginated: Boolean(json?.next_url),
  });
  return json;
}

async function polyRequest(pathname, params = {}) {
  const url = new URL(`${POLYGON_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  return polyFetch(url);
}

function providerUnavailable(extra = {}) {
  return {
    available: false,
    note: "No POLYGON_API_KEY set — add a Polygon/Massive key to enable this provider",
    source: "polygon",
    ...extra,
  };
}

/** Bulk snapshot for specific tickers. */
export async function fetchBulkQuotes(symbols = []) {
  const list = (symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean);
  if (!list.length) return { available: true, quotes: [], source: "polygon" };
  if (!hasPolygon()) return providerUnavailable({ quotes: [] });
  try {
    const raw = await polyRequest("/v2/snapshot/locale/us/markets/stocks/tickers", { tickers: list.join(",") });
    const quotes = parseSnapshotTickers(raw.tickers);
    for (const q of quotes) recordDataSample({ symbol: q.symbol, kind: "stock_quote", providerTimestamp: q.providerTimestamp });
    for (const sym of list) if (!quotes.some((q) => q.symbol === sym)) recordNoData(sym, "stock_quote");
    return { available: true, quotes, source: "polygon" };
  } catch (err) {
    const msg = String(err?.message ?? err);
    // One shared failure must NOT stamp RATE_LIMITED onto every symbol in the batch
    // (that floods System Health). Provider-level failure is enough; scanner backoff
    // still keys off `note` containing 429 / quota_exceeded.
    const rateLimited = /\b429\b|quota_exceeded|rate.?limit/i.test(msg);
    if (!rateLimited) {
      for (const sym of list) recordNoData(sym, "stock_quote", msg);
    } else {
      recordProviderFailure("polygon", msg);
    }
    return { available: false, quotes: [], note: msg, source: "polygon" };
  }
}

/**
 * Whole-market snapshot: EVERY US-listed stock in ONE call (no ticker filter).
 * Shared process TTL + inflight dedupe so scanner discovery and options monitor
 * never double-hit the same endpoint within the window.
 */
const MARKET_SNAP_TTL_MS = Math.max(1000, Number(process.env.POLYGON_MARKET_SNAP_TTL_MS ?? 5000) || 5000);

/** The endpoint label for the market snapshot, shared by the fetch and its avoidance events. */
const MARKET_SNAP_ENDPOINT = "/v2/snapshot/locale/us/markets/stocks/tickers";

/**
 * Record a request we did NOT make. Never counted as a provider request — the whole point
 * is that it was avoided — but counted so the saving is visible.
 *
 * These two counters read ZERO across all 48,135 requests of the 2026-08-03 session, which
 * made the report say caching and dedup never happen. Both do happen; neither was ever
 * emitted, because a cache hit returns before `polyFetch` and `polyFetch` was the only
 * place that metered anything. "No instrumentation" and "no caching" look identical in a
 * report and have opposite fixes.
 */
function accountAvoided(endpoint, status) {
  try {
    emitProviderRequest({ endpoint, status });
  } catch { /* accounting must never break a market-data path */ }
}

export async function fetchMarketSnapshot() {
  if (!hasPolygon()) return providerUnavailable({ quotes: [] });
  const g = globalThis;
  const now = Date.now();
  const cached = g.__optiscanMarketSnap;
  if (cached && now - cached.at < MARKET_SNAP_TTL_MS && cached.result) {
    accountAvoided(MARKET_SNAP_ENDPOINT, "cache_hit");
    return cached.result;
  }
  if (cached?.inflight) {
    accountAvoided(MARKET_SNAP_ENDPOINT, "dedup_avoided");
    return cached.inflight;
  }

  const inflight = (async () => {
    try {
      const raw = await polyRequest("/v2/snapshot/locale/us/markets/stocks/tickers");
      const quotes = parseSnapshotTickers(raw.tickers);
      const result = { available: true, quotes, source: "polygon" };
      g.__optiscanMarketSnap = { at: Date.now(), result, inflight: null };
      return result;
    } catch (err) {
      const result = { available: false, quotes: [], note: err.message, source: "polygon" };
      // Do not cache failures into the happy TTL — clear inflight so retry can proceed.
      g.__optiscanMarketSnap = { at: 0, result: null, inflight: null };
      return result;
    }
  })();

  g.__optiscanMarketSnap = { ...(cached || {}), at: cached?.at ?? 0, result: cached?.result ?? null, inflight };
  return inflight;
}

/** Whole-market top movers (Polygon's edge over quote-by-symbol providers). */
export async function fetchTopMovers(direction = "gainers", limit = 20) {
  if (!hasPolygon()) return { available: false, quotes: [], note: "No POLYGON_API_KEY", source: "polygon" };
  const dir = direction === "losers" ? "losers" : "gainers";
  try {
    const raw = await polyRequest(`/v2/snapshot/locale/us/markets/stocks/${dir}`);
    const quotes = parseSnapshotTickers(raw.tickers).slice(0, limit);
    for (const q of quotes) recordDataSample({ symbol: q.symbol, kind: "stock_quote", providerTimestamp: q.providerTimestamp });
    return { available: true, quotes, source: "polygon" };
  } catch (err) {
    return { available: false, quotes: [], note: err.message, source: "polygon" };
  }
}

export async function fetchQuote(symbol) {
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return { available: false, quote: null, note: "No symbol" };
  if (!hasPolygon()) return providerUnavailable({ quote: null });
  try {
    const raw = await polyRequest(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}`);
    const quotes = parseSnapshotTickers(raw.ticker ? [raw.ticker] : []);
    if (quotes[0]) recordDataSample({ symbol: sym, kind: "stock_quote", providerTimestamp: quotes[0].providerTimestamp });
    else recordNoData(sym, "stock_quote");
    return { available: true, quote: quotes[0] || null, source: "polygon" };
  } catch (err) {
    recordNoData(sym, "stock_quote", err.message);
    return { available: false, quote: null, note: err.message, source: "polygon" };
  }
}

export async function fetchCandles(symbol, opts = {}) {
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return { available: false, bars: [], note: "No symbol" };
  if (!hasPolygon()) return providerUnavailable({ bars: [] });
  const mult = opts.resolution || "5";
  const timespan = opts.timespan || "minute";
  const days = opts.days || 2;
  const to = opts.to || new Date().toISOString().slice(0, 10);
  const from = opts.from || new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const fromParam = typeof opts.from === "string" && opts.from.includes("T") ? opts.from : from;
  const toParam = typeof opts.to === "string" && opts.to.includes("T") ? opts.to : to;
  try {
    // limit passthrough (additive): historical replay requests up to Polygon's 50k max so a
    // windowed chunk is never silently truncated. Default preserves the prior 5000 behavior.
    const reqLimit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : (opts.countback ? Math.max(opts.countback, 120) : 5000);
    const raw = await polyRequest(`/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${mult}/${timespan}/${fromParam}/${toParam}`, {
      adjusted: "true",
      sort: "asc",
      limit: reqLimit,
    });
    let bars = parseAggregates(raw);
    if (opts.countback && bars.length > opts.countback) bars = bars.slice(-opts.countback);
    const latest = bars[bars.length - 1];
    if (latest?.t) recordDataSample({ symbol: sym, kind: "one_minute_candle", providerTimestamp: latest.t });
    else recordNoData(sym, "one_minute_candle");
    // resultCap: true when the provider returned exactly the requested limit (possible truncation).
    return { available: true, bars, source: "polygon", resolution: mult, resultCap: bars.length >= reqLimit };
  } catch (err) {
    recordNoData(sym, "one_minute_candle", err.message);
    return { available: false, bars: [], note: err.message, source: "polygon" };
  }
}

/**
 * Fetch an option chain snapshot for an underlying, filtered by side + DTE.
 *
 * Returns a DISCRIMINATED outcome, never a bare array. `contracts.length === 0`
 * cannot tell a successful empty response from a budget refusal, a missing API
 * key, a timeout or a real failure — and downstream every one of them was being
 * recorded as `PROVIDER_ERROR`, which was 53% of the contract funnel.
 *
 * `outcome` is one of: CONTRACTS_AVAILABLE · NO_CONTRACTS_IN_REQUESTED_RANGE ·
 * CHAIN_TRUNCATED_BEFORE_RANGE · PROVIDER_QUOTA_EXCEEDED · PROVIDER_TIMEOUT ·
 * PROVIDER_FAILURE · PROVIDER_CONFIGURATION_MISSING · PROVIDER_INVALID_RESPONSE.
 *
 * No provider secret is included: `note` carries the error message only, and no
 * request URL (which bears the key) is ever returned.
 *
 * @returns {Promise<{available:boolean, outcome:string, contracts:Array,
 *   quotaExceeded:boolean, configurationMissing:boolean, truncated:boolean,
 *   pagesRequested:number, pagesReceived:number, requestedDteMin:number|null,
 *   requestedDteMax:number|null, requestedExpirationGte:string|null,
 *   requestedExpirationLte:string|null, expirationsCovered:string[],
 *   note?:string, source:string, underlying:string|null}>}
 */
export async function fetchOptionChain(underlying, opts = {}) {
  const sym = String(underlying || "").toUpperCase();
  const base = {
    contracts: [], quotaExceeded: false, configurationMissing: false,
    truncated: false, pagesRequested: 0, pagesReceived: 0,
    requestedDteMin: null, requestedDteMax: null,
    requestedExpirationGte: null, requestedExpirationLte: null,
    expirationsCovered: [], source: "polygon", underlying: sym || null,
  };
  if (!sym) {
    return { ...base, available: false, outcome: "PROVIDER_INVALID_RESPONSE", note: "No underlying symbol" };
  }
  if (!hasPolygon()) {
    // Missing configuration is not a market-data result. It must never be
    // reported as the provider having nothing to say about this underlying.
    return {
      ...base,
      available: false,
      note: providerUnavailable().note,
      configurationMissing: true,
      outcome: "PROVIDER_CONFIGURATION_MISSING",
    };
  }
  const dteMin = Number(opts.dteMin ?? 3);
  const dteMax = Number(opts.dteMax ?? 45);
  // Polygon caps each snapshot page at 250 contracts; follow next_url so wide
  // chains (SPY, TSLA, ...) aren't silently truncated. maxPages bounds the API
  // cost per symbol (4 pages = up to 1000 contracts = up to 4 calls).
  const maxPages = Math.max(1, Number(opts.maxPages ?? process.env.OPTIONS_CHAIN_MAX_PAGES ?? 4));
  const gte = isoDaysFromNow(dteMin);
  const lte = isoDaysFromNow(dteMax);
  const params = { limit: 250, "expiration_date.gte": gte, "expiration_date.lte": lte };
  if (opts.side === "call" || opts.side === "put") params.contract_type = opts.side;
  /**
   * BOUNDED STRIKES — the fix for a truncation that masqueraded as market fact.
   *
   * Polygon orders snapshot results by option ticker, and an OCC encodes the
   * expiration immediately after the underlying, so pages arrive in expiration
   * order. On a dense underlying that exhausts the page budget inside the
   * NEAREST expirations: measured live on 2026-08-04, SPY and QQQ returned 500
   * contracts across 2 pages and every one of them expired 08-04 or 08-05. The
   * 0-14 DTE window we asked for was never actually sampled past day one.
   *
   * Every strategy in the catalog selects on |delta| 0.30-0.65 near the money,
   * so the far wings were paid for and discarded. Bounding strikes around spot
   * buys expiration coverage at ZERO extra requests — the same page budget now
   * reaches further out in time instead of further out in strike. Verified:
   * NVDA went from 4 expirations (truncated) to the complete 0-14 window in ONE
   * page; SPY/QQQ gained the 1-7DTE band they had never once reached.
   *
   * Opt-in via `strikeAroundPct`, so callers that genuinely want the wings
   * (chain-activity scans) are unaffected.
   */
  const spot = Number(opts.underlyingPrice);
  const aroundPct = Number(opts.strikeAroundPct);
  if (Number.isFinite(spot) && spot > 0 && Number.isFinite(aroundPct) && aroundPct > 0) {
    params["strike_price.gte"] = +(spot * (1 - aroundPct)).toFixed(2);
    params["strike_price.lte"] = +(spot * (1 + aroundPct)).toFixed(2);
  }
  try {
    let raw = await polyRequest(`/v3/snapshot/options/${encodeURIComponent(sym)}`, params);
    let contracts = parseOptionsSnapshot(raw);
    let pages = 1;
    while (raw?.next_url && pages < maxPages) {
      raw = await polyFetch(new URL(raw.next_url));
      contracts = contracts.concat(parseOptionsSnapshot(raw));
      pages += 1;
    }
    // The provider still had more to give when the page budget ran out. This is
    // OUR limit, not a fact about the market, and the caller must be able to
    // tell the difference before concluding anything from an empty band.
    const truncated = Boolean(raw?.next_url);
    contracts = contracts.filter((c) => c.dte == null || (c.dte >= dteMin && c.dte <= dteMax));
    if (opts.minOpenInterest) contracts = contracts.filter((c) => (c.openInterest ?? 0) >= opts.minOpenInterest);
    const latestTs = contracts.map((c) => c.providerTimestamp).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
    if (contracts.length) {
      recordDataSample({ symbol: sym, kind: "options_chain", providerTimestamp: latestTs });
      recordDataSample({ symbol: sym, kind: "options_quote", providerTimestamp: latestTs });
      recordDataSample({ symbol: sym, kind: "greeks", providerTimestamp: latestTs });
    } else {
      const note = `no option contracts returned for ${dteMin}-${dteMax} DTE`;
      recordNoData(sym, "options_chain", note);
      recordNoData(sym, "options_quote", note);
      recordNoData(sym, "greeks", note);
    }
    const expirationsCovered = [...new Set(contracts.map((c) => c.expiration).filter(Boolean))].sort();
    return {
      ...base,
      available: true,
      contracts,
      truncated,
      pagesRequested: maxPages,
      pagesReceived: pages,
      requestedDteMin: dteMin,
      requestedDteMax: dteMax,
      requestedExpirationGte: gte,
      requestedExpirationLte: lte,
      expirationsCovered,
      // A successful response that carried nothing in range is NOT a failure. It
      // is only an honest "nothing here" when we also saw the whole window —
      // otherwise the emptiness is an artifact of our own page budget.
      outcome: contracts.length > 0
        ? "CONTRACTS_AVAILABLE"
        : truncated ? "CHAIN_TRUNCATED_BEFORE_RANGE" : "NO_CONTRACTS_IN_REQUESTED_RANGE",
    };
  } catch (err) {
    // A budget refusal is not a provider failure and neither is a timeout. They
    // are separated here for the same reason `fetchOptionContractSnapshot`
    // separates them: collapsing all three is what made our own admission
    // control read as the provider's fault in 53% of the funnel.
    const quotaExceeded = err?.code === "quota_exceeded";
    const timedOut = err?.name === "AbortError" || err?.code === "timeout";
    if (!quotaExceeded) {
      recordNoData(sym, "options_chain", err.message);
      recordNoData(sym, "options_quote", err.message);
      recordNoData(sym, "greeks", err.message);
    }
    return {
      ...base,
      available: false,
      note: err.message,
      quotaExceeded,
      requestedDteMin: dteMin,
      requestedDteMax: dteMax,
      requestedExpirationGte: gte,
      requestedExpirationLte: lte,
      pagesRequested: maxPages,
      outcome: quotaExceeded
        ? "PROVIDER_QUOTA_EXCEEDED"
        : timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_FAILURE",
    };
  }
}

/**
 * Snapshot for ONE exact contract. One request, no pagination, no chain scan.
 *
 * WHY THIS EXISTS. Reading a single contract's quote by fetching its whole
 * chain and searching the result costs up to OPTIONS_CHAIN_MAX_PAGES requests
 * and returns up to 750 contracts to use one of them. At research scale — a few
 * hundred open cases re-observed every minute — that is over a thousand
 * requests a minute against a 280/minute cap, which exhausts the shared daily
 * budget early and then fails every subsequent research read.
 *
 * `quotaExceeded` is reported SEPARATELY from `available`. A budget refusal and
 * a contract with no market are completely different facts, and collapsing them
 * is what made a provider outage look like an absence of liquidity.
 *
 * @returns {Promise<{available:boolean, contract:object|null, quotaExceeded:boolean,
 *   cacheHit:boolean, dedupHit:boolean, note?:string, source:string}>}
 */
const EXACT_OPTION_SNAPSHOT_ENDPOINT = "/v3/snapshot/options/:sym/:occ";
const EXACT_OPTION_SNAPSHOT_CACHE_MAX = 5_000;

function exactOptionSnapshotCacheTtlMs() {
  const n = Number(process.env.OPTIONS_EXACT_QUOTE_CACHE_TTL_MS ?? 2_000);
  return Number.isFinite(n) ? Math.max(0, Math.min(15_000, Math.floor(n))) : 2_000;
}

function exactOptionSnapshotCache() {
  const g = globalThis;
  if (!g.__optiscanExactOptionSnapshots) g.__optiscanExactOptionSnapshots = new Map();
  return g.__optiscanExactOptionSnapshots;
}

function pruneExactOptionSnapshotCache(cache, nowMs, ttlMs) {
  if (cache.size <= EXACT_OPTION_SNAPSHOT_CACHE_MAX) return;
  for (const [key, entry] of cache) {
    if (!entry?.inflight && (!entry?.result || nowMs - Number(entry.at ?? 0) >= ttlMs)) cache.delete(key);
  }
  if (cache.size <= EXACT_OPTION_SNAPSHOT_CACHE_MAX) return;
  const completed = [...cache.entries()]
    .filter(([, entry]) => !entry?.inflight)
    .sort((a, b) => Number(a[1]?.at ?? 0) - Number(b[1]?.at ?? 0));
  for (const [key] of completed) {
    cache.delete(key);
    if (cache.size <= EXACT_OPTION_SNAPSHOT_CACHE_MAX) break;
  }
}

export async function fetchOptionContractSnapshot(underlying, optionSymbol) {
  const sym = String(underlying || "").toUpperCase();
  const occ = String(optionSymbol || "").toUpperCase();
  if (!sym || !occ) {
    return { available: false, contract: null, quotaExceeded: false, note: "missing underlying or option symbol", source: "polygon" };
  }
  if (!hasPolygon()) return { ...providerUnavailable({ contract: null }), quotaExceeded: false };
  const cache = exactOptionSnapshotCache();
  const key = `${sym}|${occ}`;
  const ttlMs = exactOptionSnapshotCacheTtlMs();
  const nowMs = Date.now();
  const cached = cache.get(key);
  if (ttlMs > 0 && cached?.result && nowMs - cached.at < ttlMs) {
    accountAvoided(EXACT_OPTION_SNAPSHOT_ENDPOINT, "cache_hit");
    return { ...cached.result, cacheHit: true, dedupHit: false };
  }
  if (cached?.inflight) {
    accountAvoided(EXACT_OPTION_SNAPSHOT_ENDPOINT, "dedup_avoided");
    return cached.inflight.then((result) => ({ ...result, cacheHit: false, dedupHit: true }));
  }

  const inflight = (async () => {
    try {
      const raw = await polyRequest(`/v3/snapshot/options/${encodeURIComponent(sym)}/${encodeURIComponent(occ)}`);
      // The single-contract response nests one object under `results`; reuse the
      // chain parser so field mapping can never drift between the two paths.
      const [contract] = parseOptionsSnapshot({ results: raw?.results ? [raw.results] : [] });
      if (!contract) {
        recordNoData(sym, "options_quote", `no snapshot for ${occ}`);
        return { available: true, contract: null, quotaExceeded: false, note: `no snapshot returned for ${occ}`, source: "polygon", cacheHit: false, dedupHit: false };
      }
      recordDataSample({ symbol: sym, kind: "options_quote", providerTimestamp: contract.providerTimestamp });
      return { available: true, contract, quotaExceeded: false, source: "polygon", cacheHit: false, dedupHit: false };
    } catch (err) {
      // A quota refusal is NOT a missing quote. Surfaced as its own flag so the
      // caller can record PROVIDER_BUDGET rather than "this contract had no market".
      const quotaExceeded = err?.code === "quota_exceeded";
      if (!quotaExceeded) recordNoData(sym, "options_quote", err.message);
      return { available: false, contract: null, quotaExceeded, note: err.message, source: "polygon", cacheHit: false, dedupHit: false };
    }
  })();
  cache.set(key, { at: cached?.at ?? 0, result: cached?.result ?? null, inflight });
  const result = await inflight;
  if (result.available) cache.set(key, { at: Date.now(), result, inflight: null });
  else cache.delete(key);
  pruneExactOptionSnapshotCache(cache, nowMs, ttlMs);
  return result;
}

/**
 * The expiration-query bound N days from today, as a US/Eastern calendar date.
 *
 * Anchored on the ET trading day for the same reason `calendarDte` is: the UTC
 * form rolled to tomorrow's date after 20:00 ET, so a late-evening scan asked
 * the provider for a window that excluded the very next session's expirations.
 * It must agree with `calendarDte` exactly, or the range we REQUEST and the DTE
 * we COMPUTE disagree at the edges.
 */
function isoDaysFromNow(days) {
  const today = Date.parse(`${tradingDay(Date.now())}T00:00:00Z`);
  return new Date(today + Number(days) * 86400000).toISOString().slice(0, 10);
}

/** Parse Polygon news results into the shape catalysts.js consumes. */
export function parseNews(raw) {
  const results = raw?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    title: r?.title ?? "",
    publishedAt: r?.published_utc ?? null,
    publisher: r?.publisher?.name ?? null,
    url: r?.article_url ?? null,
  }));
}

/**
 * Recent news for a ticker (Benzinga-sourced via Polygon, same API key).
 * Used ONLY for catalyst classification in Alert Lab — costs 1 call per
 * lookup, so callers cache per ticker (see alert capture in scan-core).
 */
export async function fetchNews(symbol, opts = {}) {
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return { available: false, items: [], note: "No symbol", source: "polygon" };
  if (!hasPolygon()) return providerUnavailable({ items: [] });
  const days = Number(opts.days ?? 3);
  try {
    const raw = await polyRequest("/v2/reference/news", {
      ticker: sym,
      order: "desc",
      limit: Number(opts.limit ?? 10),
      "published_utc.gte": new Date(Date.now() - days * 86400000).toISOString(),
    });
    const items = parseNews(raw);
    const latest = items.map((i) => i.publishedAt).filter(Boolean).sort().at(-1) ?? null;
    if (items.length) recordDataSample({ symbol: sym, kind: "news", providerTimestamp: latest });
    else recordNoData(sym, "news", "no recent catalysts returned");
    return { available: true, items, source: "polygon" };
  } catch (err) {
    recordNoData(sym, "news", err.message);
    return { available: false, items: [], note: err.message, source: "polygon" };
  }
}

/** Look up a company/ETF name from Polygon's reference endpoint. */
export async function fetchTickerName(symbol) {
  const sym = String(symbol || "").toUpperCase();
  if (!sym || !hasPolygon()) return null;
  try {
    const raw = await polyRequest(`/v3/reference/tickers/${encodeURIComponent(sym)}`);
    return raw?.results?.name || null;
  } catch {
    return null;
  }
}
