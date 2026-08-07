/**
 * Scanner-loop watchdog.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * The loop's beat looked like this:
 *
 *   const beat = async () => {
 *     if (!busy) { busy = true; try { await tick(); } catch {} busy = false; }
 *     setTimeout(beat, intervalMs);          // <- outside the guard
 *   };
 *
 * The reschedule is outside the guard, so the timer keeps firing forever. But
 * `busy` only clears when `await tick()` SETTLES. A rejection is fine — the catch
 * runs. A promise that never settles is not: `busy` stays true for the life of the
 * process, every later beat short-circuits, and the loop is dead while the timer,
 * the process, and `loopRunning: true` all keep insisting it is alive. Production
 * spent ~5.5 hours in exactly that state with `lastTickAgeMs` climbing monotonically
 * and the session frozen at `regular` long after the close.
 *
 * WHY THE OBVIOUS FIX IS WRONG
 *
 * Clearing `busy` on a timer would start a second tick while the first is still
 * suspended mid-flight. When the hung tick finally resumes it continues mutating the
 * same `s.symbols` state and can still reach `captureZeroDte` — a duplicate alert
 * send and duplicate provider spend, which is worse than a stalled scanner.
 *
 * WHAT THIS DOES INSTEAD
 *
 * Every tick runs under a monotonically increasing GENERATION carried in
 * AsyncLocalStorage — the same mechanism `provider-context` already uses, and the
 * only one that survives an arbitrary chain of awaits. When a tick exceeds its
 * budget the watchdog abandons that generation and lets the loop start a fresh one.
 * The abandoned tick is not killed (JavaScript cannot kill a suspended promise) but
 * it is FENCED: `currentGenerationIsActive()` returns false inside it forever, so
 * every side effect that checks the fence before acting becomes a no-op if it ever
 * resumes. Recovery is therefore never at the cost of a duplicate send.
 *
 * Abandoned ticks are also capped. If enough of them accumulate without settling,
 * the loop stops launching new work and reports WEDGED rather than piling up
 * suspended ticks and provider spend behind a health endpoint that says "running".
 * A wedge that is visible is a wedge someone can act on.
 *
 * This module makes no provider call and holds no send authority.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type LoopHealthState = "HEALTHY" | "DEGRADED" | "WEDGED" | "RECOVERING";

/** A tick's identity for the whole of its async life. */
interface TickScope {
  generation: number;
}

const tickStorage = new AsyncLocalStorage<TickScope>();

export interface WatchdogConfig {
  /** A tick past this is abandoned so the loop can continue. */
  tickTimeoutMs: number;
  /** Abandoned-but-unsettled ticks tolerated before the loop stops launching work. */
  maxOutstandingAbandoned: number;
  /** No completed tick for this long means DEGRADED even if nothing timed out. */
  stallWarnMs: number;
}

export function watchdogConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
  const n = (key: string, fallback: number, min: number) => {
    const raw = Number(env[key]);
    return Number.isFinite(raw) && raw >= min ? raw : fallback;
  };
  return {
    // The loop interval is ~1s. A healthy tick is far under this; 90s is "this is
    // never coming back", not "this is slow".
    tickTimeoutMs: n("SCANNER_TICK_TIMEOUT_MS", 90_000, 5_000),
    maxOutstandingAbandoned: n("SCANNER_MAX_ABANDONED_TICKS", 3, 1),
    stallWarnMs: n("SCANNER_STALL_WARN_MS", 120_000, 10_000),
  };
}

export interface WatchdogState {
  /** Generation of the tick currently permitted to act. */
  activeGeneration: number | null;
  nextGeneration: number;
  tickStartedAtMs: number | null;
  lastTickStartedAtMs: number | null;
  lastCompletedAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastTimeoutAtMs: number | null;
  lastDurationMs: number | null;
  ticksStarted: number;
  ticksCompleted: number;
  timeouts: number;
  recoveries: number;
  consecutiveFailures: number;
  /** Abandoned generations that have not settled. */
  outstandingAbandoned: Set<number>;
  /** Abandoned generations that later settled — proof the hang was transient. */
  lateSettled: number;
  /** Side effects refused because their tick had already been abandoned. */
  fencedSideEffects: number;
  lastError: string | null;
  lastTimeoutNote: string | null;
  /** Whether the loop is currently refusing to launch work. */
  launchBlocked: boolean;
}

type G = typeof globalThis & { __optiscanScannerWatchdog?: WatchdogState };

export function watchdogState(): WatchdogState {
  const g = globalThis as G;
  if (!g.__optiscanScannerWatchdog) {
    g.__optiscanScannerWatchdog = {
      activeGeneration: null,
      nextGeneration: 1,
      tickStartedAtMs: null,
      lastTickStartedAtMs: null,
      lastCompletedAtMs: null,
      lastSuccessAtMs: null,
      lastTimeoutAtMs: null,
      lastDurationMs: null,
      ticksStarted: 0,
      ticksCompleted: 0,
      timeouts: 0,
      recoveries: 0,
      consecutiveFailures: 0,
      outstandingAbandoned: new Set<number>(),
      lateSettled: 0,
      fencedSideEffects: 0,
      lastError: null,
      lastTimeoutNote: null,
      launchBlocked: false,
    };
  }
  return g.__optiscanScannerWatchdog;
}

