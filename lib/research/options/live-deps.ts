/**
 * lib/research/options/live-deps.ts — real provider adapter for the independent options monitor.
 * Builds OptionsMonitorDeps from the existing Polygon provider. Stage-1 underlying comes from ONE
 * whole-market snapshot per short window (cheap); Stage-2 chains come from fetchOptionChain only for
 * justified symbols. Feature-limited for now (price/dollar-vol/day-change + a cheap day-change
 * ACCELERATION from consecutive snapshots) — richer per-symbol features (rvol/VWAP/levels/options-
 * activity) are a documented next enrichment; until then the monitor is intentionally sparse.
 */
import type { OptionsMonitorDeps, UnderlyingSnapshot } from "./monitor.ts";
import type { ChainContract, ChainFetchOutcome, ChainFetchPartitionOutcome } from "./loop.ts";
import { tier2Eligible, type Session } from "./discovery.ts";
import { planPartitions, type DiscoveryPartition } from "./contract-discovery.ts";
import { deriveDecisionLevels } from "./levels.ts";
import type { Bar } from "./features.ts";
import { quoteFreshness } from "../../quote-freshness.ts";
import { emitProviderRequest } from "../../provider-accounting-sink.ts";

type PrevChange = { change: number; atMs: number };
type BarsCache = Map<string, { at: number; bars: Bar[] }>;
type ChainCache = Map<string, { at: number; outcome: ChainFetchOutcome }>;
type ChainInflight = Map<string, Promise<ChainFetchOutcome>>;
type LiveChainPartition = Omit<DiscoveryPartition, "side"> & { side: "call" | "put" | null };
type G = typeof globalThis & {
  __optiscanOptSnap?: { at: number; quotes: any[] };
  __optiscanOptPrev?: Map<string, PrevChange>;
  __optiscanOptBars?: BarsCache;
  __optiscanOptChainCache?: ChainCache;
  __optiscanOptChainInflight?: ChainInflight;
};

async function marketSnapshot(nowMs: number): Promise<any[]> {
  // Shared TTL/inflight lives in fetchMarketSnapshot (scanner + options).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { fetchMarketSnapshot } = require("@/lib/polygon-provider");
  const res = await fetchMarketSnapshot();
  return res?.available && Array.isArray(res.quotes) ? res.quotes : [];
}

function toSnapshot(q: any, prev: Map<string, PrevChange>, nowMs: number): UnderlyingSnapshot {
  const change = Number(q.changePercent);
  const p = prev.get(q.symbol);
  let accelPct: number | null = null;
  if (p && Number.isFinite(change)) { const dtMin = (nowMs - p.atMs) / 60_000; if (dtMin > 0 && dtMin <= 5) accelPct = +(((change - p.change) / dtMin)).toFixed(3); }
  if (Number.isFinite(change)) prev.set(q.symbol, { change, atMs: nowMs });
  const price = Number(q.price);
  return {
    price: Number.isFinite(price) ? price : null,
    dayDollarVolume: Number.isFinite(price) && q.volume ? price * Number(q.volume) : null,
    relVolume: null, velPct: Number.isFinite(change) ? change : null, accelPct, gapPct: null,
    aboveVwap: null, hodBreak: null, nearResistancePct: null, compressionPct: null,
    realizedVolExpanding: null, openingRange: null, premarketLevelTest: null,
  };
}

/**
 * Half-width of the strike window fetched around spot, as a fraction.
 *
 * Chosen from a live measurement on 2026-08-04, not from theory. At ±8% the
 * 0-14 DTE fetch covered NVDA's ENTIRE window in one page (previously truncated
 * at 4 expirations) and gained SPY/QQQ the 1-7DTE band they had never reached.
 *
 * It is a genuine trade-off and it is not free at the extremes: a 14DTE 0.30
 * delta sits near 3% OTM on SPY but nearer 9% on a 45%-IV name, so a very high
 * IV underlying can have its far delta band clipped. That is the RIGHT direction
 * to err — the alternative, which is what shipped before, silently dropped whole
 * EXPIRATIONS instead, and a missing expiration cannot be recovered downstream
 * while a missing wing strike is one the strategies would not have picked.
 *
 * Tunable without a deploy; widening it costs expiration coverage, not requests.
 */
