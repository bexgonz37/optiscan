/**
 * scheduler.ts — the background job scheduler (live runtime wiring). Next-server
 * module, started once per process from server boot.
 *
 * Runs the automatic maintenance + learning/drift + supervisor jobs on configurable
 * cadences. It is:
 *   • restart-safe   — last-run times reset on boot; jobs are idempotent
 *   • concurrency-safe — a single "scheduler" worker lease (DB-backed, heartbeat +
 *     staleness) means only ONE process runs the jobs, and a crashed owner's lease
 *     expires so another can take over (no permanent deadlock)
 *   • observable     — telemetry is exposed for the health surface
 *   • honest         — it never fabricates readiness; the bounded learning cycle
 *     stays INACTIVE_NO_TRAINABLE_DATA when there is no trustworthy data
 *
 * It changes no source code, thresholds, or trading rules. Discord delivery for the
 * supervisor cycle stays behind the canonical-path + auto-send gates.
 */
import { schedulerIntervals, jobDue } from "@/lib/scheduler-policy";

const LEASE_NAME = "scheduler";
const BASE_TICK_MS = 15_000;

type JobName = "maintenance" | "learning" | "supervisor" | "improvement";

export interface SchedulerState {
  started: boolean;
  isOwner: boolean;
  ownerPid: number | null;
  lastBeatAtMs: number | null;
  lastRun: Record<JobName, number | null>;
  runs: Record<JobName, number>;
  note: string;
  lastError: string | null;
}

type G = typeof globalThis & {
  __optiscanScheduler?: SchedulerState;
  __optiscanSchedulerTimer?: ReturnType<typeof setTimeout>;
  __optiscanSchedulerBusy?: Set<JobName>;
};

function state(): SchedulerState {
  const g = globalThis as G;
  g.__optiscanScheduler ??= {
    started: false, isOwner: false, ownerPid: null, lastBeatAtMs: null,
    lastRun: { maintenance: null, learning: null, supervisor: null, improvement: null },
    runs: { maintenance: 0, learning: 0, supervisor: 0, improvement: 0 },
    note: "not started", lastError: null,
  };
  return g.__optiscanScheduler;
}

function busy(): Set<JobName> {
  const g = globalThis as G;
  g.__optiscanSchedulerBusy ??= new Set<JobName>();
  return g.__optiscanSchedulerBusy;
}

/** Read-only scheduler state for the health surface. */
export function schedulerState(): SchedulerState {
  const s = state();
  return { ...s, lastRun: { ...s.lastRun }, runs: { ...s.runs } };
}

function db(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  return getDb();
}

/** Run one job with an in-process overlap guard; failures never abort the beat. */
async function runJob(name: JobName, fn: () => Promise<void> | void, nowMs: number): Promise<void> {
  const b = busy();
  if (b.has(name)) return; // already running (long job) — skip this beat
  b.add(name);
  try {
    await fn();
    state().lastRun[name] = nowMs;
    state().runs[name] += 1;
  } catch (err: any) {
    state().lastError = `${name}: ${err?.message ?? String(err)}`;
  } finally {
    b.delete(name);
  }
}

async function maintenanceJob(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { syncPaperOutcomes } = require("@/lib/outcome-store");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { refreshStatistics } = require("@/lib/statistics-store");
  syncPaperOutcomes();
  refreshStatistics();
}

async function learningJob(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runLearningCycle } = require("@/lib/learning-store");
  runLearningCycle(); // bounded: refresh + gated retrain + drift snapshot (never fabricates)
}

async function supervisorJob(nowMs: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runSupervisorCycle, supervisorRuntimeEnabled } = require("@/lib/supervisor-cycle");
  if (!supervisorRuntimeEnabled()) return;
  await runSupervisorCycle(nowMs);
}

/** Whether the low-frequency, PROPOSAL-ONLY improvement audit may run. */
export function improvementAuditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IMPROVEMENT_AUDIT === "1";
}

async function improvementJob(): Promise<void> {
  if (!improvementAuditEnabled()) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runImprovementAudit } = require("@/lib/improvement/runtime");
  runImprovementAudit(); // records immutable proposals only — never edits code or merges
}

async function beat(): Promise<void> {
  const s = state();
  const nowMs = Date.now();
  s.lastBeatAtMs = nowMs;

  // Single-owner lease: only one process runs the jobs.
  let owner = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { acquireLease, heartbeatLease } = require("@/lib/instance-lock");
    const res = acquireLease(db(), LEASE_NAME, { pid: process.pid });
    owner = res.acquired;
    if (owner) heartbeatLease(db(), LEASE_NAME, process.pid, nowMs);
    else {
      s.isOwner = false;
      s.ownerPid = res.holder?.pid ?? null;
      s.note = `standby — scheduler lease held by pid ${res.holder?.pid}`;
    }
  } catch (err: any) {
    // DB unavailable ⇒ fail OPEN so a single-node install still runs jobs.
    owner = true;
    s.lastError = `lease unavailable: ${err?.message}`;
  }
  if (!owner) return;

  s.isOwner = true;
  s.ownerPid = process.pid;
  s.note = "owner — running scheduled jobs";

  const iv = schedulerIntervals();
  if (jobDue(s.lastRun.maintenance, iv.maintenanceMs, nowMs)) await runJob("maintenance", maintenanceJob, nowMs);
  if (jobDue(s.lastRun.learning, iv.learningMs, nowMs)) await runJob("learning", learningJob, nowMs);
  if (jobDue(s.lastRun.supervisor, iv.supervisorMs, nowMs)) await runJob("supervisor", () => supervisorJob(nowMs), nowMs);
  if (jobDue(s.lastRun.improvement, iv.improvementMs, nowMs)) await runJob("improvement", improvementJob, nowMs);
}

/** Start the scheduler once per process. Idempotent; safe to call from boot. */
export function startScheduler(): void {
  const g = globalThis as G;
  const s = state();
  if (s.started) return;
  if (process.env.SCHEDULER_DISABLED === "1") { s.note = "disabled (SCHEDULER_DISABLED=1)"; return; }
  s.started = true;
  s.note = "started";
  const loop = async () => {
    try { await beat(); } catch (err: any) { state().lastError = `beat: ${err?.message}`; }
    g.__optiscanSchedulerTimer = setTimeout(loop, BASE_TICK_MS);
    (g.__optiscanSchedulerTimer as any)?.unref?.();
  };
  loop();
  console.log(`[scheduler] started (base tick ${BASE_TICK_MS}ms)`);
}
