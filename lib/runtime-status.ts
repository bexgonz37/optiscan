/**
 * runtime-status.ts — read-only aggregate of the live runtime for the health/
 * status surface (live runtime wiring). Next-server module.
 *
 * Assembles worker/lease ownership, scanner + supervisor cycle telemetry, Discord
 * delivery ledger counts, learning/drift state, model readiness (incl. outcomes
 * still needed for experimental/validated activation), and the improvement-agent
 * mode + pending proposals. It reads only aggregates and NEVER exposes secrets or
 * webhook URLs.
 */

function db(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  return getDb();
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export interface RuntimeStatus {
  nowMs: number;
  worker: {
    scanner: { holderPid: number | null; fresh: boolean; hostname: string | null; heartbeatAt: string | null; running: boolean };
    scheduler: { holderPid: number | null; fresh: boolean; hostname: string | null; heartbeatAt: string | null; started: boolean; isOwner: boolean; note: string };
    thisPid: number;
  };
  scanner: { running: boolean; lastTickAt: number | null; ticks: number; triggers: number; alerts: number; errors: number; session: string | null };
  supervisor: Record<string, unknown>;
  callouts: { canonicalTracked: number; byStatus: Record<string, number>; lastEmitAtMs: number | null; canonicalPath: string; discordDeliveryEnabled: boolean };
  discord: { deliveries: Record<string, number> };
  scheduler: Record<string, unknown>;
  learning: { lastCycleNote: string | null; nextEligibleLearningMs: number | null; driftState: string | null; lastDriftAtMs: number | null };
  outcomes: { total: number; graded: number; wins: number; losses: number };
  model: {
    state: string; tier: string; championVersion: number | null;
    moreForValidated: Record<string, number> | null;
    moreForExperimental: Record<string, number> | null;
  };
  improvement: { mode: string; auditEnabled: boolean; pendingProposals: number; blocked: number };
}

export function buildRuntimeStatus(nowMs: number = Date.now()): RuntimeStatus {
  const thisPid = process.pid;

  // ── worker / lease ownership ───────────────────────────────────────────────
  const scannerHolder = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { scannerLockHolder } = require("@/lib/instance-lock");
    return scannerLockHolder(db(), nowMs);
  }, { holder: null, fresh: false });
  const schedHolder = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { leaseHolder } = require("@/lib/instance-lock");
    return leaseHolder(db(), "scheduler", nowMs);
  }, { holder: null, fresh: false });

  const loop = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/scanner-loop").loopState();
  }, { running: false, lastTickAt: null, ticks: 0, triggers: 0, alerts: 0, errors: 0, session: null });

  const sched = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/scheduler").schedulerState();
  }, { started: false, isOwner: false, note: "unavailable", lastRun: {}, runs: {} } as any);

  const supervisor = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/supervisor-cycle").supervisorTelemetry();
  }, {} as Record<string, unknown>);

  const calloutSummary = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/callouts/state-store").calloutStateSummary();
  }, { total: 0, byStatus: {}, lastEmitAtMs: null });

  const canonicalPath = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/callouts/routing").calloutCanonicalPath();
  }, "legacy");
  const discordDeliveryEnabled = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/callouts/routing").supervisorDiscordDeliveryEnabled();
  }, false);

  const deliveries: Record<string, number> = {};
  safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rows = require("@/lib/alert-store").discordDeliverySummary() as any[];
    for (const r of rows) deliveries[r.status] = Number(r.count);
    return null;
  }, null);

  // ── learning / drift / model ───────────────────────────────────────────────
  const learning = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/learning-store").learningStatus();
  }, { modelStatus: {}, latestDrift: null, counts: { graded: 0, outcomes: 0 }, recentRuns: [] } as any);

  const model = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/model-registry").modelStatus();
  }, { state: "INACTIVE_NO_TRAINABLE_DATA", tier: "NONE", championVersion: null, experimental: null } as any);

  const req = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reg = require("@/lib/model-registry");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exp = require("@/lib/model-experimental");
    const meta = model.experimental;
    if (!meta) return { moreForValidated: null, moreForExperimental: null };
    const v = reg.defaultActivationThresholds();
    const e = reg.defaultExperimentalThresholds();
    return {
      moreForValidated: exp.requiredForValidated(meta, { minGraded: v.minGraded, minWins: v.minWins, minLosses: v.minLosses, minHoldout: v.minHoldout }),
      moreForExperimental: exp.requiredForValidated(meta, { minGraded: e.minGraded, minWins: e.minWins, minLosses: e.minLosses, minHoldout: e.minHoldout }),
    };
  }, { moreForValidated: null, moreForExperimental: null });

  const counts = learning.counts ?? { graded: 0, outcomes: 0 };
  const expMeta = model.experimental ?? { wins: 0, losses: 0 };

  const learningMs = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/scheduler-policy").schedulerIntervals().learningMs;
  }, 60 * 60_000);
  const lastLearningRun = (sched.lastRun && sched.lastRun.learning) ?? null;
  const nextEligibleLearningMs = lastLearningRun != null ? lastLearningRun + learningMs : null;

  // ── improvement agent ──────────────────────────────────────────────────────
  const improvement = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/improvement-store").improvementStatus();
  }, { agentState: "INACTIVE_NO_AUTOMATION", counts: { total: 0 } } as any);
  const auditEnabled = safe(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/scheduler").improvementAuditEnabled();
  }, false);

  return {
    nowMs,
    worker: {
      scanner: {
        holderPid: scannerHolder.holder?.pid ?? null, fresh: scannerHolder.fresh,
        hostname: scannerHolder.holder?.hostname ?? null, heartbeatAt: scannerHolder.holder?.heartbeat_at ?? null,
        running: Boolean(loop.running),
      },
      scheduler: {
        holderPid: schedHolder.holder?.pid ?? null, fresh: schedHolder.fresh,
        hostname: schedHolder.holder?.hostname ?? null, heartbeatAt: schedHolder.holder?.heartbeat_at ?? null,
        started: Boolean(sched.started), isOwner: Boolean(sched.isOwner), note: String(sched.note ?? ""),
      },
      thisPid,
    },
    scanner: {
      running: Boolean(loop.running), lastTickAt: loop.lastTickAt ?? null, ticks: loop.ticks ?? 0,
      triggers: loop.triggers ?? 0, alerts: loop.alerts ?? 0, errors: loop.errors ?? 0, session: loop.session ?? null,
    },
    supervisor,
    callouts: {
      canonicalTracked: calloutSummary.total, byStatus: calloutSummary.byStatus,
      lastEmitAtMs: calloutSummary.lastEmitAtMs, canonicalPath, discordDeliveryEnabled,
    },
    discord: { deliveries },
    scheduler: sched,
    learning: {
      lastCycleNote: learning.modelStatus?.message ?? null,
      nextEligibleLearningMs,
      driftState: learning.latestDrift?.state ?? null,
      lastDriftAtMs: learning.latestDrift?.atMs ?? null,
    },
    outcomes: {
      total: counts.outcomes ?? 0, graded: counts.graded ?? 0,
      wins: expMeta.wins ?? 0, losses: expMeta.losses ?? 0,
    },
    model: {
      state: model.state ?? "INACTIVE_NO_TRAINABLE_DATA", tier: model.tier ?? "NONE",
      championVersion: model.championVersion ?? null,
      moreForValidated: req.moreForValidated, moreForExperimental: req.moreForExperimental,
    },
    improvement: {
      mode: improvement.agentState ?? "INACTIVE_NO_AUTOMATION", auditEnabled,
      pendingProposals: improvement.counts?.READY_FOR_CODING_AGENT ?? 0,
      blocked: improvement.counts?.BLOCKED ?? 0,
    },
  };
}
