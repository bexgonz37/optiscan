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
import { schedulerIntervals, jobDue, deriveSchedulerBeatState } from "@/lib/scheduler-policy";
import { isMarketHoliday, tradingDay } from "@/lib/trading-session";
import { isEarlyCloseDay } from "@/lib/market-session-guard";

const LEASE_NAME = "scheduler";
const BASE_TICK_MS = 15_000;

type JobName = "maintenance" | "learning" | "supervisor" | "improvement" | "aiJobs" | "brokerReadiness" | "subscriberReadiness" | "contentDrafts" | "overnightResearch" | "watchlistPlanning" | "asymmetryTransitions" | "asymmetryMarks" | "asymmetryPaper" | "asymmetryPaperGate" | "asymmetryEod" | "historicalMiner";

export interface SchedulerState {
  started: boolean;
  isOwner: boolean;
  ownerPid: number | null;
  lastBeatAtMs: number | null;
  /** Set when a beat RETURNS. `lastBeatAtMs` only proves one started. */
  lastBeatCompletedAtMs: number | null;
  lastRun: Record<JobName, number | null>;
  runs: Record<JobName, number>;
  /** Per-job count of budget overruns abandoned by the beat. */
  jobTimeouts: Record<JobName, number>;
  /** When each in-flight job started; non-null for a job that never settled. */
  jobStartedAt: Record<JobName, number | null>;
  /** Beats abandoned by the whole-beat backstop. */
  beatTimeouts: number;
  lastTimeoutNote: string | null;
  note: string;
  lastError: string | null;
  /**
   * Last historical mining pass. Records the REFUSAL as well as the run, because
   * "the gate said no" and "it ran and found nothing" look identical in a row count
   * and mean opposite things about the health of the lane.
   */
  lastHistoricalMiner?: {
    ranAtMs: number;
    ran: boolean;
    skippedReason: string | null;
    sessionState: string;
    rowsWritten: number;
    requestsIssued: number;
    requestsBlocked: number;
    jobsCompleted: number;
    jobsResumable: number;
  } | null;
  /** Last Watchlist planning outcome — makes context/plan failures visible. */
  lastWatchlistPlanning?: {
    ranAtMs: number;
    tradingDay: string;
    contextRecorded: boolean;
    contextQuality: string;
    contextUsableForPlanning: boolean;
    stalePlanDaysCleared: number;
    staleRowsCleared: number;
    errors: string[];
  } | null;
  /**
   * Last professional Watchlist publication per phase. Read-only diagnostics:
   * a failure here is recorded and the legacy plan continues regardless.
   */
  /** Last High-Asymmetry state sweep. Read-only diagnostics. */
  lastAsymmetryTransitions?: unknown;
  /** Last High-Asymmetry mark sweep. Read-only diagnostics. */
  lastAsymmetryMarks?: unknown;
  /** Last High-Asymmetry paper sweep. Read-only diagnostics. */
  lastAsymmetryPaper?: unknown;
  /** Last automatic paper-activation gate run. Read-only diagnostics. */
  lastAsymmetryPaperGate?: unknown;
  /** Last High-Asymmetry EOD review. Read-only diagnostics. */
  lastAsymmetryEod?: unknown;
  /**
   * Last content-draft scan. Read-only diagnostics.
   *
   * `runContentDraftsScan` returns a full `ContentScanResult` — examined,
   * delivered, failed, skippedNoWebhook, deferredDelivered — and the job used to
   * discard every field of it. So when the recap kill switch was cleared and the
   * stranded drafts still did not move, production had no way to say whether the
   * recovery sweep had run and found nothing, run and failed, or not run at all.
   * A sweep that cannot report its own outcome is not observable, and an
   * unobservable sweep cannot be debugged from the outside.
   */
  lastContentDrafts?: unknown;
  lastProfessionalWatchlist?: {
    overnight: ProfessionalWatchlistRunState | null;
    premarket: ProfessionalWatchlistRunState | null;
  } | null;
}

export interface ProfessionalWatchlistRunState {
  ranAtMs: number;
  tradingDay: string;
  phase: string;
  flagEnabled: boolean;
  outcome: string;
  reason: string | null;
  rowsConsidered: number;
  rowsPublished: number;
  rowsWithheld: number;
  rowsRejectedByCopyScreen: number;
  copyViolations: string[];
  duplicateSuppressed: boolean;
  payloadHash: string | null;
  derivedFromPlanVersion: string | null;
  premarketEvidenceExcluded: Array<{ symbol: string; reason: string }>;
  errors: string[];
}

type G = typeof globalThis & {
  __optiscanScheduler?: SchedulerState;
  __optiscanSchedulerTimer?: ReturnType<typeof setTimeout>;
  __optiscanSchedulerBusy?: Set<JobName>;
};

