/**
 * supervisor-cycle.ts — the automatic Opportunity-Orchestrator pass (live runtime
 * wiring). Next-server module.
 *
 * This is how the background runtime "invokes the Supervisor": on each cycle it
 * takes a bounded, session-appropriate universe, runs the relevant horizon agents
 * per ticker (ONE metered 0–90 DTE chain fetch per ticker via `polyFetch`, shared
 * across horizons), supervises to one canonical result per ticker/direction/
 * horizon, persists lifecycle/dedup state, and delivers only meaningful
 * transitions through the existing tracked Discord ledger.
 *
 * It never fetches a provider directly (the agent runtime owns the metered fetch),
 * never creates paper entries, never makes a bearish idea actionable, and never
 * lets a probability or agent agreement override a hard gate — those invariants
 * live in the agent/supervisor/callout layers it reuses.
 */
import { runAgentsForTicker } from "@/lib/agents/runtime";
import type { PriorState } from "@/lib/agents/supervisor";
import { buildCallout } from "@/lib/callouts/callout";
import { getZeroDteUniverse } from "@/lib/universe.js";

type G = typeof globalThis & {
  __optiscanSupervisorPrior?: Map<string, Map<string, PriorState>>;
  __optiscanSupervisorTelemetry?: SupervisorTelemetry;
};

export interface SupervisorTelemetry {
  lastCycleAtMs: number | null;
  lastCycleTickers: number;
  lastCycleAgentsRun: number;
  lastCycleCanonical: number;
  lastCycleEmitted: number;
  cycles: number;
  lastError: string | null;
}

function telemetry(): SupervisorTelemetry {
  const g = globalThis as G;
  g.__optiscanSupervisorTelemetry ??= {
    lastCycleAtMs: null, lastCycleTickers: 0, lastCycleAgentsRun: 0,
    lastCycleCanonical: 0, lastCycleEmitted: 0, cycles: 0, lastError: null,
  };
  return g.__optiscanSupervisorTelemetry;
}

/** Per-ticker prior supervisor state so lifecycle hysteresis survives cycles. */
function priorFor(ticker: string): Map<string, PriorState> | undefined {
  const g = globalThis as G;
  g.__optiscanSupervisorPrior ??= new Map();
  return g.__optiscanSupervisorPrior.get(ticker.toUpperCase());
}
function setPriorFor(ticker: string, next: Map<string, PriorState>): void {
  const g = globalThis as G;
  g.__optiscanSupervisorPrior ??= new Map();
  g.__optiscanSupervisorPrior.set(ticker.toUpperCase(), next);
}

/** Read-only telemetry for the health surface. */
export function supervisorTelemetry(): SupervisorTelemetry {
  return { ...telemetry() };
}

/** Whether the automatic supervisor cycle is enabled (default OFF, safe). */
export function supervisorRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUPERVISOR_RUNTIME === "1";
}

function cycleUniverse(env: NodeJS.ProcessEnv = process.env): string[] {
  const cap = Math.max(1, Math.min(50, Number(env.SUPERVISOR_MAX_TICKERS ?? 8) || 8));
  const core = getZeroDteUniverse(env) as string[];
  return core.slice(0, cap);
}

export interface CanonicalCalloutRow {
  ticker: string;
  direction: string;
  horizon: string;
  status: string;
  callout: ReturnType<typeof buildCallout>;
}

export interface SupervisorCycleResult {
  ranAtMs: number;
  tickers: number;
  agentsRun: number;
  canonical: CanonicalCalloutRow[];
}

/**
 * Run one supervisor cycle over the bounded universe and return the canonical
 * callouts (delivery + persistence are applied by the caller / delivery layer).
 * Deterministic given inputs; a single ticker failure never aborts the cycle.
 */
export async function runSupervisorCycle(nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<SupervisorCycleResult> {
  const t = telemetry();
  const tickers = cycleUniverse(env);
  const canonical: CanonicalCalloutRow[] = [];
  let agentsRun = 0;

  for (const ticker of tickers) {
    try {
      const run = await runAgentsForTicker(ticker, nowMs, { previous: priorFor(ticker) });
      agentsRun += run.agentsRun.length;
      setPriorFor(ticker, run.nextPrior);
      for (const r of run.supervised.canonical) {
        canonical.push({
          ticker: r.ticker, direction: r.direction, horizon: r.horizon,
          status: r.candidateStatus, callout: buildCallout(r),
        });
      }
    } catch (err: any) {
      t.lastError = `${ticker}: ${err?.message ?? String(err)}`;
    }
  }

  t.lastCycleAtMs = nowMs;
  t.lastCycleTickers = tickers.length;
  t.lastCycleAgentsRun = agentsRun;
  t.lastCycleCanonical = canonical.length;
  t.cycles += 1;

  return { ranAtMs: nowMs, tickers: tickers.length, agentsRun, canonical };
}
