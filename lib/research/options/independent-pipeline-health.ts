/**
 * Production-wide independent options pipeline health for the dashboard.
 * Prefers persisted worker heartbeat over in-process monitor singleton so the
 * web process never reports "scanner stopped" merely because it does not host the loop.
 */
export type MonitorRunMode =
  | "RUNNING_IN_THIS_PROCESS"
  | "RUNNING_IN_WORKER"
  | "NOT_RUNNING"
  | "UNKNOWN";

export type HealthSource =
  | "Local process"
  | "Database heartbeat"
  | "Worker heartbeat"
  | "Provider telemetry"
  | "Environment configuration"
  | "Session guard"
  | "Unknown";

export interface IndependentPipelineHealthInput {
  nowMs: number;
  discoveryEnabled: boolean;
  killSwitch: boolean;
  ownership: string;
  independentOwns: boolean;
  /** In-process monitor singleton (web process usually has this false). */
  localRunning: boolean;
  localAlive: boolean;
  localLastTier0CycleMs: number | null;
  localLastTier1CycleMs: number | null;
  localLastTier2CycleMs: number | null;
  localBreaker: string;
  localUnhealthyReason: string | null;
  portfolioHealthy: boolean;
  /** Persisted options_runtime.heartbeat from the worker. */
  heartbeat: Record<string, unknown> | null;
  heartbeatAgeMs: number | null;
  heartbeatFresh: boolean;
  /** Deterministic delivery session guard (same as independent delivery). */
  sessionGuardState: string | null;
  sessionGuardReason: string | null;
  /** Env key present in this process (Railway shares env across web+worker). */
  polygonEnvConfigured: boolean;
  /** Persisted self-check polygon item, if available. */
  selfCheckPolygonOk: boolean | null;
  webhookConfigured: boolean;
  /** Recent independent SENT alerts (optional corroboration). */
  recentSentCount24h?: number | null;
}

export interface IndependentPipelineHealth {
  ownership: string;
  independentOwns: boolean;
  killSwitch: boolean;
  discoveryEnabled: boolean;
  runMode: MonitorRunMode;
  monitorRunning: boolean;
  monitorAlive: boolean;
  localProcessHostsMonitor: boolean;
  breakerState: string;
  lastTier0CycleMs: number | null;
  lastTier1CycleMs: number | null;
  lastTier2CycleMs: number | null;
  lastCycleAgeMs: number | null;
  heartbeatAgeMs: number | null;
  session: string;
  sessionGuardReason: string | null;
  polygonConfigured: boolean;
  polygonHealthy: boolean;
  webhookConfigured: boolean;
  portfolioDeliveryHealthy: boolean;
  unhealthyReason: string | null;
  sources: {
    monitor: HealthSource;
    session: HealthSource;
    polygon: HealthSource;
    webhook: HealthSource;
  };
  labels: {
    monitor: string;
    session: string;
    polygon: string;
    processNote: string | null;
  };
}

const FRESH_MS = 180_000;

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ageFresh(ageMs: number | null | undefined, nowMs: number, atMs: number | null): boolean {
  if (ageMs != null && ageMs >= 0 && ageMs < FRESH_MS) return true;
  if (atMs != null && nowMs - atMs < FRESH_MS) return true;
  return false;
}