const JOB_NAMES: JobName[] = [
  "maintenance", "learning", "supervisor", "improvement", "aiJobs", "brokerReadiness",
  "subscriberReadiness", "contentDrafts", "overnightResearch", "watchlistPlanning",
  "asymmetryTransitions", "asymmetryMarks", "asymmetryPaper", "asymmetryPaperGate",
  "asymmetryEod", "historicalMiner",
];
const EMPTY_JOB_COUNTS = Object.fromEntries(JOB_NAMES.map((n) => [n, 0])) as Record<JobName, number>;
const EMPTY_JOB_STARTS = Object.fromEntries(JOB_NAMES.map((n) => [n, null])) as Record<JobName, number | null>;

function state(): SchedulerState {
  const g = globalThis as G;
  g.__optiscanScheduler ??= {
    started: false, isOwner: false, ownerPid: null, lastBeatAtMs: null, lastBeatCompletedAtMs: null,
    lastRun: { maintenance: null, learning: null, supervisor: null, improvement: null, aiJobs: null, brokerReadiness: null, subscriberReadiness: null, contentDrafts: null, overnightResearch: null, watchlistPlanning: null, asymmetryTransitions: null, asymmetryMarks: null, asymmetryPaper: null, asymmetryPaperGate: null, asymmetryEod: null, historicalMiner: null },
    runs: { maintenance: 0, learning: 0, supervisor: 0, improvement: 0, aiJobs: 0, brokerReadiness: 0, subscriberReadiness: 0, contentDrafts: 0, overnightResearch: 0, watchlistPlanning: 0, asymmetryTransitions: 0, asymmetryMarks: 0, asymmetryPaper: 0, asymmetryPaperGate: 0, asymmetryEod: 0, historicalMiner: 0 },
    jobTimeouts: { maintenance: 0, learning: 0, supervisor: 0, improvement: 0, aiJobs: 0, brokerReadiness: 0, subscriberReadiness: 0, contentDrafts: 0, overnightResearch: 0, watchlistPlanning: 0, asymmetryTransitions: 0, asymmetryMarks: 0, asymmetryPaper: 0, asymmetryPaperGate: 0, asymmetryEod: 0, historicalMiner: 0 },
    jobStartedAt: { maintenance: null, learning: null, supervisor: null, improvement: null, aiJobs: null, brokerReadiness: null, subscriberReadiness: null, contentDrafts: null, overnightResearch: null, watchlistPlanning: null, asymmetryTransitions: null, asymmetryMarks: null, asymmetryPaper: null, asymmetryPaperGate: null, asymmetryEod: null, historicalMiner: null },
    beatTimeouts: 0, lastTimeoutNote: null,
    note: "not started", lastError: null, lastWatchlistPlanning: null, lastHistoricalMiner: null,
    lastProfessionalWatchlist: { overnight: null, premarket: null },
  };
  // Pre-existing global state from an older build may lack the newer fields.
  const cur = g.__optiscanScheduler;
  cur.lastProfessionalWatchlist ??= { overnight: null, premarket: null };
  cur.jobTimeouts ??= { ...EMPTY_JOB_COUNTS };
  cur.jobStartedAt ??= { ...EMPTY_JOB_STARTS };
  cur.beatTimeouts ??= 0;
  cur.lastTimeoutNote ??= null;
  cur.lastBeatCompletedAtMs ??= null;
  return cur;
}

function busy(): Set<JobName> {
  const g = globalThis as G;
  g.__optiscanSchedulerBusy ??= new Set<JobName>();
  return g.__optiscanSchedulerBusy;
}

/** Read-only scheduler state for the health surface. */
export function schedulerState(): SchedulerState {
  const s = state();
  return {
    ...s,
    lastRun: { ...s.lastRun }, runs: { ...s.runs },
    jobTimeouts: { ...s.jobTimeouts }, jobStartedAt: { ...s.jobStartedAt },
  };
}

export interface SchedulerHealth {
  state: "HEALTHY" | "STALE" | "WEDGED" | "NOT_STARTED" | "STANDBY";
  reason: string;
  lastBeatAtMs: number | null;
  lastBeatCompletedAtMs: number | null;
  msSinceLastBeatCompleted: number | null;
  beatTimeouts: number;
  lastTimeoutNote: string | null;
  /** Jobs in flight past their budget — the ones that would have wedged the beat. */
  stuckJobs: Array<{ job: JobName; startedAtMs: number; elapsedMs: number; timeouts: number }>;
}

/**
 * Is the beat actually alive? Derived from beat COMPLETION, not from `started`.
 *
 * The 2026-08-19 outage read as healthy everywhere: the process was up, the lease
 * said `started: true, isOwner: true`, and /api/healthz returned ok — while the
 * beat had not completed since 00:58 ET. Aliveness has to be measured by the thing
 * that stops happening.
 */
