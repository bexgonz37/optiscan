/**
 * lib/research/options/monitor.ts — the dedicated INDEPENDENT options monitoring loop. In-process,
 * bounded, and SEPARATE from the Stock Momentum Radar. It never calls shouldTrigger(), never requires
 * a +10% move, never sends Discord, and does its light network+DB work off the scanner path.
 *
 * Chosen boundary: an in-process interval loop (like the existing scanner/tracker/paper loops), NOT a
 * child process — the tick is periodic light provider+DB work (no CPU-heavy synchronous seeding), so
 * a worker process would add fragility without benefit. Provider fetches are async (they yield); the
 * per-candidate work is fast. Gated OFF by default; a bounded, staged funnel keeps provider usage low.
 */
import { researchFlags } from "../flags.ts";
import { scoreStrategies, optionsTier1, type OptionsCandidateInput, type Session } from "./discovery.ts";
import { runOptionsCandidate, type ChainContract } from "./loop.ts";

export interface UnderlyingSnapshot {
  price: number | null; dayDollarVolume: number | null; relVolume: number | null;
  velPct: number | null; accelPct: number | null; gapPct: number | null;
  aboveVwap: boolean | null; hodBreak: boolean | null; nearResistancePct: number | null;
  compressionPct: number | null; realizedVolExpanding: boolean | null; openingRange: boolean | null; premarketLevelTest: boolean | null;
}
export interface OptionsMonitorDeps {
  getUnderlyingBatch: (symbols: string[]) => Promise<Map<string, UnderlyingSnapshot>>;
  getChain: (symbol: string) => Promise<ChainContract[]>;
  tier2Universe?: () => Promise<string[]> | string[];
  getDb?: () => any;
  now?: () => number;
  session?: () => Session;
}

export interface OptionsMonitorConfig {
  tier1IntervalMs: number; tier2IntervalMs: number;
  tier1PremarketMs: number; tier1AfterHoursMs: number; tier2PremarketMs: number; tier2AfterHoursMs: number;
  maxConcurrency: number; maxSymbolsPerTier2Cycle: number;
  symbolCooldownMs: number; strategyCooldownMs: number;
  providerBudgetPerMinute: number; breakerFailureThreshold: number; breakerCooldownMs: number;
}
export function defaultMonitorConfig(env: NodeJS.ProcessEnv = process.env): OptionsMonitorConfig {
  const n = (v: string | undefined, d: number, min = 0) => { const x = Number(v); return Number.isFinite(x) && x >= min ? x : d; };
  return {
    tier1IntervalMs: n(env.OPTIONS_TIER1_INTERVAL_MS, 15_000, 2000),
    tier2IntervalMs: n(env.OPTIONS_TIER2_INTERVAL_MS, 60_000, 5000),
    tier1PremarketMs: n(env.OPTIONS_TIER1_PREMARKET_MS, 30_000, 2000),
    tier1AfterHoursMs: n(env.OPTIONS_TIER1_AFTERHOURS_MS, 30_000, 2000),
    tier2PremarketMs: n(env.OPTIONS_TIER2_PREMARKET_MS, 120_000, 5000),
    tier2AfterHoursMs: n(env.OPTIONS_TIER2_AFTERHOURS_MS, 120_000, 5000),
    maxConcurrency: n(env.OPTIONS_MAX_CONCURRENCY, 3, 1),
    maxSymbolsPerTier2Cycle: n(env.OPTIONS_MAX_SYMBOLS_PER_TIER2_CYCLE, 25, 1),
    symbolCooldownMs: n(env.OPTIONS_SYMBOL_COOLDOWN_MS, 60_000, 0),
    strategyCooldownMs: n(env.OPTIONS_STRATEGY_COOLDOWN_MS, 120_000, 0),
    providerBudgetPerMinute: n(env.OPTIONS_PROVIDER_BUDGET_PER_MINUTE, 200, 1),
    breakerFailureThreshold: n(env.OPTIONS_BREAKER_FAILS, 5, 1),
    breakerCooldownMs: n(env.OPTIONS_BREAKER_COOLDOWN_MS, 30_000, 1000),
  };
}

