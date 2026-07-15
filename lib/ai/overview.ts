/**
 * ai/overview.ts — the read model for the private AI Lab dashboard/API. Composes
 * the latest nightly report, recent history, lessons, proposals (grouped by
 * decision), AI usage/cost, recent job failures, and the current feature flags —
 * all from already-recorded rows. Read-only; no provider call, no fabrication.
 */
import { aiConfig } from "./config.ts";
import {
  listReportsOnDb, listLessonsOnDb, listProposalsOnDb, aiUsageOnDb, recentJobFailuresOnDb,
  costGateOnDb, type DbLike, type AiReportRow, type LessonRow, type ProposalRow,
} from "./store.ts";
import { nightlyRunKey, weeklyRunKey, nextNightlyEligibleMs, nextWeeklyEligibleMs } from "./schedule.ts";

function lazyDb(): DbLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/db").getDb();
}

export interface AiOverview {
  flags: {
    enabled: boolean;
    hasApiKey: boolean;
    nightlyDiagnosisEnabled: boolean;
    weeklyProposalsEnabled: boolean;
    recapEnabled: boolean;
    nightlyModel: string;
    weeklyModel: string;
  };
  cost: {
    monthKey: string;
    spendUsd: number;
    softLimitUsd: number;
    hardLimitUsd: number;
    atSoftLimit: boolean;
    atHardLimit: boolean;
    usage: ReturnType<typeof aiUsageOnDb>;
  };
  schedule: {
    nightlyDueNow: boolean;
    weeklyDueNow: boolean;
    nextNightlyEligibleMs: number | null;
    nextWeeklyEligibleMs: number | null;
    nightlyWindow: string;
    weeklyWindow: string;
    /** When the most recent nightly report was produced (its stored day + created ms). */
    lastNightlyDay: string | null;
    lastNightlyAtMs: number | null;
    lastNightlyStatus: string | null;
  };
  latestNightly: AiReportRow | null;
  nightlyHistory: AiReportRow[];
  weeklyHistory: AiReportRow[];
  lessons: LessonRow[];
  proposals: {
    pending: ProposalRow[];
    accepted: ProposalRow[];
    rejected: ProposalRow[];
  };
  jobFailures: any[];
}

export function aiOverviewOnDb(db: DbLike, env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): AiOverview {
  const cfg = aiConfig(env);
  const gate = costGateOnDb(db, cfg, nowMs);
  const nightly = listReportsOnDb(db, "nightly", 30);
  const proposals = listProposalsOnDb(db, 100);
  const lastNightly = nightly[0] ?? null;
  return {
    flags: {
      enabled: cfg.enabled,
      hasApiKey: cfg.hasApiKey,
      nightlyDiagnosisEnabled: cfg.nightlyDiagnosisEnabled,
      weeklyProposalsEnabled: cfg.weeklyProposalsEnabled,
      recapEnabled: cfg.recapEnabled,
      nightlyModel: cfg.nightlyModel,
      weeklyModel: cfg.weeklyModel,
    },
    cost: {
      monthKey: gate ? (aiUsageOnDb(db).monthKey) : "",
      spendUsd: gate.spendUsd,
      softLimitUsd: gate.softLimitUsd,
      hardLimitUsd: gate.hardLimitUsd,
      atSoftLimit: gate.atSoftLimit,
      atHardLimit: gate.atHardLimit,
      usage: aiUsageOnDb(db),
    },
    schedule: {
      nightlyDueNow: nightlyRunKey(nowMs) != null,
      weeklyDueNow: weeklyRunKey(nowMs) != null,
      nextNightlyEligibleMs: nextNightlyEligibleMs(nowMs),
      nextWeeklyEligibleMs: nextWeeklyEligibleMs(nowMs),
      nightlyWindow: "after 20:15 ET on trading weekdays",
      weeklyWindow: "Friday ≥21:00 ET or Saturday",
      lastNightlyDay: lastNightly?.periodKey ?? null,
      lastNightlyAtMs: lastNightly?.createdAtMs ?? null,
      lastNightlyStatus: lastNightly?.narrativeStatus ?? null,
    },
    latestNightly: lastNightly,
    nightlyHistory: nightly,
    weeklyHistory: listReportsOnDb(db, "weekly", 20),
    lessons: listLessonsOnDb(db, 100),
    proposals: {
      pending: proposals.filter((p) => p.status === "PENDING_APPROVAL"),
      accepted: proposals.filter((p) => p.status === "ACCEPTED"),
      rejected: proposals.filter((p) => p.status === "REJECTED"),
    },
    jobFailures: recentJobFailuresOnDb(db, 20),
  };
}

export function aiOverview(env: NodeJS.ProcessEnv = process.env): AiOverview {
  return aiOverviewOnDb(lazyDb(), env);
}