export function schedulerHealth(nowMs: number = Date.now()): SchedulerHealth {
  const s = state();
  const iv = schedulerIntervals();
  const stuckJobs = JOB_NAMES.flatMap((job) => {
    const startedAtMs = s.jobStartedAt[job];
    if (startedAtMs == null) return [];
    const elapsedMs = nowMs - startedAtMs;
    if (elapsedMs < iv.jobTimeoutMs) return [];
    return [{ job, startedAtMs, elapsedMs, timeouts: s.jobTimeouts[job] ?? 0 }];
  });
  const { state: beatState, reason } = deriveSchedulerBeatState({
    started: s.started,
    isOwner: s.isOwner,
    lastBeatCompletedAtMs: s.lastBeatCompletedAtMs,
    nowMs,
    baseTickMs: BASE_TICK_MS,
    beatTimeoutMs: iv.beatTimeoutMs,
  });
  return {
    state: beatState,
    reason,
    lastBeatAtMs: s.lastBeatAtMs,
    lastBeatCompletedAtMs: s.lastBeatCompletedAtMs,
    msSinceLastBeatCompleted: s.lastBeatCompletedAtMs == null ? null : nowMs - s.lastBeatCompletedAtMs,
    beatTimeouts: s.beatTimeouts,
    lastTimeoutNote: s.lastTimeoutNote,
    stuckJobs,
  };
}

function db(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/lib/db");
  return getDb();
}

/**
 * Run one job with an in-process overlap guard and a wall-clock budget; neither a
 * failure NOR a hang can abort the beat.
 *
 * A hung job is abandoned by the beat, not cancelled — JS has no way to cancel an
 * in-flight promise. It stays in `busy`, so the overlap guard keeps every later
 * beat from starting a second copy, and its own `finally` removes it if it ever
 * settles. `lastRun`/`runs` are only advanced on genuine completion, so an
 * abandoned job still reads as "has not run" in the health surface rather than
 * being silently credited.
 */
async function runJob(name: JobName, fn: () => Promise<void> | void, nowMs: number): Promise<void> {
  const b = busy();
  if (b.has(name)) return; // already running (long job) — skip this beat
  b.add(name);
  const s = state();
  const startedAt = Date.now();
  s.jobStartedAt[name] = startedAt;

  const work = (async () => { await fn(); })().then(
    () => { s.lastRun[name] = nowMs; s.runs[name] += 1; b.delete(name); s.jobStartedAt[name] = null; },
    (err: any) => { s.lastError = `${name}: ${err?.message ?? String(err)}`; b.delete(name); s.jobStartedAt[name] = null; },
  );
  // Not unref'd: while a job is in flight the process must stay awake long enough
  // to notice the hang. Cleared the moment the job wins the race.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budgetMs = schedulerIntervals().jobTimeoutMs;
  let timedOut = false;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve(); }, budgetMs);
  });
  try {
    await Promise.race([work, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut && b.has(name)) {
    s.jobTimeouts[name] += 1;
    s.lastTimeoutNote =
      `${name} exceeded its ${budgetMs}ms budget and was abandoned by the beat at `
      + `${new Date(Date.now()).toISOString()}; it is still in flight and will not be started again until it settles`;
    s.lastError = s.lastTimeoutNote;
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

/**
 * Offline AI jobs (nightly miss-diagnosis / weekly proposals). Run DETACHED so a
 * slow model call can never delay the supervisor/maintenance jobs in this beat.
 * The job is idempotent (one report per day/week) and fails closed; AI being
 * disabled makes it a fast no-op. An in-flight guard prevents overlap.
 */
function launchAiJobs(nowMs: number): void {
  const b = busy();
  if (b.has("aiJobs")) return;
  b.add("aiJobs");
  void (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { runAiScheduledJobs } = require("@/lib/ai/runtime");
      await runAiScheduledJobs({ nowMs });
      state().runs.aiJobs += 1;
    } catch (err: any) {
      state().lastError = `aiJobs: ${err?.message ?? String(err)}`;
    } finally {
      b.delete("aiJobs");
    }
  })();
}

async function brokerReadinessJob(nowMs: number): Promise<void> {
  // Observational soak only — never enables flags or cutover.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runBrokerReadinessSoakJob } = require("@/lib/broker/soak-report");
  runBrokerReadinessSoakJob(process.env, nowMs);
}

/**
 * Owner subscriber-readiness state machine. Re-evaluates the strict launch gate and sends at most one
 * recap-channel message per NOT_READY⇄SUBSCRIBER_READY edge. READY promotions only fire on a completed-
 * day boundary; a safety/integrity breach revokes immediately. Never enables billing/roles/deploys.
 */
async function subscriberReadinessJob(nowMs: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runReadinessTransition } = require("@/lib/research/subscriber-readiness-notifier");
  await runReadinessTransition(db(), {}, process.env, { trigger: "intraday", nowMs });
}