type BreakerState = "closed" | "open" | "half_open";
interface MonitorState {
  running: boolean; timers: any[];
  cooldownSymbol: Map<string, number>; cooldownStrategy: Map<string, number>;
  inFlight: Set<string>;
  breaker: { state: BreakerState; failures: number; openUntil: number };
  budget: { windowStart: number; used: number };
  metrics: {
    symbolsScanned: number; candidatesCreated: number; candidatesRejected: number; chainsFetched: number;
    providerUnderlying: number; providerChain: number; providerDetailed: number; providerFailures: number; throttles: number; cooldownSkips: number;
    lastTier1CycleMs: number | null; lastTier2CycleMs: number | null; latestCandidateMs: number | null;
    cycleDurations: number[]; detectionToDecision: number[];
  };
}
type G = typeof globalThis & { __optiscanOptionsMonitor?: MonitorState };
function state(): MonitorState {
  const g = globalThis as G;
  return (g.__optiscanOptionsMonitor ??= {
    running: false, timers: [], cooldownSymbol: new Map(), cooldownStrategy: new Map(), inFlight: new Set(),
    breaker: { state: "closed", failures: 0, openUntil: 0 }, budget: { windowStart: 0, used: 0 },
    metrics: { symbolsScanned: 0, candidatesCreated: 0, candidatesRejected: 0, chainsFetched: 0, providerUnderlying: 0, providerChain: 0, providerDetailed: 0, providerFailures: 0, throttles: 0, cooldownSkips: 0, lastTier1CycleMs: null, lastTier2CycleMs: null, latestCandidateMs: null, cycleDurations: [], detectionToDecision: [] },
  });
}

function tryConsume(s: MonitorState, cfg: OptionsMonitorConfig, now: number): boolean {
  if (now - s.budget.windowStart >= 60_000) { s.budget.windowStart = now; s.budget.used = 0; }
  if (s.budget.used >= cfg.providerBudgetPerMinute) return false;
  s.budget.used += 1; return true;
}
function breakerOpen(s: MonitorState, now: number): boolean {
  if (s.breaker.state === "open") { if (now >= s.breaker.openUntil) { s.breaker.state = "half_open"; return false; } return true; }
  return false;
}
function breakerSuccess(s: MonitorState): void { s.breaker.state = "closed"; s.breaker.failures = 0; }
function breakerFail(s: MonitorState, cfg: OptionsMonitorConfig, now: number): void { s.breaker.failures += 1; if (s.breaker.failures >= cfg.breakerFailureThreshold) { s.breaker.state = "open"; s.breaker.openUntil = now + cfg.breakerCooldownMs; } }

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } });
  await Promise.all(workers);
}

function toCandidate(symbol: string, tier: 1 | 2, session: Session, snap: UnderlyingSnapshot, nowMs: number): OptionsCandidateInput {
  return { symbol, nowMs, session, tier, underlying: { ...snap }, optionsActivity: null, earnings: null };
}

export interface CycleResult { tier: 1 | 2; scanned: number; created: number; rejected: number; chains: number; durationMs: number }

/** Run ONE monitor cycle over a symbol set. Staged funnel: Stage 1 cheap underlying rejects most;
 *  Stage 2 fetches a chain ONLY when a strategy is applicable. Bounded, cooldown-aware, breaker-aware. */
