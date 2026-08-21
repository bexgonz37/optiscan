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
import { withProviderConsumer } from "../../provider-context.ts";
import { scoreStrategies, selectOptionsStrategy, optionsTier1, optionsTier0, type OptionsCandidateInput, type Session } from "./discovery.ts";
import { sessionState } from "./session-state.ts";
import { decideDeliveryBatch, type DeliverySubmission } from "./delivery-decision.ts";
import { runOptionsCandidate, type ChainContract, type ChainFetchOutcome } from "./loop.ts";
import { computeOptionsFeatures, featuresToUnderlying, type Bar, type FeatureContext } from "./features.ts";
import { summarizeChainFeatures, chainFeaturesToActivity, type OptionContract } from "./chain-features.ts";
import { persistOptionsLatencyTraceOnDb, type OptionsLatencyTrace } from "./latency-telemetry.ts";
import { assertSubscriberScanAllowed } from "../../market-session-guard.ts";
import { bearishPipelineEnabled, latestPendingBearishEscalationForSymbol } from "./bearish-authority.ts";
import { selectTier2Cycle, tier2PriorityConfig, type Tier2Candidate } from "./tier2-priority.ts";
import {
  sweepAwareness, nextObservationCache, optionsAwarenessConfig,
  type AwarenessQuote, type AwarenessObservation, type AwarenessSweep,
} from "./awareness.ts";
import {
  computePromotionCapacity, selectPromotions, promotionCapacityConfig, explorationSweepCycles,
} from "./promotion.ts";
import {
  classifySessionRangePosition,
  SESSION_RANGE_POSITION_SEMANTICS,
} from "./session-range-position.ts";
import {
  classifyChainAttempt, applyOptionabilityObservation, shouldSpendChainRequest,
  unknownRecord, expireIfStale, optionabilityConfig, emptyZeroContractCounters,
  type OptionabilityRecord, type ZeroContractCause,
} from "./optionability.ts";
import {
  admitChainRequests, chainAdmissionConfig, chainTicketKey,
  type ChainTicket, type ChainAdmissionResult,
} from "./chain-admission.ts";
import {
  collectMissedOpportunities, missedOpportunityConfig,
  persistMissedOpportunitiesOnDb, pruneMissedOpportunitiesOnDb,
  type MissedOpportunityConfig, type SkipReason,
} from "./missed-opportunity.ts";
import { observeLiveShadow } from "./live-shadow.ts";
import { splitChainCapacity, actionableReserveFraction } from "./provider-lane-audit.ts";
import { activeSignals, type StrategySelection } from "./discovery.ts";
import { tradingDay } from "../../trading-session.ts";
import type { AwarenessRow } from "./awareness.ts";

export function portfolioDeliveryStatus(env: NodeJS.ProcessEnv = process.env): { required: boolean; enabled: boolean; healthy: boolean; reason: string | null } {
  const required = researchFlags(env).independentOptionsDiscovery;
  const enabled = env.OPTIONS_PORTFOLIO_DELIVERY_ENABLED === "1";
  const healthy = !required || enabled;
  return { required, enabled, healthy, reason: healthy ? null : "OPTIONS_PORTFOLIO_DELIVERY_ENABLED!=1 while INDEPENDENT_OPTIONS_DISCOVERY_ENABLED=1" };
}

export interface UnderlyingSnapshot {
  price: number | null; dayDollarVolume: number | null; relVolume: number | null;
  velPct: number | null; accelPct: number | null; gapPct: number | null;
  volumeAccel?: number | null; volumeSurgeProxy?: number | null; dollarVolumeAccel?: number | null;
  aboveVwap: boolean | null; hodBreak: boolean | null; lodBreak?: boolean | null; nearResistancePct: number | null; nearSupportPct?: number | null;
  compressionPct: number | null; realizedVolExpanding: boolean | null; openingRange: boolean | null; premarketLevelTest: boolean | null;
}
export interface OptionsMonitorDeps {
  getUnderlyingBatch: (symbols: string[]) => Promise<Map<string, UnderlyingSnapshot>>;
  /**
   * Returns a discriminated outcome, not a bare array. The array form could not
   * distinguish our own page-budget truncation from an empty market, and
   * contract discovery was recording the difference as `PROVIDER_ERROR`.
   * `underlyingPrice` lets the fetch bound strikes around spot.
   */
  getChain: (symbol: string, underlyingPrice?: number | null, opts?: { side?: "call" | "put" | null; strategyKey?: string | null }) => Promise<ChainFetchOutcome>;
  /** Stage 1.5: compact recent 1-minute bars for enriched decision-time features. Optional — without
   *  it the monitor falls back to snapshot-only features (sparser). */
  getBars?: (symbol: string) => Promise<Bar[]>;
  levelContext?: (symbol: string) => Partial<FeatureContext> | null;
  tier2Universe?: () => Promise<string[]> | string[];
  /**
   * The Tier-2 eligible universe WITH the day-move each symbol is showing, so
   * the cycle can be pointed at what is actually moving instead of at whatever
   * order the provider happened to return.
   *
   * Preferred over `tier2Universe` when present. Absent means the old
   * provider-order behaviour, which is what every existing test injects.
   */
  tier2Candidates?: () => Promise<Tier2Candidate[]> | Tier2Candidate[];
  /**
   * The FULL Tier-2 eligible universe with every snapshot field already paid
   * for — the input to cheap awareness.
   *
   * Preferred over `tier2Candidates`, which is preferred over `tier2Universe`.
   * When present, the whole universe is scored every cycle and the expensive
   * slot count stops being the number of symbols the monitor can see at all.
   * Absent means the previous behaviour, which is what existing tests inject.
   */
  tier2AwarenessQuotes?: () => Promise<AwarenessQuote[]> | AwarenessQuote[];
  /**
   * The GLOBAL provider meter, so promotion capacity is sized against real
   * shared headroom rather than only this lane's process-local bucket. Absent
   * means read it from the provider module directly, which is what production
   * does; injecting it is what makes the saturation behaviour testable.
   */
  providerStats?: (nowMs: number) => { minuteCap?: number; callsThisMinute?: number } | null;
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
  /**
   * Whether the chain-admission queue orders this lane's chain spend.
   *
   * DEFAULT OFF, and the default is the point. Admission changes the SHAPE of a
   * cycle — candidates are prepared, ranked as a batch, and only then served —
   * where today each symbol races straight from plausibility to its own chain
   * fetch. The ordering it produces is strictly better and every boundedness
   * property is tested, but it is an unproven change to the live path of the
   * primary product, and the owner is not at the desk. One env var turns it on
   * after review; nothing about the streaming path changes while it is off.
   */
  chainAdmissionEnabled: boolean;
  /** Deadline a chain ticket is served by, after which it describes a stale market. */
  chainTicketTtlMs: number;
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
    chainAdmissionEnabled: env.OPTIONS_CHAIN_ADMISSION_ENABLED === "1",
    // One Tier-2 cadence. A chain fetched a full cycle after the observation
    // that justified it is answering a question about a market that has moved,
    // so the ticket leaves rather than being served stale.
    chainTicketTtlMs: n(env.OPTIONS_CHAIN_TICKET_TTL_MS, 60_000, 1000),
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
  /** Round-robin position in the Tier-2 rotation band. Survives cycles, not restarts. */
  tier2Cursor: number;
  /** What the last Tier-2 cycle chose and why. Observability only. */
  lastTier2Selection: {
    atMs: number; universeSize: number; priority: string[];
    rotated: number; deferred: number; cyclesForFullCoverage: number;
  } | null;
  /**
   * Previous cheap observation per symbol, so the next sweep can compute
   * acceleration. REPLACED wholesale each sweep, never appended — bounded by
   * the eligible universe (~1.6k entries), so it cannot grow across a session.
   */
  awarenessPrior: Map<string, AwarenessObservation>;
  /** When each symbol was last CHEAPLY observed. Rebuilt each sweep. */
  cheapObservedAt: Map<string, number>;
  /**
   * When each symbol was last DEEPLY analysed. Pruned to the current universe
   * each sweep so delisted/ineligible names cannot accumulate.
   */
  deepAnalyzedAt: Map<string, number>;
  /** Phase-10 coverage record for the last Tier-2 cycle. */
  lastAwareness: {
    atMs: number;
    eligibleOptionsUniverse: number;
    cheapObservedThisCycle: number;
    cheapObservationCoveragePct: number;
    withVelocity: number;
    countsByBand: Record<string, number>;
    deepAnalysisPromoted: number;
    deepAnalysisDeferred: number;
    promotionCapacity: number;
    capacityBoundBy: string;
    providerHeadroomRatio: number;
    capacityExplain: string;
    promotedByScore: string[];
    promotedByExploration: string[];
    explorationSweepCycles: number;
    topRanked: { symbol: string; preScore: number; band: string; reason: string }[];
  } | null;
  /** High-priority work refused by the provider budget, for Phase-9 diagnosis. */
  quotaBlockedHighPriority: number;