/**
 * Content Event Engine — DETERMINISTIC (no language model). Scans PENDING opportunity_content_events and
 * delivers private Twitter/X draft ideas to the owner's content Discord channel for manual review.
 * Never auto-posts. HARD no-op unless CONTENT_EVENTS_ENABLED=1 and a webhook is configured.
 */
async function contentDraftsJob(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { contentEventsEnabled, runContentDraftsScan, contentWebhookConfigured } = require("@/lib/content/content-drafts-runtime");
  const ranAtMs = Date.now();
  if (!contentEventsEnabled(process.env)) {
    // "Did not run" and "ran and delivered nothing" are different facts. Record
    // which one happened rather than leaving the field null for both.
    state().lastContentDrafts = { ran: false, reason: "CONTENT_EVENTS_DISABLED", ranAtMs, result: null, error: null };
    return;
  }
  try {
    const result = await runContentDraftsScan(db(), {}, process.env);
    // The digest CONSUMES drafts the lane fix held back. It runs after the live
    // scan and is told whether that scan delivered, because live content always
    // outranks historical: the recap budget is 2 posts / 10 min, so a digest
    // taking a slot ahead of a live closure would recreate the original harm.
    // A throw here must not lose the live scan's result, so it is isolated.
    let digest: unknown = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { runHistoricalDigestScan } = require("@/lib/content/historical-digest-runtime");
      digest = await runHistoricalDigestScan(
        db(), { liveDeliveredThisRun: result.delivered > 0 || result.deferredDelivered > 0 }, process.env,
      );
    } catch (e: any) {
      digest = { ran: false, error: String(e?.message ?? e).slice(0, 300) };
    }
    state().lastContentDrafts = {
      ran: true,
      reason: null,
      ranAtMs,
      webhookConfigured: contentWebhookConfigured(process.env),
      result,
      digest,
      error: null,
    };
  } catch (e: any) {
    // The job is diagnostics-bearing now, so a throw must be recorded rather
    // than swallowed into an indistinguishable silence.
    state().lastContentDrafts = {
      ran: true,
      reason: "THREW",
      ranAtMs,
      webhookConfigured: contentWebhookConfigured(process.env),
      result: null,
      error: String(e?.message ?? e).slice(0, 300),
    };
    throw e;
  }
}

type EtClock = { weekday: string; minutes: number };

function etClockNow(nowMs: number): EtClock {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(nowMs));
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return { weekday, minutes: h * 60 + m };
}

export type WatchlistScheduleKind = "next_session_watchlist" | "premarket_watchlist_update" | "market_open_revalidation";

export type WatchlistScheduleWindow = {
  kind: WatchlistScheduleKind;
  label: string;
  sourceWindow: string;
  compareAnyKind: boolean;
};

export function watchlistScheduleWindow(nowMs: number, env: NodeJS.ProcessEnv = process.env): WatchlistScheduleWindow | null {
  const clock = etClockNow(nowMs);
  const day = tradingDay(nowMs);
  if (clock.weekday === "Sat" || clock.weekday === "Sun" || isMarketHoliday(day)) return null;
  const early = isEarlyCloseDay(day, env);
  if (clock.minutes >= 18 * 60 && clock.minutes < 18 * 60 + 10) {
    return {
      kind: "next_session_watchlist",
      label: "NEXT SESSION WATCHLIST",
      sourceWindow: early ? "1800_et_after_early_close" : "1800_et",
      compareAnyKind: false,
    };
  }
  if (clock.minutes >= 8 * 60 + 30 && clock.minutes < 8 * 60 + 40) {
    return {
      kind: "premarket_watchlist_update",
      label: "PREMARKET WATCHLIST UPDATE",
      sourceWindow: "0830_et",
      compareAnyKind: true,
    };
  }
  if (clock.minutes >= 9 * 60 + 35 && clock.minutes < 9 * 60 + 40) {
    return {
      kind: "market_open_revalidation",
      label: "MARKET-OPEN REVALIDATION",
      sourceWindow: "0935_0940_et",
      compareAnyKind: true,
    };
  }
  return null;
}

export function nextWatchlistWindowSummary(nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): string | null {
  const stepMs = 5 * 60_000;
  const limitMs = nowMs + 8 * 24 * 60 * 60_000;
  for (let t = nowMs; t <= limitMs; t += stepMs) {
    const w = watchlistScheduleWindow(t, env);
    if (w) return `${w.label} at ${new Date(t).toISOString()}`;
  }
  return null;
}

/**
 * Watchlist planning — the ONLY writer of market context, stale-plan clearing, and
 * the persisted overnight plan. GET /api/now is read-only, so these writes live here
 * where a failure lands in scheduler state instead of on a user's page refresh.
 * Idempotent: every step is an upsert or a bounded delete.
 */