export async function runOptionsMonitorCycle(tier: 1 | 2, symbols: string[], deps: OptionsMonitorDeps, env: NodeJS.ProcessEnv = process.env, cfg: OptionsMonitorConfig = defaultMonitorConfig(env)): Promise<CycleResult> {
  const s = state();
  const now = deps.now ?? Date.now;
  const session = (deps.session ?? (() => "regular" as Session))();
  const getDb = deps.getDb;
  const t0 = now();
  let scanned = 0, created = 0, rejected = 0, chains = 0;

  if (breakerOpen(s, t0)) { s.metrics.throttles += 1; return { tier, scanned: 0, created: 0, rejected: 0, chains: 0, durationMs: now() - t0 }; }

  // STAGE 1 — ONE cheap underlying batch snapshot for the whole set (rejects most symbols before any
  // chain is ever fetched). One provider call for the batch.
  let snaps: Map<string, UnderlyingSnapshot>;
  if (!tryConsume(s, cfg, t0)) { s.metrics.throttles += 1; return { tier, scanned: 0, created: 0, rejected: 0, chains: 0, durationMs: now() - t0 }; }
  try { snaps = await deps.getUnderlyingBatch(symbols); s.metrics.providerUnderlying += 1; breakerSuccess(s); }
  catch { s.metrics.providerFailures += 1; breakerFail(s, cfg, now()); return { tier, scanned: 0, created: 0, rejected: 0, chains: 0, durationMs: now() - t0 }; }

  await mapWithConcurrency(symbols, cfg.maxConcurrency, async (symbol) => {
    const n0 = now();
    if ((s.cooldownSymbol.get(symbol) ?? 0) > n0) { s.metrics.cooldownSkips += 1; return; }
    if (s.inFlight.has(symbol)) return; // no overlapping scan of the same symbol
    s.inFlight.add(symbol);
    try {
      scanned += 1; s.metrics.symbolsScanned += 1;
      const snap = snaps.get(symbol);
      if (!snap || snap.price == null) { s.cooldownSymbol.set(symbol, n0 + cfg.symbolCooldownMs); return; }
      const input = toCandidate(symbol, tier, session, snap, n0);
      // Stage 1 gate — only fetch a chain when a strategy is applicable.
      if (!scoreStrategies(input).some((x) => x.applicable)) { rejected += 1; s.metrics.candidatesRejected += 1; s.cooldownSymbol.set(symbol, n0 + cfg.symbolCooldownMs); return; }
      if (breakerOpen(s, now())) { s.metrics.throttles += 1; return; }
      if (!tryConsume(s, cfg, now())) { s.metrics.throttles += 1; return; }
      // STAGE 2 — fetch the chain now that it is justified.
      const chain = await deps.getChain(symbol);
      s.metrics.providerChain += 1; s.metrics.chainsFetched += 1; chains += 1; breakerSuccess(s);
      const res = runOptionsCandidate({ ...input }, chain, getDb ? { getDb } : {}, env);
      if (res?.selection.selected) { created += 1; s.metrics.candidatesCreated += 1; s.metrics.latestCandidateMs = now(); s.cooldownStrategy.set(`${symbol}:${res.selection.selected.key}`, now() + cfg.strategyCooldownMs); }
      else { rejected += 1; s.metrics.candidatesRejected += 1; }
      s.cooldownSymbol.set(symbol, now() + cfg.symbolCooldownMs);
      record(s.metrics.detectionToDecision, now() - n0);
    } catch {
      s.metrics.providerFailures += 1; breakerFail(s, cfg, now());
    } finally { s.inFlight.delete(symbol); }
  });

  const durationMs = now() - t0;
  record(s.metrics.cycleDurations, durationMs);
  if (tier === 1) s.metrics.lastTier1CycleMs = now(); else s.metrics.lastTier2CycleMs = now();
  return { tier, scanned, created, rejected, chains, durationMs };
}

function record(arr: number[], v: number) { arr.push(v); if (arr.length > 500) arr.shift(); }
const pct = (arr: number[], q: number): number | null => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };

export interface MonitorHealth { enabled: boolean; running: boolean; breakerState: string; lastTier1CycleMs: number | null; lastTier2CycleMs: number | null; alive: boolean }
/** Health that NEVER fails the web endpoint: reports the loop state; "alive" is true when enabled and
 *  a recent cycle ran, but a disabled loop is simply {enabled:false} — not an error. */
