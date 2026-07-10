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

const POLYGON_BASE = process.env.POLYGON_API_URL || "https://api.polygon.io";

export function getPolygonKey() {
  return process.env.POLYGON_API_KEY || process.env.MASSIVE_API_KEY || "";
}

export function hasPolygon() {
  return Boolean(getPolygonKey());
}

const numOrNull = (v) => (v == null || v === "" ? null : Number(v));

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
    const row = {
      symbol: String(t.ticker).toUpperCase(),
      last,
      price: last,
      change: numOrNull(t.todaysChange),
      volume: numOrNull(day.v) ?? numOrNull(min.av) ?? 0,
      dayOpen: numOrNull(day.o),
      dayClose,
      dayHigh: numOrNull(day.h),
      dayLow: numOrNull(day.l),
      prevClose: numOrNull(t.prevDay?.c),
      bid: null,
      ask: null,
      mid: last,
      providerTimestamp: numOrNull(t.lastTrade?.t) ?? numOrNull(min.t) ?? numOrNull(day.t),
    };
    row.changePercent = normalizeDayChangePercent({
      price: dayClose ?? last,
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
    const dte = expiration ? Math.max(0, Math.round((Date.parse(expiration) - nowMs) / 86400000)) : null;
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
      volume: numOrNull(day.volume) ?? 0,
      openInterest: numOrNull(r.open_interest) ?? 0,
      iv: numOrNull(r.implied_volatility),
      delta: numOrNull(greeks.delta),
      gamma: numOrNull(greeks.gamma),
      theta: numOrNull(greeks.theta),
      vega: numOrNull(greeks.vega),
      underlyingPrice: numOrNull(r.underlying_asset?.price),
      spreadPct,
      providerTimestamp: numOrNull(q.last_updated) ?? numOrNull(r.last_trade?.sip_timestamp) ?? numOrNull(day.last_updated),
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
    };
  }
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
 * Throws QuotaExceededError (code "quota_exceeded") when a cap is exceeded —
 * the request must NOT be made. Cap <= 0 disables that cap.
 */
export function recordPolygonCall(nowMs = Date.now()) {
  const m = callMeter();
  rollBuckets(m, nowMs);
  const dCap = dailyCallCap();
  const mCap = minuteCallCap();
  if (dCap > 0 && m.callsToday >= dCap) {
    m.quotaExceededCount += 1;
    m.lastQuotaExceededAt = nowMs;
    throw new QuotaExceededError("daily", m.callsToday, dCap);
  }
  if (mCap > 0 && m.callsThisMinute >= mCap) {
    m.quotaExceededCount += 1;
    m.lastQuotaExceededAt = nowMs;
    throw new QuotaExceededError("minute", m.callsThisMinute, mCap);
  }
  m.callsToday += 1;
  m.callsThisMinute += 1;
}

/** Live spend stats for /api/health and the UI status bar. */
export function getCallStats(nowMs = Date.now()) {
  const m = callMeter();
  rollBuckets(m, nowMs);
  const dCap = dailyCallCap();
  const mCap = minuteCallCap();
  return {
    tradingDay: m.day,
    callsToday: m.callsToday,
    callsThisMinute: m.callsThisMinute,
    lastMinuteBucket: m.lastMinuteBucket,
    dailyCap: dCap,
    minuteCap: mCap,
    quotaExceeded: (dCap > 0 && m.callsToday >= dCap) || (mCap > 0 && m.callsThisMinute >= mCap),
    quotaExceededCount: m.quotaExceededCount,
    lastQuotaExceededAt: m.lastQuotaExceededAt,
  };
}

/** Test-only: reset the meter so unit tests are order-independent. */
export function __resetCallStatsForTest() {
  delete globalThis.__optiscanCallMeter;
}

