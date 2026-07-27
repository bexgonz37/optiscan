/**
 * Trader-facing operating modes — presentation only.
 * Never changes delivery/scan enforcement (see market-session-guard.ts).
 *
 * Canonical entry points:
 *   resolveOperatingMode()            — server + unit tests (full health input)
 *   resolveOperatingModeFromHealth()  — shell, mobile header, client polling
 */
import { evaluateMarketSessionGuard, type GuardState } from "../market-session-guard.ts";
import { isMarketHoliday, marketSession, tradingDay, type MarketSession } from "../trading-session.ts";
import type { UiReviewSession } from "./ui-review.ts";

export type OperatingMode =
  | "REGULAR_SESSION_LIVE"
  | "PREMARKET_RESEARCH"
  | "AFTER_HOURS_RESEARCH"
  | "OVERNIGHT_RESEARCH"
  | "WEEKEND_PLANNING"
  | "MARKET_DATA_UNAVAILABLE"
  | "SYSTEM_OFFLINE";

export interface OperatingModeInput {
  nowMs?: number;
  /** Override session for UI review fixtures. */
  sessionOverride?: MarketSession | "overnight" | "weekend";
  systemOffline?: boolean;
  monitorAlive?: boolean | null;
  providerConfigured?: boolean | null;
  providerHealthy?: boolean | null;
  /** Age of last successful market tick (ms). Null = unknown. */
  lastTickAgeMs?: number | null;
  dbOk?: boolean | null;
  authFailed?: boolean;
}

export interface OperatingModeResult {
  mode: OperatingMode;
  label: string;
  detail: string;
  /** True when options may be treated as potentially executable (still need quote gates). */
  optionsExecutableWindow: boolean;
  /** True when the market is closed/extended but the app is healthy. */
  researchActive: boolean;
  guardState: GuardState | "REVIEW_OVERRIDE";
}

/** Shallow /api/health body fields used for client operating-mode resolution. */
export interface HealthBody {
  ok?: boolean;
  loopRunning?: boolean;
  lastTickAgeMs?: number | null;
  session?: string | null;
  keyPresent?: boolean;
  dbWritable?: boolean;
}

export interface ClientOperatingModeOptions {
  nowMs?: number;
  sessionOverride?: UiReviewSession | null;
  fetchFailed?: boolean;
  authFailed?: boolean;
}

export const TICK_STALE_MS = 120_000;

const REVIEW_MODE_MAP: Record<string, OperatingMode> = {
  regular: "REGULAR_SESSION_LIVE",
  premarket: "PREMARKET_RESEARCH",
  afterhours: "AFTER_HOURS_RESEARCH",
  overnight: "OVERNIGHT_RESEARCH",
  weekend: "WEEKEND_PLANNING",
  closed: "OVERNIGHT_RESEARCH",
};

function etMinutes(nowMs: number): { weekday: string; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  return { weekday: get("weekday"), minutes: hour * 60 + Number(get("minute")) };
}

function labelsFor(mode: OperatingMode, detail: string): Pick<OperatingModeResult, "label" | "detail" | "optionsExecutableWindow" | "researchActive"> {
  switch (mode) {
    case "REGULAR_SESSION_LIVE":
      return { label: "LIVE · OPTIONS SESSION", detail, optionsExecutableWindow: true, researchActive: false };
    case "PREMARKET_RESEARCH":
      return { label: "PREMARKET · RESEARCH ACTIVE", detail: detail || "Premarket research — contracts not executable", optionsExecutableWindow: false, researchActive: true };
    case "AFTER_HOURS_RESEARCH":
      return { label: "AFTER HOURS · RESEARCH ACTIVE", detail: detail || "After-hours research — contracts not executable", optionsExecutableWindow: false, researchActive: true };
    case "OVERNIGHT_RESEARCH":
      return { label: "OVERNIGHT · RESEARCH ACTIVE", detail: detail || "Overnight next-session planning", optionsExecutableWindow: false, researchActive: true };
    case "WEEKEND_PLANNING":
      return { label: "WEEKEND · PLANNING ACTIVE", detail: detail || "Weekend planning — next session watchlist", optionsExecutableWindow: false, researchActive: true };
    case "MARKET_DATA_UNAVAILABLE":
      return { label: "MARKET DATA UNAVAILABLE", detail, optionsExecutableWindow: false, researchActive: false };
    case "SYSTEM_OFFLINE":
      return { label: "SYSTEM OFFLINE", detail, optionsExecutableWindow: false, researchActive: false };
  }
}

