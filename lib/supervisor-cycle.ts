/**
 * supervisor-cycle.ts — the automatic Opportunity-Orchestrator pass (live runtime
 * wiring). Next-server module.
 *
 * This is how the background scheduler "invokes the Supervisor": on each cycle it
 * takes a bounded, session-appropriate universe and delegates to the single
 * canonical callout path (`buildCalloutsForTickers`), which runs the relevant
 * horizon agents per ticker (ONE metered 0–90 DTE chain fetch per ticker via
 * `polyFetch`, shared across horizons), supervises to one canonical result per
 * ticker/direction/horizon, persists lifecycle/dedup state, and delivers only
 * meaningful transitions through the existing tracked Discord ledger.
 *
 * It never fetches a provider directly, never creates paper entries, never makes a
 * bearish idea actionable, and never lets a probability or agent agreement override
 * a hard gate — those invariants live in the agent/supervisor/callout layers.
 */
import { buildCalloutsForTickers, type CalloutFunnel } from "@/lib/callouts/runtime";
import { getZeroDteUniverse } from "@/lib/universe.js";
import { loopState } from "@/lib/scanner-loop";
import { buildCycleUniverse, DEFAULT_SUPERVISOR_CORE_TICKERS } from "@/lib/supervisor-universe";
import { recordOptionsDiagnostic } from "@/lib/options-diagnostics";
import { marketSession } from "@/lib/trading-session";

const SUPERVISOR_STRATEGY_VERSION = "supervisor-options-v1";

type G = typeof globalThis & {
  __optiscanSupervisorTelemetry?: SupervisorTelemetry;
  __optiscanSupervisorRunning?: boolean;
};

export interface SupervisorTelemetry {
  lastCycleAtMs: number | null;
  lastCycleTickers: number;
  lastCycleCanonical: number;
  lastCycleEmitted: number;
  lastCycleDelivered: number;
  lastCycleDurationMs: number;
  lastCycleSymbols: string[];
  lastChainConcurrency: number;
  lastOptionsChainsSucceeded: number;
  lastOptionsChainsFailed: number;
  lastTickerLatencies: Array<{ ticker: string; ok: boolean; durationMs: number; canonical: number; error?: string }>;
  overlapPrevented: number;
  cycles: number;
  lastError: string | null;
  /** Last cycle's options funnel (live surface; the persistent record is in options_diagnostics). */
  lastFunnel: CalloutFunnel | null;
}

function telemetry(): SupervisorTelemetry {
  const g = globalThis as G;
  g.__optiscanSupervisorTelemetry ??= {
    lastCycleAtMs: null, lastCycleTickers: 0, lastCycleCanonical: 0,
    lastCycleEmitted: 0, lastCycleDelivered: 0, lastCycleDurationMs: 0,
    lastCycleSymbols: [], lastChainConcurrency: 0, lastOptionsChainsSucceeded: 0,
    lastOptionsChainsFailed: 0, lastTickerLatencies: [], overlapPrevented: 0,
    cycles: 0, lastError: null, lastFunnel: null,
  };
  return g.__optiscanSupervisorTelemetry;
}

/** Read-only telemetry for the health surface. */
export function supervisorTelemetry(): SupervisorTelemetry {
  return { ...telemetry() };
}

/** Whether the automatic supervisor cycle is enabled (default OFF, safe). */
export function supervisorRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUPERVISOR_RUNTIME === "1";
}

/**
 * Dynamic candidates for the cycle, ranked strongest-first: live scanner movers
 * (already sorted by short-rate magnitude), then any promoted discovery names,
 * then the static 0DTE watchlist as a never-empty fallback. Reading the scanner
 * is best-effort — if it has not booted yet the watchlist alone still yields a
 * valid cycle. `buildCycleUniverse` deduplicates the combined list.
 */
function dynamicCandidates(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  try {
    const st = loopState() as { movers?: Array<{ symbol?: string }>; promotedSymbols?: string[] };
    for (const m of st.movers ?? []) if (m?.symbol) out.push(String(m.symbol));
    for (const p of st.promotedSymbols ?? []) if (p) out.push(String(p));
  } catch {
    // Scanner not booted (e.g. cold start / closed session) — fall back to the
    // static watchlist below. Never throw into the cycle.
  }
  for (const s of getZeroDteUniverse(env) as string[]) out.push(s);
  return out;
}

