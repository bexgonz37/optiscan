/**
 * lib/research/options/live-deps.ts — real provider adapter for the independent options monitor.
 * Builds OptionsMonitorDeps from the existing Polygon provider. Stage-1 underlying comes from ONE
 * whole-market snapshot per short window (cheap); Stage-2 chains come from fetchOptionChain only for
 * justified symbols. Feature-limited for now (price/dollar-vol/day-change + a cheap day-change
 * ACCELERATION from consecutive snapshots) — richer per-symbol features (rvol/VWAP/levels/options-
 * activity) are a documented next enrichment; until then the monitor is intentionally sparse.
 */
import type { OptionsMonitorDeps, UnderlyingSnapshot } from "./monitor.ts";
import type { ChainContract } from "./loop.ts";
import { tier2Eligible, type Session } from "./discovery.ts";
import { deriveDecisionLevels } from "./levels.ts";
import type { Bar } from "./features.ts";

type PrevChange = { change: number; atMs: number };
type BarsCache = Map<string, { at: number; bars: Bar[] }>;
type G = typeof globalThis & { __optiscanOptSnap?: { at: number; quotes: any[] }; __optiscanOptPrev?: Map<string, PrevChange>; __optiscanOptBars?: BarsCache };

async function marketSnapshot(nowMs: number): Promise<any[]> {
  const g = globalThis as G;
  if (g.__optiscanOptSnap && nowMs - g.__optiscanOptSnap.at < 5000) return g.__optiscanOptSnap.quotes;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { fetchMarketSnapshot } = require("@/lib/polygon-provider");
  const res = await fetchMarketSnapshot();
  const quotes = res?.available && Array.isArray(res.quotes) ? res.quotes : [];
  g.__optiscanOptSnap = { at: nowMs, quotes };
  return quotes;
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

function mapOptionContracts(raw: any[], nowMs: number): ChainContract[] {
  return (raw ?? []).map((c: any): ChainContract => ({
    optionSymbol: c.optionSymbol ?? c.symbol ?? c.ticker ?? "", side: String(c.side ?? c.contract_type ?? "").toLowerCase() === "put" ? "put" : "call",
    strike: Number(c.strike ?? c.strike_price), expiration: c.expiration ?? c.expiration_date ?? "", dte: Number(c.dte ?? 0),
    bid: c.bid ?? null, ask: c.ask ?? null, spreadPct: c.spreadPct ?? null, volume: c.volume ?? null, openInterest: c.openInterest ?? c.open_interest ?? null,
    iv: c.iv ?? c.implied_volatility ?? null, delta: c.delta ?? null, providerTimestamp: c.providerTimestamp ?? nowMs,
  })).filter((c: ChainContract) => c.optionSymbol && Number.isFinite(c.strike));
}

export function buildLiveOptionsDeps(): OptionsMonitorDeps {
  const g = globalThis as G;
  const prev = (g.__optiscanOptPrev ??= new Map());
  const barsCache = (g.__optiscanOptBars ??= new Map());
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
    getChain: async (symbol: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { fetchOptionChain } = require("@/lib/polygon-provider");
      const res = await fetchOptionChain(symbol, { dteMin: 0, dteMax: 14, maxPages: 2 });
      return res?.available ? mapOptionContracts(res.contracts, Date.now()) : [];
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

/** Live deps for the AUTOMATIC grader: refresh one open contract's quote by fetching its underlying's
 *  chain and matching the OCC symbol. Returns null when unavailable (position stays open, not fabricated). */
export function buildLiveGradeDeps(): { getDb: () => any; now: () => number; getQuote: (optionSymbol: string, underlyingSymbol: string) => Promise<{ bid: number | null; ask: number | null; quoteAgeMs: number | null } | null> } {
  return {
    now: Date.now,
    getDb: () => require("@/lib/db").getDb(), // eslint-disable-line @typescript-eslint/no-require-imports
    getQuote: async (optionSymbol: string, underlyingSymbol: string) => {
      if (!underlyingSymbol) return null;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { fetchOptionChain } = require("@/lib/polygon-provider");
      const res = await fetchOptionChain(underlyingSymbol, { dteMin: 0, dteMax: 60, maxPages: 3 });
      if (!res?.available) return null;
      const nowMs = Date.now();
      const c = mapOptionContracts(res.contracts, nowMs).find((x) => x.optionSymbol === optionSymbol);
      if (!c) return null;
      return { bid: c.bid, ask: c.ask, quoteAgeMs: c.providerTimestamp != null ? nowMs - c.providerTimestamp : null };
    },
  };
}
