/**
 * scheduler-policy.ts — pure cadence policy for the background scheduler (live
 * runtime wiring). PURE. Decides which jobs are DUE from their last-run time and
 * a configurable interval, with safe documented defaults and hard clamps so a
 * misconfigured env can never spin the loop or disable it entirely.
 *
 * The actual retrain/drift GATING (≥25 new graded, ≥24h, both classes, coverage,
 * watermark) lives in the Phase-7 retrain policy — this module only paces WHEN the
 * bounded learning cycle is invoked, never whether it may train.
 */

export interface SchedulerIntervals {
  maintenanceMs: number;   // outcome sync + statistics refresh (frequent, bounded)
  learningMs: number;      // model-readiness + bounded retrain check + drift snapshot
  supervisorMs: number;    // supervisor callout cycle
  improvementMs: number;   // low-frequency improvement audit
}

function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Resolve intervals from env with safe defaults and clamps (ms). */
export function schedulerIntervals(env: NodeJS.ProcessEnv = process.env): SchedulerIntervals {
  return {
    // 5 min default; never faster than 60s, never slower than 1h.
    maintenanceMs: clampInt(env.SCHED_MAINTENANCE_MS, 5 * 60_000, 60_000, 60 * 60_000),
    // 60 min default; the retrain policy still requires ≥24h between real trainings.
    learningMs: clampInt(env.SCHED_LEARNING_MS, 60 * 60_000, 10 * 60_000, 24 * 60 * 60_000),
    // 60s default supervisor cadence; never faster than 15s.
    supervisorMs: clampInt(env.SCHED_SUPERVISOR_MS, 60_000, 15_000, 30 * 60_000),
    // 6h default improvement audit; never faster than 1h.
    improvementMs: clampInt(env.SCHED_IMPROVEMENT_MS, 6 * 60 * 60_000, 60 * 60_000, 7 * 24 * 60 * 60_000),
  };
}

/** A job is due when it has never run or its interval has elapsed. */
export function jobDue(lastRunMs: number | null | undefined, intervalMs: number, nowMs: number): boolean {
  if (lastRunMs == null) return true;
  return nowMs - lastRunMs >= intervalMs;
}