export function buildIndependentPipelineHealth(input: IndependentPipelineHealthInput): IndependentPipelineHealth {
  const hb = input.heartbeat;
  const hbRunning = Boolean(hb?.running);
  const hbTier1 = numOrNull(hb?.lastTier1CycleMs);
  const hbTier2 = numOrNull(hb?.lastTier2CycleMs);
  const hbAt = numOrNull(hb?.at);
  const localCycleMs = Math.max(
    input.localLastTier0CycleMs ?? 0,
    input.localLastTier1CycleMs ?? 0,
    input.localLastTier2CycleMs ?? 0,
  );
  const workerCycleMs = Math.max(hbTier1 ?? 0, hbTier2 ?? 0, hbAt ?? 0);

  const localFresh =
    (input.localRunning && input.localAlive) ||
    (input.localRunning && localCycleMs > 0 && input.nowMs - localCycleMs < FRESH_MS);

  const workerFresh =
    input.heartbeatFresh ||
    (hbRunning && ageFresh(input.heartbeatAgeMs, input.nowMs, workerCycleMs > 0 ? workerCycleMs : hbAt)) ||
    (workerCycleMs > 0 && input.nowMs - workerCycleMs < FRESH_MS);

  let runMode: MonitorRunMode;
  let monitorSource: HealthSource;

  if (localFresh) {
    runMode = "RUNNING_IN_THIS_PROCESS";
    monitorSource = "Local process";
  } else if (workerFresh || (hbRunning && (input.heartbeatAgeMs ?? Infinity) < FRESH_MS)) {
    runMode = "RUNNING_IN_WORKER";
    monitorSource = "Database heartbeat";
  } else if (!input.discoveryEnabled) {
    runMode = "NOT_RUNNING";
    monitorSource = "Environment configuration";
  } else if (hb == null && !input.localRunning) {
    // No local loop and no persisted heartbeat yet — do not claim stopped.
    runMode = (input.recentSentCount24h ?? 0) > 0 ? "RUNNING_IN_WORKER" : "UNKNOWN";
    monitorSource = (input.recentSentCount24h ?? 0) > 0 ? "Worker heartbeat" : "Unknown";
  } else if (!hbRunning && !input.localRunning) {
    runMode = "NOT_RUNNING";
    monitorSource = hb != null ? "Database heartbeat" : "Local process";
  } else {
    runMode = "UNKNOWN";
    monitorSource = "Unknown";
  }

  const monitorAlive = runMode === "RUNNING_IN_THIS_PROCESS" || runMode === "RUNNING_IN_WORKER";
  const monitorRunning = monitorAlive;

  const lastTier0CycleMs = input.localLastTier0CycleMs;
  const lastTier1CycleMs = input.localLastTier1CycleMs ?? hbTier1;
  const lastTier2CycleMs = input.localLastTier2CycleMs ?? hbTier2;
  const lastCycleMs = Math.max(lastTier0CycleMs ?? 0, lastTier1CycleMs ?? 0, lastTier2CycleMs ?? 0, hbAt ?? 0);
  const lastCycleAgeMs = lastCycleMs > 0 ? Math.max(0, input.nowMs - lastCycleMs) : input.heartbeatAgeMs;

  const hbSession = hb?.session != null ? String(hb.session) : null;
  const session = input.sessionGuardState ?? hbSession ?? "unknown";
  const sessionSource: HealthSource = input.sessionGuardState
    ? "Session guard"
    : hbSession
      ? "Database heartbeat"
      : "Unknown";

  const polygonConfigured = input.polygonEnvConfigured || input.selfCheckPolygonOk === true;
  const providerFailures = Number(hb?.providerFailures ?? 0);
  const polygonHealthy = polygonConfigured && !(Number.isFinite(providerFailures) && providerFailures >= 50);
  const polygonSource: HealthSource = input.polygonEnvConfigured
    ? "Environment configuration"
    : input.selfCheckPolygonOk === true
      ? "Database heartbeat"
      : hb != null
        ? "Provider telemetry"
        : "Environment configuration";

  const breakerState = localFresh
    ? input.localBreaker
    : String(hb?.breaker ?? input.localBreaker ?? "unknown");

  let monitorLabel: string;
  if (runMode === "RUNNING_IN_WORKER") {
    monitorLabel = "Independent options monitor is running in the worker process";
  } else if (runMode === "RUNNING_IN_THIS_PROCESS") {
    monitorLabel = "Independent options monitor is running in this process";
  } else if (runMode === "NOT_RUNNING") {
    monitorLabel = input.discoveryEnabled
      ? "Independent options monitor is not running"
      : "Independent options discovery is disabled in config";
  } else {
    monitorLabel = "Independent options monitor status is unknown";
  }

  const sessionLabel = session === "unknown"
    ? "Current options session: unknown"
    : `Current options session: ${session}`;

  const polygonLabel = !polygonConfigured
    ? "Polygon/Massive API key is not configured"
    : polygonHealthy
      ? "Polygon/Massive provider configured and healthy in worker"
      : "Polygon/Massive provider configured but reporting elevated failures";

  const processNote = runMode === "RUNNING_IN_WORKER"
    ? "Web process does not host the scanner"
    : null;

  return {
    ownership: input.ownership,
    independentOwns: input.independentOwns,
    killSwitch: input.killSwitch,
    discoveryEnabled: input.discoveryEnabled,
    runMode,
    monitorRunning,
    monitorAlive,
    localProcessHostsMonitor: runMode === "RUNNING_IN_THIS_PROCESS",
    breakerState,
    lastTier0CycleMs,
    lastTier1CycleMs,
    lastTier2CycleMs,
    lastCycleAgeMs,
    heartbeatAgeMs: input.heartbeatAgeMs,
    session,
    sessionGuardReason: input.sessionGuardReason,
    polygonConfigured,
    polygonHealthy,
    webhookConfigured: input.webhookConfigured,
    portfolioDeliveryHealthy: input.portfolioHealthy,
    unhealthyReason: input.localUnhealthyReason,
    sources: {
      monitor: monitorSource,
      session: sessionSource,
      polygon: polygonSource,
      webhook: "Environment configuration",
    },
    labels: {
      monitor: monitorLabel,
      session: sessionLabel,
      polygon: polygonLabel,
      processNote,
    },
  };
}
