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
 *      falling back to <=5 when no same-day expiry exists). Chains are
 *      prefetched while a symbol is near-trigger so the alert isn't delayed
 *      by a cold fetch. Active-alert refresh uses a separate throttle.
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

import { fetchBulkQuotes, fetchCandles, fetchOptionChain, fetchTopMovers, isRecapNoiseSymbol } from "@/lib/polygon-provider";
import { vwap as sessionVwap, sessionBars, relativeVolume } from "@/lib/momentum-signals";
import {
  acceleration, volumeSurge, pathEfficiency, detectLevels, directionRead,
  shouldTrigger, rankZeroDteContracts, expectedRemainingMovePct,
  speedPersistentFromRing,
} from "@/lib/zero-dte";
import { getZeroDteUniverse, getZeroDteDiscoveryUniverse, isCoreSymbol } from "@/lib/universe";
import { tradingDay, minutesToClose, marketSession, type MarketSession } from "@/lib/trading-session";
import { getSettingNum } from "@/lib/alert-store";
import { getCallStats } from "@/lib/polygon-provider";
import {
  firstFailedGate, recordNearMiss, shouldRecordNearMiss, nearMinuteBudget,
  type NearMissEntry,
} from "@/lib/near-miss";
import { detectMajorMove } from "@/lib/major-move";
import { maybeEmitPositionCallout } from "@/lib/position-callout";

const LOOP_MS = Number(process.env.SCANNER_LOOP_MS ?? 1000);
const ACTIVE_REFRESH_MS = Number(process.env.SCANNER_ACTIVE_REFRESH_MS ?? 7000);
const TRIGGER_COOLDOWN_MS = Number(process.env.SCANNER_TRIGGER_COOLDOWN_MS ?? 10 * 60 * 1000);
const CORE_TRIGGER_COOLDOWN_MS = Number(process.env.SCANNER_CORE_TRIGGER_COOLDOWN_MS ?? 3 * 60 * 1000);
const DISCOVERY_MS = Number(process.env.SCANNER_DISCOVERY_MS ?? 30_000);
const DISCOVERY_TOP_N = Number(process.env.SCANNER_DISCOVERY_TOP_N ?? 30);
const PROMOTION_MS = Number(process.env.SCANNER_PROMOTION_MS ?? 5 * 60_000);
const DISCOVERY_MIN_VOLUME = Number(process.env.SCANNER_DISCOVERY_MIN_VOLUME ?? 50_000);
const TAPE_ENRICH_MS = Number(process.env.SCANNER_TAPE_ENRICH_MS ?? 30_000);
// When a trigger's capture returns null (SKIP tier / dedup) the full cooldown
// is intentionally NOT consumed (so an improving setup can still fire), but a
// short retry window is required: with no cooldown at all, a hot symbol that
// keeps SKIPping re-triggers EVERY TICK, each with a chain fetch — a 1/s
// quota burn. 45s caps that at ~1 fetch/min/symbol.
const SKIP_RETRY_COOLDOWN_MS = Number(process.env.SCANNER_SKIP_RETRY_COOLDOWN_MS ?? 45_000);
const RING_MAX = 360; // ~6 minutes of 1s ticks

interface Tick { t: number; p: number; v: number }
interface SymState {
  ring: Tick[];
  recentRates: number[];
  cooldownUntil: number;
  optionsCooldownUntil: number;
  stockCooldownUntil: number;
  /** Throttle for active-alert quote refresh only — never block new triggers. */
  lastChainFetch: number;
  prefetchedChain: any | null;
  prefetchAt: number;
  vwap: number | null;
  vwapAt: number;
  relVol: number | null;
  lastAlertAt: number;
  lastOptionsAlertAt: number;
  lastNearMissAt: number;
  lastMajorMoveAt: number;
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
  session: MarketSession | null;
  symbols: Map<string, SymState>;
  movers: any[];
  tape: any[];
  lastDiscoveryAt: number;
  discoveryCount: number;
  promoted: Map<string, number>;
  lastTapeEnrichAt: number;
  lastRecapAt: number;
  tapeBadgeCache: Map<string, { catalystType?: string; catalystFresh?: boolean; haltStatus?: string | null }>;
  nearMisses: NearMissEntry[];
  majorMoves: any[];
}

type G = typeof globalThis & { __optiscanLoop?: LoopState; __optiscanLoopTimer?: ReturnType<typeof setTimeout> };

