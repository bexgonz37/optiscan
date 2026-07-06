/**
 * scan-core.ts — orchestration that turns Polygon/Massive data into ranked
 * options signals (directional momentum) and unusual-activity hits.
 *
 * One underlying scan feeds both UI tabs. Results are cached (TTL) and per-symbol
 * enrichment is bounded by a concurrency limit to respect the provider's rate
 * limit. All heavy signal math lives in the reused pure libs; this file only
 * fetches, fans out, and aggregates.
 */

import {
  hasPolygon,
  fetchBulkQuotes,
  fetchTopMovers,
  fetchQuote,
  fetchCandles,
  fetchOptionChain,
  fetchTickerName,
} from "@/lib/polygon-provider";
import { buildMomentumSignal, momentumConfigFromEnv } from "@/lib/momentum-signals";
import { buildOptionSignal, optionsConfigFromEnv } from "@/lib/options-signals";
import { detectUnusualContracts, unusualConfigFromEnv } from "@/lib/unusual-activity";
import { getScanUniverse } from "@/lib/universe";
import { companyName } from "@/lib/company-names";
import { cached, cachedMaxAge, mapLimit } from "@/lib/scan-cache";

const NAME_TTL_MS = 24 * 60 * 60 * 1000;

/** Resolve a company name: instant static map first, then Polygon (cached 24h). */
async function resolveName(symbol: string): Promise<string | null> {
  const stat = companyName(symbol);
  if (stat) return stat;
  if (!hasPolygon()) return null;
  return cached<string | null>(`name:${symbol}`, NAME_TTL_MS, async () => {
    try {
      return (await fetchTickerName(symbol)) ?? null;
    } catch {
      return null;
    }
  });
}
import type {
  MomentumRow,
  UnusualRow,
  OptionContract,
  ScanResult,
  SymbolDetail,
} from "@/lib/types";

interface ScanConfig {
  shortlist: number;
  concurrency: number;
  cacheTtlMs: number;
  includeMovers: boolean;
  moversPerSide: number;
  minPrice: number;
}

function scanConfig(env = process.env): ScanConfig {
  return {
    shortlist: Number(env.RADAR_SHORTLIST ?? 12),
    concurrency: Number(env.SCAN_CONCURRENCY ?? 4),
    cacheTtlMs: Number(env.SCAN_CACHE_MS ?? 45000),
    includeMovers: env.SCAN_INCLUDE_MOVERS !== "0",
    moversPerSide: Number(env.SCAN_MOVERS_PER_SIDE ?? 10),
    minPrice: Number(env.RADAR_MIN_PRICE ?? 3),
  };
}

interface Enriched {
  symbol: string;
  quote: { symbol: string; price: number | null; changePercent: number | null; volume: number | null } | null;
  momentum: MomentumRow | null;
  unusual: UnusualRow[];
  contracts: OptionContract[];
  error?: string;
}