const CHAIN_STRIKE_WINDOW_PCT = Math.max(
  0.01,
  Math.min(0.5, Number(process.env.OPTIONS_CHAIN_STRIKE_WINDOW_PCT ?? 0.08)),
);
const CHAIN_CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.OPTIONS_CHAIN_CACHE_TTL_MS ?? 15_000),
);
const CHAIN_PARTITION_MAX_PAGES = Math.max(
  1,
  Number(process.env.OPTIONS_CHAIN_PARTITION_MAX_PAGES ?? 2),
);
const CHAIN_MAX_STRATEGY_PARTITIONS = Math.max(
  1,
  Number(process.env.OPTIONS_CHAIN_MAX_STRATEGY_PARTITIONS ?? 6),
);

function mapOptionContracts(raw: any[]): ChainContract[] {
  return (raw ?? []).map((c: any): ChainContract => ({
    optionSymbol: c.optionSymbol ?? c.symbol ?? c.ticker ?? "", side: String(c.side ?? c.contract_type ?? "").toLowerCase() === "put" ? "put" : "call",
    strike: Number(c.strike ?? c.strike_price), expiration: c.expiration ?? c.expiration_date ?? "", dte: Number(c.dte ?? 0),
    bid: c.bid ?? null, ask: c.ask ?? null, spreadPct: c.spreadPct ?? null, volume: c.volume ?? null, openInterest: c.openInterest ?? c.open_interest ?? null,
    iv: c.iv ?? c.implied_volatility ?? null, delta: c.delta ?? null, providerTimestamp: c.providerTimestamp ?? null,
  })).filter((c: ChainContract) => c.optionSymbol && Number.isFinite(c.strike));
}

function chainCacheKey(symbol: string, part: LiveChainPartition, underlyingPrice?: number | null): string {
  const spot = Number(underlyingPrice);
  const spotBucket = Number.isFinite(spot) && spot > 0 ? (Math.round(spot * 10) / 10).toFixed(1) : "na";
  return [
    symbol.toUpperCase(),
    part.side ?? "both",
    `${part.dteMin}-${part.dteMax}`,
    `spot:${spotBucket}`,
    `window:${CHAIN_STRIKE_WINDOW_PCT}`,
    `pages:${CHAIN_PARTITION_MAX_PAGES}`,
  ].join("|");
}

function cloneOutcome(outcome: ChainFetchOutcome, over: Partial<ChainFetchOutcome> = {}): ChainFetchOutcome {
  return {
    ...outcome,
    contracts: [...outcome.contracts],
    expirationsCovered: [...outcome.expirationsCovered],
    requestedDteRanges: [...(outcome.requestedDteRanges ?? [])],
    fetchedDteRanges: [...(outcome.fetchedDteRanges ?? [])],
    partitions: [...(outcome.partitions ?? [])],
    ...over,
  };
}

function partitionFromResponse(
  part: LiveChainPartition,
  res: any,
  contracts: ChainContract[],
): ChainFetchPartitionOutcome {
  return {
    label: part.label,
    side: part.side,
    dteMin: Number(res?.requestedDteMin ?? part.dteMin),
    dteMax: Number(res?.requestedDteMax ?? part.dteMax),
    outcome: res?.outcome ?? "PROVIDER_INVALID_RESPONSE",
    truncated: Boolean(res?.truncated),
    requestedExpirationStart: res?.requestedExpirationGte ?? null,
    requestedExpirationEnd: res?.requestedExpirationLte ?? null,
    expirationsCovered: res?.expirationsCovered ?? [],
    contractsReceived: contracts.length,
    pagesRequested: Number(res?.pagesRequested ?? CHAIN_PARTITION_MAX_PAGES),
    pagesReceived: Number(res?.pagesReceived ?? 0),
  };
}

function safeProviderMessage(res: any): string | null {
  const msg = typeof res?.note === "string" ? res.note : null;
  return msg ? msg.replace(/apiKey=[^&\s]+/gi, "apiKey=REDACTED").slice(0, 240) : null;
}

function outcomeFromResponse(part: LiveChainPartition, res: any): ChainFetchOutcome {
  const contracts = res?.available ? mapOptionContracts(res.contracts) : [];
  const partition = partitionFromResponse(part, res, contracts);
  const succeeded = partition.outcome === "CONTRACTS_AVAILABLE" || partition.outcome === "NO_CONTRACTS_IN_REQUESTED_RANGE";
  return {
    contracts,
    outcome: partition.outcome,
    truncated: partition.truncated,
    expirationsCovered: partition.expirationsCovered,
    requestedDteMin: partition.dteMin,
    requestedDteMax: partition.dteMax,
    requestedSide: part.side,
    strategyKey: null,
    providerPurpose: "options_discovery",
    requestedExpirationStart: partition.requestedExpirationStart,
    requestedExpirationEnd: partition.requestedExpirationEnd,
    requestedDteRanges: [{ dteMin: part.dteMin, dteMax: part.dteMax, label: part.label }],
    fetchedDteRanges: succeeded && !partition.truncated
      ? [{ dteMin: part.dteMin, dteMax: part.dteMax, label: part.label }]
      : [],
    partitions: [partition],
    cacheHit: false,
    dedupHit: false,
    rawContractsReceived: Array.isArray(res?.contracts) ? res.contracts.length : contracts.length,
    normalizedContractsReceived: contracts.length,
    safeErrorCode: res?.outcome && String(res.outcome).startsWith("PROVIDER_") ? String(res.outcome) : null,
    safeErrorMessage: safeProviderMessage(res),
    pagesRequested: partition.pagesRequested,
    pagesReceived: partition.pagesReceived,
  };
}