  /* ── PHASE A · tri-state optionability ───────────────────────────────── */
  /**
   * What is KNOWN about each symbol having listed options.
   *
   * Pruned to the live universe every sweep, exactly like `deepAnalyzedAt`, so a
   * delisted name cannot accumulate. UNKNOWN symbols are deliberately NOT stored
   * — absence already means UNKNOWN, and storing it would double the map to
   * record the default.
   */
  optionability: Map<string, OptionabilityRecord>;
  /** Chain requests not spent because a live NOT_OPTIONABLE verdict said so. */
  chainSkippedForProvenNotOptionable: number;

  /* ── PHASE B · zero-contract causes ──────────────────────────────────── */
  /** Bounded per-cause tallies. Fixed key set, so it cannot grow. */
  zeroContractCauses: Record<ZeroContractCause, number>;
  /** The same totals split by whose fault it was. */
  zeroContractOrigins: { PROVIDER: number; REQUEST: number; SELECTOR: number; SYMBOL: number };

  /* ── PHASE C · chain admission ───────────────────────────────────────── */
  /**
   * Tickets deferred by a previous cycle, re-offered by the next one.
   *
   * Bounded three ways and every one of them is enforced in `admitChainRequests`
   * rather than here: a deadline, an attempt count, and de-duplication by
   * (symbol, side, strategy). The map is additionally capped on write, because a
   * bound that depends on a downstream function being called is not a bound.
   */
  chainQueue: Map<string, ChainTicket>;
  /**
   * Whether the LAST cycle actually ran with admission on.
   *
   * Read from the cycle's own env rather than re-derived from `process.env` at
   * report time. The monitor takes its env as an argument, so a metrics reader
   * that consults the ambient environment can report "inactive" for a lane that
   * has been ordering its spend all session — a reporting bug that would make
   * the rollout impossible to verify.
   */
  chainAdmissionActive: boolean;
  /**
   * Carried tickets dropped because this cycle did not re-prepare their symbol.
   *
   * A persistently large number means the promoted set is churning faster than
   * the queue can serve it, which is a capacity finding rather than a bug.
   */
  chainCarryDropped: number;
  lastAdmission: {
    atMs: number; capacity: number; actionableReserved: number;
    admitted: number; deferred: number; expired: number;
    duplicatesCollapsed: number; highPriorityDeferred: number;
  } | null;

  /* ── PHASE E · missed / deferred capture ─────────────────────────────── */
  /**
   * Last (reason, band) written per symbol, so only TRANSITIONS are stored.
   *
   * Without this a symbol that is simply never the best idea in the universe
   * writes one identical row a minute for 390 minutes — 1,600 symbols would turn
   * a diagnostic into the largest table in the database, and every row after the
   * first says exactly what the first one said. Pruned to the live universe.
   */
  missedLastState: Map<string, { reason: SkipReason; atMs: number }>;
  /**
   * Transitions recorded since the last sweep, waiting for the awareness row
   * that explains them.
   *
   * The skip happens deep inside the per-symbol scan, where the pre-score, rank
   * and band that make the record worth keeping are not in scope; the sweep has
   * all three and no idea which symbols were skipped. This map is the join, and
   * it is DRAINED every sweep so it cannot accumulate.
   */
  missedPending: Map<string, SkipReason>;
  missedWritten: number;
  missedTruncated: number;
  lastMissedPruneMs: number;
}
type G = typeof globalThis & { __optiscanOptionsMonitor?: MonitorState };
function state(): MonitorState {
  const g = globalThis as G;
  return (g.__optiscanOptionsMonitor ??= {
    running: false, timers: [], cooldownSymbol: new Map(), cooldownStrategy: new Map(), inFlight: new Set(),
    breaker: { state: "closed", failures: 0, openUntil: 0 }, budget: { windowStart: 0, used: 0 }, budgetTier0: { windowStart: 0, used: 0 },
    metrics: { symbolsScanned: 0, candidatesCreated: 0, candidatesRejected: 0, chainsFetched: 0, providerUnderlying: 0, providerBars: 0, providerChain: 0, providerDetailed: 0, providerFailures: 0, throttles: 0, cooldownSkips: 0, stage1Pass: 0, stage15Enrich: 0, stage15Stale: 0, stage15Forming: 0, stage2Chain: 0, optionsActivityEscalations: 0, tier0Scanned: 0, tier0Candidates: 0, tier0BudgetSkips: 0, phaseEarly: 0, phaseDuring: 0, phaseLate: 0, lastTier0CycleMs: null, lastTier1CycleMs: null, lastTier2CycleMs: null, latestCandidateMs: null, cycleDurations: [], detectionToDecision: [], rvolSamples: [], vwapDistSamples: [], compressionSamples: [], fractionMoveSamples: [] },
    tier2Cursor: 0, lastTier2Selection: null,
    awarenessPrior: new Map(), cheapObservedAt: new Map(), deepAnalyzedAt: new Map(),
    lastAwareness: null, quotaBlockedHighPriority: 0,
    optionability: new Map(), chainSkippedForProvenNotOptionable: 0,
    zeroContractCauses: emptyZeroContractCounters(),
    zeroContractOrigins: { PROVIDER: 0, REQUEST: 0, SELECTOR: 0, SYMBOL: 0 },
    chainQueue: new Map(), chainAdmissionActive: false, chainCarryDropped: 0, lastAdmission: null,
    missedLastState: new Map(), missedPending: new Map(),
    missedWritten: 0, missedTruncated: 0, lastMissedPruneMs: 0,
  });
}

function tryConsume(s: MonitorState, cfg: OptionsMonitorConfig, now: number, tier: 0 | 1 | 2 = 1): boolean {
  // Soft global budget: Tier 1/2 yield when the shared Polygon minute meter is hot.
  // Tier 0 stays privileged (fast index path) unless the hard provider cap refuses.
  if (tier !== 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { nearMinuteBudget } = require("@/lib/near-miss");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getCallStats } = require("@/lib/polygon-provider");
      if (nearMinuteBudget(getCallStats(now))) {
        s.metrics.throttles += 1;
        return false;
      }
    } catch {
      /* budget helpers unavailable — fall through to local bucket */
    }
  }
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
/**
 * One discovery cycle for a tier.
 *
 * Attributed to `options_discovery` (Gate B5). Before this scope existed the whole
 * independent options monitor billed to `unattributed`, which production measured at
 * 66.6% of the entire day's provider spend — the single largest consumer in the system
 * was the one nobody could name.
 */
export async function runOptionsMonitorCycle(tier: 0 | 1 | 2, symbols: string[], deps: OptionsMonitorDeps, env: NodeJS.ProcessEnv = process.env, cfg: OptionsMonitorConfig = defaultMonitorConfig(env)): Promise<CycleResult> {
  return withProviderConsumer("options_discovery", () => runOptionsMonitorCycleInner(tier, symbols, deps, env, cfg));
}