/** Fetch candles + full chain for one symbol and derive both signal types. */
async function enrichSymbol(symbol: string, quote: any, maxAgeMs: number): Promise<Enriched> {
  return cachedMaxAge<Enriched>(`sym:${symbol}`, maxAgeMs, async () => {
    const momCfg = momentumConfigFromEnv();
    const optCfg = optionsConfigFromEnv();
    const unuCfg = unusualConfigFromEnv();

    try {
      // The provider returns { available: false, note } instead of throwing —
      // check it, or a failed fetch silently becomes "no bars / no contracts"
      // and the scan reports wrong scores with zero errors.
      const problems: string[] = [];

      const candlesRes: any = await fetchCandles(symbol, {
        resolution: "5",
        timespan: "minute",
        days: 2,
        countback: 120,
      });
      if (candlesRes?.available === false) problems.push(`candles: ${candlesRes.note ?? "unavailable"}`);
      const bars = candlesRes?.bars ?? [];
      const mom: any = buildMomentumSignal(quote || { symbol }, bars, momCfg);

      const chainRes: any = await fetchOptionChain(symbol, {
        dteMin: optCfg.dteMin,
        dteMax: optCfg.dteMax,
      });
      if (chainRes?.available === false) problems.push(`chain: ${chainRes.note ?? "unavailable"}`);
      const contracts: OptionContract[] = chainRes?.contracts ?? [];

      const name = await resolveName(symbol);
      const opt: any = buildOptionSignal(mom, contracts, optCfg);
      // buildOptionSignal drops gamma/theta/vega; re-attach from the full chain
      // so the detail panel can show the complete greeks.
      let optContract = opt.contract;
      if (optContract?.optionSymbol) {
        const full: any = contracts.find((c: any) => c.optionSymbol === optContract.optionSymbol);
        if (full) {
          optContract = {
            ...optContract,
            gamma: full.gamma ?? null,
            theta: full.theta ?? null,
            vega: full.vega ?? null,
          };
        }
      }
      const unusualRaw: UnusualRow[] = detectUnusualContracts(contracts, {
        ...unuCfg,
        symbol,
      });
      const unusual: UnusualRow[] = unusualRaw.map((u) => ({ ...u, name }));

      const momentumRow: MomentumRow = {
        symbol: mom.symbol ?? symbol,
        name,
        bias: opt.bias ?? mom.bias,
        side: opt.side ?? null,
        score: opt.score ?? 0,
        grade: opt.grade ?? "SKIP",
        momentumScore: mom.score ?? 0,
        underlyingPrice: opt.underlyingPrice ?? mom.price ?? null,
        movePct: mom.movePct ?? 0,
        priceVsVwapPct: mom.priceVsVwapPct ?? null,
        rsi: mom.rsi ?? null,
        relVol: mom.relVol ?? null,
        trend: mom.trend ?? "mixed",
        contract: optContract ?? null,
        reason: opt.reason ?? mom.reason ?? "",
        reasons: opt.reasons ?? [],
        warnings: opt.warnings ?? mom.warnings ?? [],
      };

      return {
        symbol,
        quote: quote
          ? {
              symbol,
              name,
              price: quote.price ?? quote.last ?? null,
              changePercent: quote.changePercent ?? null,
              volume: quote.volume ?? null,
            }
          : { symbol, name, price: null, changePercent: null, volume: null },
        momentum: momentumRow,
        unusual,
        contracts,
        error: problems.length ? problems.join("; ") : undefined,
      };
    } catch (err: any) {
      return {
        symbol,
        quote: quote
          ? { symbol, price: quote.price ?? null, changePercent: quote.changePercent ?? null, volume: quote.volume ?? null }
          : null,
        momentum: null,
        unusual: [],
        contracts: [],
        error: err?.message ?? String(err),
      };
    }
  });
}

/** Build the shortlist of symbols to enrich: biggest movers in the universe. */
async function buildShortlist(cfg: ScanConfig): Promise<{ symbols: string[]; quotes: Map<string, any>; universeCount: number; notes: string[] }> {
  const universe = getScanUniverse();
  const quotes = new Map<string, any>();
  const notes: string[] = [];

  const bulk: any = await fetchBulkQuotes(universe);
  if (bulk?.available === false) notes.push(`bulk quotes: ${bulk.note ?? "unavailable"}`);
  for (const q of bulk?.quotes ?? []) quotes.set(q.symbol, q);

  if (cfg.includeMovers) {
    const [gain, lose]: any[] = await Promise.all([
      fetchTopMovers("gainers", cfg.moversPerSide),
      fetchTopMovers("losers", cfg.moversPerSide),
    ]);
    if (gain?.available === false) notes.push(`gainers: ${gain.note ?? "unavailable"}`);
    if (lose?.available === false) notes.push(`losers: ${lose.note ?? "unavailable"}`);
    for (const q of [...(gain?.quotes ?? []), ...(lose?.quotes ?? [])]) {
      if (!quotes.has(q.symbol)) quotes.set(q.symbol, q);
    }
  }

  const ranked = Array.from(quotes.values())
    .filter((q) => (q.price ?? 0) >= cfg.minPrice && q.changePercent != null)
    .sort((a, b) => Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0));

  const symbols = ranked.slice(0, cfg.shortlist).map((q) => q.symbol);
  return { symbols, quotes, universeCount: universe.length, notes };
}