/**
 * The bounded, session-appropriate ticker universe for one supervisor cycle.
 * Pinned core tickers (SUPERVISOR_CORE_TICKERS or OWNER_CORE_TICKERS, default
 * NVDA,META,SPY,QQQ,AAPL,AMZN,MSFT,TSLA,AMD,GOOGL) are always included first
 * when capacity allows; the strongest dynamic movers fill the
 * remaining slots up to SUPERVISOR_MAX_TICKERS. See `buildCycleUniverse`.
 */
export function cycleUniverse(env: NodeJS.ProcessEnv = process.env): string[] {
  const cap = Math.max(1, Math.min(50, Number(env.SUPERVISOR_MAX_TICKERS ?? 12) || 12));
  const coreCsv = env.OWNER_CORE_TICKERS ?? env.SUPERVISOR_CORE_TICKERS ?? DEFAULT_SUPERVISOR_CORE_TICKERS;
  return buildCycleUniverse(coreCsv, dynamicCandidates(env), cap, { rotationOffset: telemetry().cycles });
}

export interface SupervisorCycleResult {
  ranAtMs: number;
  tickers: number;
  canonical: number;
  emitted: number;
  delivered: number;
}

/**
 * Run one supervisor cycle over the bounded universe: build + persist + deliver
 * canonical callouts via the single canonical path. Deterministic given inputs;
 * a failure is recorded in telemetry and never throws into the scheduler.
 */
export async function runSupervisorCycle(nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<SupervisorCycleResult> {
  const g = globalThis as G;
  const t = telemetry();
  if (g.__optiscanSupervisorRunning) {
    t.overlapPrevented += 1;
    t.lastError = "overlap prevented: previous supervisor cycle still running";
    return { ranAtMs: nowMs, tickers: 0, canonical: 0, emitted: 0, delivered: 0 };
  }
  g.__optiscanSupervisorRunning = true;
  const tickers = cycleUniverse(env);
  let canonical = 0, emitted = 0, delivered = 0;
  const started = Date.now();
  try {
    const res = await buildCalloutsForTickers(tickers, nowMs, { deliver: true });
    canonical = res.bundles.length;
    emitted = res.bundles.filter((b) => b.decision.emit).length;
    delivered = res.delivered;
    t.lastChainConcurrency = res.execution.concurrency;
    t.lastOptionsChainsSucceeded = res.execution.succeeded;
    t.lastOptionsChainsFailed = res.execution.failed;
    t.lastTickerLatencies = res.execution.tickerResults;
    t.lastFunnel = res.funnel;
    t.lastError = null;
    // Persist the options funnel (bounded, non-throwing) so a "no options alerts"
    // day is diagnosable after a restart and the nightly AI can narrate it.
    const f = res.funnel;
    recordOptionsDiagnostic({
      cycleAtMs: nowMs,
      session: marketSession(nowMs),
      tickersConsidered: f.tickersConsidered,
      chainsOk: f.chainsOk,
      chainsFailed: f.chainsFailed,
      tickersWithCanonical: f.tickersWithCanonical,
      canonical: f.canonical,
      portfolioSuppressed: f.portfolioSuppressed,
      dedupSuppressed: f.dedupSuppressed,
      emitted: f.emitted,
      delivered: f.delivered,
      notActionableNow: f.notActionableNow,
      contractIncomplete: f.contractIncomplete,
      contractMismatch: f.contractMismatch,
      discordAutoSend: f.discordAutoSend,
      deliveryGateReason: f.deliveryGateReason,
      topReason: f.topReason,
      durationMs: res.execution.durationMs,
      strategyVersion: SUPERVISOR_STRATEGY_VERSION,
    });
  } catch (err: any) {
    t.lastError = err?.message ?? String(err);
  } finally {
    g.__optiscanSupervisorRunning = false;
  }

  t.lastCycleAtMs = nowMs;
  t.lastCycleTickers = tickers.length;
  t.lastCycleSymbols = tickers;
  t.lastCycleCanonical = canonical;
  t.lastCycleEmitted = emitted;
  t.lastCycleDelivered = delivered;
  t.lastCycleDurationMs = Date.now() - started;
  t.cycles += 1;

  return { ranAtMs: nowMs, tickers: tickers.length, canonical, emitted, delivered };
}
