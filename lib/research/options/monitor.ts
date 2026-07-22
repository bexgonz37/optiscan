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
import { scoreStrategies, optionsTier1, optionsTier0, type OptionsCandidateInput, type Session } from "./discovery.ts";
import { sessionState } from "./session-state.ts";
import { runOptionsCandidate, type ChainContract } from "./loop.ts";
import { computeOptionsFeatures, featuresToUnderlying, type Bar, type FeatureContext } from "./features.ts";
import { summarizeChainFeatures, chainFeaturesToActivity, type OptionContract } from "./chain-features.ts";

export interface UnderlyingSnapshot {
  price: number | null; dayDollarVolume: number | null; relVolume: number | null;
  velPct: number | null; accelPct: number | null; gapPct: number | null;
  aboveVwap: boolean | null; hodBreak: boolean | null; nearResistancePct: number | null;
  compressionPct: number | null; realizedVolExpanding: boolean | null; openingRange: boolean | null; premarketLevelTest: boolean | null;
}
export interface OptionsMonitorDeps {
  getUnderlyingBatch: (symbols: string[]) => Promise<Map<string, UnderlyingSnapshot>>;
  getChain: (symbol: string) => Promise<ChainContract[]>;
  /** Stage 1.5: compact recent 1-minute bars for enriched decision-time features. Optional — without
   *  it the monitor falls back to snapshot-only features (sparser). */
  getBars?: (symbol: string) => Promise<Bar[]>;
  levelContext?: (symbol: string) => Partial<FeatureContext> | null;
  tier2Universe?: () => Promise<string[]> | string[];
  getDb?: () => any;
  now?: () => number;
  session?: () => Session;
}