async function runOptionsMonitorCycleInner(tier: 0 | 1 | 2, symbols: string[], deps: OptionsMonitorDeps, env: NodeJS.ProcessEnv, cfg: OptionsMonitorConfig): Promise<CycleResult> {
  const s = state();
  const now = deps.now ?? Date.now;
  const session = (deps.session ?? (() => "regular" as Session))();
  const getDb = deps.getDb;
  const candTier: 1 | 2 = tier === 2 ? 2 : 1;   // Tier 0 evaluates as core for strategy/DTE purposes
  const t0 = now();
  let scanned = 0, created = 0, rejected = 0, chains = 0;

  if (breakerOpen(s, t0)) { s.metrics.throttles += 1; return { tier, scanned: 0, created: 0, rejected: 0, chains: 0, durationMs: now() - t0 }; }

  const scanGuard = assertSubscriberScanAllowed(t0, env);
  const guardMode = String(env.MARKET_SESSION_GUARD ?? "shadow").toLowerCase();
  if (!scanGuard.ok && guardMode !== "shadow" && guardMode !== "0") {
    s.metrics.throttles += 1;
    return { tier, scanned: 0, created: 0, rejected: 0, chains: 0, durationMs: now() - t0 };
  }

  // PORTFOLIO DELIVERY (flag-gated): collect every READY candidate this cycle so they compete in ONE
  // ranked delivery decision instead of racing first-come to Discord. Sensitivity unchanged — research
  // shadow paper still opens per candidate; only the DELIVERY decision becomes portfolio-level.
  const portfolio = portfolioDeliveryStatus(env);
  if (!portfolio.healthy) {
    console.error(`[options-monitor] unhealthy: ${portfolio.reason}; subscriber delivery is fail-closed`);
    s.metrics.throttles += 1;
    return { tier, scanned: 0, created: 0, rejected: 0, chains: 0, durationMs: now() - t0 };
  }
  const deliveryBatch: DeliverySubmission[] = [];

  // STAGE 1 — ONE cheap underlying batch snapshot for the whole set (rejects most symbols before any
  // chain is ever fetched). One provider call for the batch (from the tier's own budget bucket).
  let snaps: Map<string, UnderlyingSnapshot>;
  if (!tryConsume(s, cfg, t0, tier)) { s.metrics.throttles += 1; return { tier, scanned: 0, created: 0, rejected: 0, chains: 0, durationMs: now() - t0 }; }
  try { snaps = await deps.getUnderlyingBatch(symbols); s.metrics.providerUnderlying += 1; breakerSuccess(s); }
  catch { s.metrics.providerFailures += 1; breakerFail(s, cfg, now()); return { tier, scanned: 0, created: 0, rejected: 0, chains: 0, durationMs: now() - t0 }; }

  /**
   * ONE SYMBOL, UP TO THE MOMENT A CHAIN WOULD BE SPENT.
   *
   * The per-symbol work is split here into PREPARE (everything free, or already
   * paid for) and COMPLETE (the chain request and everything downstream of it).
   * The split exists so that the expensive half can be ORDERED — with admission
   * off the two halves run back to back and the behaviour is byte-for-byte what
   * it was; with admission on, every symbol prepares first and the lane then
   * spends its budget on the best tickets instead of on whichever symbol the
   * concurrency pool happened to reach first.
   *
   * Returns null when the symbol is finished (rejected, cooling down, out of
   * budget). A non-null return means "this symbol wants a chain", and the caller
   * owns `inFlight` for it until `completeCandidate` runs or drops it.
   */
  interface PreparedCandidate {
    symbol: string;
    n0: number;
    input: OptionsCandidateInput;
    candidateCreatedAtMs: number;
    featureSnapshot: any;
    fractionMove: number | null;
    preSelection: StrategySelection | null;
    escalatedBy: string | null;
    legacyBearishEscalation: any;
    bars: Bar[] | null;
    hod: number | null;
    lod: number | null;
    ticket: ChainTicket;
  }

  const releaseSymbol = (symbol: string, reason: SkipReason | null): void => {
    s.inFlight.delete(symbol);
    if (reason) noteSkip(s, symbol, reason, now(), env);
  };

  const prepareCandidate = async (symbol: string): Promise<PreparedCandidate | null> => {
    const n0 = now();
    if ((s.cooldownSymbol.get(symbol) ?? 0) > n0) { s.metrics.cooldownSkips += 1; return null; }
    if (s.inFlight.has(symbol)) return null; // no overlapping scan of the same symbol
    s.inFlight.add(symbol);
    const flags = researchFlags(env);
    try {
      scanned += 1; s.metrics.symbolsScanned += 1; if (tier === 0) s.metrics.tier0Scanned += 1;
      const snap = snaps.get(symbol);
      // STAGE 1 — cheap liquidity/price/fresh reject (no bars, no chain).
      if (!snap || snap.price == null || (snap.dayDollarVolume ?? 0) < 5_000_000) { s.cooldownSymbol.set(symbol, n0 + cfg.symbolCooldownMs); releaseSymbol(symbol, null); return null; }
      s.metrics.stage1Pass += 1;

      // STAGE 1.5 — enrich with compact recent bars → decision-time features (when getBars is wired).
      let input = toCandidate(symbol, candTier, session, snap, n0);
      const candidateCreatedAtMs = now();
      let featureSnapshot: any = { source: "snapshot_only" };
      let fractionMove: number | null = null;
      let bars: Bar[] | null = null;
      let hod: number | null = null;
      let lod: number | null = null;
      if (deps.getBars) {
        if (breakerOpen(s, now())) { s.metrics.throttles += 1; releaseSymbol(symbol, null); return null; }
        if (!tryConsume(s, cfg, now(), tier)) { s.metrics.throttles += 1; releaseSymbol(symbol, "QUOTA_BLOCKED"); return null; }
        bars = await deps.getBars(symbol); s.metrics.providerBars += 1; breakerSuccess(s);
        const ctx: FeatureContext = { nowMs: n0, session, ...(deps.levelContext?.(symbol) ?? {}) };
        const f = computeOptionsFeatures(bars, ctx);
        s.metrics.stage15Enrich += 1;
        if (f.stale) { s.metrics.stage15Stale += 1; rejected += 1; s.metrics.candidatesRejected += 1; s.cooldownSymbol.set(symbol, n0 + cfg.symbolCooldownMs); releaseSymbol(symbol, null); return null; } // stale bars reject safely
        const u = featuresToUnderlying(f);
        input = { ...input, underlying: u };
        featureSnapshot = { source: "enriched", underlying: f };
        hod = f.hod; lod = f.lod;
        // Record only legitimate time-of-day RVOL. The separately named surge
        // proxy must never enter an RVOL distribution.
        if (u.relVolume != null) record(s.metrics.rvolSamples, u.relVolume);
        if (f.vwapDistPct != null) record(s.metrics.vwapDistSamples, f.vwapDistPct);
        if (f.compressionScore != null) record(s.metrics.compressionSamples, f.compressionScore);
        if (f.hod != null && f.lod != null && f.hod > f.lod && f.price != null) { fractionMove = +(((f.price - f.lod) / (f.hod - f.lod))).toFixed(3); record(s.metrics.fractionMoveSamples, fractionMove); }
      }

      // STAGE 1.5 gate — a chain is fetched only when a strategy is plausible OR (options-activity
      // discovery on) to let abnormal chain activity INDEPENDENTLY escalate the symbol.
      let escalatedBy: string | null = null;
      let legacyBearishEscalation: any | null = null;
      if (getDb && bearishPipelineEnabled(env)) {
        try { legacyBearishEscalation = latestPendingBearishEscalationForSymbol(getDb(), symbol, n0); }
        catch { legacyBearishEscalation = null; }
      }
      const active = activeSignals(input);
      const plausible = scoreStrategies(input).some((x) => x.applicable);
      const preSelection = plausible
        ? selectOptionsStrategy(input, { bearishActionable: bearishPipelineEnabled(env) })
        : null;

      // PHASES F–J — SHADOW OBSERVATION AT THE DECISION INSTANT.
      //
      // Placed here, before the chain decision, because this is the exact state
      // production decided from: the same bars, the same board, the same
      // fractionMove. Measuring after the chain would let a shadow "explain" a
      // rejection using evidence the live decision never had. It returns void
      // and cannot throw out — see live-shadow.ts.
      observeLiveShadow({
        symbol, atMs: n0, tier,
        bars, price: input.underlying.price ?? null, hod, lod,
        productionFractionMove: fractionMove,
        side: preSelection?.selected?.side ?? null,
        strategyKey: preSelection?.selected?.key ?? null,
        considered: preSelection?.considered ?? null,
        activeSignals: active,
        underlying: input.underlying,
        strategyScore: preSelection?.selected?.score ?? null,
        researchOnly: preSelection?.selected?.researchOnly ?? null,
      }, env);

      // FORMING, not yet plausible: re-check at the scan cadence (symbolFormingRecheckMs, default 0)
      // instead of freezing 60s, so the callout can fire as soon as the setup validates — while it is
      // still forming, not after the expansion. NOT a quality change: no gate loosened, no extra alert
      // (actual callouts are still deduped by the per-strategy cooldown + delivery alertId bucket).
      if (!plausible && !flags.optionsActivityDiscovery && !legacyBearishEscalation) { rejected += 1; s.metrics.candidatesRejected += 1; s.metrics.stage15Forming += 1; s.cooldownSymbol.set(symbol, n0 + cfg.symbolFormingRecheckMs); releaseSymbol(symbol, "STRATEGY_REJECTED"); return null; }
      if (!plausible) escalatedBy = legacyBearishEscalation ? "legacy_bearish_escalation" : "options_activity_probe";

      // PHASE A — TRI-STATE OPTIONABILITY, ON THE LIVE CHAIN PATH.
      //
      // The ONLY state that suppresses spend is a live, in-TTL NOT_OPTIONABLE
      // verdict. UNKNOWN spends: not knowing whether a symbol has options is the
      // reason to look, not a reason to be blind, and a registry that treated
      // silence as a negative would make every new listing permanently invisible.
      // `expireIfStale` is applied on read so an aged verdict returns to UNKNOWN
      // without a sweep having to run.
      const optCfg = optionabilityConfig(env);
      const known = s.optionability.get(symbol);
      if (known) {
        const fresh = expireIfStale(known, now(), optCfg);
        if (fresh !== known) s.optionability.set(symbol, fresh);
        const verdict = shouldSpendChainRequest(fresh, now(), optCfg);
        if (!verdict.spend) {
          s.chainSkippedForProvenNotOptionable += 1;
          rejected += 1; s.metrics.candidatesRejected += 1;
          s.cooldownSymbol.set(symbol, now() + cfg.symbolCooldownMs);
          releaseSymbol(symbol, "NO_CHAIN");
          return null;
        }
      }

      const ticket: ChainTicket = {
        symbol,
        side: preSelection?.selected?.side ?? null,
        strategyKey: preSelection?.selected?.key ?? null,
        score: preSelection?.selected?.score ?? 0,
        researchOnly: preSelection?.selected?.researchOnly !== false,
        tier,
        requestedAtMs: n0,
        deadlineMs: n0 + cfg.chainTicketTtlMs,
        attempts: 0,
      };

      return {
        symbol, n0, input, candidateCreatedAtMs, featureSnapshot, fractionMove,
        preSelection, escalatedBy, legacyBearishEscalation, bars, hod, lod, ticket,
      };
    } catch {
      s.metrics.providerFailures += 1; breakerFail(s, cfg, now());
      releaseSymbol(symbol, null);
      return null;
    }
  };

  /** THE EXPENSIVE HALF. Everything from the chain request onward. */
  const completeCandidate = async (p: PreparedCandidate): Promise<void> => {
    const { symbol, n0 } = p;
    let input = p.input;
    let featureSnapshot = p.featureSnapshot;
    try {
      if (breakerOpen(s, now())) { s.metrics.throttles += 1; return; }
      if (!tryConsume(s, cfg, now(), tier)) { s.metrics.throttles += 1; noteSkip(s, symbol, "QUOTA_BLOCKED", now(), env); return; }
      // STAGE 2 — fetch the chain + compute chain features.
      const chainStartedAtMs = now();
      const chainRes = await deps.getChain(symbol, input.underlying.price ?? null, {
        side: p.preSelection?.selected?.side ?? null,
        strategyKey: p.preSelection?.selected?.key ?? null,
      });
      const chainCompletedAtMs = now();
      const chain = chainRes.contracts;
      s.metrics.providerChain += 1; s.metrics.stage2Chain += 1; s.metrics.chainsFetched += 1; chains += 1; breakerSuccess(s);
      // "Available" is about whether the provider answered, not whether the answer
      // was non-empty. A successful empty response is available-and-empty; a
      // refusal or failure is not available at all.
      const chainAvailable = chainRes.outcome === "CONTRACTS_AVAILABLE"
        || chainRes.outcome === "NO_CONTRACTS_IN_REQUESTED_RANGE"
        || chainRes.outcome === "CHAIN_TRUNCATED_BEFORE_RANGE";
      const chainF = summarizeChainFeatures({ symbol, underlyingPrice: input.underlying.price, underlyingDollarVolume: input.underlying.dayDollarVolume, contracts: chain as unknown as OptionContract[], chainAvailable, nowMs: now() });
      input = { ...input, optionsActivity: chainFeaturesToActivity(chainF) };
      featureSnapshot = { ...featureSnapshot, chain: chainF, legacyBearishEscalation: p.legacyBearishEscalation };
      // If we only reached here via escalation, require the chain to actually be abnormal.
      if (p.escalatedBy === "options_activity_probe") { if (!chainF.abnormal || chainF.direction === "ambiguous") { rejected += 1; s.metrics.candidatesRejected += 1; s.cooldownSymbol.set(symbol, n0 + cfg.symbolCooldownMs); return; } s.metrics.optionsActivityEscalations += 1; }

      // Session RANGE POSITION, not earliness. The buckets and thresholds are
      // unchanged so stored rows keep their meaning; only the name is now honest.
      // It is direction-blind — for a PUT the "early" bucket is the moment the
      // downside move has already happened — so it must not be read as pre-move
      // discovery. See pre-move-discovery.ts for the metric that can be.
      const earlinessPhase = classifySessionRangePosition(p.fractionMove);
      if (earlinessPhase === "early") s.metrics.phaseEarly += 1; else if (earlinessPhase === "during") s.metrics.phaseDuring += 1; else if (earlinessPhase === "late") s.metrics.phaseLate += 1;

      const latencyTrace: OptionsLatencyTrace = {
        traceId: `olt:${n0}:${tier}:${symbol.toUpperCase()}`,
        symbol: symbol.toUpperCase(), tier,
        observationReceivedAtMs: n0,
        candidateCreatedAtMs: p.candidateCreatedAtMs,
        strategyEvaluationCompletedAtMs: null,
        chainStartedAtMs,
        chainCompletedAtMs,
        contractSelectedAtMs: null,
        providerQuoteTimestampMs: null,
        providerQuoteAgeMs: null,
      };
      const res = runOptionsCandidate({ ...input }, chain, getDb ? { getDb } : {}, env, {
        chainOutcome: chainRes,
        featureSnapshot: { ...featureSnapshot, fractionMove: p.fractionMove, earlinessPhase }, earlinessPhase, escalatedBy: p.escalatedBy, coreBroad: tier === 2 ? "broad" : "core",
        rankTier: tier, fractionMove: p.fractionMove, latencyTrace,
        ...(portfolio.enabled ? { collectDelivery: (sub) => deliveryBatch.push(sub) } : {}),
      });
      latencyTrace.strategyEvaluationCompletedAtMs = now();
      latencyTrace.contractSelectedAtMs = res?.contract ? latencyTrace.strategyEvaluationCompletedAtMs : null;
      latencyTrace.providerQuoteTimestampMs = res?.contract?.providerTimestamp ?? null;
      latencyTrace.providerQuoteAgeMs = res?.contract?.providerTimestamp == null
        ? null
        : Math.max(0, latencyTrace.strategyEvaluationCompletedAtMs - res.contract.providerTimestamp);

      // PHASES A + B — WHAT THE ATTEMPT ACTUALLY PROVED.
      //
      // Classified from the FETCH first and the selector only where contracts
      // genuinely arrived, so a quota refusal can never be recorded as a band
      // rejection. Only the causes that `countsAsEvidence` may move a symbol
      // toward NOT_OPTIONABLE, and corroboration is counted per SESSION — 802
      // attempts inside one bad afternoon is one observation repeated.
      recordChainAttempt(s, symbol, chainRes, res, now(), env);

      if (getDb) {
        try {
          persistOptionsLatencyTraceOnDb(
            getDb(), latencyTrace, res?.selection.selected?.key ?? null,
            res?.state ?? "NO_SELECTION", latencyTrace.strategyEvaluationCompletedAtMs,
          );
        } catch { /* telemetry must never alter evaluation */ }
      }
      // PHASE F — the counterfactual needs the OUTCOME beside the evidence, so
      // the Stage-1.5 attempt is closed here rather than at decision time.
      observeLiveShadow({
        symbol, atMs: n0, tier,
        side: p.preSelection?.selected?.side ?? null,
        strategyKey: p.preSelection?.selected?.key ?? null,
        underlying: input.underlying,
        strategyScore: p.preSelection?.selected?.score ?? null,
        researchOnly: p.preSelection?.selected?.researchOnly ?? null,
        contractsReturned: chain.length,
        selectedOcc: !!res?.contract,
        becameCase: !!res?.selection.selected,
      }, env);

      if (res?.selection.selected) { created += 1; s.metrics.candidatesCreated += 1; if (tier === 0) s.metrics.tier0Candidates += 1; s.metrics.latestCandidateMs = now(); s.cooldownStrategy.set(`${symbol}:${res.selection.selected.key}`, now() + cfg.strategyCooldownMs); }
      else { rejected += 1; s.metrics.candidatesRejected += 1; noteSkip(s, symbol, chain.length === 0 ? "NO_CHAIN" : "STRATEGY_REJECTED", now(), env); }
      s.cooldownSymbol.set(symbol, now() + cfg.symbolCooldownMs);
      record(s.metrics.detectionToDecision, now() - n0);
    } catch {
      s.metrics.providerFailures += 1; breakerFail(s, cfg, now());
    } finally { s.inFlight.delete(symbol); }
  };

  s.chainAdmissionActive = cfg.chainAdmissionEnabled;
  if (!cfg.chainAdmissionEnabled) {
    // STREAMING PATH — the shipped behaviour, unchanged. Each symbol goes
    // straight from its own plausibility verdict to its own chain request.
    await mapWithConcurrency(symbols, cfg.maxConcurrency, async (symbol) => {
      const prepared = await prepareCandidate(symbol);
      if (prepared) await completeCandidate(prepared);
    });
  } else {
    // ADMISSION PATH — prepare everything, then spend the lane's remaining
    // budget on the best tickets. The barrier is the cost and the point: the
    // ordering cannot exist without knowing the whole board.
    const prepared: PreparedCandidate[] = [];
    await mapWithConcurrency(symbols, cfg.maxConcurrency, async (symbol) => {
      const p = await prepareCandidate(symbol);
      if (p) prepared.push(p);
    });

    const admitCfg = chainAdmissionConfig(env);
    const nowMs = now();
    const byKey = new Map<string, PreparedCandidate>();
    for (const p of prepared) byKey.set(chainTicketKey(p.ticket), p);

    /**
     * Carried tickets are re-offered ONLY where this cycle prepared the same
     * setup again.
     *
     * A ticket carries two things worth keeping: its original `requestedAtMs`,
     * which is what the aging term measures, and its attempt count, which is
     * what eventually retires it. `admitChainRequests` merges both onto the
     * fresh ticket when it collapses the duplicate, so nothing is lost.
     *
     * What it CANNOT carry is the candidate. A chain cannot be fetched for a
     * symbol this cycle never prepared — there are no features, no strategy and
     * no input to evaluate against. Offering such a ticket anyway lets it WIN a
     * slot, do nothing with it, and vanish: a wasted request-slot that also
     * defers a servable ticket. That is the queue starving the work it exists
     * to protect, so an unservable carry is dropped and counted instead.
     */
    const carried: ChainTicket[] = [];
    for (const t of s.chainQueue.values()) {
      if (t.deadlineMs <= nowMs) continue;
      if (byKey.has(chainTicketKey(t))) carried.push(t);
      else s.chainCarryDropped += 1;
    }

    const headroom = tier2Headroom(s, cfg, nowMs, deps.providerStats);
    const split = splitChainCapacity(headroom.remainingThisMinute, actionableReserveFraction(env));
    const admission: ChainAdmissionResult = admitChainRequests(
      [...carried, ...prepared.map((p) => p.ticket)],
      split.total, nowMs, admitCfg,
      { actionableReserved: split.actionableReserved },
    );

    s.lastAdmission = {
      atMs: nowMs, capacity: admission.capacity, actionableReserved: admission.actionableReserved,
      admitted: admission.admitted.length, deferred: admission.deferred.length,
      expired: admission.expired.length, duplicatesCollapsed: admission.duplicatesCollapsed,
      highPriorityDeferred: admission.highPriorityDeferred,
    };

    const admittedKeys = new Set(admission.admitted.map(chainTicketKey));
    await mapWithConcurrency(
      admission.admitted.map(chainTicketKey).filter((k) => byKey.has(k)),
      cfg.maxConcurrency,
      async (key) => { const p = byKey.get(key); if (p) await completeCandidate(p); },
    );

    // Everything prepared but not served releases its in-flight slot NOW. A
    // deferred ticket that kept the slot would block the same symbol from being
    // prepared next cycle — a queue that starves the very ticket it is holding.
    for (const [key, p] of byKey) {
      if (!admittedKeys.has(key)) {
        s.inFlight.delete(p.symbol);
        noteSkip(s, p.symbol, "DEEP_DEFERRED", nowMs, env);
      }
    }

    // Rebuild the carry-over queue from the deferrals ONLY. Expired tickets are
    // dropped here, which is what makes the queue bounded by the deadline rather
    // than by hope; the size cap below bounds it even if the deadline is
    // misconfigured to something absurd.
    s.chainQueue = new Map();
    for (const t of admission.deferred.slice(0, CHAIN_QUEUE_MAX)) {
      s.chainQueue.set(chainTicketKey(t), t);
    }
  }

  // FLUSH the portfolio delivery decision: rank the whole batch, deliver only the subscriber-worthy
  // winners, route the rest to research, persist every rationale. Isolated — never fails the cycle.
  if (portfolio.enabled && deliveryBatch.length > 0) {
    try { await decideDeliveryBatch(deliveryBatch, { getDb, now }, env); }
    catch { /* decision-layer failure never blocks scanning */ }
  }

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

/**
 * Hard cap on the carry-over chain queue.
 *
 * The deadline and the attempt counter already bound it, and this bounds it
 * again with a number that does not depend on either being configured sanely. A
 * queue whose only limit is a TTL is one bad env var away from unbounded, and
 * the whole point of Phase C is that boundedness is a proven property rather
 * than an intended one. Sized above any real cycle's ticket count so it never
 * binds in normal operation — if it ever does, the deadline logic is broken and
 * the counter below says so.
 */
export const CHAIN_QUEUE_MAX = 200;

/**
 * PHASE B — fold one resolved chain attempt into the counters and the registry.
 *
 * ORDER IS LOAD-BEARING. The fetch outcome is classified first and the selector's
 * terminal reason is consulted only when contracts genuinely arrived, so a quota
 * refusal can never be relabelled as a band rejection by a stale funnel field.
 *
 * `sessionDay` is the trading day, not the wall-clock day, and it is what makes
 * corroboration mean something: repeating a measurement 802 times inside one
 * afternoon is one observation, and only separate SESSIONS may accumulate toward
 * a NOT_OPTIONABLE verdict.
 */
function recordChainAttempt(
  s: MonitorState,
  symbol: string,
  chainRes: ChainFetchOutcome,
  res: { contract?: unknown; contractFunnel?: { terminalReason?: any } | null } | null,
  nowMs: number,
  env: NodeJS.ProcessEnv,
): void {
  try {
    const classification = classifyChainAttempt(chainRes, {
      terminalReason: res?.contractFunnel?.terminalReason ?? null,
      contractSelected: !!res?.contract,
    });
    s.zeroContractCauses[classification.cause] += 1;
    s.zeroContractOrigins[classification.origin] += 1;

    const prior = s.optionability.get(symbol) ?? unknownRecord(symbol);
    const next = applyOptionabilityObservation(prior, {
      classification,
      contractsSeen: chainRes.contracts?.length ?? 0,
      sessionDay: tradingDay(nowMs),
      nowMs,
    }, optionabilityConfig(env));

    // UNKNOWN with nothing recorded is the default, so storing it would double
    // the map to say what absence already says. Anything else is worth keeping.
    if (next.state === "UNKNOWN" && next.corroboratingEmptyDays.length === 0) {
      s.optionability.delete(symbol);
    } else {
      s.optionability.set(symbol, next);
    }
  } catch { /* classification is observability; it never fails an evaluation */ }
}

/**
 * PHASE E — remember that a symbol was skipped, and why, WITHOUT writing a row.
 *
 * Only the transition is kept in memory here; the durable write happens once per
 * cycle in `runAwarenessCycle`, where the awareness row that justifies the
 * record is actually in hand. Recording the skip at the skip site and writing it
 * at the sweep site is what lets the stored row carry the pre-score, rank and
 * band — a record that said only "we skipped COIN" would not answer the question
 * Phase E exists to answer.
 */
function noteSkip(
  s: MonitorState,
  symbol: string,
  reason: SkipReason,
  nowMs: number,
  env: NodeJS.ProcessEnv,
): void {
  try {
    const prior = s.missedLastState.get(symbol);
    // A TRANSITION is a NEW reason, or the SAME reason after long enough that a
    // fresh sample is a genuinely new observation rather than an echo of the
    // last one. Without the second clause a symbol stuck in one state would be
    // written once and never revisited, which loses the fact that it stayed
    // there all session; without the first, every cycle would write a row.
    const isTransition = !prior
      || prior.reason !== reason
      || nowMs - prior.atMs >= MISSED_RESAMPLE_MS;
    if (!isTransition) return;
    s.missedLastState.set(symbol, { reason, atMs: nowMs });
    // Last write wins within a cycle: a symbol that was deferred and then quota
    // blocked is recorded as quota blocked, which is the more specific fact.
    // Capped for the same reason `missedLastState` is, and INDEPENDENTLY of it:
    // this map is drained by the awareness sweep, and a deployment that has not
    // wired the snapshot source never runs one. A bound that only holds on the
    // production path is not a bound.
    if (s.missedPending.size < MISSED_STATE_MAX) s.missedPending.set(symbol, reason);
    // Cap the map independently of the universe, so a provider returning a
    // pathological symbol list cannot turn a diagnostic into a leak.
    if (s.missedLastState.size > MISSED_STATE_MAX) {
      const oldest = [...s.missedLastState.entries()].sort((a, b) => a[1].atMs - b[1].atMs);
      for (const [k] of oldest.slice(0, s.missedLastState.size - MISSED_STATE_MAX)) s.missedLastState.delete(k);
    }
  } catch { /* never fails a scan */ }
}

/** Same reason, re-sampled at most this often. One row per symbol per 15 minutes. */
export const MISSED_RESAMPLE_MS = 15 * 60_000;
/** Hard cap on the transition map, independent of universe size. */
export const MISSED_STATE_MAX = 4_000;

function record(arr: number[], v: number) { arr.push(v); if (arr.length > 500) arr.shift(); }
const pct = (arr: number[], q: number): number | null => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };

