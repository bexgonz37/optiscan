/**
 * health.ts — pure builder for the deep /api/health response (audit T4/P1-1).
 *
 * Kept free of Next.js/SQLite imports so tests can exercise the stall logic
 * directly. The route supplies live inputs (loop state, call stats, db ping).
 *
 * Liveness rule: outside a closed session the loop must be running and have
 * ticked within 3× its interval; otherwise HTTP 503 so Docker healthchecks
 * and uptime monitors react (a silently-dead loop was audit risk P0-1/P0-5).
 *
 * Disclosure rule (documented in README): unauthenticated callers get a
 * SHALLOW body — liveness only, no internal notes/error strings. Full stats
 * (counters, quota, db) require the SCAN_API_TOKEN gate; when no token is
 * configured everything is local-trusted and the full body is returned.
 */

export interface HealthLoopInput {
  running: boolean;
  intervalMs: number;
  lastTickAt: number | null;
  ticks: number;
  triggers: number;
  alerts: number;
  errors: number;
  note: string | null;
  session: string | null;
}

export interface HealthCallStats {
  callsToday: number;
  callsThisMinute: number;
  dailyCap: number;
  minuteCap: number;
  quotaExceeded: boolean;
}

export interface HealthInput {
  loop: HealthLoopInput;
  callStats: HealthCallStats | null;
  dbWritable: boolean | null;
  provider: string;
  keyPresent: boolean;
  nowMs: number;
  /** true when request passed the token gate OR no token is configured */
  authorized: boolean;
}

export const STALL_INTERVAL_MULTIPLIER = 3;

export function lastTickAgeMs(loop: HealthLoopInput, nowMs: number): number | null {
  return loop.lastTickAt == null ? null : Math.max(0, nowMs - loop.lastTickAt);
}

/** Loop is required to be alive in every session except fully closed. */
export function isLoopStalled(loop: HealthLoopInput, nowMs: number): boolean {
  const session = loop.session ?? "closed";
  if (session === "closed") return false;
  if (!loop.running) return true;
  const age = lastTickAgeMs(loop, nowMs);
  if (age == null) return true; // running but never ticked during open session
  return age > STALL_INTERVAL_MULTIPLIER * Math.max(1, loop.intervalMs);
}

export function buildHealth(input: HealthInput): { status: number; body: Record<string, unknown> } {
  const { loop, callStats, dbWritable, provider, keyPresent, nowMs, authorized } = input;
  const stalled = isLoopStalled(loop, nowMs);
  const ok = !stalled;
  const age = lastTickAgeMs(loop, nowMs);
  const session = loop.session ?? "closed";

  const shallow: Record<string, unknown> = {
    ok,
    provider,
    keyPresent,
    time: new Date(nowMs).toISOString(),
    loopRunning: loop.running,
    lastTickAgeMs: age,
    session,
    quotaExceeded: callStats?.quotaExceeded ?? false,
  };

  if (!authorized) {
    // Shallow public body: liveness only — no notes, counters, or error text.
    return { status: ok ? 200 : 503, body: shallow };
  }

  return {
    status: ok ? 200 : 503,
    body: {
      ...shallow,
      ticks: loop.ticks,
      triggers: loop.triggers,
      alerts: loop.alerts,
      errors: loop.errors,
      intervalMs: loop.intervalMs,
      note: loop.note,
      callsToday: callStats?.callsToday ?? null,
      callsThisMinute: callStats?.callsThisMinute ?? null,
      dailyCap: callStats?.dailyCap ?? null,
      minuteCap: callStats?.minuteCap ?? null,
      dbWritable,
    },
  };
}
