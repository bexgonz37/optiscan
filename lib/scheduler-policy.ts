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
  aiCheckMs: number;       // how often to CHECK whether an offline AI job is due
  /** How often to CHECK whether today's Brokerage V2 soak readiness report is due. */
  brokerReadinessMs: number;
  /** How often to re-evaluate owner subscriber-readiness (state machine + edge notification). */
  subscriberReadinessMs: number;
  /** How often to scan PENDING content events and deliver private Twitter/X draft ideas. */
  contentDraftsMs: number;
  /** How often to CHECK overnight research schedule windows (ET clock gates inside the job). */
  overnightResearchMs: number;
  /**
   * How often to record deterministic market context, clear stale Watchlist plans,
   * and rebuild the persisted plan. Owns every write GET /api/now used to perform.
   */
  watchlistPlanningMs: number;
  asymmetryTransitionsMs: number;
  asymmetryMarksMs: number;
  asymmetryPaperMs: number;
  asymmetryPaperGateMs: number;
  asymmetryEodMs: number;
  historicalMinerMs: number;
  /**
   * Per-job wall-clock budget. The beat runs jobs sequentially and awaits each
   * one, so a job that never settles used to stop the beat from ever returning —
   * and because the next tick is only scheduled after the beat resolves, the whole
   * scheduler died silently until the process restarted. On 2026-08-19 that
   * happened at 00:58 ET and took the asymmetry marks/transitions/paper-gate/EOD
   * lanes and the supervisor cycle with it for the rest of the session, while
   * /api/healthz still reported ok. A job that blows this budget is abandoned by
   * the BEAT (it keeps running; a promise cannot be cancelled) and the in-process
   * overlap guard stops it from ever being started twice.
   */
  jobTimeoutMs: number;
  /**
   * Whole-beat budget. Backstop for a hang that is not inside a timed job — the
   * lease acquire, a synchronous DB call, a due-check. Guarantees the next tick
   * is always scheduled.
   */
  beatTimeoutMs: number;
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
    // 30s default supervisor cadence — halves the worst-case lag between an
    // entry-zone callout being built and it reaching Discord (so an options alert
    // does not arrive a minute late at the top of the candle). Never faster than
    // 15s; override with SCHED_SUPERVISOR_MS. Budget-safe: ~12 tickers/cycle.
    supervisorMs: clampInt(env.SCHED_SUPERVISOR_MS, 30_000, 15_000, 30 * 60_000),
    // 6h default improvement audit; never faster than 1h.
    improvementMs: clampInt(env.SCHED_IMPROVEMENT_MS, 6 * 60 * 60_000, 60 * 60_000, 7 * 24 * 60 * 60_000),
    // 5 min default AI-due CHECK (not the job itself); the job is idempotent and
    // detached. Never faster than 1 min, never slower than 1h.
    aiCheckMs: clampInt(env.SCHED_AI_CHECK_MS, 5 * 60_000, 60_000, 60 * 60_000),
    // 60 min default soak readiness check; idempotent per ET day. Never faster than 15m.
    brokerReadinessMs: clampInt(env.SCHED_BROKER_READINESS_MS, 60 * 60_000, 15 * 60_000, 24 * 60 * 60_000),
    // 15 min default subscriber-readiness re-evaluation. Frequent enough to REVOKE promptly on a
    // safety breach; READY promotions still only fire on a completed-day boundary. Never faster than 5m.
    subscriberReadinessMs: clampInt(env.SCHED_SUBSCRIBER_READINESS_MS, 15 * 60_000, 5 * 60_000, 6 * 60 * 60_000),
    // 3 min default content-drafts scan (owner review pipeline; never auto-posts). Never faster than 60s.
    contentDraftsMs: clampInt(env.SCHED_CONTENT_DRAFTS_MS, 3 * 60_000, 60_000, 60 * 60_000),
    // 5 min default overnight research window check. Never faster than 60s.
    overnightResearchMs: clampInt(env.SCHED_OVERNIGHT_RESEARCH_MS, 5 * 60_000, 60_000, 60 * 60_000),
    // 10 min default Watchlist planning refresh. Bounded provider use (2 index candle
    // fetches per run) and idempotent, so a repeat run is always safe. Never faster than 60s.
    watchlistPlanningMs: clampInt(env.SCHED_WATCHLIST_PLANNING_MS, 10 * 60_000, 60_000, 6 * 60 * 60_000),
    // High-Asymmetry forward marks. 60s so the 1-minute horizon is reachable;
    // the runner itself only does due work, so a fast tick is cheap.
    // High-Asymmetry state sweep. 60s: fast enough to catch a chase before it
    // matters, bounded so a sweep cannot pile up on the beat.
    asymmetryTransitionsMs: clampInt(env.SCHED_ASYMMETRY_TRANSITIONS_MS, 60_000, 30_000, 30 * 60_000),
    asymmetryMarksMs: clampInt(env.SCHED_ASYMMETRY_MARKS_MS, 60_000, 30_000, 30 * 60_000),
    // High-Asymmetry paper lane. 60s: a simulated stop that is only checked
    // every few minutes is not the stop the rules describe, and the sweep
    // caches one quote per contract so a fast tick stays cheap.
    asymmetryPaperMs: clampInt(env.SCHED_ASYMMETRY_PAPER_MS, 60_000, 30_000, 30 * 60_000),
    // Activation gate. 2 min: the window is 09:40-11:30 ET, so this gives ~55
    // bounded attempts — frequent enough to activate promptly once proof
    // exists, cheap because the gate reads persisted rows and calls no provider.
    asymmetryPaperGateMs: clampInt(env.SCHED_ASYMMETRY_PAPER_GATE_MS, 120_000, 60_000, 30 * 60_000),
    // End-of-day review check. Hourly; the job itself is idempotent per day.
    asymmetryEodMs: clampInt(env.SCHED_ASYMMETRY_EOD_MS, 60 * 60_000, 5 * 60_000, 6 * 60 * 60_000),
    // Historical mining. Checked every 15 minutes; the job itself refuses during RTH, so
    // the interval only controls how soon after the close a backfill can begin. A short
    // interval costs nothing when the gate says no — the check reads no provider.
    historicalMinerMs: clampInt(env.SCHED_HISTORICAL_MINER_MS, 15 * 60_000, 60_000, 6 * 60 * 60_000),
    // 3 min per job. The longest legitimate job is the historical miner, which
    // bounds ITSELF at HISTORICAL_MINER_MAX_RUN_MS (default 120s), so this leaves
    // headroom for a slow-but-healthy pass and still frees the beat well inside a
    // single asymmetry marks interval. Never shorter than 30s.
    jobTimeoutMs: clampInt(env.SCHED_JOB_TIMEOUT_MS, 3 * 60_000, 30_000, 30 * 60_000),
    // A beat that reaches this has a hang outside any single job. Generous enough
    // that a healthy beat running several due jobs back to back never trips it.
    beatTimeoutMs: clampInt(env.SCHED_BEAT_TIMEOUT_MS, 10 * 60_000, 60_000, 60 * 60_000),
  };
}