export interface MonitorHealth {
  enabled: boolean; running: boolean; breakerState: string;
  lastTier0CycleMs: number | null; lastTier1CycleMs: number | null; lastTier2CycleMs: number | null;
  alive: boolean; portfolioDelivery: ReturnType<typeof portfolioDeliveryStatus>; unhealthyReason: string | null;
}
/** Health that NEVER fails the web endpoint: reports the loop state; "alive" is true when enabled and
 *  a recent cycle ran, but a disabled loop is simply {enabled:false} — not an error. */
export function optionsMonitorHealth(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): MonitorHealth {
  const s = state(); const enabled = researchFlags(env).independentOptionsDiscovery;
  const portfolio = portfolioDeliveryStatus(env);
  const last = Math.max(s.metrics.lastTier0CycleMs ?? 0, s.metrics.lastTier1CycleMs ?? 0, s.metrics.lastTier2CycleMs ?? 0);
  const alive = enabled ? (portfolio.healthy && last > 0 && now - last < 120_000) : true;
  return { enabled, running: s.running, breakerState: s.breaker.state, lastTier0CycleMs: s.metrics.lastTier0CycleMs, lastTier1CycleMs: s.metrics.lastTier1CycleMs, lastTier2CycleMs: s.metrics.lastTier2CycleMs, alive, portfolioDelivery: portfolio, unhealthyReason: portfolio.reason };
}
export function optionsMonitorMetrics(): Record<string, unknown> {
  const s = state();
  const m = s.metrics;
  const dist = (arr: number[]) => ({ p50: pct(arr, 0.5), p95: pct(arr, 0.95), n: arr.length });
  const totalCalls = m.providerUnderlying + m.providerBars + m.providerChain + m.providerDetailed;
  return {
    running: s.running, breaker: s.breaker.state, budgetUsed: s.budget.used, budgetTier0Used: s.budgetTier0.used, queueInFlight: s.inFlight.size,
    sessionState: sessionState(Date.now()),
    // WHICH symbols the last Tier-2 cycle chose, and how far the rotation has
    // travelled. Without this the only way to answer "was the day's biggest
    // mover ever looked at" is to infer it from the absence of a record, which
    // is exactly how the 2026-08-19 gap stayed invisible for a full session.
    tier2Selection: s.lastTier2Selection,
    tier2Cursor: s.tier2Cursor,
    // PHASE 10 — CHEAP AWARENESS and DEEP ANALYSIS as separate quantities.
    //
    // "25 names scanned" was never a coverage statement; it was a SPEND
    // statement wearing a coverage statement's clothes, and reporting it as
    // coverage is what let a 1.6%-visibility architecture look healthy for a
    // full session. These two must never be collapsed back into one number.
    coverage: optionsCoverageMetrics(Date.now()),
    // PHASE 2 — PROVIDER EFFICIENCY, as separately attributable quantities.
    //
    // `zeroContract.byOrigin` is the number the audit could not produce: 802
    // zero-contract attempts were one undifferentiated total, so there was no
    // way to tell the share that was the provider refusing us from the share
    // that was our own bands refusing the market. Those need opposite fixes.
    optionability: optionabilityMetrics(),
    zeroContract: zeroContractMetrics(),
    chainAdmission: chainAdmissionMetrics(),
    missedOpportunity: missedOpportunityMetrics(),
    tier0: { scanned: m.tier0Scanned, candidates: m.tier0Candidates, budgetSkips: m.tier0BudgetSkips, lastCycleMs: m.lastTier0CycleMs },
    symbolsScanned: m.symbolsScanned, candidatesCreated: m.candidatesCreated, candidatesRejected: m.candidatesRejected, chainsFetched: m.chainsFetched,
    stages: { stage1Pass: m.stage1Pass, stage15Enrich: m.stage15Enrich, stage15Stale: m.stage15Stale, stage15Forming: m.stage15Forming, stage2Chain: m.stage2Chain, stage3Detailed: m.providerDetailed, optionsActivityEscalations: m.optionsActivityEscalations },
    stage1PassRate: m.symbolsScanned > 0 ? +((m.stage1Pass / m.symbolsScanned) * 100).toFixed(2) : null,
    providerCalls: { underlying: m.providerUnderlying, bars: m.providerBars, chain: m.providerChain, detailed: m.providerDetailed, total: totalCalls },
    providerFailures: m.providerFailures, throttles: m.throttles, cooldownSkips: m.cooldownSkips,
    sessionRangePosition: {
      early: m.phaseEarly, during: m.phaseDuring, late: m.phaseLate,
      ...SESSION_RANGE_POSITION_SEMANTICS,
    },
    fractionMoveComplete: dist(m.fractionMoveSamples),
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
  const portfolio = portfolioDeliveryStatus(env);
  if (!portfolio.healthy) {
    console.error(`[options-monitor] startup error: ${portfolio.reason}; refusing to start independent options delivery without portfolio ranking`);
    return { started: false, reason: portfolio.reason ?? "portfolio delivery unhealthy" };
  }
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
    try {
      await runOptionsMonitorCycle(2, await selectTier2Symbols(deps, tier0Set, env, cfg), deps, env, cfg);
    } catch { /* isolated */ } finally { t2Busy = false; }
  }, sessionCadence(cfg, 2, sessionOf()));
  if (typeof (t1 as any).unref === "function") { (t0Timer as any).unref(); (t1 as any).unref(); (t2 as any).unref(); }
  s.timers = [t0Timer, t1, t2];
  const stop = () => stopOptionsMonitor();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return { started: true, reason: "started" };
}
/**
 * Requests the Tier-2 lane can actually spend this minute.
 *
 * TWO CEILINGS, AND THE SMALLER WINS. The lane bucket (`tryConsume` decrements
 * the same one, so plan and spend cannot drift apart) is only half the truth: it
 * is process-local and knows nothing about the GLOBAL provider meter, which is
 * shared with the scanner, the marks and everything else.
 *
 * Reading the lane bucket alone would compute a large capacity on a fresh local
 * window while the global 280/min cap was already saturated — which is precisely
 * the state that produced 11,449 quota blocks. Planning a big cycle into a
 * saturated provider does not get more data; it converts real headroom into
 * refusals, and a refusal still costs a request while returning nothing.
 *
 * When the global meter is unreadable the lane bucket is used alone. That is the
 * pre-existing behaviour and is safe, because the lane bucket is the tighter of
 * the two in normal operation.
 */