function state(): LoopState {
  const g = globalThis as G;
  if (!g.__optiscanLoop) {
    g.__optiscanLoop = {
      running: false, intervalMs: LOOP_MS, targetMs: LOOP_MS, lastTickAt: null,
      ticks: 0, triggers: 0, alerts: 0, errors: 0, note: null, session: null,
      symbols: new Map(), movers: [], tape: [], lastDiscoveryAt: 0, discoveryCount: 0, promoted: new Map(),
      lastTapeEnrichAt: 0, lastRecapAt: 0, tapeBadgeCache: new Map(),
      nearMisses: [],
      majorMoves: [],
    };
  }
  // Survive Next dev hot reloads from pre-discovery loop state.
  g.__optiscanLoop.session ??= null;
  g.__optiscanLoop.lastDiscoveryAt ??= 0;
  g.__optiscanLoop.discoveryCount ??= 0;
  g.__optiscanLoop.promoted ??= new Map();
  g.__optiscanLoop.lastTapeEnrichAt ??= 0;
  g.__optiscanLoop.lastRecapAt ??= 0;
  g.__optiscanLoop.tapeBadgeCache ??= new Map();
  g.__optiscanLoop.nearMisses ??= [];
  g.__optiscanLoop.majorMoves ??= [];
  return g.__optiscanLoop;
}

/** When the session is closed, show Polygon snapshot movers (Robinhood-style recap). */
async function refreshClosedRecap(nowMs: number) {
  const s = state();
  const [gainers, losers] = await Promise.all([
    fetchTopMovers("gainers", 20),
    fetchTopMovers("losers", 20),
  ]);
  if (!gainers?.available && !losers?.available) {
    s.note = gainers?.note ?? losers?.note ?? "market closed — snapshot unavailable";
    return;
  }
  const seen = new Set<string>();
  const quotes = [...(gainers?.quotes ?? []), ...(losers?.quotes ?? [])].filter((q: any) => {
    if (!q?.symbol || seen.has(q.symbol)) return false;
    if (isRecapNoiseSymbol(q.symbol, q.price)) return false;
    seen.add(q.symbol);
    return q.price != null && q.changePercent != null;
  });
  quotes.sort((a: any, b: any) => Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0));
  s.tape = quotes.slice(0, 40).map((q: any) => ({
    symbol: q.symbol,
    price: q.price,
    movePct: q.changePercent,
    volume: q.volume ?? null,
    shortRate: null,
    accel: null,
    surge: null,
    efficiency: null,
    direction: (q.changePercent ?? 0) > 0.15 ? "bullish" : (q.changePercent ?? 0) < -0.15 ? "bearish" : "choppy",
    confidence: 20,
    hodBreak: false,
    lodBreak: false,
    aboveVwap: null,
    vwapDistPct: null,
    relVol: null,
    promoted: false,
    core: isCoreSymbol(q.symbol),
    recap: true,
  }));
  s.movers = s.tape.slice(0, 20);
  s.lastRecapAt = nowMs;
  s.note = "Market closed — latest snapshot movers (live scan resumes 4:00 AM ET)";
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
  const newlyPromoted = ranked.filter((q: any) => !s.promoted.has(q.symbol)).map((q: any) => q.symbol);
  for (const q of ranked) s.promoted.set(q.symbol, nowMs + PROMOTION_MS);
  for (const [ticker, expiresAt] of s.promoted) if (expiresAt <= nowMs) s.promoted.delete(ticker);
  // Latency fix (2026-07-09): a freshly promoted discovery name used to sit
  // through a 10-tick live warmup before it could ever trigger — by then the
  // move was minutes old (the "RIVN alerted at the top" failure). Seed its
  // ring from 1-min candle history so persistence/velocity windows are warm
  // on arrival. Bounded + budget-aware; gates themselves are unchanged.
  if (newlyPromoted.length && !nearMinuteBudget(getCallStats(nowMs))) {
    for (const ticker of newlyPromoted.slice(0, 4)) {
      seedRingFromCandles(ticker, nowMs).catch(() => { /* seeding is best-effort */ });
    }
  }
}