/** Full scan feeding both tabs. Freshness is controlled by `maxAgeMs` (the
 * client's poll rate), defaulting to SCAN_CACHE_MS. */
export async function runScan(maxAgeMs?: number): Promise<ScanResult> {
  const cfg = scanConfig();
  const keyPresent = hasPolygon();
  const freshness = Number.isFinite(maxAgeMs) ? Math.max(0, Number(maxAgeMs)) : cfg.cacheTtlMs;

  if (!keyPresent) {
    const universe = getScanUniverse();
    return {
      generatedAt: new Date().toISOString(),
      provider: "polygon",
      keyPresent: false,
      note: "No POLYGON_API_KEY set — add your Polygon/Massive key to .env.local to see live signals.",
      universeCount: universe.length,
      scannedCount: 0,
      scanned: [],
      errors: [],
      momentum: [],
      unusual: [],
    };
  }

  return cachedMaxAge<ScanResult>("scan", freshness, async () => {
    const { symbols, quotes, universeCount, notes } = await buildShortlist(cfg);

    const enriched = await mapLimit(symbols, cfg.concurrency, (sym) =>
      enrichSymbol(sym, quotes.get(sym), freshness),
    );

    const momentum: MomentumRow[] = [];
    const unusual: UnusualRow[] = [];
    const errors: { symbol: string; message: string }[] = notes.map((n) => ({ symbol: "*", message: n }));

    for (const e of enriched) {
      if (e.error) errors.push({ symbol: e.symbol, message: e.error });
      if (e.momentum && e.momentum.side && e.momentum.contract) momentum.push(e.momentum);
      for (const u of e.unusual) unusual.push(u);
    }

    momentum.sort((a, b) => b.score - a.score);
    unusual.sort((a, b) => b.score - a.score);

    // Alert Lab capture: fire-and-forget so persistence/news lookups never add
    // latency to (or break) the scan itself. Dynamic import keeps the scanner
    // fully functional if better-sqlite3 isn't installed.
    import("@/lib/alert-capture")
      .then(({ captureAlerts }) => captureAlerts({ momentum, unusual, quotes }))
      .catch((err) => console.warn("[alert-lab] capture skipped:", err?.message));

    return {
      generatedAt: new Date().toISOString(),
      provider: "polygon",
      keyPresent: true,
      universeCount,
      scannedCount: symbols.length,
      scanned: symbols,
      errors,
      momentum,
      unusual,
    };
  });
}

/** Deep-dive one symbol for the detail drawer (reuses per-symbol cache). */
export async function scanSymbol(symbolRaw: string): Promise<SymbolDetail> {
  const cfg = scanConfig();
  const symbol = String(symbolRaw || "").toUpperCase();
  const keyPresent = hasPolygon();

  const base = {
    generatedAt: new Date().toISOString(),
    provider: "polygon",
    keyPresent,
    universeCount: 0,
    scannedCount: keyPresent ? 1 : 0,
    scanned: keyPresent ? [symbol] : [],
    errors: [] as { symbol: string; message: string }[],
    symbol,
  };

  if (!keyPresent) {
    return {
      ...base,
      note: "No POLYGON_API_KEY set — add your Polygon/Massive key to .env.local.",
      quote: null,
      momentum: null,
      unusual: [],
      contracts: [],
    };
  }

  const qRes: any = await fetchQuote(symbol);
  const quote = qRes?.quote ?? { symbol };
  const e = await enrichSymbol(symbol, quote, cfg.cacheTtlMs);
  if (e.error) base.errors.push({ symbol, message: e.error });

  return {
    ...base,
    quote: e.quote,
    momentum: e.momentum,
    unusual: e.unusual,
    contracts: e.contracts,
  };
}

export function providerStatus() {
  return { provider: "polygon", keyPresent: hasPolygon() };
}