/** Fetch an absolute Polygon URL (used for pagination next_url too). */
async function polyFetch(url) {
  recordPolygonCall();
  url.searchParams.set("apiKey", getPolygonKey());
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    recordProviderFailure("polygon", err?.message ?? String(err), Date.now() - started);
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(`polygon timeout after ${REQUEST_TIMEOUT_MS}ms: ${url.pathname}`);
    }
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    recordProviderFailure("polygon", `polygon ${res.status}: ${body.slice(0, 200)}`, Date.now() - started);
    const hint = res.status === 429 ? " (rate limited — slow the poll interval or shrink RADAR_SHORTLIST)" : "";
    throw new Error(`polygon ${res.status}${hint}: ${body.slice(0, 200)}`);
  }
  recordProviderSuccess("polygon", Date.now() - started);
  return res.json();
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
    for (const sym of list) recordNoData(sym, "stock_quote", err.message);
    return { available: false, quotes: [], note: err.message, source: "polygon" };
  }
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
    const raw = await polyRequest(`/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${mult}/${timespan}/${fromParam}/${toParam}`, {
      adjusted: "true",
      sort: "asc",
      limit: opts.countback ? Math.max(opts.countback, 120) : 5000,
    });
    let bars = parseAggregates(raw);
    if (opts.countback && bars.length > opts.countback) bars = bars.slice(-opts.countback);
    const latest = bars[bars.length - 1];
    if (latest?.t) recordDataSample({ symbol: sym, kind: "one_minute_candle", providerTimestamp: latest.t });
    else recordNoData(sym, "one_minute_candle");
    return { available: true, bars, source: "polygon", resolution: mult };
  } catch (err) {
    recordNoData(sym, "one_minute_candle", err.message);
    return { available: false, bars: [], note: err.message, source: "polygon" };
  }
}

/**
 * Fetch an option chain snapshot for an underlying, filtered by side + DTE.
 * @returns {Promise<{available:boolean, contracts:Array, note?:string, source:string}>}
 */
export async function fetchOptionChain(underlying, opts = {}) {
  const sym = String(underlying || "").toUpperCase();
  if (!sym) return { available: false, contracts: [], note: "No underlying symbol", source: "polygon" };
  if (!hasPolygon()) return providerUnavailable({ contracts: [] });
  const dteMin = Number(opts.dteMin ?? 3);
  const dteMax = Number(opts.dteMax ?? 45);
  // Polygon caps each snapshot page at 250 contracts; follow next_url so wide
  // chains (SPY, TSLA, ...) aren't silently truncated. maxPages bounds the API
  // cost per symbol (4 pages = up to 1000 contracts = up to 4 calls).
  const maxPages = Math.max(1, Number(opts.maxPages ?? process.env.OPTIONS_CHAIN_MAX_PAGES ?? 4));
  const params = { limit: 250, "expiration_date.gte": isoDaysFromNow(dteMin), "expiration_date.lte": isoDaysFromNow(dteMax) };
  if (opts.side === "call" || opts.side === "put") params.contract_type = opts.side;
  try {
    let raw = await polyRequest(`/v3/snapshot/options/${encodeURIComponent(sym)}`, params);
    let contracts = parseOptionsSnapshot(raw);
    let pages = 1;
    while (raw?.next_url && pages < maxPages) {
      raw = await polyFetch(new URL(raw.next_url));
      contracts = contracts.concat(parseOptionsSnapshot(raw));
      pages += 1;
    }
    contracts = contracts.filter((c) => c.dte == null || (c.dte >= dteMin && c.dte <= dteMax));
    if (opts.minOpenInterest) contracts = contracts.filter((c) => (c.openInterest ?? 0) >= opts.minOpenInterest);
    const latestTs = contracts.map((c) => c.providerTimestamp).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
    if (contracts.length) {
      recordDataSample({ symbol: sym, kind: "options_chain", providerTimestamp: latestTs });
      recordDataSample({ symbol: sym, kind: "options_quote", providerTimestamp: latestTs });
      recordDataSample({ symbol: sym, kind: "greeks", providerTimestamp: latestTs });
    } else {
      recordNoData(sym, "options_chain");
      recordNoData(sym, "options_quote");
      recordNoData(sym, "greeks");
    }
    return { available: true, contracts, source: "polygon", underlying: sym };
  } catch (err) {
    recordNoData(sym, "options_chain", err.message);
    recordNoData(sym, "options_quote", err.message);
    recordNoData(sym, "greeks", err.message);
    return { available: false, contracts: [], note: err.message, source: "polygon", underlying: sym };
  }
}

function isoDaysFromNow(days) {
  return new Date(Date.now() + Number(days) * 86400000).toISOString().slice(0, 10);
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