/** Backfill a symbol's ring with synthetic 5s ticks from recent 1-min bars. */
async function seedRingFromCandles(ticker: string, nowMs: number) {
  const s = state();
  const st = sym(s, ticker);
  if (st.ring.length >= 10) return; // already warm
  const res: any = await fetchCandles(ticker, { resolution: "1", timespan: "minute", days: 1, countback: 8 });
  if (!res?.available || !res.bars?.length) return;
  if (st.ring.length >= 10) return; // live ticks won the race — don't clobber
  const bars = res.bars.slice(-8);
  const seeded: { t: number; p: number; v: number }[] = [];
  let cumVol = 0;
  for (const b of bars) {
    cumVol += b.v ?? 0;
    // Interpolate o→c inside each minute as 12 × 5s pseudo-ticks so the
    // velocity/persistence windows have realistic sub-minute structure.
    for (let i = 1; i <= 12; i++) {
      seeded.push({ t: b.t + i * 5000, p: b.o + ((b.c - b.o) * i) / 12, v: cumVol });
    }
  }
  const cutoff = st.ring[0]?.t ?? nowMs;
  st.ring.unshift(...seeded.filter((x) => x.t < cutoff).slice(-RING_MAX + st.ring.length));
  console.log(`[0dte-loop] seeded ${ticker} ring from candles (${st.ring.length} ticks) — warm on promotion`);
}

function realtimeUniverse(nowMs: number) {
  const s = state();
  for (const [ticker, expiresAt] of s.promoted) if (expiresAt <= nowMs) s.promoted.delete(ticker);
  return Array.from(new Set([...getZeroDteUniverse(), ...s.promoted.keys()]));
}

function sym(s: LoopState, ticker: string): SymState {
  let st = s.symbols.get(ticker);
  if (!st) {
    st = {
      ring: [], recentRates: [], cooldownUntil: 0, optionsCooldownUntil: 0, stockCooldownUntil: 0, lastChainFetch: 0,
      prefetchedChain: null, prefetchAt: 0,
      vwap: null, vwapAt: 0, relVol: null, lastAlertAt: 0, lastOptionsAlertAt: 0, lastNearMissAt: 0, lastMajorMoveAt: 0,
    };
    s.symbols.set(ticker, st);
  }
  st.optionsCooldownUntil ??= st.cooldownUntil ?? 0;
  st.stockCooldownUntil ??= 0;
  st.lastOptionsAlertAt ??= st.lastAlertAt ?? 0;
  st.lastNearMissAt ??= 0;
  st.lastMajorMoveAt ??= 0;
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

/** Warm chain fetch while a symbol is heating up — shaves 1–3s off callout latency. */
function prefetchChain(ticker: string, st: SymState, nowMs: number) {
  const minGap = isCoreSymbol(ticker) ? 5_000 : 8_000;
  if (nowMs - st.prefetchAt < minGap) return;
  if (st.prefetchedChain?.available && st.prefetchedChain?.contracts?.length) return;
  st.prefetchAt = nowMs;
  fetchOptionChain(ticker, { dteMin: 0, dteMax: 1, maxPages: 2 })
    .then((chain: any) => {
      if (chain?.available && chain.contracts?.length) {
        st.prefetchedChain = chain;
        return null;
      }
      return fetchOptionChain(ticker, { dteMin: 0, dteMax: 5, maxPages: 2 });
    })
    .then((chain: any) => {
      if (chain?.available) st.prefetchedChain = chain;
    })
    .catch(() => {});
}

/** Extended-hours trigger: regular-stock callout, NO option chain fetch. */
async function handleStockTrigger(ticker: string, st: SymState, read: any, quote: any, nowMs: number) {
  if (process.env.STOCK_CALLOUTS !== "1") return;
  const s = state();
  const core = isCoreSymbol(ticker);
  const promoted = s.promoted.has(ticker);
  if (!core && !promoted) return;
  if (nowMs < st.stockCooldownUntil) return;
  const cooldownMs = isCoreSymbol(ticker) ? CORE_TRIGGER_COOLDOWN_MS : TRIGGER_COOLDOWN_MS;
  s.triggers++;
  const { captureStockAlert } = await import("@/lib/stock-capture");
  const id = await captureStockAlert({
    ticker, price: quote.price, movePct: quote.changePercent ?? 0,
    shortRate: read.accelRead.shortRate, accel: read.accelRead.accel,
    surge: read.surge, relVol: st.relVol, efficiency: read.efficiency,
    vwap: st.vwap, aboveVwap: read.levels.aboveVwap,
    hodBreak: read.levels.hodBreak, lodBreak: read.levels.lodBreak,
    direction: read.dir.direction, directionConfidence: read.dir.confidence,
    shareVolume: quote.volume ?? null, nowMs,
  });
  if (id != null) {
    st.lastAlertAt = nowMs;
    st.stockCooldownUntil = nowMs + cooldownMs;
    s.alerts++;
  } else {
    st.stockCooldownUntil = Math.max(st.stockCooldownUntil, nowMs + SKIP_RETRY_COOLDOWN_MS);
  }
}

async function handleTrigger(ticker: string, st: SymState, read: any, quote: any, nowMs: number) {
  const s = state();
  if (nowMs < st.optionsCooldownUntil) return;
  const cooldownMs = isCoreSymbol(ticker) ? CORE_TRIGGER_COOLDOWN_MS : TRIGGER_COOLDOWN_MS;
  s.triggers++;

  let chain: any = st.prefetchedChain;
  const prefetchFresh = chain?.available && chain?.contracts?.length && nowMs - st.prefetchAt < 25_000;
  if (!prefetchFresh) {
    chain = await fetchOptionChain(ticker, { dteMin: 0, dteMax: 1, maxPages: 2 });
    if (!chain?.available || !chain.contracts?.length) {
      chain = await fetchOptionChain(ticker, { dteMin: 0, dteMax: 5, maxPages: 2 });
    }
  }
  st.prefetchedChain = null;
  if (!chain?.available) {
    // Provider hiccup — short retry window, not a 1/s chain-fetch hammer.
    st.optionsCooldownUntil = Math.max(st.optionsCooldownUntil, nowMs + SKIP_RETRY_COOLDOWN_MS);
    return;
  }

  const minsToClose = minutesToClose(nowMs);
  const expRemainPct = expectedRemainingMovePct({ shortRate: read.accelRead.shortRate ?? 0, minsToClose });
  const bestCall = rankZeroDteContracts(chain.contracts, "call", { minsToClose, expRemainPct, max: 1, underlying: quote.price } as any)[0]?.contract ?? null;
  const bestPut = rankZeroDteContracts(chain.contracts, "put", { minsToClose, expRemainPct, max: 1, underlying: quote.price } as any)[0]?.contract ?? null;

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
    st.lastOptionsAlertAt = nowMs;
    st.optionsCooldownUntil = nowMs + cooldownMs;
    s.alerts++;
  } else {
    st.optionsCooldownUntil = Math.max(st.optionsCooldownUntil, nowMs + SKIP_RETRY_COOLDOWN_MS);
  }
}