/** Loop session values where a paused monitor is expected — not a system failure. */
export function isResearchLoopSession(session: string | null | undefined): boolean {
  return session === "premarket" || session === "afterhours" || session === "closed";
}

function resolveReviewMode(sessionOverride: string): OperatingModeResult {
  const mode = REVIEW_MODE_MAP[sessionOverride] ?? "OVERNIGHT_RESEARCH";
  return { mode, ...labelsFor(mode, `UI review session=${sessionOverride}`), guardState: "REVIEW_OVERRIDE" };
}

/** Clock-only session mode — ignores monitor/provider health. */
export function resolveClockOperatingMode(nowMs: number): OperatingModeResult {
  const guard = evaluateMarketSessionGuard(nowMs);
  const { weekday, minutes } = etMinutes(nowMs);
  const day = tradingDay(nowMs);

  if (weekday === "Sat" || weekday === "Sun" || isMarketHoliday(day)) {
    const mode: OperatingMode = "WEEKEND_PLANNING";
    return { mode, ...labelsFor(mode, guard.reason), guardState: guard.state };
  }

  if (minutes < 4 * 60 || minutes >= 20 * 60) {
    const mode: OperatingMode = "OVERNIGHT_RESEARCH";
    return { mode, ...labelsFor(mode, "Outside extended hours — overnight research"), guardState: guard.state };
  }

  if (guard.state === "PREMARKET") {
    return { mode: "PREMARKET_RESEARCH", ...labelsFor("PREMARKET_RESEARCH", guard.reason), guardState: guard.state };
  }

  if (guard.state === "AFTER_HOURS") {
    return { mode: "AFTER_HOURS_RESEARCH", ...labelsFor("AFTER_HOURS_RESEARCH", guard.reason), guardState: guard.state };
  }

  if (
    guard.state === "REGULAR_SESSION"
    || guard.state === "OPENING_DISCOVERY"
    || guard.state === "POWER_HOUR"
    || guard.state === "EARLY_CLOSE"
    || guard.state === "CLOSING_WINDOW"
  ) {
    return { mode: "REGULAR_SESSION_LIVE", ...labelsFor("REGULAR_SESSION_LIVE", guard.reason), guardState: guard.state };
  }

  return { mode: "OVERNIGHT_RESEARCH", ...labelsFor("OVERNIGHT_RESEARCH", guard.reason || "Research mode"), guardState: guard.state };
}

export function isResearchOperatingMode(mode: OperatingMode): boolean {
  return mode === "PREMARKET_RESEARCH"
    || mode === "AFTER_HOURS_RESEARCH"
    || mode === "OVERNIGHT_RESEARCH"
    || mode === "WEEKEND_PLANNING";
}

/**
 * Canonical client resolver — maps /api/health (+ optional UI review session) to operating mode.
 * Used by shell sidebar, mobile header, and any client badge that must match NOW.
 */
