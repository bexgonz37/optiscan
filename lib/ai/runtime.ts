/**
 * ai/runtime.ts — the scheduler-facing entry for the offline AI jobs. Decides,
 * from the ET clock + calendar (schedule.ts) and durable idempotency (ai_reports),
 * whether a nightly or weekly job is due, and runs it. Everything here is
 * best-effort and never throws — the scheduler beat that calls it must stay fast
 * and the scanner/Discord/paper paths must never be affected by an AI outage.
 *
 * Intended to be invoked DETACHED (not awaited) from the scheduler beat so a slow
 * model call can never delay the supervisor/maintenance jobs.
 */
import { aiConfig } from "./config.ts";
import { nightlyRunKey, weeklyRunKey } from "./schedule.ts";
import { getReportOnDb, type DbLike } from "./store.ts";
import { runNightlyDiagnosis, type NightlyJobResult } from "./nightly.ts";
import { runWeeklyProposals, type WeeklyJobResult } from "./weekly.ts";

function lazyDb(): DbLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/db").getDb();
}

// In-process guard so repeated beats don't re-gather for a key already handled
// this process; the DB ai_reports row is the durable, restart-safe guard.
const handled = { nightly: new Set<string>(), weekly: new Set<string>() };

export interface AiScheduledResult {
  nightly?: NightlyJobResult;
  weekly?: WeeklyJobResult;
  ranNightly: boolean;
  ranWeekly: boolean;
}

export interface AiRuntimeOptions {
  nowMs?: number;
  db?: DbLike;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run whichever AI job is due now. Nightly requires nightlyDiagnosisEnabled; weekly
 * requires weeklyProposalsEnabled (both imply AI_ENABLED + a key). When neither is
 * due/enabled this returns immediately with nothing run.
 */
export async function runAiScheduledJobs(opts: AiRuntimeOptions = {}): Promise<AiScheduledResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const cfg = aiConfig(opts.env);
  const out: AiScheduledResult = { ranNightly: false, ranWeekly: false };
  if (!cfg.enabled) return out;

  let db: DbLike;
  try { db = opts.db ?? lazyDb(); } catch { return out; }

  // Nightly (after extended-hours finalization).
  try {
    const nk = cfg.nightlyDiagnosisEnabled ? nightlyRunKey(nowMs) : null;
    if (nk && !handled.nightly.has(nk) && !getReportOnDb(db, "nightly", nk)) {
      out.nightly = await runNightlyDiagnosis({ nowMs, day: nk, db, env: opts.env, config: cfg });
      out.ranNightly = true;
      handled.nightly.add(nk);
    }
  } catch { /* never throw into the scheduler */ }

  // Weekly (Friday night / Saturday).
  try {
    const wk = cfg.weeklyProposalsEnabled ? weeklyRunKey(nowMs) : null;
    if (wk && !handled.weekly.has(wk) && !getReportOnDb(db, "weekly", wk)) {
      out.weekly = await runWeeklyProposals({ nowMs, weekKey: wk, db, env: opts.env, config: cfg });
      out.ranWeekly = true;
      handled.weekly.add(wk);
    }
  } catch { /* never throw into the scheduler */ }

  return out;
}

/** Test-only: clear the in-process handled guard. */
export function __resetAiHandledGuard(): void {
  handled.nightly.clear();
  handled.weekly.clear();
}