async function watchlistPlanningJob(nowMs: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runWatchlistPlanningJobOnDb, liveWatchlistPlanningDeps } = require("@/lib/research/watchlist/market-context-job");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildNextSessionPlan, persistOvernightPlan } = require("@/lib/research/overnight/next-session-plan");
  const result = await runWatchlistPlanningJobOnDb(
    db(),
    { ...liveWatchlistPlanningDeps(), now: () => nowMs },
    { buildNextSessionPlan, persistOvernightPlan },
  );
  state().lastWatchlistPlanning = result;
  if (result.errors.length) throw new Error(result.errors.join("; "));
}

/**
 * Legacy alert-derived overnight/next-session research. UNCHANGED behaviour: it
 * still owns the next_session_watchlist, premarket_watchlist_update, and
 * market_open_revalidation windows exactly as before.
 */
async function legacyOvernightResearchJob(nowMs: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {
    buildNextSessionPlan,
    persistOvernightPlan,
    persistWatchlistVersionOnDb,
    markWatchlistVersionOnDb,
  } = require("@/lib/research/overnight/next-session-plan");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {
    formatEodWatchlist,
    formatPremarketPlan,
    formatMarketOpenConfirm,
    sendOwnerResearchNotify,
  } = require("@/lib/notifications/owner-research-notify");

  const window = watchlistScheduleWindow(nowMs);
  if (!window) return;
  const database = db();
  const plan = buildNextSessionPlan(database, nowMs);
  persistOvernightPlan(database, plan);

  // Windows (ET): 18:00 next-session, 08:30 premarket, 09:35-09:40 open revalidation.
  const version = persistWatchlistVersionOnDb(database, plan, {
    kind: window.kind,
    sourceWindow: window.sourceWindow,
    compareAnyKind: window.compareAnyKind,
  });
  if (!version.changed) {
    markWatchlistVersionOnDb(database, version.versionId, "SUPPRESSED_UNCHANGED", nowMs);
    return;
  }
  const content = window.kind === "next_session_watchlist"
    ? formatEodWatchlist(plan)
    : window.kind === "premarket_watchlist_update"
      ? formatPremarketPlan(plan)
      : formatMarketOpenConfirm(plan, version.reasons);
  const res = await sendOwnerResearchNotify({
    db: database,
    kind: window.kind,
    content,
    symbol: version.versionId,
    nowMs,
  });
  if (res.sent) markWatchlistVersionOnDb(database, version.versionId, "SENT", nowMs);
  else if (res.skipped && /DISCORD_WEBHOOK_WATCHLIST not configured/.test(res.reason)) {
    markWatchlistVersionOnDb(database, version.versionId, "SKIPPED_NO_WEBHOOK", nowMs, res.reason);
  } else {
    markWatchlistVersionOnDb(database, version.versionId, res.skipped ? "SUPPRESSED_UNCHANGED" : "FAILED", nowMs, res.reason);
  }
}

/**
 * Professional Watchlist publication for the two planning windows. Additive and
 * flag-gated: with PROFESSIONAL_WATCHLIST_ENABLED unset this performs no build,
 * no provider call, no write, and no send.
 *
 * It runs only for next_session_watchlist and premarket_watchlist_update — the
 * 09:35 market-open revalidation stays legacy-only, because the professional
 * plan's live-session families are not published from a planning window.
 *
 * Deliberately separate from the legacy job so neither can affect the other.
 */
async function professionalWatchlistJob(nowMs: number): Promise<void> {
  const window = watchlistScheduleWindow(nowMs);
  if (!window) return;
  const phase = window.kind === "next_session_watchlist"
    ? "OVERNIGHT_PLAN"
    : window.kind === "premarket_watchlist_update"
      ? "PREMARKET_UPDATE"
      : null;
  if (!phase) return;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { publishProfessionalWatchlist } = require("@/lib/research/watchlist/professional-publication");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { liveProfessionalWatchlistDeps } = require("@/lib/research/watchlist/professional-runner");

  const result = await publishProfessionalWatchlist(
    db(),
    { runner: liveProfessionalWatchlistDeps(), now: () => nowMs },
    phase,
  );
  const slot = phase === "OVERNIGHT_PLAN" ? "overnight" : "premarket";
  const s = state();
  s.lastProfessionalWatchlist ??= { overnight: null, premarket: null };
  s.lastProfessionalWatchlist[slot] = {
    ranAtMs: result.ranAtMs,
    tradingDay: result.tradingDay,
    phase: result.phase,
    flagEnabled: result.flagEnabled,
    outcome: result.outcome,
    reason: result.reason,
    rowsConsidered: result.rowsConsidered,
    rowsPublished: result.rowsPublished,
    rowsWithheld: result.rowsWithheld,
    rowsRejectedByCopyScreen: result.rowsRejectedByCopyScreen,
    copyViolations: result.copyViolations,
    duplicateSuppressed: result.duplicateSuppressed,
    payloadHash: result.payloadHash,
    derivedFromPlanVersion: result.derivedFromPlanVersion,
    premarketEvidenceExcluded: result.premarketEvidenceExcluded,
    errors: result.errors,
  };
}