export function resolveOperatingModeFromHealth(
  body: HealthBody | null,
  options: ClientOperatingModeOptions = {},
): OperatingModeResult {
  const nowMs = options.nowMs ?? Date.now();

  if (options.authFailed) {
    return resolveOperatingMode({ nowMs, authFailed: true });
  }

  if (options.sessionOverride) {
    return resolveOperatingMode({ nowMs, sessionOverride: options.sessionOverride });
  }

  if (options.fetchFailed) {
    return resolveOperatingMode({ nowMs, systemOffline: true });
  }

  const loopSession = body?.session ?? null;
  const loopRunning = Boolean(body?.ok ?? body?.loopRunning);
  const tickAge = Number(body?.lastTickAgeMs);
  const clockMode = resolveClockOperatingMode(nowMs);
  const researchWindow = isResearchOperatingMode(clockMode.mode) || isResearchLoopSession(loopSession);

  return resolveOperatingMode({
    nowMs,
    dbOk: body?.dbWritable !== false,
    providerConfigured: body?.keyPresent !== false,
    providerHealthy: researchWindow ? true : loopRunning,
    lastTickAgeMs: researchWindow ? null : (Number.isFinite(tickAge) ? tickAge : null),
    monitorAlive: researchWindow ? true : loopRunning,
    systemOffline: false,
  });
}

/**
 * Resolve trader-facing operating mode from health + session clock.
 * OFFLINE only when the system itself is unavailable — never when the market is merely closed.
 */
export function resolveOperatingMode(input: OperatingModeInput = {}): OperatingModeResult {
  const nowMs = input.nowMs ?? Date.now();

  if (input.authFailed || input.dbOk === false) {
    const mode: OperatingMode = "SYSTEM_OFFLINE";
    return {
      mode,
      ...labelsFor(mode, input.authFailed ? "Access token required" : "Database unavailable"),
      guardState: "UNKNOWN_OR_UNSAFE",
    };
  }

  // UI review session override — wins over health/monitor noise (fixtures only).
  if (input.sessionOverride) {
    return resolveReviewMode(input.sessionOverride);
  }

  const clockMode = resolveClockOperatingMode(nowMs);

  // Closed-market / research windows: healthy app with paused monitor ≠ offline.
  if (isResearchOperatingMode(clockMode.mode)) {
    if (input.systemOffline) {
      return { mode: "SYSTEM_OFFLINE", ...labelsFor("SYSTEM_OFFLINE", "App or monitor unavailable"), guardState: "UNKNOWN_OR_UNSAFE" };
    }
    return clockMode;
  }

  // Regular session — monitor + provider gates apply.
  if (input.systemOffline || input.monitorAlive === false) {
    return { mode: "SYSTEM_OFFLINE", ...labelsFor("SYSTEM_OFFLINE", input.systemOffline ? "App or monitor unavailable" : "Independent options monitor not running"), guardState: "UNKNOWN_OR_UNSAFE" };
  }

  const providerBad =
    input.providerConfigured === false
    || input.providerHealthy === false
    || (input.lastTickAgeMs != null && input.lastTickAgeMs > TICK_STALE_MS && marketSession(nowMs) === "regular");

  if (providerBad) {
    return {
      mode: "MARKET_DATA_UNAVAILABLE",
      ...labelsFor("MARKET_DATA_UNAVAILABLE", input.providerConfigured === false ? "Provider API key missing" : input.providerHealthy === false ? "Provider unhealthy" : "Market tick stale"),
      guardState: "UNKNOWN_OR_UNSAFE",
    };
  }

  return clockMode;
}

export function heroTitleForMode(mode: OperatingMode): string {
  if (mode === "REGULAR_SESSION_LIVE") return "BEST CURRENT SETUP";
  return "TOP SETUP FOR NEXT SESSION";
}

export function reviewSessionFromMode(mode: OperatingMode): UiReviewSession {
  switch (mode) {
    case "REGULAR_SESSION_LIVE":
      return "regular";
    case "PREMARKET_RESEARCH":
      return "premarket";
    case "AFTER_HOURS_RESEARCH":
      return "afterhours";
    case "WEEKEND_PLANNING":
      return "weekend";
    default:
      return "overnight";
  }
}
