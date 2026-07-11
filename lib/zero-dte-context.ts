/**
 * zero-dte-context.ts — universe-driven 0DTE strip symbol resolution + ATM IV helpers.
 */

import { getZeroDteUniverse } from "./universe.js";
import { fetchCandles, fetchOptionChain, fetchQuote } from "./polygon-provider.js";
import { ivToPct } from "./alert-scoring.js";
import { nearTheMoneyPair } from "./zero-dte.js";
import { cached } from "./scan-cache.ts";
import { keyLevels, type KeyLevel } from "./chart-indicators.ts";
import { minutesToClose } from "./trading-session.ts";

const STRIP_IV_TTL_MS = 90_000;
const NEAR_LEVEL_PCT = 0.2;

export function resolveZeroDteStripSymbols({
  chartSymbol = null,
  override = null,
  universe = getZeroDteUniverse(),
  max = 6,
}: {
  chartSymbol?: string | null;
  override?: string[] | null;
  universe?: string[];
  max?: number;
} = {}): string[] {
  const cap = Math.max(1, Math.min(max, 6));
  const norm = (s: string) => String(s ?? "").trim().toUpperCase();
  const out: string[] = [];

  const sel = chartSymbol ? norm(chartSymbol) : null;
  if (sel) out.push(sel);

  for (const sym of (override ?? []).map(norm).filter(Boolean)) {
    if (out.length >= cap) break;
    if (!out.includes(sym)) out.push(sym);
  }

  for (const sym of universe) {
    if (out.length >= cap) break;
    const u = norm(sym);
    if (u && !out.includes(u)) out.push(u);
  }

  return out.slice(0, cap);
}

/** Pick ATM-ish IV from a 0DTE chain (nearest strike to spot, prefer liquid). */
export function atmIvFromContracts(contracts: any[], spot: number | null): number | null {
  if (!contracts?.length || spot == null || !Number.isFinite(spot)) return null;
  let best: any = null;
  let bestDist = Infinity;
  for (const c of contracts) {
    if (c.strike == null) continue;
    const dist = Math.abs(c.strike - spot);
    const liq = (c.volume ?? 0) + (c.openInterest ?? 0) * 0.1;
    if (dist < bestDist - 0.01 || (Math.abs(dist - bestDist) < 0.01 && liq > (best?.volume ?? 0))) {
      bestDist = dist;
      best = c;
    }
  }
  const iv = ivToPct(best?.iv);
  return iv != null ? Math.round(iv) : null;
}

export function nearestKeyLevel(
  price: number | null,
  levels: KeyLevel[],
): { label: string; price: number; distPct: number } | null {
  if (price == null || !Number.isFinite(price) || price <= 0 || !levels.length) return null;
  let best: { label: string; price: number; distPct: number } | null = null;
  let bestDist = Infinity;
  for (const l of levels) {
    const distPct = (Math.abs(l.price - price) / price) * 100;
    if (distPct < bestDist) {
      bestDist = distPct;
      best = { label: l.label, price: l.price, distPct: +distPct.toFixed(3) };
    }
  }
  return best;
}

export function stripNearLevel(distPct: number | null, threshold = NEAR_LEVEL_PCT): boolean {
  return distPct != null && distPct <= threshold;
}

function quotePrice(quoteRes: any): number | null {
  const q = quoteRes?.quote ?? quoteRes;
  const p = q?.price ?? q?.last ?? null;
  return p != null && Number.isFinite(p) ? p : null;
}

async function fetchStripLevels(symbol: string, spot: number | null, nowMs: number) {
  const levels: KeyLevel[] = await cached(`strip-lvl:${symbol}`, STRIP_IV_TTL_MS, async () => {
    const candles: any = await fetchCandles(symbol, { resolution: "1", timespan: "minute", days: 1 }).catch(() => null);
    const bars = candles?.available ? candles.bars ?? [] : [];
    return keyLevels(bars);
  });
  const nearest = nearestKeyLevel(spot, levels);
  const mins = minutesToClose(nowMs);
  return {
    nearestLevelLabel: nearest?.label ?? null,
    nearestLevelDistPct: nearest?.distPct ?? null,
    nearLevel: stripNearLevel(nearest?.distPct ?? null),
    minutesToClose: mins,
  };
}

export interface StripContract {
  optionSymbol: string | null;
  strike: number;
  side: "call" | "put";
  bid: number | null;
  ask: number | null;
  mid: number;
  spreadPct: number | null;
  delta: number | null;
  /** % move of the underlying needed for the premium to break even. */
  breakevenPct: number;
  breakevenOk: boolean | null;
  distFromSpotPct: number;
}

export interface StripRow {
  symbol: string;
  price: number | null;
  atmIv: number | null;
  /** Nearest usable strike each side (delta 0.35-0.65 preferred). */
  call?: StripContract | null;
  put?: StripContract | null;
  nearestLevelLabel?: string | null;
  nearestLevelDistPct?: number | null;
  nearLevel?: boolean;
  minutesToClose?: number | null;
  error?: string;
}

export async function fetchStripAtmIv(symbol: string, nowMs = Date.now()): Promise<StripRow> {
  const sym = String(symbol).toUpperCase();
  return cached(`strip-iv:${sym}`, STRIP_IV_TTL_MS, async () => {
    const [quoteRes, chainRes]: any[] = await Promise.all([
      fetchQuote(sym).catch(() => null),
      fetchOptionChain(sym, { dteMin: 0, dteMax: 1, maxPages: 3 }).catch(() => null),
    ]);
    const price = quotePrice(quoteRes);
    let chain = chainRes;
    if (!chain?.available || !chain?.contracts?.length) {
      chain = await fetchOptionChain(sym, { dteMin: 0, dteMax: 5, maxPages: 3 });
    }
    const spot = price ?? chain?.contracts?.[0]?.underlyingPrice ?? null;
    const levelCtx = await fetchStripLevels(sym, spot, nowMs).catch(() => ({
      nearestLevelLabel: null,
      nearestLevelDistPct: null,
      nearLevel: false,
      minutesToClose: minutesToClose(nowMs),
    }));

    if (!chain?.available) {
      return {
        symbol: sym,
        price: spot,
        atmIv: null,
        call: null,
        put: null,
        error: chain?.note ?? "chain unavailable",
        ...levelCtx,
      };
    }
    // Near-the-money pair: what you'd actually buy. No extra API cost — the
    // chain is already here for ATM IV.
    // breakevenOk needs live speed context — the strip shows the raw "needs
    // X% move" number and lets the callout gates judge feasibility.
    // nearTheMoneyPair delegates to the centralized selector's nearTheMoney
    // (research display: nearest usable strike each side, non-actionable framing).
    const pair = nearTheMoneyPair(chain.contracts ?? [], spot);
    return {
      symbol: sym,
      price: spot,
      atmIv: atmIvFromContracts(chain.contracts ?? [], spot),
      call: pair.call,
      put: pair.put,
      ...levelCtx,
    };
  });
}

export async function fetchStripContext(symbols: string[], nowMs = Date.now()) {
  const uniq = Array.from(new Set(symbols.map((s) => String(s).toUpperCase()).filter(Boolean))).slice(0, 6);
  const rows = await Promise.all(uniq.map((s) => fetchStripAtmIv(s, nowMs)));
  return { symbols: uniq, rows };
}
