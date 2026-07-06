/**
 * zero-dte-context.ts — universe-driven 0DTE strip symbol resolution + ATM IV helpers.
 */

import { getZeroDteUniverse } from "./universe.js";
import { fetchOptionChain, fetchQuote } from "./polygon-provider.js";
import { ivToPct } from "./alert-scoring";
import { cached } from "./scan-cache";

const STRIP_IV_TTL_MS = 90_000;

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
  const overrideList = (override ?? []).map(norm).filter(Boolean).slice(0, cap);

  if (overrideList.length) {
    const sel = chartSymbol ? norm(chartSymbol) : null;
    if (sel && !overrideList.includes(sel)) return [sel, ...overrideList].slice(0, cap);
    return overrideList;
  }

  const out: string[] = [];
  const sel = chartSymbol ? norm(chartSymbol) : null;
  if (sel) out.push(sel);
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

export async function fetchStripAtmIv(symbol: string): Promise<{ symbol: string; price: number | null; atmIv: number | null; error?: string }> {
  const sym = String(symbol).toUpperCase();
  return cached(`strip-iv:${sym}`, STRIP_IV_TTL_MS, async () => {
    const [quoteRes, chainRes]: any[] = await Promise.all([
      fetchQuote(sym).catch(() => null),
      fetchOptionChain(sym, { dteMin: 0, dteMax: 1, maxPages: 1 }).catch(() => null),
    ]);
    const price = quoteRes?.price ?? quoteRes?.last ?? null;
    let chain = chainRes;
    if (!chain?.available || !chain?.contracts?.length) {
      chain = await fetchOptionChain(sym, { dteMin: 0, dteMax: 5, maxPages: 1 });
    }
    if (!chain?.available) {
      return { symbol: sym, price, atmIv: null, error: chain?.note ?? "chain unavailable" };
    }
    const spot = price ?? chain.contracts?.[0]?.underlyingPrice ?? null;
    return { symbol: sym, price: spot, atmIv: atmIvFromContracts(chain.contracts ?? [], spot) };
  });
}

export async function fetchStripContext(symbols: string[]) {
  const uniq = Array.from(new Set(symbols.map((s) => String(s).toUpperCase()).filter(Boolean))).slice(0, 6);
  const rows = await Promise.all(uniq.map((s) => fetchStripAtmIv(s)));
  return { symbols: uniq, rows };
}
