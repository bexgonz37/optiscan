/**
 * swing-scan.ts — server orchestrator for the 1–4 week swing scanner.
 *
 * Budget-first design (docs/SWING-SCANNER.md §6): on demand only, cached 15
 * minutes, chains fetched ONLY for the top price-action candidates, refuses
 * to run near the minute cap. All provider I/O goes through the metered
 * polygon-provider like everything else.
 */

import { fetchCandles, fetchOptionChain, getCallStats } from "@/lib/polygon-provider";
import { nearMinuteBudget } from "@/lib/near-miss";
import { getZeroDteUniverse } from "@/lib/universe";
import {
  scoreSwingCandidate, trendScore, momentumScore,
  type DailyBar, type SwingCandidate, type SwingContract,
} from "@/lib/swing-score";

const CACHE_MS = Number(process.env.SWING_CACHE_MS ?? 15 * 60_000);
const CHAIN_CANDIDATES = Number(process.env.SWING_CHAIN_CANDIDATES ?? 12);

interface SwingScanResult {
  ok: boolean;
  ranAtMs: number;
  candidates: SwingCandidate[];
  note: string | null;
  callsUsed: number;
}

type G = typeof globalThis & { __optiscanSwingCache?: { at: number; result: SwingScanResult } };

async function dailyBars(symbol: string): Promise<DailyBar[]> {
  const res: any = await fetchCandles(symbol, { resolution: "1", timespan: "day", days: 90 });
  return res?.available ? (res.bars as DailyBar[]) : [];
}

export async function runSwingScan(force = false): Promise<SwingScanResult> {
  const g = globalThis as G;
  const now = Date.now();
  if (!force && g.__optiscanSwingCache && now - g.__optiscanSwingCache.at < CACHE_MS) {
    return g.__optiscanSwingCache.result;
  }
  if (nearMinuteBudget(getCallStats(now))) {
    return { ok: false, ranAtMs: now, candidates: [], note: "deferred — provider minute budget nearly spent; try again shortly", callsUsed: 0 };
  }

  const before = getCallStats(now).callsToday;
  const universe = getZeroDteUniverse();

  // Pass 1: daily candles for everyone; cheap price-action prescreen.
  const withBars: { ticker: string; bars: DailyBar[]; pre: number }[] = [];
  for (const ticker of universe) {
    const bars = await dailyBars(ticker);
    if (bars.length < 55) continue;
    const pre = trendScore(bars).score * 0.6 + momentumScore(bars).score * 0.4;
    withBars.push({ ticker, bars, pre });
  }
  const spyBars = withBars.find((w) => w.ticker === "SPY")?.bars ?? (await dailyBars("SPY"));

  // Pass 2: chains only for the strongest price action (budget bound).
  const top = [...withBars].sort((a, b) => b.pre - a.pre).slice(0, CHAIN_CANDIDATES);
  const candidates: SwingCandidate[] = [];
  for (const { ticker, bars } of top) {
    if (nearMinuteBudget(getCallStats(Date.now()))) break; // stop fetching, score what we have
    const chain: any = await fetchOptionChain(ticker, { dteMin: 7, dteMax: 35, maxPages: 2 });
    const contracts: SwingContract[] = chain?.available ? chain.contracts : [];
    candidates.push(scoreSwingCandidate(ticker, bars, contracts, spyBars));
  }
  candidates.sort((a, b) => b.score - a.score);

  const result: SwingScanResult = {
    ok: true,
    ranAtMs: now,
    candidates,
    note: candidates.length < top.length ? "budget guard stopped some chain fetches — partial run" : null,
    callsUsed: getCallStats(Date.now()).callsToday - before,
  };
  g.__optiscanSwingCache = { at: now, result };
  return result;
}