export function optionsMonitorHealth(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): MonitorHealth {
  const s = state(); const enabled = researchFlags(env).independentOptionsDiscovery;
  const last = Math.max(s.metrics.lastTier1CycleMs ?? 0, s.metrics.lastTier2CycleMs ?? 0);
  return { enabled, running: s.running, breakerState: s.breaker.state, lastTier1CycleMs: s.metrics.lastTier1CycleMs, lastTier2CycleMs: s.metrics.lastTier2CycleMs, alive: enabled ? (last > 0 && now - last < 120_000) : true };
}
export function optionsMonitorMetrics(): Record<string, unknown> {
  const s = state();
  const m = s.metrics;
  return {
    running: s.running, breaker: s.breaker.state, budgetUsed: s.budget.used, queueInFlight: s.inFlight.size,
    symbolsScanned: m.symbolsScanned, candidatesCreated: m.candidatesCreated, candidatesRejected: m.candidatesRejected, chainsFetched: m.chainsFetched,
    providerCalls: { underlying: m.providerUnderlying, chain: m.providerChain, detailed: m.providerDetailed }, providerFailures: m.providerFailures, throttles: m.throttles, cooldownSkips: m.cooldownSkips,
    lastTier1CycleMs: m.lastTier1CycleMs, lastTier2CycleMs: m.lastTier2CycleMs, latestCandidateMs: m.latestCandidateMs,
    cycleMs: { p50: pct(m.cycleDurations, 0.5), p95: pct(m.cycleDurations, 0.95) },
    detectionToDecisionMs: { p50: pct(m.detectionToDecision, 0.5), p95: pct(m.detectionToDecision, 0.95) },
    candidatesPer100Calls: (m.providerUnderlying + m.providerChain) > 0 ? +((m.candidatesCreated / (m.providerUnderlying + m.providerChain)) * 100).toFixed(2) : null,
  };
}

const sessionCadence = (cfg: OptionsMonitorConfig, tier: 1 | 2, session: Session): number => {
  if (tier === 1) return session === "premarket" ? cfg.tier1PremarketMs : session === "afterhours" ? cfg.tier1AfterHoursMs : cfg.tier1IntervalMs;
  return session === "premarket" ? cfg.tier2PremarketMs : session === "afterhours" ? cfg.tier2AfterHoursMs : cfg.tier2IntervalMs;
};

/** Start the in-process monitor (singleton, gated OFF by default). Clean shutdown; no recursion. */
export function startOptionsMonitor(deps: OptionsMonitorDeps, env: NodeJS.ProcessEnv = process.env): { started: boolean; reason: string } {
  const s = state();
  if (s.running) return { started: true, reason: "already running" };
  if (!researchFlags(env).independentOptionsDiscovery) return { started: false, reason: "INDEPENDENT_OPTIONS_DISCOVERY_ENABLED!=1" };
  const cfg = defaultMonitorConfig(env);
  const sessionOf = deps.session ?? (() => "regular" as Session);
  s.running = true;
  let t1Busy = false, t2Busy = false;
  const t1 = setInterval(() => {
    if (t1Busy) return; t1Busy = true;
    void runOptionsMonitorCycle(1, optionsTier1(env), deps, env, cfg).catch(() => {}).finally(() => { t1Busy = false; });
  }, sessionCadence(cfg, 1, sessionOf()));
  const t2 = setInterval(async () => {
    if (t2Busy) return; t2Busy = true;
    try { const uni = (await (deps.tier2Universe?.() ?? [])) as string[]; await runOptionsMonitorCycle(2, uni.slice(0, cfg.maxSymbolsPerTier2Cycle), deps, env, cfg); } catch { /* isolated */ } finally { t2Busy = false; }
  }, sessionCadence(cfg, 2, sessionOf()));
  if (typeof (t1 as any).unref === "function") { (t1 as any).unref(); (t2 as any).unref(); }
  s.timers = [t1, t2];
  const stop = () => stopOptionsMonitor();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return { started: true, reason: "started" };
}
export function stopOptionsMonitor(): void { const s = state(); for (const t of s.timers) clearInterval(t); s.timers = []; s.running = false; }
/** Test-only: reset the singleton state (cooldowns/metrics/breaker) for order-independent tests. */
export function __resetOptionsMonitorForTest(): void { stopOptionsMonitor(); delete (globalThis as G).__optiscanOptionsMonitor; }