export interface OptionsMonitorConfig {
  tier0IntervalMs: number; tier1IntervalMs: number; tier2IntervalMs: number;
  tier1PremarketMs: number; tier1AfterHoursMs: number; tier2PremarketMs: number; tier2AfterHoursMs: number;
  maxConcurrency: number; maxSymbolsPerTier2Cycle: number;
  symbolCooldownMs: number; symbolFormingRecheckMs: number; strategyCooldownMs: number;
  providerBudgetPerMinute: number; providerBudgetTier0PerMinute: number; breakerFailureThreshold: number; breakerCooldownMs: number;
}
export function defaultMonitorConfig(env: NodeJS.ProcessEnv = process.env): OptionsMonitorConfig {
  const n = (v: string | undefined, d: number, min = 0) => { const x = Number(v); return Number.isFinite(x) && x >= min ? x : d; };
  return {
    // Tier 0 (SPY/QQQ/IWM) scans FASTER than the broad universe, on its own timer + reserved budget.
    tier0IntervalMs: n(env.OPTIONS_TIER0_INTERVAL_MS, 5_000, 1000),
    tier1IntervalMs: n(env.OPTIONS_TIER1_INTERVAL_MS, 15_000, 2000),
    tier2IntervalMs: n(env.OPTIONS_TIER2_INTERVAL_MS, 60_000, 5000),
    tier1PremarketMs: n(env.OPTIONS_TIER1_PREMARKET_MS, 30_000, 2000),
    tier1AfterHoursMs: n(env.OPTIONS_TIER1_AFTERHOURS_MS, 30_000, 2000),
    tier2PremarketMs: n(env.OPTIONS_TIER2_PREMARKET_MS, 120_000, 5000),
    tier2AfterHoursMs: n(env.OPTIONS_TIER2_AFTERHOURS_MS, 120_000, 5000),
    maxConcurrency: n(env.OPTIONS_MAX_CONCURRENCY, 3, 1),
    maxSymbolsPerTier2Cycle: n(env.OPTIONS_MAX_SYMBOLS_PER_TIER2_CYCLE, 25, 1),
    symbolCooldownMs: n(env.OPTIONS_SYMBOL_COOLDOWN_MS, 60_000, 0),
    // Earliness: a symbol that passed liquidity + freshness but has NO plausible strategy yet is still
    // FORMING — the exact pre-expansion window. Re-check it at the scan cadence (default 0 = next tick)
    // instead of the full 60s cooldown, so the callout can fire while the move is still forming. Dup
    // protection is unaffected (per-strategy cooldown + delivery alertId dedup guard actual callouts).
    symbolFormingRecheckMs: n(env.OPTIONS_SYMBOL_FORMING_RECHECK_MS, 0, 0),
    strategyCooldownMs: n(env.OPTIONS_STRATEGY_COOLDOWN_MS, 120_000, 0),
    providerBudgetPerMinute: n(env.OPTIONS_PROVIDER_BUDGET_PER_MINUTE, 200, 1),
    // RESERVED capacity for Tier 0 — a separate budget bucket so broad-universe work can never starve
    // SPY/QQQ/IWM out of a cycle.
    providerBudgetTier0PerMinute: n(env.OPTIONS_TIER0_PROVIDER_BUDGET_PER_MINUTE, 60, 1),
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
  budgetTier0: { windowStart: number; used: number };
  metrics: {
    symbolsScanned: number; candidatesCreated: number; candidatesRejected: number; chainsFetched: number;
    providerUnderlying: number; providerBars: number; providerChain: number; providerDetailed: number; providerFailures: number; throttles: number; cooldownSkips: number;
    stage1Pass: number; stage15Enrich: number; stage15Stale: number; stage15Forming: number; stage2Chain: number; optionsActivityEscalations: number;
    tier0Scanned: number; tier0Candidates: number; tier0BudgetSkips: number;
    phaseEarly: number; phaseDuring: number; phaseLate: number;
    lastTier0CycleMs: number | null; lastTier1CycleMs: number | null; lastTier2CycleMs: number | null; latestCandidateMs: number | null;
    cycleDurations: number[]; detectionToDecision: number[]; rvolSamples: number[]; vwapDistSamples: number[]; compressionSamples: number[]; fractionMoveSamples: number[];
  };
}
type G = typeof globalThis & { __optiscanOptionsMonitor?: MonitorState };
function state(): MonitorState {
  const g = globalThis as G;
  return (g.__optiscanOptionsMonitor ??= {
    running: false, timers: [], cooldownSymbol: new Map(), cooldownStrategy: new Map(), inFlight: new Set(),
    breaker: { state: "closed", failures: 0, openUntil: 0 }, budget: { windowStart: 0, used: 0 }, budgetTier0: { windowStart: 0, used: 0 },
    metrics: { symbolsScanned: 0, candidatesCreated: 0, candidatesRejected: 0, chainsFetched: 0, providerUnderlying: 0, providerBars: 0, providerChain: 0, providerDetailed: 0, providerFailures: 0, throttles: 0, cooldownSkips: 0, stage1Pass: 0, stage15Enrich: 0, stage15Stale: 0, stage15Forming: 0, stage2Chain: 0, optionsActivityEscalations: 0, tier0Scanned: 0, tier0Candidates: 0, tier0BudgetSkips: 0, phaseEarly: 0, phaseDuring: 0, phaseLate: 0, lastTier0CycleMs: null, lastTier1CycleMs: null, lastTier2CycleMs: null, latestCandidateMs: null, cycleDurations: [], detectionToDecision: [], rvolSamples: [], vwapDistSamples: [], compressionSamples: [], fractionMoveSamples: [] },
  });
}

function tryConsume(s: MonitorState, cfg: OptionsMonitorConfig, now: number, tier: 0 | 1 | 2 = 1): boolean {
  const bucket = tier === 0 ? s.budgetTier0 : s.budget;
  const limit = tier === 0 ? cfg.providerBudgetTier0PerMinute : cfg.providerBudgetPerMinute;
  if (now - bucket.windowStart >= 60_000) { bucket.windowStart = now; bucket.used = 0; }
  if (bucket.used >= limit) { if (tier === 0) s.metrics.tier0BudgetSkips += 1; return false; }
  bucket.used += 1; return true;
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

export interface CycleResult { tier: 0 | 1 | 2; scanned: number; created: number; rejected: number; chains: number; durationMs: number }

/** Run ONE monitor cycle over a symbol set. Staged funnel: Stage 1 cheap underlying rejects most;
 *  Stage 2 fetches a chain ONLY when a strategy is applicable. Bounded, cooldown-aware, breaker-aware.
 *  Tier 0 uses a RESERVED provider budget so broad work can never starve SPY/QQQ/IWM. */
export async function runOptionsMonitorCycle(tier: 0 | 1 | 2, symbols: string[], deps: OptionsMonitorDeps, env: NodeJS.ProcessEnv = process.env, cfg: OptionsMonitorConfig = defaultMonitorConfig(env)): Promise<CycleResult> {
  const s = state();
  const now = deps.now ?? Date.now;
  const session = (deps.session ?? (() => "regular" as Session))();
  const getDb = deps.getDb;
  const candTier: 1 | 2 = tier === 2 ? 2 : 1;   // Tier 0 evaluates as core for strategy/DTE purposes
  const t0 = now();
  let scanned = 0, created = 0, rejected = 0, chains = 0;

  if (breakerOpen(s, t0)) { s.metrics.throttles += 1; return { tier, scanned: 0, created: 0, rejected: 0, chains: 0, durationMs: now() - t0 }; }

  // STAGE 1 — ONE cheap underlying batch snapshot for the whole set (rejects most symbols before any
  // chain is ever fetched). One provider call for the batch (from the tier's own budget bucket).
  let snaps: Map<string, UnderlyingSnapshot>;
  if (!tryConsume(s, cfg, t0, tier)) { s.metrics.throttles += 1; return { tier, scanned: 0, created: 0, rejected: 0, chains: 0, durationMs: now() - t0 }; }
  try { snaps = await deps.getUnderlyingBatch(symbols); s.metrics.providerUnderlying += 1; breakerSuccess(s); }
  catch { s.metrics.providerFailures += 1; breakerFail(s, cfg, now()); return { tier, scanned: 0, created: 0, rejected: 0, chains: 0, durationMs: now() - t0 }; }

  await mapWithConcurrency(symbols, cfg.maxConcurrency, async (symbol) => {
    const n0 = now();
    if ((s.cooldownSymbol.get(symbol) ?? 0) > n0) { s.metrics.cooldownSkips += 1; return; }
    if (s.inFlight.has(symbol)) return; // no overlapping scan of the same symbol
    s.inFlight.add(symbol);
    const flags = researchFlags(env);
    try {
      scanned += 1; s.metrics.symbolsScanned += 1; if (tier === 0) s.metrics.tier0Scanned += 1;
      const snap = snaps.get(symbol);
      // STAGE 1 — cheap liquidity/price/fresh reject (no bars, no chain).
      if (!snap || snap.price == null || (snap.dayDollarVolume ?? 0) < 5_000_000) { s.cooldownSymbol.set(symbol, n0 + cfg.symbolCooldownMs); return; }
      s.metrics.stage1Pass += 1;

      // STAGE 1.5 — enrich with compact recent bars → decision-time features (when getBars is wired).
      let input = toCandidate(symbol, candTier, session, snap, n0);
      let featureSnapshot: any = { source: "snapshot_only" };
      let fractionMove: number | null = null;
      if (deps.getBars) {
        if (breakerOpen(s, now())) { s.metrics.throttles += 1; return; }
        if (!tryConsume(s, cfg, now(), tier)) { s.metrics.throttles += 1; return; }
        const bars = await deps.getBars(symbol); s.metrics.providerBars += 1; breakerSuccess(s);
        const ctx: FeatureContext = { nowMs: n0, session, ...(deps.levelContext?.(symbol) ?? {}) };
        const f = computeOptionsFeatures(bars, ctx);
        s.metrics.stage15Enrich += 1;
        if (f.stale) { s.metrics.stage15Stale += 1; rejected += 1; s.metrics.candidatesRejected += 1; s.cooldownSymbol.set(symbol, n0 + cfg.symbolCooldownMs); return; } // stale bars reject safely
        const u = featuresToUnderlying(f);
        input = { ...input, underlying: u };
        featureSnapshot = { source: "enriched", underlying: f };
        // record the EFFECTIVE relVolume (the proxy when no baseline exists), so the distribution is
        // observable during hours; distributions summarize all NON-STALE enriched symbols.
        if (u.relVolume != null) record(s.metrics.rvolSamples, u.relVolume);
        if (f.vwapDistPct != null) record(s.metrics.vwapDistSamples, f.vwapDistPct);
        if (f.compressionScore != null) record(s.metrics.compressionSamples, f.compressionScore);
        if (f.hod != null && f.lod != null && f.hod > f.lod && f.price != null) { fractionMove = +(((f.price - f.lod) / (f.hod - f.lod))).toFixed(3); record(s.metrics.fractionMoveSamples, fractionMove); }
      }

      // STAGE 1.5 gate — a chain is fetched only when a strategy is plausible OR (options-activity
      // discovery on) to let abnormal chain activity INDEPENDENTLY escalate the symbol.
      let escalatedBy: string | null = null;
      const plausible = scoreStrategies(input).some((x) => x.applicable);
      // FORMING, not yet plausible: re-check at the scan cadence (symbolFormingRecheckMs, default 0)
      // instead of freezing 60s, so the callout can fire as soon as the setup validates — while it is
      // still forming, not after the expansion. NOT a quality change: no gate loosened, no extra alert
      // (actual callouts are still deduped by the per-strategy cooldown + delivery alertId bucket).
      if (!plausible && !flags.optionsActivityDiscovery) { rejected += 1; s.metrics.candidatesRejected += 1; s.metrics.stage15Forming += 1; s.cooldownSymbol.set(symbol, n0 + cfg.symbolFormingRecheckMs); return; }
      if (!plausible) escalatedBy = "options_activity_probe";

      if (breakerOpen(s, now())) { s.metrics.throttles += 1; return; }
      if (!tryConsume(s, cfg, now(), tier)) { s.metrics.throttles += 1; return; }
      // STAGE 2 — fetch the chain + compute chain features.
      const chain = await deps.getChain(symbol);
      s.metrics.providerChain += 1; s.metrics.stage2Chain += 1; s.metrics.chainsFetched += 1; chains += 1; breakerSuccess(s);
      const chainF = summarizeChainFeatures({ symbol, underlyingPrice: input.underlying.price, underlyingDollarVolume: input.underlying.dayDollarVolume, contracts: chain as unknown as OptionContract[], chainAvailable: chain.length > 0, nowMs: now() });
      input = { ...input, optionsActivity: chainFeaturesToActivity(chainF) };
      featureSnapshot = { ...featureSnapshot, chain: chainF };
      // If we only reached here via escalation, require the chain to actually be abnormal.
      if (escalatedBy) { if (!chainF.abnormal || chainF.direction === "ambiguous") { rejected += 1; s.metrics.candidatesRejected += 1; s.cooldownSymbol.set(symbol, n0 + cfg.symbolCooldownMs); return; } s.metrics.optionsActivityEscalations += 1; }

      const earlinessPhase = fractionMove == null ? null : fractionMove >= 0.75 ? "late" : fractionMove <= 0.4 ? "early" : "during";
      if (earlinessPhase === "early") s.metrics.phaseEarly += 1; else if (earlinessPhase === "during") s.metrics.phaseDuring += 1; else if (earlinessPhase === "late") s.metrics.phaseLate += 1;

      const res = runOptionsCandidate({ ...input }, chain, getDb ? { getDb } : {}, env, { featureSnapshot: { ...featureSnapshot, fractionMove, earlinessPhase }, earlinessPhase, escalatedBy, coreBroad: tier === 2 ? "broad" : "core" });
      if (res?.selection.selected) { created += 1; s.metrics.candidatesCreated += 1; if (tier === 0) s.metrics.tier0Candidates += 1; s.metrics.latestCandidateMs = now(); s.cooldownStrategy.set(`${symbol}:${res.selection.selected.key}`, now() + cfg.strategyCooldownMs); }
      else { rejected += 1; s.metrics.candidatesRejected += 1; }
      s.cooldownSymbol.set(symbol, now() + cfg.symbolCooldownMs);
      record(s.metrics.detectionToDecision, now() - n0);
    } catch {
      s.metrics.providerFailures += 1; breakerFail(s, cfg, now());
    } finally { s.inFlight.delete(symbol); }
  });

  const durationMs = now() - t0;
  record(s.metrics.cycleDurations, durationMs);
  if (tier === 0) s.metrics.lastTier0CycleMs = now(); else if (tier === 1) s.metrics.lastTier1CycleMs = now(); else s.metrics.lastTier2CycleMs = now();

  // Persist a heartbeat so autonomous runtime status survives restart/deploy (no manual endpoint call).
  if (getDb) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { persistHeartbeatOnDb } = require("./runtime.ts");
      const m = s.metrics;
      persistHeartbeatOnDb(getDb(), {
        session, running: s.running, breaker: s.breaker.state,
        lastTier1CycleMs: m.lastTier1CycleMs, lastTier2CycleMs: m.lastTier2CycleMs,
        symbolsScanned: m.symbolsScanned, stage15Stale: m.stage15Stale, candidatesCreated: m.candidatesCreated,
        stage2Chain: m.stage2Chain, providerFailures: m.providerFailures, latestCandidateMs: m.latestCandidateMs,
      }, now());
    } catch { /* heartbeat is best-effort; never fail a cycle */ }
  }
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
  const dist = (arr: number[]) => ({ p50: pct(arr, 0.5), p95: pct(arr, 0.95), n: arr.length });
  const totalCalls = m.providerUnderlying + m.providerBars + m.providerChain + m.providerDetailed;
  return {
    running: s.running, breaker: s.breaker.state, budgetUsed: s.budget.used, budgetTier0Used: s.budgetTier0.used, queueInFlight: s.inFlight.size,
    sessionState: sessionState(Date.now()),
    tier0: { scanned: m.tier0Scanned, candidates: m.tier0Candidates, budgetSkips: m.tier0BudgetSkips, lastCycleMs: m.lastTier0CycleMs },
    symbolsScanned: m.symbolsScanned, candidatesCreated: m.candidatesCreated, candidatesRejected: m.candidatesRejected, chainsFetched: m.chainsFetched,
    stages: { stage1Pass: m.stage1Pass, stage15Enrich: m.stage15Enrich, stage15Stale: m.stage15Stale, stage15Forming: m.stage15Forming, stage2Chain: m.stage2Chain, stage3Detailed: m.providerDetailed, optionsActivityEscalations: m.optionsActivityEscalations },
    stage1PassRate: m.symbolsScanned > 0 ? +((m.stage1Pass / m.symbolsScanned) * 100).toFixed(2) : null,
    providerCalls: { underlying: m.providerUnderlying, bars: m.providerBars, chain: m.providerChain, detailed: m.providerDetailed, total: totalCalls },
    providerFailures: m.providerFailures, throttles: m.throttles, cooldownSkips: m.cooldownSkips,
    earliness: { early: m.phaseEarly, during: m.phaseDuring, late: m.phaseLate }, fractionMoveComplete: dist(m.fractionMoveSamples),
    // distributions summarize ALL NON-STALE Stage-1.5 enriched symbols (not just created candidates).
    // When stage15Stale ≈ stage15Enrich, n=0 means every enriched symbol had stale/empty bars (e.g. market closed).
    distributionsScope: "all_non_stale_enriched", distributions: { rvol: dist(m.rvolSamples), vwapDistPct: dist(m.vwapDistSamples), compression: dist(m.compressionSamples) },
    lastTier0CycleMs: m.lastTier0CycleMs, lastTier1CycleMs: m.lastTier1CycleMs, lastTier2CycleMs: m.lastTier2CycleMs, latestCandidateMs: m.latestCandidateMs,
    cycleMs: { p50: pct(m.cycleDurations, 0.5), p95: pct(m.cycleDurations, 0.95) },
    detectionToDecisionMs: { p50: pct(m.detectionToDecision, 0.5), p95: pct(m.detectionToDecision, 0.95) },
    candidatesPer100Calls: totalCalls > 0 ? +((m.candidatesCreated / totalCalls) * 100).toFixed(2) : null,
  };
}

