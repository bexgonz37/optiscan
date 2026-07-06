/**
 * scanner-loop.ts — the every-second underlying loop for 0DTE momentum.
 *
 * Architecture (per spec):
 *   1. UNDERLYING LOOP (default every 1s, SCANNER_LOOP_MS): ONE bulk snapshot
 *      call for the small 0DTE universe. Per symbol it maintains a ~5-minute
 *      ring buffer of (t, price, cumVolume) and computes acceleration, volume
 *      surge, path efficiency, and HOD/LOD/VWAP state — all in memory, all
 *      deterministic, no AI, no news.
 *   2. TRIGGER-GATED OPTIONS FETCH: chains are NEVER pulled wholesale. Only a
 *      symbol that passes shouldTrigger() gets a 0DTE chain fetch (dte<=1,
 *      falling back to <=5 when no same-day expiry exists), throttled to one
 *      chain per symbol per 60s, with a 5-minute re-trigger cooldown.
 *   3. ACTIVE-ALERT REFRESH: symbols alerted in the last 30 min get their
 *      chain re-quoted every SCANNER_ACTIVE_REFRESH_MS (default 7s, max 3
 *      symbols per beat) into options_snapshots (checkpoint 'live').
 *   4. BACKOFF: any 429 doubles the loop interval (up to 60s) and it decays
 *      back toward the target — a free-tier key degrades gracefully instead
 *      of melting.
 *
 * VWAP comes from 1-min candles cached 60s per symbol — only fetched for
 * symbols that are near-trigger, so the quiet 90% of the universe costs
 * nothing beyond the single shared snapshot call.
 */

import { fetchBulkQuotes, fetchCandles, fetchOptionChain } from "@/lib/polygon-provider";
import { vwap as sessionVwap, sessionBars, relativeVolume } from "@/lib/momentum-signals";
import {
  acceleration, volumeSurge, pathEfficiency, detectLevels, directionRead,
  shouldTrigger, rankZeroDteContracts, expectedRemainingMovePct,
} from "@/lib/zero-dte";
import { getZeroDteUniverse, getZeroDteDiscoveryUniverse } from "@/lib/universe";
import { tradingDay, minutesToClose, getDb } from "@/lib/db";

const LOOP_MS = Number(process.env.SCANNER_LOOP_MS ?? 1000);
const ACTIVE_REFRESH_MS = Number(process.env.SCANNER_ACTIVE_REFRESH_MS ?? 7000);
const TRIGGER_COOLDOWN_MS = Number(process.env.SCANNER_TRIGGER_COOLDOWN_MS ?? 5 * 60 * 1000);
const MIN_RATE = Number(process.env.SCANNER_MIN_RATE_PCT_MIN ?? 0.15);
const MIN_SURGE = Number(process.env.SCANNER_MIN_VOL_SURGE ?? 1.3);
const DISCOVERY_MS = Number(process.env.SCANNER_DISCOVERY_MS ?? 30_000);
const DISCOVERY_TOP_N = Number(process.env.SCANNER_DISCOVERY_TOP_N ?? 20);
const PROMOTION_MS = Number(process.env.SCANNER_PROMOTION_MS ?? 5 * 60_000);
const DISCOVERY_MIN_VOLUME = Number(process.env.SCANNER_DISCOVERY_MIN_VOLUME ?? 100_000);
const RING_MAX = 360; // ~6 minutes of 1s ticks

interface Tick { t: number; p: number; v: number }
interface SymState {
  ring: Tick[];
  cooldownUntil: number;
  lastChainFetch: number;
  vwap: number | null;
  vwapAt: number;
  relVol: number | null;
  lastAlertAt: number;
}

interface LoopState {
  running: boolean;
  intervalMs: number;
  targetMs: number;
  lastTickAt: number | null;
  ticks: number;
  triggers: number;
  alerts: number;
  errors: number;
  note: string | null;
  symbols: Map<string, SymState>;
  movers: any[];
  lastDiscoveryAt: number;
  discoveryCount: number;
  promoted: Map<string, number>;
}

type G = typeof globalThis & { __optiscanLoop?: LoopState; __optiscanLoopTimer?: ReturnType<typeof setTimeout> };

function state(): LoopState {
  const g = globalThis as G;
  if (!g.__optiscanLoop) {
    g.__optiscanLoop = {
      running: false, intervalMs: LOOP_MS, targetMs: LOOP_MS, lastTickAt: null,
      ticks: 0, triggers: 0, alerts: 0, errors: 0, note: null,
      symbols: new Map(), movers: [], lastDiscoveryAt: 0, discoveryCount: 0, promoted: new Map(),
    };
  }
  // Survive Next dev hot reloads from pre-discovery loop state.
  g.__optiscanLoop.lastDiscoveryAt ??= 0;
  g.__optiscanLoop.discoveryCount ??= 0;
  g.__optiscanLoop.promoted ??= new Map();
  return g.__optiscanLoop;
}