/**
 * The scheduled overnight-research job: the legacy plan first, then the
 * additive professional publication. Each is contained, so a professional
 * failure can never block, delay, or alter the legacy plan — and the legacy
 * job's early returns can never skip the professional one.
 */
async function overnightResearchJob(nowMs: number): Promise<void> {
  let legacyError: string | null = null;
  try {
    await legacyOvernightResearchJob(nowMs);
  } catch (err: any) {
    legacyError = `legacy: ${err?.message ?? String(err)}`;
  }
  try {
    await professionalWatchlistJob(nowMs);
  } catch (err: any) {
    // Belt and braces: publishProfessionalWatchlist already contains its own
    // failures, so reaching here means an unexpected wiring fault. Record it
    // and let the legacy outcome stand.
    state().lastError = `professionalWatchlist: ${err?.message ?? String(err)}`;
  }
  // The legacy failure is the job's failure; surfacing it preserves the
  // existing runJob error semantics for the legacy path.
  if (legacyError) throw new Error(legacyError);
}

/**
 * High-Asymmetry state sweep (research, OFF by default). Reads active cases,
 * evaluates deterministic transitions, persists them, and surfaces eligible
 * ones to the owner-private channel. One bad case cannot abort the sweep and
 * nothing here can reach a subscriber SEND.
 */
async function asymmetryTransitionsJob(nowMs: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runAsymmetryTransitions } = require("@/lib/research/asymmetry/transition-runner");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tradingDay } = require("@/lib/trading-session");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { observeAsymmetryCase } = require("@/lib/research/asymmetry/live-quote");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sendAsymmetryWebhook } = require("@/lib/notifications/asymmetry-private-send");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { withProviderConsumer } = require("@/lib/provider-context");
  const res = await withProviderConsumer("asymmetry_discovery", () => runAsymmetryTransitions(db(), {
    observe: observeAsymmetryCase,
    // Without this the notifier returns NOT_CONFIGURED forever: `send` is
    // optional and nothing was injecting it, so no private message could ever
    // leave the process no matter how the flags were set.
    send: sendAsymmetryWebhook,
    nowMs,
    clock: Date.now,
    sessionDate: tradingDay(nowMs),
  }));
  state().lastAsymmetryTransitions = res;
}

/**
 * High-Asymmetry forward marks (research, OFF by default). Due-work only: the
 * runner computes which horizons have elapsed and marks those. A failure is
 * recorded in scheduler state and can never abort the beat or reach delivery.
 */
async function asymmetryMarksJob(nowMs: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runDueAsymmetryMarks } = require("@/lib/research/asymmetry/mark-runner");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tradingDay } = require("@/lib/trading-session");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { liveAsymmetryQuote } = require("@/lib/research/asymmetry/live-quote");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { withProviderConsumer } = require("@/lib/provider-context");
  const res = await withProviderConsumer("asymmetry_mark", () => runDueAsymmetryMarks(db(), {
    quote: liveAsymmetryQuote,
    nowMs,
    sessionDate: tradingDay(nowMs),
  }));
  state().lastAsymmetryMarks = res;
}

/**
 * High-Asymmetry PAPER lane (research, OFF by default). Opens simulated
 * positions for eligible cases and manages the open ones on the same tick, so
 * entry and management always see the same quote for the same contract.
 *
 * Owner-private simulation only: this job cannot create a subscriber alert,
 * touch any subscriber paper trade, or reach a broker. It is entirely
 * deterministic — no AI module is imported, called, or awaited anywhere in it.
 */
async function asymmetryPaperJob(nowMs: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runAsymmetryPaper } = require("@/lib/research/asymmetry/paper/runner");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tradingDay } = require("@/lib/trading-session");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { liveAsymmetryQuote } = require("@/lib/research/asymmetry/live-quote");
  const res = await runAsymmetryPaper(db(), {
    quote: liveAsymmetryQuote,
    nowMs,
    sessionDate: tradingDay(nowMs),
    codeVersion: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
  });
  state().lastAsymmetryPaper = res;
}

/**
 * High-Asymmetry automatic paper-activation gate.
 *
 * This is what removes the human from activation. The owner sets
 * HIGH_ASYMMETRY_PAPER_ENABLED=1 once; this job then proves the live exact-OCC
 * quote path from real persisted marks and flips the PERSISTED activation
 * state to ACTIVE on its own. No redeploy and no Railway change is needed on
 * the day, and nothing about the criteria is relaxed to get there.
 *
 * Deterministic: no AI, and no provider call of its own — it judges the marks
 * the real mark-runner produced, so it cannot pass on a parallel path that
 * succeeds where production fails.
 */