/** Reset — tests only. Production state lives for the life of the process. */
export function resetWatchdogForTests(): void {
  (globalThis as G).__optiscanScannerWatchdog = undefined;
}

/**
 * True when the caller is running inside the tick the loop currently recognises.
 *
 * Call this immediately before any side effect that must not happen twice — sending
 * an alert, spending provider budget. Outside a tick scope it returns true, so
 * callers shared with non-loop code paths are unaffected.
 */
export function currentGenerationIsActive(): boolean {
  const scope = tickStorage.getStore();
  if (!scope) return true;
  return watchdogState().activeGeneration === scope.generation;
}

/**
 * Guard a side effect on the fence. Returns false and counts the refusal when the
 * calling tick has been abandoned, so the skip is visible rather than silent.
 */
export function sideEffectAllowed(): boolean {
  if (currentGenerationIsActive()) return true;
  watchdogState().fencedSideEffects += 1;
  return false;
}

export interface TickOutcome {
  started: boolean;
  generation: number | null;
  /** Why no tick was started. */
  skipped: "busy" | "wedged" | null;
}

/**
 * Run one tick under the watchdog.
 *
 * Resolves when the tick finishes OR when it exceeds its budget and is abandoned —
 * whichever comes first — so the caller can always reschedule. An abandoned tick
 * keeps running unattached and fenced; if it later settles that is recorded as a
 * late settle and the outstanding slot is released.
 */
export async function runWatchedTick(
  tick: () => Promise<void>,
  cfg: WatchdogConfig = watchdogConfigFromEnv(),
  nowFn: () => number = Date.now,
): Promise<TickOutcome> {
  const s = watchdogState();

  // A tick is already in flight. Either it still has budget, or it is abandoned here
  // so this beat can take over.
  if (s.activeGeneration != null) {
    const startedAt = s.tickStartedAtMs ?? nowFn();
    const elapsed = nowFn() - startedAt;
    if (elapsed < cfg.tickTimeoutMs) {
      return { started: false, generation: null, skipped: "busy" };
    }
    abandonActiveTick(s, elapsed, nowFn());
  }

  if (s.outstandingAbandoned.size >= cfg.maxOutstandingAbandoned) {
    // Launching more work would stack suspended ticks and provider spend behind a
    // health endpoint that still says "running". Refuse, and say so truthfully.
    s.launchBlocked = true;
    return { started: false, generation: null, skipped: "wedged" };
  }
  s.launchBlocked = false;

  const generation = s.nextGeneration++;
  const startedAt = nowFn();
  s.activeGeneration = generation;
  s.tickStartedAtMs = startedAt;
  s.lastTickStartedAtMs = startedAt;
  s.ticksStarted += 1;

  let settled = false;
  const work = tickStorage.run({ generation }, () => tick());

  // The tick's own completion bookkeeping. Attached to the promise rather than
  // awaited directly, so a late settle is still recorded after abandonment.
  const tracked = work.then(
    () => { settleTick(s, generation, startedAt, null, nowFn()); settled = true; },
    (err: unknown) => {
      settleTick(s, generation, startedAt, String((err as any)?.message ?? err), nowFn());
      settled = true;
    },
  );

  // The budget timer is deliberately NOT unref'd: while a tick is in flight the
  // process must stay awake long enough to notice the hang and recover from it. It is
  // cleared the moment the tick wins the race, so it never outlives the tick.
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => { budgetTimer = setTimeout(resolve, cfg.tickTimeoutMs); });
  try {
    await Promise.race([tracked, budget]);
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }

  if (!settled && s.activeGeneration === generation) {
    abandonActiveTick(s, nowFn() - startedAt, nowFn());
  }
  return { started: true, generation, skipped: null };
}

function abandonActiveTick(s: WatchdogState, elapsedMs: number, nowMs: number): void {
  const gen = s.activeGeneration;
  if (gen == null) return;
  s.outstandingAbandoned.add(gen);
  s.timeouts += 1;
  s.consecutiveFailures += 1;
  s.lastTimeoutAtMs = nowMs;
  s.lastTimeoutNote = `tick generation ${gen} exceeded its budget after ${Math.round(elapsedMs)}ms and was abandoned; it is fenced from all further side effects`;
  // Clearing the active generation is what fences the abandoned tick: from here
  // `currentGenerationIsActive()` is false inside it forever.
  s.activeGeneration = null;
  s.tickStartedAtMs = null;
  s.recoveries += 1;
}

