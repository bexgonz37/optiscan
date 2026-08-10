/**
 * adapters.ts — the seam between the provider fetchers and the durable store.
 *
 * The ingestion runner takes its fetchers as injected dependencies, which made it
 * testable and left it inert: nothing in production supplied them. This module supplies
 * them, from the SAME provider and auth infrastructure the rest of OptiScan already
 * trusts (`massive-historical.ts` + `RequestAccountant`), rather than opening a second
 * path to the provider that would have its own key handling and its own budget.
 *
 * ── What an adapter is responsible for ───────────────────────────────────────
 *
 * Exactly two things: shape translation, and EVIDENCE LABELLING.
 *
 * A quote row becomes a quote row. A trade row becomes a trade row. There is deliberately
 * no adapter that turns trades into quotes, no midpoint synthesis, and no carry-forward
 * of a stale bid/ask across a gap. If a period has only trades, the store gets trades
 * and the replay engine reports no executable quote — which is the truth, and is what
 * stops a backtest from filling at a price nobody was showing.
 *
 * ── Truncation is not emptiness ──────────────────────────────────────────────
 *
 * `HistoricalResult.truncated` means the provider returned exactly the requested limit,
 * so the window is NOT covered. On a liquid contract 5,000 NBBO rows can span under a
 * minute. An adapter that silently returned that prefix would let a "peak premium" be
 * the peak of an arbitrary slice, so truncation is surfaced and the caller records the
 * window as incomplete rather than done.
 */
import {
  fetchContractUniverse,
  fetchHistoricalBars,
  fetchHistoricalOptionQuotes,
  fetchHistoricalOptionTrades,
  historicalAvailable,
  type HistoricalDeps,
} from "../asymmetry/historical/massive-historical.ts";
import { RequestAccountant, resolveRequestCaps } from "../asymmetry/historical/request-accounting.ts";
import type { BarRow, ContractRefRow, OptionQuoteRow, OptionTradeRow, Timeframe } from "./store.ts";

export const ADAPTER_VERSION = "HIST_ADAPTER_V1" as const;

/** Where a row came from and WHAT KIND of observation it is. Never inferred downstream. */
export const EVIDENCE_SOURCE = {
  underlyingAggregate: "provider:v2/aggs:underlying",
  optionQuote: "provider:v3/quotes:NBBO",
  optionTrade: "provider:v3/trades:PRINT",
  contractReference: "provider:v3/reference:expired-inclusive",
} as const;

export interface AdapterResult<T> {
  rows: T[];
  /** The provider returned the full limit, so this window is NOT covered. */
  truncated: boolean;
  /** The provider confirmed zero rows. Distinct from a failure that produced zero. */
  confirmedEmpty: boolean;
  blocked: boolean;
  note: string;
}

/**
 * Build the shared provider deps.
 *
 * One accountant per run, deliberately: two concurrent runs must not silently share a
 * budget, and the constructor is the only place caps are resolved.
 */
export function buildHistoricalDeps(
  env: NodeJS.ProcessEnv = process.env,
  opts: { accountant?: RequestAccountant; fetchImpl?: typeof fetch; nowMs?: () => number } = {},
): HistoricalDeps {
  return {
    accountant: opts.accountant ?? new RequestAccountant(resolveRequestCaps(env)),
    env,
    fetchImpl: opts.fetchImpl,
    nowMs: opts.nowMs,
  };
}

export function historicalProviderAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return historicalAvailable(env);
}

const tfToProvider = (tf: Timeframe): { multiplier: number; timespan: "minute" | "day" } =>
  tf === "1d" ? { multiplier: 1, timespan: "day" }
    : tf === "5m" ? { multiplier: 5, timespan: "minute" }
      : { multiplier: 1, timespan: "minute" };

/** Underlying aggregates → BarRow. Trade-derived OHLCV; never an NBBO claim. */
export async function adaptUnderlyingBars(
  symbol: string,
  fromMs: number,
  toMs: number,
  timeframe: Timeframe,
  deps: HistoricalDeps,
): Promise<AdapterResult<BarRow>> {
  const { multiplier, timespan } = tfToProvider(timeframe);
  const r = await fetchHistoricalBars(String(symbol).toUpperCase(), fromMs, toMs, deps, {
    multiplier, timespan, symbol: String(symbol).toUpperCase(),
  });
  return {
    rows: r.rows.map((b) => ({
      symbol: String(symbol).toUpperCase(),
      timeframe,
      tsMs: b.t,
      open: b.o, high: b.h, low: b.l, close: b.c,
      volume: b.v, vwap: b.vw, tradeCount: b.n,
    })),
    truncated: r.truncated,
    confirmedEmpty: r.confirmedEmpty,
    blocked: !r.outcome.ok && r.outcome.blocked,
    note: r.outcome.note,
  };
}