async function asymmetryPaperGateJob(nowMs: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runPaperActivationGate } = require("@/lib/research/asymmetry/paper/gate-runner");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolvePrivateConfig } = require("@/lib/research/asymmetry/private-notify");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sendAsymmetryWebhook } = require("@/lib/notifications/asymmetry-private-send");

  // Sweep health is injected so the gate module stays pure over the database.
  const s = state();
  const sweepErrors: string[] = [
    ...(((s.lastAsymmetryMarks as any)?.errors ?? []) as string[]),
    ...(((s.lastAsymmetryTransitions as any)?.errors ?? []) as string[]),
  ];

  // The owner-private webhook ONLY. If it is missing or collides with a
  // subscriber channel the gate still runs and simply does not notify.
  const cfg = resolvePrivateConfig();
  const notify = cfg.webhook && !cfg.refusedReason
    ? (content: string) => sendAsymmetryWebhook(cfg.webhook, content)
    : undefined;

  const res = await runPaperActivationGate(db(), { nowMs, schedulerErrors: sweepErrors, notify });
  state().lastAsymmetryPaperGate = res;
}

/**
 * High-Asymmetry end-of-day review (research, OFF by default). Deterministic
 * aggregation and the Quant report are persisted BEFORE the advisory AI runs,
 * so an AI failure — or an exhausted budget — can never remove or alter a
 * measured result. The advisory call is budget-controlled and happens at most
 * once per trading session.
 */
async function asymmetryEodJob(nowMs: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runAsymmetryEodReview } = require("@/lib/research/asymmetry/eod-review");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tradingDay } = require("@/lib/trading-session");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { explainAsymmetryReviewWithBudget } = require("@/lib/ai/asymmetry-explain");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { deliverPaperReport } = require("@/lib/research/asymmetry/paper/report-delivery");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sendAsymmetryWebhook } = require("@/lib/notifications/asymmetry-private-send");
  const sessionDate = tradingDay(nowMs);
  const res = await runAsymmetryEodReview(db(), {
    nowMs,
    sessionDate,
    explain: (review: unknown) => explainAsymmetryReviewWithBudget(db(), sessionDate, review, nowMs),
    deliverPaperReport: (report: unknown) => deliverPaperReport(sessionDate, report, { send: sendAsymmetryWebhook }),
  });
  state().lastAsymmetryEod = {
    ranAtMs: nowMs, sessionDate: res.sessionDate, persisted: res.persisted,
    quantPersisted: res.quantPersisted, aiStatus: res.aiStatus, aiReason: res.aiReason, errors: res.errors,
  };
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
    // DB unavailable => fail-open so a single-node install still runs jobs.
    // Intentional degraded mode: the DB lease is the only deterministic cross-process coordinator.
    // A local pid/file lock would split-brain across containers, while fail-closed can miss bounded,
    // idempotent maintenance and AI/reporting jobs until DB ownership is restored.
    owner = true;
    s.lastError = `lease unavailable: ${err?.message}`;
  }
  if (!owner) { s.lastBeatCompletedAtMs = Date.now(); return; }

  s.isOwner = true;
  s.ownerPid = process.pid;
  s.note = "owner — running scheduled jobs";

  const iv = schedulerIntervals();
  if (jobDue(s.lastRun.maintenance, iv.maintenanceMs, nowMs)) await runJob("maintenance", maintenanceJob, nowMs);
  if (jobDue(s.lastRun.learning, iv.learningMs, nowMs)) await runJob("learning", learningJob, nowMs);
  if (jobDue(s.lastRun.supervisor, iv.supervisorMs, nowMs)) await runJob("supervisor", () => supervisorJob(nowMs), nowMs);
  if (jobDue(s.lastRun.improvement, iv.improvementMs, nowMs)) await runJob("improvement", improvementJob, nowMs);
  // AI jobs: pace the DUE-check, then launch detached (never awaited in the beat).
  if (jobDue(s.lastRun.aiJobs, iv.aiCheckMs, nowMs)) {
    s.lastRun.aiJobs = nowMs;
    launchAiJobs(nowMs);
  }
  if (jobDue(s.lastRun.brokerReadiness, iv.brokerReadinessMs, nowMs)) {
    await runJob("brokerReadiness", () => brokerReadinessJob(nowMs), nowMs);
  }
  if (jobDue(s.lastRun.subscriberReadiness, iv.subscriberReadinessMs, nowMs)) {
    await runJob("subscriberReadiness", () => subscriberReadinessJob(nowMs), nowMs);
  }
  if (jobDue(s.lastRun.contentDrafts, iv.contentDraftsMs, nowMs)) {
    await runJob("contentDrafts", () => contentDraftsJob(), nowMs);
  }
  if (jobDue(s.lastRun.watchlistPlanning, iv.watchlistPlanningMs, nowMs)) {
    await runJob("watchlistPlanning", () => watchlistPlanningJob(nowMs), nowMs);
  }
  if (jobDue(s.lastRun.asymmetryTransitions, iv.asymmetryTransitionsMs, nowMs)) {
    await runJob("asymmetryTransitions", () => asymmetryTransitionsJob(nowMs), nowMs);
  }
  if (jobDue(s.lastRun.asymmetryMarks, iv.asymmetryMarksMs, nowMs)) {
    await runJob("asymmetryMarks", () => asymmetryMarksJob(nowMs), nowMs);
  }
  if (jobDue(s.lastRun.asymmetryPaperGate, iv.asymmetryPaperGateMs, nowMs)) {
    await runJob("asymmetryPaperGate", () => asymmetryPaperGateJob(nowMs), nowMs);
  }
  if (jobDue(s.lastRun.asymmetryPaper, iv.asymmetryPaperMs, nowMs)) {
    await runJob("asymmetryPaper", () => asymmetryPaperJob(nowMs), nowMs);
  }
  if (jobDue(s.lastRun.asymmetryEod, iv.asymmetryEodMs, nowMs)) {
    await runJob("asymmetryEod", () => asymmetryEodJob(nowMs), nowMs);
  }
  if (jobDue(s.lastRun.overnightResearch, iv.overnightResearchMs, nowMs)) {
    await runJob("overnightResearch", () => overnightResearchJob(nowMs), nowMs);
  }
  if (jobDue(s.lastRun.historicalMiner, iv.historicalMinerMs, nowMs)) {
    await runJob("historicalMiner", () => historicalMinerJob(nowMs), nowMs);
  }
  s.lastBeatCompletedAtMs = Date.now();
}