const sessionCadence = (cfg: OptionsMonitorConfig, tier: 0 | 1 | 2, session: Session): number => {
  if (tier === 0) return cfg.tier0IntervalMs; // core index fast lane — fastest in every session
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
  const tier0 = optionsTier0(env);
  const tier0Set = new Set(tier0.map((x) => x.toUpperCase()));
  s.running = true;
  let t0Busy = false, t1Busy = false, t2Busy = false;
  // Tier 0 (SPY/QQQ/IWM): fastest timer + reserved budget, on its OWN interval so it never waits behind
  // broad-universe provider work.
  const t0Timer = setInterval(() => {
    if (t0Busy) return; t0Busy = true;
    void runOptionsMonitorCycle(0, tier0, deps, env, cfg).catch(() => {}).finally(() => { t0Busy = false; });
  }, sessionCadence(cfg, 0, sessionOf()));
  const t1 = setInterval(() => {
    if (t1Busy) return; t1Busy = true;
    // Tier 1 scans the OTHER core names — Tier 0 owns SPY/QQQ/IWM to avoid redundant provider calls.
    void runOptionsMonitorCycle(1, optionsTier1(env).filter((x) => !tier0Set.has(x.toUpperCase())), deps, env, cfg).catch(() => {}).finally(() => { t1Busy = false; });
  }, sessionCadence(cfg, 1, sessionOf()));
  const t2 = setInterval(async () => {
    if (t2Busy) return; t2Busy = true;
    try { const uni = (await (deps.tier2Universe?.() ?? [])) as string[]; await runOptionsMonitorCycle(2, uni.filter((x) => !tier0Set.has(x.toUpperCase())).slice(0, cfg.maxSymbolsPerTier2Cycle), deps, env, cfg); } catch { /* isolated */ } finally { t2Busy = false; }
  }, sessionCadence(cfg, 2, sessionOf()));
  if (typeof (t1 as any).unref === "function") { (t0Timer as any).unref(); (t1 as any).unref(); (t2 as any).unref(); }
  s.timers = [t0Timer, t1, t2];
  const stop = () => stopOptionsMonitor();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return { started: true, reason: "started" };
}
export function stopOptionsMonitor(): void { const s = state(); for (const t of s.timers) clearInterval(t); s.timers = []; s.running = false; }
/** Inspect the live per-symbol cooldown (for the diagnostic — does not mutate state). */
export function optionsCooldownRemainingMs(symbol: string, nowMs: number = Date.now()): number { return Math.max(0, (state().cooldownSymbol.get(symbol.toUpperCase()) ?? 0) - nowMs); }
/** Test-only: reset the singleton state (cooldowns/metrics/breaker) for order-independent tests. */
export function __resetOptionsMonitorForTest(): void { stopOptionsMonitor(); delete (globalThis as G).__optiscanOptionsMonitor; }