function dedupeContracts(contracts: ChainContract[]): ChainContract[] {
  const seen = new Set<string>();
  const out: ChainContract[] = [];
  for (const c of contracts) {
    const key = c.optionSymbol.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function combineOutcomes(
  strategyKey: string | null,
  side: "call" | "put" | null,
  planned: LiveChainPartition[],
  outcomes: ChainFetchOutcome[],
): ChainFetchOutcome {
  if (!outcomes.length) {
    return {
      contracts: [],
      outcome: "RANGE_NOT_FETCHED",
      truncated: false,
      expirationsCovered: [],
      requestedDteMin: planned.length ? Math.min(...planned.map((p) => p.dteMin)) : null,
      requestedDteMax: planned.length ? Math.max(...planned.map((p) => p.dteMax)) : null,
      requestedSide: side,
      strategyKey,
      providerPurpose: "options_discovery",
      requestedExpirationStart: null,
      requestedExpirationEnd: null,
      requestedDteRanges: planned.map((p) => ({ dteMin: p.dteMin, dteMax: p.dteMax, label: p.label })),
      fetchedDteRanges: [],
      partitions: [],
      cacheHit: false,
      dedupHit: false,
      rawContractsReceived: 0,
      normalizedContractsReceived: 0,
      safeErrorCode: "RANGE_NOT_FETCHED",
      safeErrorMessage: null,
      pagesRequested: 0,
      pagesReceived: 0,
    };
  }
  const contracts = dedupeContracts(outcomes.flatMap((o) => o.contracts));
  const partitions = outcomes.flatMap((o) => o.partitions ?? []);
  const successOutcomes = new Set(["CONTRACTS_AVAILABLE", "NO_CONTRACTS_IN_REQUESTED_RANGE"]);
  const firstBlocking = outcomes.find((o) => !successOutcomes.has(o.outcome));
  const outcome = contracts.length > 0
    ? "CONTRACTS_AVAILABLE"
    : firstBlocking?.outcome ?? (outcomes.some((o) => o.truncated) ? "CHAIN_TRUNCATED_BEFORE_RANGE" : "NO_CONTRACTS_IN_REQUESTED_RANGE");
  return {
    contracts,
    outcome,
    truncated: outcomes.some((o) => o.truncated),
    expirationsCovered: [...new Set(outcomes.flatMap((o) => o.expirationsCovered))].sort(),
    requestedDteMin: planned.length ? Math.min(...planned.map((p) => p.dteMin)) : null,
    requestedDteMax: planned.length ? Math.max(...planned.map((p) => p.dteMax)) : null,
    requestedSide: side,
    strategyKey,
    providerPurpose: "options_discovery",
    requestedExpirationStart: outcomes.map((o) => o.requestedExpirationStart).filter(Boolean).sort()[0] ?? null,
    requestedExpirationEnd: outcomes.map((o) => o.requestedExpirationEnd).filter(Boolean).sort().at(-1) ?? null,
    requestedDteRanges: planned.map((p) => ({ dteMin: p.dteMin, dteMax: p.dteMax, label: p.label })),
    fetchedDteRanges: outcomes.flatMap((o) => o.fetchedDteRanges ?? []),
    partitions,
    cacheHit: outcomes.some((o) => o.cacheHit),
    dedupHit: outcomes.some((o) => o.dedupHit),
    rawContractsReceived: outcomes.reduce((n, o) => n + Number(o.rawContractsReceived ?? o.contracts.length), 0),
    normalizedContractsReceived: contracts.length,
    safeErrorCode: firstBlocking?.safeErrorCode ?? (outcome.startsWith("PROVIDER_") ? outcome : null),
    safeErrorMessage: firstBlocking?.safeErrorMessage ?? null,
    pagesRequested: outcomes.reduce((n, o) => n + Number(o.pagesRequested ?? 0), 0),
    pagesReceived: outcomes.reduce((n, o) => n + Number(o.pagesReceived ?? 0), 0),
  };
}

export function buildLiveOptionsDeps(): OptionsMonitorDeps {
  const g = globalThis as G;
  const prev = (g.__optiscanOptPrev ??= new Map());
  const barsCache = (g.__optiscanOptBars ??= new Map());
  const chainCache = (g.__optiscanOptChainCache ??= new Map());
  const chainInflight = (g.__optiscanOptChainInflight ??= new Map());

  async function fetchPartition(symbol: string, underlyingPrice: number | null | undefined, part: LiveChainPartition): Promise<ChainFetchOutcome> {
    const key = chainCacheKey(symbol, part, underlyingPrice);
    const nowMs = Date.now();
    const cached = chainCache.get(key);
    if (cached && nowMs - cached.at < CHAIN_CACHE_TTL_MS) {
      emitProviderRequest({ endpoint: `/v3/snapshot/options/${symbol.toUpperCase()}`, status: "cache_hit", symbol });
      return cloneOutcome(cached.outcome, { cacheHit: true });
    }
    const existing = chainInflight.get(key);
    if (existing) {
      emitProviderRequest({ endpoint: `/v3/snapshot/options/${symbol.toUpperCase()}`, status: "dedup_avoided", symbol });
      return existing.then((outcome: ChainFetchOutcome) => cloneOutcome(outcome, { dedupHit: true }));
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fetchOptionChain } = require("@/lib/polygon-provider");
    const spot = Number(underlyingPrice);
    const pending = fetchOptionChain(symbol, {
      dteMin: part.dteMin,
      dteMax: part.dteMax,
      maxPages: CHAIN_PARTITION_MAX_PAGES,
      ...(part.side ? { side: part.side } : {}),
      ...(Number.isFinite(spot) && spot > 0
        ? { underlyingPrice: spot, strikeAroundPct: CHAIN_STRIKE_WINDOW_PCT }
        : {}),
    }).then((res: any) => {
      const outcome = outcomeFromResponse(part, res);
      chainCache.set(key, { at: Date.now(), outcome });
      return outcome;
    }).finally(() => {
      chainInflight.delete(key);
    });
    chainInflight.set(key, pending);
    return pending;
  }

  return {
    now: Date.now,
    session: (): Session => { try { const { marketSession } = require("@/lib/trading-session"); return marketSession(Date.now()) as Session; } catch { return "regular"; } }, // eslint-disable-line @typescript-eslint/no-require-imports
    getDb: () => require("@/lib/db").getDb(), // eslint-disable-line @typescript-eslint/no-require-imports
    getUnderlyingBatch: async (symbols: string[]) => {
      const nowMs = Date.now();
      const quotes = await marketSnapshot(nowMs);
      const bySym = new Map(quotes.map((q: any) => [String(q.symbol).toUpperCase(), q]));
      const out = new Map<string, UnderlyingSnapshot>();
      for (const sym of symbols) { const q = bySym.get(sym.toUpperCase()); if (q) out.set(sym.toUpperCase(), toSnapshot(q, prev, nowMs)); }
      return out;
    },
    getBars: async (symbol: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { fetchCandles } = require("@/lib/polygon-provider");
      // 2 days incl. extended hours so decision-time levels (prev-day H/L/close, premarket H/L) are
      // derivable from THIS same fetch — no extra provider call, no added alert latency.
      const res = await fetchCandles(symbol, { days: 2, resolution: "1", timespan: "minute" });
      const raw = res?.available ? (res.bars ?? []) : [];
      const bars: Bar[] = raw.map((b: any) => ({ t: Number(b.t ?? b.timestamp), o: Number(b.o ?? b.open), h: Number(b.h ?? b.high), l: Number(b.l ?? b.low), c: Number(b.c ?? b.close), v: Number(b.v ?? b.volume ?? 0) })).filter((b: any) => Number.isFinite(b.t) && Number.isFinite(b.c));
      barsCache.set(symbol.toUpperCase(), { at: Date.now(), bars });
      return bars;
    },
    // Levels derived from the SAME bars getBars just fetched (the monitor calls getBars then
    // levelContext in the same tick). This unlocks the early, pre-breakout strategies without any
    // extra network call. Absent bars → null levels (the feature engine degrades gracefully).
    levelContext: (symbol: string) => {
      const cached = barsCache.get(symbol.toUpperCase());
      if (!cached || Date.now() - cached.at > 60_000 || cached.bars.length === 0) return null;
      return deriveDecisionLevels(cached.bars, Date.now());
    },
    getChain: async (symbol: string, underlyingPrice?: number | null, opts: { side?: "call" | "put" | null; strategyKey?: string | null } = {}) => {
      const side = opts.side === "put" ? "put" : opts.side === "call" ? "call" : null;
      const strategyKey = typeof opts.strategyKey === "string" && opts.strategyKey ? opts.strategyKey : null;
      const planned: LiveChainPartition[] = side && strategyKey
        ? planPartitions(side, strategyKey, CHAIN_MAX_STRATEGY_PARTITIONS)
        : [{ side: null, dteMin: 0, dteMax: 14, label: "both:0-14dte" }];
      const outcomes: ChainFetchOutcome[] = [];
      for (const part of planned) {
        const out = await fetchPartition(symbol, underlyingPrice, part);
        outcomes.push(out);
        if (out.outcome === "PROVIDER_QUOTA_EXCEEDED"
          || out.outcome === "PROVIDER_CONFIGURATION_MISSING"
          || out.outcome === "PROVIDER_TIMEOUT"
          || out.outcome === "PROVIDER_FAILURE"
          || out.outcome === "PROVIDER_INVALID_RESPONSE") {
          break;
        }
      }
      return combineOutcomes(strategyKey, side, planned, outcomes);
    },
    tier2Universe: async () => {
      const nowMs = Date.now();
      const quotes = await marketSnapshot(nowMs);
      return quotes
        .filter((q: any) => tier2Eligible({ symbol: q.symbol, price: q.price, dayDollarVolume: (q.price ?? 0) * (q.volume ?? 0) }).eligible)
        .map((q: any) => String(q.symbol).toUpperCase());
    },
  };
}

export function buildLiveGradeDeps(): {
  getDb: () => any;
  now: () => number;
  getQuote: (optionSymbol: string, underlyingSymbol: string) => Promise<{
    bid: number | null;
    ask: number | null;
    quoteAgeMs: number | null;
    providerTimestamp: number | null;
  } | null>;
  fetchUnderlying: (symbol: string) => Promise<number | null>;
} {
  return {
    now: Date.now,
    getDb: () => require("@/lib/db").getDb(), // eslint-disable-line @typescript-eslint/no-require-imports
    /**
     * Present-time quote for ONE exact OCC — one provider request.
     *
     * FIXED 2026-08-03 (Gate B5 measurement). This read the entire 0-60 DTE chain,
     * up to 3 pages / 750 contracts, and `.find()`-ed a single row out of it. The
     * identical defect was fixed on the asymmetry lane on 2026-08-02
     * (lib/research/asymmetry/live-quote.ts) but the SUBSCRIBER grade lane kept it.
     *
     * Production proved the cost: `options_paper_mark` spent 12,975 requests to
     * receive 3,124,152 contract records — 241 records per request to use one —
     * which is 27% of the whole day's provider budget. Meanwhile `asymmetry_mark`,
     * already on the exact-OCC path, was refused 78,595 times and got 263 requests
     * through. The chain scan was starving the lane that had already been fixed.
     *
     * `quoteAgeMs` is measured against the instant the provider ANSWERED, not the
     * instant the sweep started — the same observation-clock rule as the asymmetry
     * lane, so a quote fetched late in a long pass is not judged as arriving from
     * the future.
     */
    getQuote: async (optionSymbol: string, underlyingSymbol: string) => {
      if (!underlyingSymbol) return null;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { fetchOptionContractSnapshot } = require("@/lib/polygon-provider");
      const res = await fetchOptionContractSnapshot(underlyingSymbol, optionSymbol);
      const observedAtMs = Date.now();
      // A budget refusal is NOT a missing quote. Both yield null here — the grader
      // treats null as "no observation this tick" and holds, which is correct for
      // both — but they are counted apart so a quota block can never be read as
      // evidence that the contract had no market.
      if (res?.quotaExceeded) return null;
      if (!res?.available) return null;
      const c = res.contract;
      if (!c) return null;
      return {
        bid: c.bid,
        ask: c.ask,
        quoteAgeMs: quoteFreshness(c.providerTimestamp, observedAtMs).ageMs,
        providerTimestamp: c.providerTimestamp,
      };
    },
    fetchUnderlying: async (symbol: string) => {
      const quotes = await marketSnapshot(Date.now());
      const q = quotes.find((x: any) => String(x.symbol).toUpperCase() === symbol.toUpperCase());
      const p = Number(q?.price);
      return Number.isFinite(p) ? p : null;
    },
  };
}