/**
 * Expired-inclusive contract reference → ContractRefRow.
 *
 * The entry point to every historical option study: an expired OCC cannot be resolved
 * any other way, and a universe of contracts still listed today is survivorship bias of
 * exactly the wrong kind.
 */
export async function adaptContractReference(
  underlying: string,
  expirationFrom: string,
  expirationTo: string,
  deps: HistoricalDeps,
  opts: { side?: "call" | "put"; maxPages?: number } = {},
): Promise<AdapterResult<ContractRefRow>> {
  const r = await fetchContractUniverse(underlying, expirationFrom, expirationTo, deps, {
    side: opts.side, maxPages: opts.maxPages ?? 4,
  });
  return {
    rows: r.contracts.map((c) => ({
      occ: c.occ,
      underlying: c.underlying,
      side: c.side,
      strike: c.strike,
      expiration: c.expiration,
      // Everything this endpoint returns under expired=true has already expired or is
      // listed; the flag records which query produced the row, not a re-derivation.
      expired: true,
    })),
    truncated: false,
    confirmedEmpty: r.contracts.length === 0 && r.outcome.ok,
    blocked: !r.outcome.ok && r.outcome.blocked,
    note: r.outcome.note,
  };
}

/**
 * Exact-OCC NBBO → OptionQuoteRow.
 *
 * A row here is an EXECUTABLE quote: what was being shown. This is the only adapter
 * whose output may answer "what could have been paid".
 */
export async function adaptOptionQuotes(
  occ: string,
  fromMs: number,
  toMs: number,
  deps: HistoricalDeps,
  opts: { symbol?: string | null; limit?: number } = {},
): Promise<AdapterResult<OptionQuoteRow>> {
  const key = String(occ).toUpperCase();
  const r = await fetchHistoricalOptionQuotes(key, fromMs, toMs, deps, {
    symbol: opts.symbol ?? null, limit: opts.limit,
  });
  return {
    rows: r.rows.map((q) => ({
      occ: key, tsMs: q.atMs, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize,
    })),
    truncated: r.truncated,
    confirmedEmpty: r.confirmedEmpty,
    blocked: !r.outcome.ok && r.outcome.blocked,
    note: r.outcome.note,
  };
}

/**
 * Exact-OCC trades → OptionTradeRow.
 *
 * A print, and stored as one. There is no path from here into the quote table: a trade
 * says someone traded there, not that we could have, and the entire durable store is
 * shaped around keeping those two claims apart.
 */
export async function adaptOptionTrades(
  occ: string,
  fromMs: number,
  toMs: number,
  deps: HistoricalDeps,
  opts: { symbol?: string | null; limit?: number } = {},
): Promise<AdapterResult<OptionTradeRow>> {
  const key = String(occ).toUpperCase();
  const r = await fetchHistoricalOptionTrades(key, fromMs, toMs, deps, {
    symbol: opts.symbol ?? null, limit: opts.limit,
  });
  return {
    rows: r.rows.map((t) => ({ occ: key, tsMs: t.atMs, price: t.price, size: t.size })),
    truncated: r.truncated,
    confirmedEmpty: r.confirmedEmpty,
    blocked: !r.outcome.ok && r.outcome.blocked,
    note: r.outcome.note,
  };
}

/**
 * The live dependency bundle the ingestion runner expects.
 *
 * Returns `{}` when no provider key is present, so the runner degrades to "no fetcher
 * supplied" and refuses, rather than throwing at the first window. A mining lane that
 * crashes on a missing key looks identical to one that crashed on a bug.
 */
export function liveIngestDeps(
  env: NodeJS.ProcessEnv = process.env,
  opts: { accountant?: RequestAccountant; nowMs?: () => number } = {},
): {
  fetchBars?: (symbol: string, fromMs: number, toMs: number, tf: Timeframe) => Promise<BarRow[]>;
  fetchContracts?: (underlying: string, expFrom: string, expTo: string) => Promise<ContractRefRow[]>;
  fetchQuotes?: (occ: string, fromMs: number, toMs: number) => Promise<OptionQuoteRow[]>;
  fetchTrades?: (occ: string, fromMs: number, toMs: number) => Promise<OptionTradeRow[]>;
} {
  if (!historicalProviderAvailable(env)) return {};
  const deps = buildHistoricalDeps(env, opts);
  return {
    fetchBars: async (symbol, fromMs, toMs, tf) =>
      (await adaptUnderlyingBars(symbol, fromMs, toMs, tf, deps)).rows,
    fetchContracts: async (underlying, expFrom, expTo) =>
      (await adaptContractReference(underlying, expFrom, expTo, deps)).rows,
    fetchQuotes: async (occ, fromMs, toMs) =>
      (await adaptOptionQuotes(occ, fromMs, toMs, deps)).rows,
    fetchTrades: async (occ, fromMs, toMs) =>
      (await adaptOptionTrades(occ, fromMs, toMs, deps)).rows,
  };
}
