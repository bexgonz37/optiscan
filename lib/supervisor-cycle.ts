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
import { buildCalloutsForTickers } from "@/lib/callouts/runtime";
import { getZeroDteUniverse } from "@/lib/universe.js";

type G = typeof globalThis & { __optiscanSupervisorTelemetry?: SupervisorTelemetry };

export interface SupervisorTelemetry {
  lastCycleAtMs: number | null;
  lastCycleTickers: number;
  lastCycleCanonical: number;
  lastCycleEmitted: number;
  lastCycleDelivered: number;
  cycles: number;
  lastError: string | null;
}

function telemetry(): SupervisorTelemetry {
  const g = globalThis as G;
  g.__optiscanSupervisorTelemetry ??= {
    lastCycleAtMs: null, lastCycleTickers: 0, lastCycleCanonical: 0,
    lastCycleEmitted: 0, lastCycleDelivered: 0, cycles: 0, lastError: null,
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

export function cycleUniverse(env: NodeJS.ProcessEnv = process.env): string[] {
  const cap = Math.max(1, Math.min(50, Number(env.SUPERVISOR_MAX_TICKERS ?? 8) || 8));
  const core = getZeroDteUniverse(env) as string[];
  return core.slice(0, cap);
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
  const t = telemetry();
  const tickers = cycleUniverse(env);
  let canonical = 0, emitted = 0, delivered = 0;
  try {
    const res = await buildCalloutsForTickers(tickers, nowMs, { deliver: true });
    canonical = res.bundles.length;
    emitted = res.bundles.filter((b) => b.decision.emit).length;
    delivered = res.delivered;
  } catch (err: any) {
    t.lastError = err?.message ?? String(err);
  }

  t.lastCycleAtMs = nowMs;
  t.lastCycleTickers = tickers.length;
  t.lastCycleCanonical = canonical;
  t.lastCycleEmitted = emitted;
  t.lastCycleDelivered = delivered;
  t.cycles += 1;

  return { ranAtMs: nowMs, tickers: tickers.length, canonical, emitted, delivered };
}