/** A job is due when it has never run or its interval has elapsed. */
export function jobDue(lastRunMs: number | null | undefined, intervalMs: number, nowMs: number): boolean {
  if (lastRunMs == null) return true;
  return nowMs - lastRunMs >= intervalMs;
}

/**
 * Derive scheduler liveness from beat COMPLETION.
 *
 * Pure so it is testable without the scheduler's DI graph. The 2026-08-19 outage
 * is the reason this exists: every other signal — process up, lease held,
 * `started: true`, `isOwner: true`, /api/healthz ok — stayed green for the 9h22m
 * the beat was dead. Only "when did a beat last FINISH" moved.
 */
export type SchedulerBeatState = "HEALTHY" | "STALE" | "WEDGED" | "NOT_STARTED" | "STANDBY";

export function deriveSchedulerBeatState(input: {
  started: boolean;
  isOwner: boolean;
  lastBeatCompletedAtMs: number | null;
  nowMs: number;
  baseTickMs: number;
  beatTimeoutMs: number;
}): { state: SchedulerBeatState; reason: string } {
  if (!input.started) return { state: "NOT_STARTED", reason: "scheduler has not been started in this process" };
  if (!input.isOwner) return { state: "STANDBY", reason: "another process holds the scheduler lease" };
  if (input.lastBeatCompletedAtMs == null) {
    return { state: "STALE", reason: "no beat has completed since this process started" };
  }
  const since = input.nowMs - input.lastBeatCompletedAtMs;
  if (since > input.beatTimeoutMs) {
    return { state: "WEDGED", reason: `no beat has completed for ${Math.round(since / 1000)}s` };
  }
  if (since > input.baseTickMs * 8) {
    return { state: "STALE", reason: `last beat completed ${Math.round(since / 1000)}s ago` };
  }
  return { state: "HEALTHY", reason: "beats are completing" };
}