function settleTick(
  s: WatchdogState,
  generation: number,
  startedAtMs: number,
  error: string | null,
  nowMs: number,
): void {
  const wasAbandoned = s.outstandingAbandoned.delete(generation);
  if (wasAbandoned) {
    // The hang was transient after all. Worth knowing: it means the timeout budget
    // is too tight, not that the subsystem is dead.
    s.lateSettled += 1;
    return;
  }
  if (s.activeGeneration !== generation) return;
  s.activeGeneration = null;
  s.tickStartedAtMs = null;
  s.lastCompletedAtMs = nowMs;
  s.lastDurationMs = nowMs - startedAtMs;
  s.ticksCompleted += 1;
  if (error) {
    s.lastError = error;
    s.consecutiveFailures += 1;
  } else {
    s.lastSuccessAtMs = nowMs;
    s.consecutiveFailures = 0;
  }
}

export interface LoopHealth {
  state: LoopHealthState;
  reason: string;
  running: boolean;
  busy: boolean;
  activeGeneration: number | null;
  currentTickDurationMs: number | null;
  lastTickStartedAtMs: number | null;
  lastCompletedAtMs: number | null;
  lastSuccessAtMs: number | null;
  msSinceLastSuccess: number | null;
  lastDurationMs: number | null;
  ticksStarted: number;
  ticksCompleted: number;
  timeoutCount: number;
  recoveryCount: number;
  lateSettledCount: number;
  outstandingAbandoned: number;
  fencedSideEffects: number;
  consecutiveFailures: number;
  launchBlocked: boolean;
  lastError: string | null;
  lastTimeoutNote: string | null;
  config: WatchdogConfig;
}

/**
 * Truthful loop health. Deliberately does NOT report HEALTHY merely because the
 * process is alive — that is the exact claim that hid a 5.5 hour wedge.
 */
export function loopHealth(
  opts: { running: boolean; nowMs?: number; cfg?: WatchdogConfig } = { running: false },
): LoopHealth {
  const s = watchdogState();
  const cfg = opts.cfg ?? watchdogConfigFromEnv();
  const nowMs = opts.nowMs ?? Date.now();
  const currentTickDurationMs = s.tickStartedAtMs != null ? nowMs - s.tickStartedAtMs : null;
  const msSinceLastSuccess = s.lastSuccessAtMs != null ? nowMs - s.lastSuccessAtMs : null;

  let state: LoopHealthState;
  let reason: string;

  if (!opts.running) {
    state = "WEDGED";
    reason = "scanner loop is not running";
  } else if (s.launchBlocked || s.outstandingAbandoned.size >= cfg.maxOutstandingAbandoned) {
    state = "WEDGED";
    reason = `${s.outstandingAbandoned.size} abandoned tick(s) have never settled — the loop is refusing to launch more work`;
  } else if (currentTickDurationMs != null && currentTickDurationMs > cfg.tickTimeoutMs) {
    state = "WEDGED";
    reason = `the in-flight tick has run ${Math.round(currentTickDurationMs)}ms, past its ${cfg.tickTimeoutMs}ms budget`;
  } else if (s.outstandingAbandoned.size > 0) {
    state = "RECOVERING";
    reason = `${s.outstandingAbandoned.size} abandoned tick(s) outstanding; new ticks are still being launched`;
  } else if (s.ticksCompleted === 0 && s.ticksStarted > 0) {
    state = "RECOVERING";
    reason = "no tick has completed yet";
  } else if (msSinceLastSuccess != null && msSinceLastSuccess > cfg.stallWarnMs) {
    state = "DEGRADED";
    reason = `no successful tick for ${Math.round(msSinceLastSuccess)}ms`;
  } else if (s.consecutiveFailures > 0) {
    state = "DEGRADED";
    reason = `${s.consecutiveFailures} consecutive tick failure(s)`;
  } else if (s.lastSuccessAtMs == null) {
    state = "RECOVERING";
    reason = "loop is running but has not yet recorded a successful tick";
  } else {
    state = "HEALTHY";
    reason = "ticks are completing";
  }

  return {
    state,
    reason,
    running: opts.running,
    busy: s.activeGeneration != null,
    activeGeneration: s.activeGeneration,
    currentTickDurationMs,
    lastTickStartedAtMs: s.lastTickStartedAtMs,
    lastCompletedAtMs: s.lastCompletedAtMs,
    lastSuccessAtMs: s.lastSuccessAtMs,
    msSinceLastSuccess,
    lastDurationMs: s.lastDurationMs,
    ticksStarted: s.ticksStarted,
    ticksCompleted: s.ticksCompleted,
    timeoutCount: s.timeouts,
    recoveryCount: s.recoveries,
    lateSettledCount: s.lateSettled,
    outstandingAbandoned: s.outstandingAbandoned.size,
    fencedSideEffects: s.fencedSideEffects,
    consecutiveFailures: s.consecutiveFailures,
    launchBlocked: s.launchBlocked,
    lastError: s.lastError,
    lastTimeoutNote: s.lastTimeoutNote,
    config: cfg,
  };
}