/** Refresh live option quotes for recently-alerted symbols (bounded). */
async function refreshActiveAlerts(nowMs: number) {
  const s = state();
  const active = [...s.symbols.entries()]
    .filter(([, st]) => st.lastOptionsAlertAt && nowMs - st.lastOptionsAlertAt < 30 * 60_000)
    .slice(0, 3);
  for (const [ticker, st] of active) {
    if (nowMs - st.lastChainFetch < ACTIVE_REFRESH_MS) continue;
    st.lastChainFetch = nowMs;
    const chain: any = await fetchOptionChain(ticker, { dteMin: 0, dteMax: 1, maxPages: 1 });
    if (!chain?.available) continue;
    // Fast paper exits (2026-07-09): reuse this already-fetched chain so open
    // paper trades on hot symbols react in ~7s (0DTE moves fast) — zero extra
    // API cost. Never allowed to break the heartbeat.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("@/lib/paper-engine").evaluatePaperTradesWithChain(ticker, chain.contracts, nowMs);
    } catch { /* paper piggyback is best-effort */ }
    try {
      const { getDb } = await import("@/lib/db");
      const db = getDb();
      // Mark EVERY open ticket for this ticker, not just the newest row —
      // audit found 22/23 TRADE orders had zero live marks (ungradeable)
      // because marks all attached to the ticker's latest alert.
      const open: any[] = db.prepare(
        `SELECT id, option_symbol FROM alerts
         WHERE ticker=? AND trading_day=? AND option_symbol IS NOT NULL
           AND status='tracking' AND (capture_action='TRADE' OR id=(SELECT MAX(id) FROM alerts WHERE ticker=? AND trading_day=?))
         ORDER BY id DESC LIMIT 6`,
      ).all(ticker, tradingDay(nowMs), ticker, tradingDay(nowMs));
      const ins = db.prepare(
        `INSERT INTO options_snapshots (alert_id, taken_at, checkpoint, option_symbol, bid, ask, mid, spread_pct, volume, open_interest, iv, delta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const alert of open) {
        const c = chain.contracts.find((x: any) => x.optionSymbol === alert.option_symbol);
        if (!c) continue;
        ins.run(alert.id, new Date(nowMs).toISOString(), "live", c.optionSymbol, c.bid, c.ask, c.mid, c.spreadPct, c.volume, c.openInterest, c.iv, c.delta);
      }
    } catch { /* snapshot bookkeeping never breaks the loop */ }
  }
}

/** Throttled news enrichment for top tape symbols (catalyst + halt badges). */
async function enrichTapeContext(tape: any[], nowMs: number) {
  const top = [...tape]
    .filter((r) => r?.symbol && Math.abs(r.shortRate ?? 0) > 0)
    .sort((a, b) => Math.abs(b.shortRate ?? 0) - Math.abs(a.shortRate ?? 0))
    .slice(0, 8);
  if (!top.length) return;

  const { fetchNews } = await import("@/lib/polygon-provider");
  const { cached } = await import("@/lib/scan-cache");
  const { classifyHeadline } = await import("@/lib/catalysts");
  const { inferHaltStatus, catalystFromNews } = await import("@/lib/halt-inference");

  await Promise.all(
    top.map(async (row) => {
      try {
        const news: any = await cached(`loop-news:${row.symbol}`, 120_000, () =>
          fetchNews(row.symbol, { limit: 8, days: 2 }),
        );
        const articles = news?.articles ?? news?.results ?? [];
        const headlines = articles.map((a: any) => a.title ?? a.headline ?? "").filter(Boolean);
        const cat = catalystFromNews(articles, classifyHeadline, nowMs);
        row.catalystType = cat.catalystType;
        row.catalystFresh = cat.catalystFresh;
        row.haltStatus = inferHaltStatus(headlines);
      } catch {
        row.catalystType ??= "no_clear_catalyst";
        row.catalystFresh ??= false;
        row.haltStatus ??= null;
      }
    }),
  );
}

async function tick() {
  const s = state();
  const nowMs = Date.now();
  s.lastTickAt = nowMs;
  s.ticks++;

  // Options-only: scan during regular hours; outside RTH the loop still
  // updates tape for charts but does not fire callouts.
  const session: MarketSession = marketSession(nowMs);
  s.session = session;
  if (session === "closed") {
    if (nowMs - s.lastRecapAt >= 60_000 || !s.tape.length) {
      await refreshClosedRecap(nowMs).catch((err) => {
        s.errors++;
        s.note = err?.message ?? "market closed — recap unavailable";
      });
    }
    return;
  }
  if (session !== "regular") {
    s.note = "0DTE callouts fire 9:30–4:00 ET — tape still live for charts";
  }

  // Core: 10s/20s — early enough to catch the move, long enough to skip 1-tick
  // flickers (audit: 8s fired 6 TRADEs with 0% stock follow-through @ 5m).
  const minRate = getSettingNum("scanner_min_rate_pct_min", Number(process.env.SCANNER_MIN_RATE_PCT_MIN ?? 0.17));
  const minSurge = getSettingNum("scanner_min_vol_surge", Number(process.env.SCANNER_MIN_VOL_SURGE ?? 1.32));
  const minAccel = getSettingNum("scanner_min_accel", Number(process.env.SCANNER_MIN_ACCEL ?? 0));
  const minEfficiency = getSettingNum("scanner_min_efficiency", Number(process.env.SCANNER_MIN_EFFICIENCY ?? 0.30));
  const minLevelSurge = getSettingNum("scanner_min_level_surge", Number(process.env.SCANNER_MIN_LEVEL_SURGE ?? 1.25));

  if (nowMs - s.lastDiscoveryAt >= DISCOVERY_MS) {
    s.lastDiscoveryAt = nowMs;
    refreshDiscovery(nowMs).catch((err) => { s.errors++; console.warn("[0dte-loop] discovery failed:", err?.message); });
  }
  const res: any = await fetchBulkQuotes(realtimeUniverse(nowMs));
  if (!res?.available) {
    s.errors++;
    s.note = res?.note ?? "snapshot unavailable";
    // quota_exceeded (central call-cap guard) backs off exactly like a 429.
    if (String(s.note).includes("429") || String(s.note).includes("quota_exceeded")) s.intervalMs = Math.min(s.intervalMs * 2, 60_000); // backoff
    return;
  }
  s.note = null;
  s.intervalMs = Math.max(s.targetMs, Math.round(s.intervalMs * 0.8)); // decay back after backoff

  const movers: any[] = [];
  const tape: any[] = [];
  const vwapCandidates: { symbol: string; st: SymState; rate: number }[] = [];

  const quotes = [...(res.quotes ?? [])];
  quotes.sort((a, b) => (isCoreSymbol(a.symbol) ? 0 : 1) - (isCoreSymbol(b.symbol) ? 0 : 1));
  for (const q of quotes) {
    if (q.price == null) continue;
    const st = sym(s, q.symbol);
    st.ring.push({ t: nowMs, p: q.price, v: q.volume ?? 0 });
    if (st.ring.length > RING_MAX) st.ring.shift();

    const core = isCoreSymbol(q.symbol);
    const warmupMin = core ? 6 : 10;

    if (st.ring.length < warmupMin) {
      const warmLevels = detectLevels({ price: q.price, dayHigh: q.dayHigh, dayLow: q.dayLow, vwap: st.vwap });
      tape.push({
        symbol: q.symbol, price: q.price, movePct: q.changePercent, volume: q.volume ?? null,
        shortRate: null, accel: null, surge: null, efficiency: null,
        direction: (q.changePercent ?? 0) > 0.15 ? "bullish" : (q.changePercent ?? 0) < -0.15 ? "bearish" : "choppy",
        confidence: 15,
        hodBreak: warmLevels.hodBreak, lodBreak: warmLevels.lodBreak,
        aboveVwap: warmLevels.aboveVwap, vwapDistPct: warmLevels.vwapDistPct, relVol: st.relVol,
        promoted: s.promoted.has(q.symbol),
        core: isCoreSymbol(q.symbol),
      });
      continue;
    }

    // Core: 9s speed window — responsive but filters 1-tick flickers.
    const shortMs = core ? 9_000 : 12_000;
    const surgeShortMs = core ? 14_000 : 20_000;
    const surgeLongMs = core ? 90_000 : 120_000;
    const accelRead = acceleration(st.ring, { shortMs, nowMs } as any);
    const instantRead = acceleration(st.ring, { shortMs: 5000, nowMs } as any);
    const surge = volumeSurge(st.ring, { shortMs: surgeShortMs, longMs: surgeLongMs, nowMs } as any);
    const efficiency = pathEfficiency(st.ring, { nowMs } as any);
    const triggerMinRate = core ? minRate * 0.9 : minRate;
    const triggerMinSurge = core ? Math.max(1.22, minSurge - 0.08) : minSurge;
    const triggerMinEff = core ? minEfficiency * 0.9 : minEfficiency;
    const nearTrigger =
      (accelRead.shortRate != null && Math.abs(accelRead.shortRate) >= triggerMinRate * 0.6)
      || (core && instantRead.shortRate != null && Math.abs(instantRead.shortRate) >= triggerMinRate * 0.55);
    if (nearTrigger) {
      await ensureVwap(q.symbol, st, nowMs);
      // Warm prefetch is an optimization; near the minute cap the budget is
      // saved for real triggers (audit P1-8). Trigger fetches are never deferred.
      if (session === "regular" && !nearMinuteBudget(getCallStats(nowMs))) prefetchChain(q.symbol, st, nowMs);
    }
    if (accelRead.shortRate != null) {
      vwapCandidates.push({ symbol: q.symbol, st, rate: Math.abs(accelRead.shortRate) });
    }
    const levels = detectLevels({ price: q.price, dayHigh: q.dayHigh, dayLow: q.dayLow, vwap: st.vwap });
    const dir = directionRead({
      movePct: q.changePercent, shortRate: accelRead.shortRate, accel: accelRead.accel,
      aboveVwap: levels.aboveVwap, hodBreak: levels.hodBreak, lodBreak: levels.lodBreak, efficiency,
    });

    if (accelRead.shortRate != null) {
      st.recentRates.push(accelRead.shortRate);
      if (st.recentRates.length > 5) st.recentRates.shift();
    }

    const row = {
      symbol: q.symbol, price: q.price, movePct: q.changePercent, volume: q.volume ?? null,
      shortRate: accelRead.shortRate, instantRate: instantRead.shortRate, accel: accelRead.accel, surge, efficiency,
      direction: dir.direction, confidence: dir.confidence,
      hodBreak: levels.hodBreak, lodBreak: levels.lodBreak, aboveVwap: levels.aboveVwap,
      vwapDistPct: levels.vwapDistPct, relVol: st.relVol,
      promoted: s.promoted.has(q.symbol),
      core: isCoreSymbol(q.symbol),
    };

    tape.push(row);
    if (Math.abs(accelRead.shortRate ?? 0) >= minRate * 0.5 || nearTrigger) {
      movers.push(row);
    }

    // Day-timeframe major-move detection (META-miss fix, 2026-07-09): a
    // large-cap grinding a big day on real dollars is VISIBLE even when no
    // 10-second burst ever fires. Detection only — no BUY, no gate changes.
    const major = detectMajorMove({
      symbol: q.symbol, price: q.price, movePct: q.changePercent ?? null,
      volume: q.volume ?? null, relVol: st.relVol, aboveVwap: levels.aboveVwap,
      core: isCoreSymbol(q.symbol),
    });
    if (major.detected) {
      (row as any).majorMove = major.status;
      if (nowMs - st.lastMajorMoveAt >= 30 * 60_000) {
        st.lastMajorMoveAt = nowMs;
        s.majorMoves.unshift({
          t: nowMs, symbol: q.symbol, status: major.status, direction: major.direction,
          movePct: q.changePercent ?? null, why: major.why,
        });
        if (s.majorMoves.length > 20) s.majorMoves.length = 20;
        console.log(`[major-move] ${q.symbol} ${major.status} (${(q.changePercent ?? 0).toFixed(1)}%): ${major.why[0]}`);
        // Longer-dated position callout (the "META mid-July 650C" ask):
        // fire-and-forget; one per symbol/day; budget-aware; WATCH tier only.
        if (session === "regular") {
          maybeEmitPositionCallout(
            { symbol: q.symbol, price: q.price, movePct: q.changePercent ?? null, volume: q.volume ?? null, relVol: st.relVol },
            major, nowMs,
          ).catch((err: any) => console.warn("[position] callout failed:", err?.message));
        }
      }
    }

    const levelBreak = levels.hodBreak || levels.lodBreak;
    const dirBear = dir.direction === "bearish";
    const instantRate = instantRead.shortRate;
    const sustainedOk =
      accelRead.shortRate != null &&
      instantRate != null &&
      Math.sign(accelRead.shortRate) === Math.sign(instantRate) &&
      Math.abs(instantRate) >= triggerMinRate * 0.75 &&
      Math.abs(accelRead.shortRate) >= triggerMinRate * 0.85;
    const persistOk = speedPersistentFromRing(st.ring, {
      minRate: triggerMinRate * 0.9,
      direction: dirBear ? "bearish" : "bullish",
      minHits: levelBreak ? 1 : 2,
      subWindowMs: core ? 3500 : 4000,
    });
    const accelOk = minAccel <= 0 || (accelRead.accel != null && accelRead.accel > minAccel);
    const tapeMoving =
      levelBreak ||
      sustainedOk ||
      (accelRead.shortRate != null &&
        Math.abs(accelRead.shortRate) >= triggerMinRate * 0.85 &&
        surge != null &&
        surge >= triggerMinSurge * 0.88);

    const stockEnabled = process.env.STOCK_CALLOUTS === "1";
    // Options and stock use separate cooldowns — stock must not block 0DTE re-fire.
    const routeCooldownUntil = session === "regular"
      ? st.optionsCooldownUntil
      : st.stockCooldownUntil;

    // Gate evaluation is UNCHANGED (audit hard constraint) — shouldTrigger is
    // called with the exact same inputs; its result is captured so a blocked
    // near-trigger symbol leaves a "why not" trace (audit P1-5/T8).
    const shouldTriggerOk = shouldTrigger({
      shortRate: accelRead.shortRate, surge, hodBreak: levels.hodBreak, lodBreak: levels.lodBreak,
      efficiency, nowMs, cooldownUntil: routeCooldownUntil,
      minRate: triggerMinRate, minSurge: triggerMinSurge, minLevelSurge, minEfficiency: triggerMinEff,
    });
    const fired = persistOk && accelOk && tapeMoving && shouldTriggerOk;

    if (nearTrigger && !fired && shouldRecordNearMiss(st.lastNearMissAt, nowMs)) {
      st.lastNearMissAt = nowMs;
      const gates = {
        persistOk, accelOk, tapeMoving, shouldTrigger: shouldTriggerOk,
        cooldownBlocked: nowMs < routeCooldownUntil,
      };
      recordNearMiss(s.nearMisses, {
        t: nowMs, symbol: q.symbol, session,
        failedGate: firstFailedGate(gates) ?? "unknown",
        gates,
        values: {
          shortRate: accelRead.shortRate, accel: accelRead.accel, surge, efficiency,
          hodBreak: levels.hodBreak, lodBreak: levels.lodBreak,
        },
        thresholds: {
          minRate: triggerMinRate, minSurge: triggerMinSurge,
          minEfficiency: triggerMinEff, minAccel,
        },
      });
    }

    if (fired) {
      // fire-and-forget: the 1s heartbeat must never wait on a chain fetch.
      const read = { accelRead, surge, efficiency, levels, dir };
      const tasks: Promise<unknown>[] = [];
      if (session === "regular") tasks.push(handleTrigger(q.symbol, st, read, q, nowMs));
      if (stockEnabled) tasks.push(handleStockTrigger(q.symbol, st, read, q, nowMs));
      const fire = Promise.allSettled(tasks);
      fire.then((results) => {
        for (const result of results) {
          if (result.status !== "rejected") continue;
          s.errors++;
          console.warn("[dual-product-loop] trigger failed:", result.reason?.message ?? result.reason);
        }
      });
    }
  }
  vwapCandidates.sort((a, b) => b.rate - a.rate);
  for (const c of vwapCandidates.slice(0, 8)) {
    await ensureVwap(c.symbol, c.st, nowMs);
  }
  for (const row of tape) {
    const st = s.symbols.get(row.symbol);
    if (!st) continue;
    const levels = detectLevels({
      price: row.price, dayHigh: null, dayLow: null, vwap: st.vwap,
    });
    if (st.vwap != null) {
      row.aboveVwap = levels.aboveVwap;
      row.vwapDistPct = levels.vwapDistPct;
      row.relVol = st.relVol;
    }
  }

  s.movers = movers.sort((a, b) => Math.abs(b.shortRate ?? 0) - Math.abs(a.shortRate ?? 0)).slice(0, 20);

  for (const row of tape) {
    const cached = s.tapeBadgeCache.get(row.symbol);
    if (cached) {
      row.catalystType = cached.catalystType;
      row.catalystFresh = cached.catalystFresh;
      row.haltStatus = cached.haltStatus;
    }
  }
  if (nowMs - s.lastTapeEnrichAt >= TAPE_ENRICH_MS && !nearMinuteBudget(getCallStats(nowMs))) {
    s.lastTapeEnrichAt = nowMs;
    await enrichTapeContext(tape, nowMs);
    for (const row of tape) {
      s.tapeBadgeCache.set(row.symbol, {
        catalystType: row.catalystType,
        catalystFresh: row.catalystFresh,
        haltStatus: row.haltStatus ?? null,
      });
    }
  }

  s.tape = tape;

  // Live option-quote refresh needs chains — RTH only.
  if (session === "regular") refreshActiveAlerts(nowMs).catch(() => {});
}

const LOCK_HEARTBEAT_MS = 15_000;

export function startScannerLoop() {
  const g = globalThis as G;
  const s = state();
  if (s.running) return;
  if (process.env.SCANNER_REALTIME === "0") { console.log("[0dte-loop] disabled (SCANNER_REALTIME=0)"); return; }

  // Single-instance advisory lock (audit P1-3): a second process sharing the
  // data volume (stray `next dev`, accidental replica) must NOT start a
  // second loop — it would double Polygon spend and double-fire triggers.
  // DB unavailability fails OPEN (loop starts) so a fresh install still runs.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require("@/lib/db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { acquireScannerLock } = require("@/lib/instance-lock");
    const lock = acquireScannerLock(getDb(), { pid: process.pid });
    if (!lock.acquired) {
      s.note = `scanner loop NOT started: advisory lock held by pid ${lock.holder?.pid} (heartbeat ${lock.holder?.heartbeat_at}) — single-instance design, see docs/VPS.md`;
      console.warn(`[0dte-loop] ${s.note}`);
      return;
    }
  } catch (err: any) {
    console.warn("[0dte-loop] advisory lock unavailable (starting anyway):", err?.message);
  }

  s.running = true;
  let busy = false;
  let lastLockBeatAt = 0;
  const beat = async () => {
    if (!busy) {
      busy = true;
      try { await tick(); } catch (err: any) { s.errors++; console.warn("[0dte-loop] tick failed:", err?.message); }
      // Keep the advisory lock fresh (throttled; never breaks the heartbeat).
      const hbNow = Date.now();
      if (hbNow - lastLockBeatAt >= LOCK_HEARTBEAT_MS) {
        lastLockBeatAt = hbNow;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getDb } = require("@/lib/db");
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { heartbeatScannerLock } = require("@/lib/instance-lock");
          heartbeatScannerLock(getDb(), process.pid, hbNow);
        } catch { /* lock heartbeat is best-effort */ }
      }
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
    note: s.note, session: s.session ?? marketSession(), movers: s.movers, tape: s.tape,
    coreSymbols: getZeroDteUniverse().length,
    discoverySymbols: s.discoveryCount,
    promotedSymbols: [...s.promoted.keys()],
    nearMisses: s.nearMisses.slice(0, 25),
    majorMoves: s.majorMoves.slice(0, 12),
  };
}