/** Promote broad-universe movers into the fast loop without fetching chains. */
async function refreshDiscovery(nowMs: number) {
  const s = state();
  const res: any = await fetchBulkQuotes(getZeroDteDiscoveryUniverse());
  if (!res?.available) {
    s.note = res?.note ?? "discovery snapshot unavailable";
    return;
  }
  s.discoveryCount = (res.quotes ?? []).length;
  const ranked = (res.quotes ?? [])
    .filter((q: any) => q?.symbol && q.price > 0 && q.changePercent != null && (q.volume ?? 0) >= DISCOVERY_MIN_VOLUME)
    .sort((a: any, b: any) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
    .slice(0, Math.max(0, DISCOVERY_TOP_N));
  for (const q of ranked) s.promoted.set(q.symbol, nowMs + PROMOTION_MS);
  for (const [ticker, expiresAt] of s.promoted) if (expiresAt <= nowMs) s.promoted.delete(ticker);
}

function realtimeUniverse(nowMs: number) {
  const s = state();
  for (const [ticker, expiresAt] of s.promoted) if (expiresAt <= nowMs) s.promoted.delete(ticker);
  return Array.from(new Set([...getZeroDteUniverse(), ...s.promoted.keys()]));
}

function sym(s: LoopState, ticker: string): SymState {
  let st = s.symbols.get(ticker);
  if (!st) {
    st = { ring: [], cooldownUntil: 0, lastChainFetch: 0, vwap: null, vwapAt: 0, relVol: null, lastAlertAt: 0 };
    s.symbols.set(ticker, st);
  }
  return st;
}

/** VWAP + relVol from 1-min candles, cached 60s, near-trigger symbols only. */
async function ensureVwap(ticker: string, st: SymState, nowMs: number) {
  if (nowMs - st.vwapAt < 60_000) return;
  st.vwapAt = nowMs; // set first so failures don't hot-loop
  const res: any = await fetchCandles(ticker, { resolution: "1", timespan: "minute", days: 1 });
  if (res?.available && res.bars?.length) {
    st.vwap = sessionVwap(sessionBars(res.bars));
    st.relVol = relativeVolume(res.bars, nowMs);
  }
}

async function handleTrigger(ticker: string, st: SymState, read: any, quote: any, nowMs: number) {
  const s = state();
  if (nowMs - st.lastChainFetch < 60_000) return; // chain throttle
  st.lastChainFetch = nowMs;
  st.cooldownUntil = nowMs + TRIGGER_COOLDOWN_MS;
  s.triggers++;

  // 0DTE first; if no same-day expiry (non-Friday single names), nearest week.
  let chain: any = await fetchOptionChain(ticker, { dteMin: 0, dteMax: 1, maxPages: 2 });
  if (!chain?.available || !chain.contracts?.length) {
    chain = await fetchOptionChain(ticker, { dteMin: 0, dteMax: 5, maxPages: 2 });
  }
  if (!chain?.available) return;

  const minsToClose = minutesToClose(nowMs);
  const expRemainPct = expectedRemainingMovePct({ shortRate: read.accelRead.shortRate ?? 0, minsToClose });
  const bestCall = rankZeroDteContracts(chain.contracts, "call", { minsToClose, expRemainPct, max: 1 } as any)[0]?.contract ?? null;
  const bestPut = rankZeroDteContracts(chain.contracts, "put", { minsToClose, expRemainPct, max: 1 } as any)[0]?.contract ?? null;

  const { captureZeroDte } = await import("@/lib/alert-capture");
  const id = await captureZeroDte({
    ticker, price: quote.price, movePct: quote.changePercent ?? 0,
    shortRate: read.accelRead.shortRate, accel: read.accelRead.accel,
    surge: read.surge, relVol: st.relVol, efficiency: read.efficiency,
    vwap: st.vwap, aboveVwap: read.levels.aboveVwap,
    hodBreak: read.levels.hodBreak, lodBreak: read.levels.lodBreak,
    direction: read.dir.direction, directionConfidence: read.dir.confidence,
    shareVolume: quote.volume ?? null, bestCall, bestPut,
    chainContracts: chain.contracts,
    source: "momentum", alertType: "0dte_momentum", nowMs,
  });
  if (id != null) {
    st.lastAlertAt = nowMs;
    s.alerts++;
  }
}

/** Refresh live option quotes for recently-alerted symbols (bounded). */
async function refreshActiveAlerts(nowMs: number) {
  const s = state();
  const active = [...s.symbols.entries()]
    .filter(([, st]) => st.lastAlertAt && nowMs - st.lastAlertAt < 30 * 60_000)
    .slice(0, 3);
  for (const [ticker, st] of active) {
    if (nowMs - st.lastChainFetch < ACTIVE_REFRESH_MS) continue;
    st.lastChainFetch = nowMs;
    const chain: any = await fetchOptionChain(ticker, { dteMin: 0, dteMax: 1, maxPages: 1 });
    if (!chain?.available) continue;
    try {
      const db = getDb();
      const alert: any = db.prepare(
        "SELECT id, option_symbol FROM alerts WHERE ticker=? AND trading_day=? ORDER BY id DESC LIMIT 1",
      ).get(ticker, tradingDay(nowMs));
      if (!alert?.option_symbol) continue;
      const c = chain.contracts.find((x: any) => x.optionSymbol === alert.option_symbol);
      if (!c) continue;
      db.prepare(
        `INSERT INTO options_snapshots (alert_id, taken_at, checkpoint, option_symbol, bid, ask, mid, spread_pct, volume, open_interest, iv, delta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(alert.id, new Date(nowMs).toISOString(), "live", c.optionSymbol, c.bid, c.ask, c.mid, c.spreadPct, c.volume, c.openInterest, c.iv, c.delta);
    } catch { /* snapshot bookkeeping never breaks the loop */ }
  }
}

async function tick() {
  const s = state();
  const nowMs = Date.now();
  s.lastTickAt = nowMs;
  s.ticks++;

  if (nowMs - s.lastDiscoveryAt >= DISCOVERY_MS) {
    s.lastDiscoveryAt = nowMs;
    refreshDiscovery(nowMs).catch((err) => { s.errors++; console.warn("[0dte-loop] discovery failed:", err?.message); });
  }
  const res: any = await fetchBulkQuotes(realtimeUniverse(nowMs));
  if (!res?.available) {
    s.errors++;
    s.note = res?.note ?? "snapshot unavailable";
    if (String(s.note).includes("429")) s.intervalMs = Math.min(s.intervalMs * 2, 60_000); // backoff
    return;
  }
  s.note = null;
  s.intervalMs = Math.max(s.targetMs, Math.round(s.intervalMs * 0.8)); // decay back after backoff

  const movers: any[] = [];
  for (const q of res.quotes ?? []) {
    if (q.price == null) continue;
    const st = sym(s, q.symbol);
    st.ring.push({ t: nowMs, p: q.price, v: q.volume ?? 0 });
    if (st.ring.length > RING_MAX) st.ring.shift();
    if (st.ring.length < 10) continue; // warm-up

    const accelRead = acceleration(st.ring, { nowMs } as any);
    const surge = volumeSurge(st.ring, { nowMs } as any);
    const efficiency = pathEfficiency(st.ring, { nowMs } as any);
    const nearTrigger = accelRead.shortRate != null && Math.abs(accelRead.shortRate) >= MIN_RATE * 0.7;
    if (nearTrigger) await ensureVwap(q.symbol, st, nowMs);
    const levels = detectLevels({ price: q.price, dayHigh: q.dayHigh, dayLow: q.dayLow, vwap: st.vwap });
    const dir = directionRead({
      movePct: q.changePercent, shortRate: accelRead.shortRate, accel: accelRead.accel,
      aboveVwap: levels.aboveVwap, hodBreak: levels.hodBreak, lodBreak: levels.lodBreak, efficiency,
    });

    movers.push({
      symbol: q.symbol, price: q.price, movePct: q.changePercent,
      shortRate: accelRead.shortRate, accel: accelRead.accel, surge, efficiency,
      direction: dir.direction, confidence: dir.confidence,
      hodBreak: levels.hodBreak, lodBreak: levels.lodBreak, aboveVwap: levels.aboveVwap,
    });

    if (shouldTrigger({
      shortRate: accelRead.shortRate, surge, hodBreak: levels.hodBreak, lodBreak: levels.lodBreak,
      efficiency, nowMs, cooldownUntil: st.cooldownUntil, minRate: MIN_RATE, minSurge: MIN_SURGE,
    })) {
      // fire-and-forget: the 1s heartbeat must never wait on a chain fetch
      handleTrigger(q.symbol, st, { accelRead, surge, efficiency, levels, dir }, q, nowMs)
        .catch((err) => { s.errors++; console.warn("[0dte-loop] trigger failed:", err?.message); });
    }
  }
  s.movers = movers.sort((a, b) => Math.abs(b.shortRate ?? 0) - Math.abs(a.shortRate ?? 0)).slice(0, 20);

  refreshActiveAlerts(nowMs).catch(() => {});
}

export function startScannerLoop() {
  const g = globalThis as G;
  const s = state();
  if (s.running) return;
  if (process.env.SCANNER_REALTIME === "0") { console.log("[0dte-loop] disabled (SCANNER_REALTIME=0)"); return; }
  s.running = true;
  let busy = false;
  const beat = async () => {
    if (!busy) {
      busy = true;
      try { await tick(); } catch (err: any) { s.errors++; console.warn("[0dte-loop] tick failed:", err?.message); }
      busy = false;
    }
    g.__optiscanLoopTimer = setTimeout(beat, s.intervalMs);
    (g.__optiscanLoopTimer as any)?.unref?.();
  };
  beat();
  console.log(`[0dte-loop] running every ${s.intervalMs}ms over ${getZeroDteUniverse().length} symbols (chains fetch on trigger only)`);
}

/** Read-only view for /api/scanner/live. */
export function loopState() {
  const s = state();
  return {
    running: s.running, intervalMs: s.intervalMs, lastTickAt: s.lastTickAt,
    ticks: s.ticks, triggers: s.triggers, alerts: s.alerts, errors: s.errors,
    note: s.note, movers: s.movers,
    coreSymbols: getZeroDteUniverse().length,
    discoverySymbols: s.discoveryCount,
    promotedSymbols: [...s.promoted.keys()],
  };
}