function tier2Headroom(
  s: MonitorState,
  cfg: OptionsMonitorConfig,
  now: number,
  providerStats?: OptionsMonitorDeps["providerStats"],
): { remainingThisMinute: number; minuteCap: number } {
  const cap = cfg.providerBudgetPerMinute;
  const windowExpired = now - s.budget.windowStart >= 60_000;
  const used = windowExpired ? 0 : s.budget.used;
  const laneRemaining = Math.max(0, cap - used);

  let globalRemaining = Number.POSITIVE_INFINITY;
  try {
    const st = providerStats
      ? providerStats(now)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      : require("@/lib/polygon-provider").getCallStats(now);
    const minuteCap = Number(st?.minuteCap);
    if (Number.isFinite(minuteCap) && minuteCap > 0) {
      globalRemaining = Math.max(0, minuteCap - (Number(st?.callsThisMinute) || 0));
    }
  } catch { /* meter unreadable — the lane bucket alone is the safe fallback */ }

  return { remainingThisMinute: Math.min(laneRemaining, globalRemaining), minuteCap: cap };
}

/**
 * Provider requests one promotion ACTUALLY costs, measured from this process.
 *
 * The config carries an ESTIMATE (bars plus an expected fractional chain, since
 * most promoted symbols are rejected by strategy scoring before any chain is
 * requested). An estimate is the wrong thing to size a budget with once real
 * counters exist, so this prefers the measurement and falls back only while the
 * sample is too small to mean anything.
 */