/**
 * Historical mining. OFF-PEAK ONLY, and the gate that enforces that lives inside the
 * runner rather than here — scheduling is not authorization, and a second caller
 * (a diagnostics POST, a script) must hit the same refusal.
 *
 * Deliberately small per pass. This is a background lane filling a research store; a
 * long-running job would hold the scheduler beat and delay work the live system needs.
 * It resumes from persisted cursors, so many short passes reach the same place as one
 * long one without ever competing.
 *
 * The whole job is a no-op unless HISTORICAL_INGESTION_ENABLED=1.
 */
async function historicalMinerJob(nowMs: number): Promise<void> {
  if (process.env.HISTORICAL_INGESTION_ENABLED !== "1") return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runHistoricalMinerOnDb } = require("@/lib/research/historical/miner");
  const result = await runHistoricalMinerOnDb(
    db(),
    {
      nowMs,
      maxRunMs: Number(process.env.HISTORICAL_MINER_MAX_RUN_MS ?? 120_000),
      maxOptionWindows: Number(process.env.HISTORICAL_MINER_MAX_OPTION_WINDOWS ?? 10),
      maxUnderlyingSymbols: Number(process.env.HISTORICAL_MINER_MAX_SYMBOLS ?? 10),
    },
    {},
    process.env,
  );
  state().lastHistoricalMiner = {
    ranAtMs: nowMs,
    ran: result.ran,
    skippedReason: result.skippedReason,
    sessionState: result.sessionState,
    rowsWritten: result.totals.rowsWritten,
    requestsIssued: result.totals.requestsIssued,
    requestsBlocked: result.totals.requestsBlocked,
    jobsCompleted: result.totals.jobsCompleted,
    jobsResumable: result.totals.jobsResumable,
  };
}

/** Start the scheduler once per process. Idempotent; safe to call from boot. */
export function startScheduler(): void {
  const g = globalThis as G;
  const s = state();
  if (s.started) return;
  if (process.env.SCHEDULER_DISABLED === "1") { s.note = "disabled (SCHEDULER_DISABLED=1)"; return; }
  s.started = true;
  s.note = "started";
  // The next tick is scheduled after the beat resolves, so the beat must always
  // resolve. Per-job budgets cover the common case; this races the whole beat as a
  // backstop for a hang outside any job (lease acquire, a synchronous DB call).
  // Abandoning a beat is safe: every job carries its own overlap guard, so a
  // concurrent later beat cannot start a second copy of anything still in flight.
  const loop = async () => {
    const budgetMs = schedulerIntervals().beatTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve(); }, budgetMs);
    });
    try {
      await Promise.race([
        beat().catch((err: any) => { state().lastError = `beat: ${err?.message}`; }),
        budget,
      ]);
    } catch (err: any) {
      state().lastError = `beat: ${err?.message}`;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (timedOut) {
      const s = state();
      s.beatTimeouts += 1;
      s.lastTimeoutNote = `beat exceeded its ${budgetMs}ms budget and was abandoned; the next tick was scheduled anyway`;
      s.lastError = s.lastTimeoutNote;
    }
    g.__optiscanSchedulerTimer = setTimeout(loop, BASE_TICK_MS);
    (g.__optiscanSchedulerTimer as any)?.unref?.();
  };
  loop();
  console.log(`[scheduler] started (base tick ${BASE_TICK_MS}ms)`);
}