function measuredRequestsPerPromotion(s: MonitorState, fallback: number): number {
  const m = s.metrics;
  const scanned = m.symbolsScanned;
  if (scanned < 50) return fallback; // too small a sample to size a budget on
  const requests = m.providerBars + m.providerChain + m.providerDetailed;
  const perSymbol = requests / scanned;
  return perSymbol > 0.01 ? +perSymbol.toFixed(3) : fallback;
}

/** Percentile of a numeric sample. Returns null on an empty sample — never 0. */
function percentileOf(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * ONE CHEAP SWEEP OF THE WHOLE UNIVERSE, then a bounded promotion.
 *
 * This is the function that retires the 25-symbol visibility cap. Every
 * eligible symbol is scored here, every cycle, from the snapshot the caller
 * already holds — no provider request is issued by this function or anything it
 * calls. Only the returned symbols go on to cost anything.
 */
function runAwarenessCycle(
  quotes: AwarenessQuote[],
  deps: OptionsMonitorDeps,
  env: NodeJS.ProcessEnv,
  cfg: OptionsMonitorConfig,
): string[] {
  const s = state();
  const now = (deps.now ?? Date.now)();

  const sweep: AwarenessSweep = sweepAwareness(
    quotes, s.awarenessPrior, now, optionsAwarenessConfig(env),
  );

  const basePcfg = promotionCapacityConfig(env);
  // Size the budget on what a promotion is MEASURED to cost, not on the estimate.
  const pcfg = {
    ...basePcfg,
    estRequestsPerPromotion: measuredRequestsPerPromotion(s, basePcfg.estRequestsPerPromotion),
  };
  const headroom = tier2Headroom(s, cfg, now, deps.providerStats);
  const capacity = computePromotionCapacity(headroom, pcfg);
  const sel = selectPromotions(sweep, s.tier2Cursor ?? 0, capacity.capacity, pcfg);

  s.tier2Cursor = sel.nextCursor;
  s.awarenessPrior = nextObservationCache(sweep);

  // Cheap-observation recency is rebuilt from THIS sweep, so the map tracks the
  // live universe exactly and drops names that left it.
  const observedAt = new Map<string, number>();
  for (const r of sweep.rows) observedAt.set(r.symbol, now);
  s.cheapObservedAt = observedAt;

  // Deep-analysis recency is retained across cycles but pruned to the current
  // universe, so it cannot accumulate delisted symbols over a long session.
  for (const sym of s.deepAnalyzedAt.keys()) if (!observedAt.has(sym)) s.deepAnalyzedAt.delete(sym);
  for (const d of sel.promoted) s.deepAnalyzedAt.set(d.symbol, now);

  // The Phase-A and Phase-E maps are pruned on exactly the same rule and for
  // exactly the same reason: a symbol that has left the eligible universe can no
  // longer be promoted, so nothing will ever read its record again, and a map
  // that only ever grows is a leak with a long fuse. Tier-0 and Tier-1 names are
  // NOT in the Tier-2 sweep, so they are exempted rather than evicted — pruning
  // them would throw away the registry for the symbols scanned most often.
  const coreExempt = new Set([
    ...optionsTier0(env).map((x) => x.toUpperCase()),
    ...optionsTier1(env).map((x) => x.toUpperCase()),
  ]);
  const keep = (sym: string) => observedAt.has(sym) || coreExempt.has(sym.toUpperCase());
  for (const sym of [...s.optionability.keys()]) if (!keep(sym)) s.optionability.delete(sym);
  for (const sym of [...s.missedLastState.keys()]) if (!keep(sym)) s.missedLastState.delete(sym);

  s.lastAwareness = {
    atMs: now,
    eligibleOptionsUniverse: sweep.universeSize,
    cheapObservedThisCycle: sweep.universeSize,
    cheapObservationCoveragePct: sweep.universeSize > 0 ? 100 : 0,
    withVelocity: sweep.withVelocity,
    countsByBand: { ...sweep.countsByBand },
    deepAnalysisPromoted: sel.promoted.length,
    deepAnalysisDeferred: sel.notPromoted,
    promotionCapacity: capacity.capacity,
    capacityBoundBy: capacity.boundBy,
    providerHeadroomRatio: capacity.headroomRatio,
    capacityExplain: capacity.explain,
    promotedByScore: sel.byScore,
    promotedByExploration: sel.byExploration,
    explorationSweepCycles: explorationSweepCycles(sweep.universeSize, capacity.capacity, pcfg),
    topRanked: sweep.rows.slice(0, 10).map((r) => ({
      symbol: r.symbol, preScore: r.preScore, band: r.band, reason: r.reason,
    })),
  };

  // Kept in sync so existing observability surfaces keep reporting, with the
  // meanings the new architecture gives them.
  s.lastTier2Selection = {
    atMs: now,
    universeSize: sweep.universeSize,
    priority: sel.byScore,
    rotated: sel.byExploration.length,
    deferred: sel.notPromoted,
    cyclesForFullCoverage: 1, // cheap coverage is complete every cycle now
  };

  if (capacity.capacity === 0 && sweep.rows.some((r) => r.band === "HIGH_PRIORITY" || r.band === "NEWLY_ACCELERATING")) {
    s.quotaBlockedHighPriority += 1;
  }

  captureMissedOpportunities(s, sweep, sel, capacity.capacity, now, deps, env);

  return sel.promoted.map((d) => d.symbol);
}

/**
 * PHASE E — WHAT WAS COIN DOING AT 10:02, AND WHY DID WE NOT LOOK AT IT?
 *
 * The join between the two halves of that question. The SWEEP knows every
 * symbol's pre-score, rank and band; the SCAN knows which symbols were skipped
 * and for what reason. Neither alone can answer it, and until now neither was
 * written down.
 *
 * THREE THINGS BOUND THIS, and all three are needed:
 *
 *  1. TRANSITIONS, not states. `noteSkip` already refused to re-record a symbol
 *     sitting in the same reason, so a name that is simply never the best idea
 *     in a 1,600-symbol universe contributes ONE row per 15 minutes, not one per
 *     minute. Without this the table grows by ~1,600 rows a minute forever.
 *  2. A PER-CYCLE CAP, enforced by `collectMissedOpportunities`, which sorts
 *     capacity failures above judgements first — so when the cap truncates, what
 *     survives is what is hardest to explain rather than whatever sorted first.
 *  3. RETENTION, swept on a slow timer rather than every cycle, because a DELETE
 *     on every 60s beat is a cost with no reader.
 *
 * NOTHING HERE INVENTS AN OPTION. The record carries underlying and decision
 * state only; the schema has no column for an OCC, a premium or a return, so a
 * later writer cannot quietly start filling one in for a contract that was never
 * selected.
 */
function captureMissedOpportunities(
  s: MonitorState,
  sweep: AwarenessSweep,
  sel: { promoted: { symbol: string }[] },
  promotionCapacity: number,
  now: number,
  deps: OptionsMonitorDeps,
  env: NodeJS.ProcessEnv,
): void {
  try {
    if (env.OPTIONS_MISSED_CAPTURE === "0") return;
    const cfg: MissedOpportunityConfig = missedOpportunityConfig(env);
    const promoted = new Set(sel.promoted.map((d) => d.symbol));

    // A symbol that was cheaply seen, ranked, and did not make the cut is a
    // NOT_PROMOTED skip. Routed through `noteSkip` rather than recorded directly
    // so it obeys exactly the same transition rule as every other reason — one
    // dedup policy, not two that can drift apart.
    for (const row of sweep.rows) {
      if (!promoted.has(row.symbol)) noteSkip(s, row.symbol, "NOT_PROMOTED", now, env);
    }

    const rowBySymbol = new Map<string, AwarenessRow>();
    for (const r of sweep.rows) rowBySymbol.set(r.symbol, r);

    const candidates: { row: AwarenessRow; reason: SkipReason }[] = [];
    for (const [symbol, reason] of s.missedPending) {
      const row = rowBySymbol.get(symbol);
      // No awareness row means no pre-score, no rank and no band. A record
      // without them cannot be read in context later, so it is dropped rather
      // than written with invented zeroes.
      if (row) candidates.push({ row, reason });
    }
    s.missedPending.clear();
    if (candidates.length === 0) return;

    const collected = collectMissedOpportunities(candidates, {
      sessionDate: tradingDay(now),
      universeSize: sweep.universeSize,
      promotionCapacity,
    }, cfg);
    s.missedTruncated += collected.truncated;

    const getDb = deps.getDb;
    if (!getDb || collected.records.length === 0) return;
    const db = getDb();
    const res = persistMissedOpportunitiesOnDb(db, collected.records);
    s.missedWritten += res.inserted;

    // Retention on a slow timer. Bounds total storage independently of the write
    // rate, which is the only bound that survives a misconfigured cap.
    if (now - s.lastMissedPruneMs >= MISSED_PRUNE_INTERVAL_MS) {
      s.lastMissedPruneMs = now;
      pruneMissedOpportunitiesOnDb(db, now, cfg);
    }
  } catch { /* a lost diagnostic row must never take down the scan that produced it */ }
}

/** Retention sweep cadence. Hourly — a DELETE on every 60s beat has no reader. */
export const MISSED_PRUNE_INTERVAL_MS = 60 * 60_000;

/**
 * PHASE A — the tri-state registry as a reportable quantity.
 *
 * UNKNOWN is reported as a count of symbols that are NOT in the registry, which
 * is the honest shape: absence IS unknown, and the number that matters is how
 * many of them remain eligible (all of them, always).
 */
export function optionabilityMetrics(): {
  tracked: number;
  optionable: number;
  notOptionable: number;
  corroborating: number;
  chainSkippedForProvenNotOptionable: number;
  unknownRemainsEligible: true;
  bySource: Record<string, number>;
} {
  const s = state();
  let optionable = 0, notOptionable = 0, corroborating = 0;
  const bySource: Record<string, number> = {};
  for (const rec of s.optionability.values()) {
    if (rec.state === "OPTIONABLE") optionable += 1;
    else if (rec.state === "NOT_OPTIONABLE") notOptionable += 1;
    if (rec.state !== "NOT_OPTIONABLE" && rec.corroboratingEmptyDays.length > 0) corroborating += 1;
    bySource[rec.source] = (bySource[rec.source] ?? 0) + 1;
  }
  return {
    tracked: s.optionability.size,
    optionable,
    notOptionable,
    corroborating,
    chainSkippedForProvenNotOptionable: s.chainSkippedForProvenNotOptionable,
    // Not a measurement — an INVARIANT, asserted in the payload so a regression
    // that started skipping UNKNOWN symbols would have to change this line.
    unknownRemainsEligible: true,
    bySource,
  };
}

/** PHASE B — zero-contract outcomes, by cause and by whose fault it was. */
export function zeroContractMetrics(): {
  byCause: Record<ZeroContractCause, number>;
  byOrigin: { PROVIDER: number; REQUEST: number; SELECTOR: number; SYMBOL: number };
  total: number;
  semantics: string;
} {
  const s = state();
  const byCause = { ...s.zeroContractCauses };
  const total = Object.values(byCause).reduce((a, b) => a + b, 0);
  return {
    byCause,
    byOrigin: { ...s.zeroContractOrigins },
    total,
    semantics: "PROVIDER = the market was never successfully asked; REQUEST = we asked a window too "
      + "narrow for an empty answer to mean anything; SELECTOR = it answered and our bands rejected "
      + "every contract; SYMBOL = the answer was about the instrument. A PROVIDER cause can never be "
      + "reported as a SELECTOR one.",
  };
}

/** PHASE C — the admission queue, including whether it is active at all. */
export function chainAdmissionMetrics(): {
  active: boolean;
  rolloutControl: string;
  queueDepth: number;
  queueMax: number;
  carryDropped: number;
  last: MonitorState["lastAdmission"];
} {
  const s = state();
  return {
    active: s.chainAdmissionActive,
    rolloutControl: "OPTIONS_CHAIN_ADMISSION_ENABLED=1",
    queueDepth: s.chainQueue.size,
    queueMax: CHAIN_QUEUE_MAX,
    carryDropped: s.chainCarryDropped,
    last: s.lastAdmission,
  };
}

/** PHASE E — how much was written down, and how much was dropped by the cap. */
export function missedOpportunityMetrics(): {
  written: number;
  truncatedByCap: number;
  trackedSymbols: number;
  pendingJoin: number;
  resampleMs: number;
  fabricationGuard: string;
} {
  const s = state();
  return {
    written: s.missedWritten,
    truncatedByCap: s.missedTruncated,
    trackedSymbols: s.missedLastState.size,
    pendingJoin: s.missedPending.size,
    resampleMs: MISSED_RESAMPLE_MS,
    fabricationGuard: "underlying and decision state only — the schema has no OCC, premium or return column",
  };
}

/**
 * Phase-10 coverage metrics. Reports CHEAP AWARENESS and DEEP ANALYSIS as
 * separate quantities, because conflating them is what made "25 names scanned"
 * look like a coverage statement when it was a spend statement.
 */
export function optionsCoverageMetrics(nowMs: number = Date.now()): {
  eligibleOptionsUniverse: number;
  cheapObservedThisCycle: number;
  cheapObservationCoveragePct: number;
  deepAnalysisPromoted: number;
  deepAnalysisDeferred: number;
  medianTimeSinceCheapObservationMs: number | null;
  p95TimeSinceCheapObservationMs: number | null;
  medianTimeSinceDeepAnalysisMs: number | null;
  p95TimeSinceDeepAnalysisMs: number | null;
  providerHeadroom: number;
  promotionCapacity: number;
  capacityBoundBy: string | null;
  quotaBlockedHighPriority: number;
  explorationSweepCycles: number;
  countsByBand: Record<string, number>;
  topRanked: { symbol: string; preScore: number; band: string; reason: string }[];
  capacityExplain: string | null;
} {
  const s = state();
  const a = s.lastAwareness;
  const cheapAges = [...s.cheapObservedAt.values()].map((t) => nowMs - t);
  // Only symbols in the CURRENT universe count, so a name that has never been
  // deeply analysed is absent rather than recorded as age zero.
  const deepAges = [...s.deepAnalyzedAt.values()].map((t) => nowMs - t);
  return {
    eligibleOptionsUniverse: a?.eligibleOptionsUniverse ?? 0,
    cheapObservedThisCycle: a?.cheapObservedThisCycle ?? 0,
    cheapObservationCoveragePct: a?.cheapObservationCoveragePct ?? 0,
    deepAnalysisPromoted: a?.deepAnalysisPromoted ?? 0,
    deepAnalysisDeferred: a?.deepAnalysisDeferred ?? 0,
    medianTimeSinceCheapObservationMs: percentileOf(cheapAges, 50),
    p95TimeSinceCheapObservationMs: percentileOf(cheapAges, 95),
    medianTimeSinceDeepAnalysisMs: percentileOf(deepAges, 50),
    p95TimeSinceDeepAnalysisMs: percentileOf(deepAges, 95),
    providerHeadroom: a?.providerHeadroomRatio ?? 0,
    promotionCapacity: a?.promotionCapacity ?? 0,
    capacityBoundBy: a?.capacityBoundBy ?? null,
    quotaBlockedHighPriority: s.quotaBlockedHighPriority,
    explorationSweepCycles: a?.explorationSweepCycles ?? 0,
    countsByBand: a?.countsByBand ?? {},
    topRanked: a?.topRanked ?? [],
    capacityExplain: a?.capacityExplain ?? null,
  };
}

/**
 * The symbols one Tier-2 cycle analyses DEEPLY.
 *
 * THREE PATHS, most capable first:
 *
 *  1. `tier2AwarenessQuotes` — the whole eligible universe is cheaply scored
 *     every cycle off the snapshot that was already paid for, and only the
 *     affordable few are promoted. `maxSymbolsPerTier2Cycle` stops being a
 *     visibility cap here; it survives only as one input to the capacity
 *     ceiling. This is the production path.
 *  2. `tier2Candidates` — ranked by day move, still a hard 25-symbol horizon.
 *  3. `tier2Universe` — provider order, the original behaviour.
 *
 * Paths 2 and 3 are kept because every existing test injects them, and because
 * a deployment that has not wired the snapshot source must degrade to the
 * previous behaviour rather than to no coverage at all.
 */
async function selectTier2Symbols(
  deps: OptionsMonitorDeps,
  tier0Set: Set<string>,
  env: NodeJS.ProcessEnv,
  cfg: OptionsMonitorConfig,
): Promise<string[]> {
  const slots = cfg.maxSymbolsPerTier2Cycle;
  const notTier0 = (sym: string) => !tier0Set.has(sym.toUpperCase());

  if (deps.tier2AwarenessQuotes && env.OPTIONS_AWARENESS !== "0") {
    const quotes = ((await deps.tier2AwarenessQuotes()) ?? []).filter((q) => q?.symbol && notTier0(q.symbol));
    return runAwarenessCycle(quotes, deps, env, cfg);
  }

  if (deps.tier2Candidates && env.OPTIONS_TIER2_PRIORITY !== "0") {
    const candidates = ((await deps.tier2Candidates()) ?? []).filter((c) => c?.symbol && notTier0(c.symbol));
    const s = state();
    const sel = selectTier2Cycle(candidates, s.tier2Cursor ?? 0, slots, tier2PriorityConfig(env));
    s.tier2Cursor = sel.nextCursor;
    s.lastTier2Selection = {
      atMs: Date.now(),
      universeSize: candidates.length,
      priority: sel.priority,
      rotated: sel.rotated.length,
      deferred: sel.deferred,
      cyclesForFullCoverage: sel.cyclesForFullCoverage,
    };
    return sel.selected;
  }

  const uni = (await (deps.tier2Universe?.() ?? [])) as string[];
  return uni.filter(notTier0).slice(0, slots);
}

export function stopOptionsMonitor(): void { const s = state(); for (const t of s.timers) clearInterval(t); s.timers = []; s.running = false; }
/** Inspect the live per-symbol cooldown (for the diagnostic — does not mutate state). */
export function optionsCooldownRemainingMs(symbol: string, nowMs: number = Date.now()): number { return Math.max(0, (state().cooldownSymbol.get(symbol.toUpperCase()) ?? 0) - nowMs); }
/**
 * Test-only seam onto the cycle's symbol selection.
 *
 * Exposed because the property that matters — a 1,606-symbol universe yields
 * full cheap coverage and a bounded handful of expensive promotions — is a
 * property of the WIRING, and testing the pure modules alone would leave the
 * step that actually retired the 25-symbol cap uncovered.
 */
export async function __selectTier2SymbolsForTest(
  deps: OptionsMonitorDeps,
  tier0: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  cfg: OptionsMonitorConfig = defaultMonitorConfig(env),
): Promise<string[]> {
  return selectTier2Symbols(deps, new Set(tier0.map((s) => s.toUpperCase())), env, cfg);
}

/** Test-only: reset the singleton state (cooldowns/metrics/breaker) for order-independent tests. */
export function __resetOptionsMonitorForTest(): void { stopOptionsMonitor(); delete (globalThis as G).__optiscanOptionsMonitor; }
