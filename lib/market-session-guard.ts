/**
 * market-session-guard.ts — authoritative subscriber session guard (America/New_York).
 * Used at scan, READY, batch, delivery, retry, revival, and grading boundaries.
 */
import { isMarketHoliday, tradingDay, type MarketSession } from "./trading-session.ts";
import { sessionState as optionsSessionState, openingWindowMinutes, type SessionState as OptionsSessionState } from "./research/options/session-state.ts";

export type GuardState =
  | "CLOSED_WEEKEND"
  | "CLOSED_HOLIDAY"
  | "EARLY_CLOSE"
  | "PREMARKET"
  | "OPENING_DISCOVERY"
  | "REGULAR_SESSION"
  | "CLOSING_WINDOW"
  | "POWER_HOUR"
  | "AFTER_HOURS"
  | "UNKNOWN_OR_UNSAFE";

/** YYYY-MM-DD -> close time HH:MM ET on early-close days. */
const DEFAULT_EARLY_CLOSE: Record<string, string> = {
  "2025-11-28": "13:00",
  "2026-11-27": "13:00",
  "2027-11-26": "13:00",
};

function earlyCloseMap(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const m = new Map(Object.entries(DEFAULT_EARLY_CLOSE));
  const raw = env.MARKET_EARLY_CLOSE_DAYS;
  if (!raw) return m;
  for (const part of raw.split(",")) {
    const [day, time] = part.trim().split(":");
    if (day && time) m.set(day.trim(), time.trim());
  }
  return m;
}

export function isEarlyCloseDay(day: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return earlyCloseMap(env).has(day);
}

/** ET close ms for a trading day (13:00 on early close, else 16:00). */
export function regularCloseMs(day: string, env: NodeJS.ProcessEnv = process.env): number {
  const early = earlyCloseMap(env).get(day);
  const closeTime = early ?? "16:00";
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false });
  for (const off of ["-04:00", "-05:00"]) {
    const ms = Date.parse(`${day}T${closeTime}:00${off}`);
    if (Number.isFinite(ms) && hourFmt.format(new Date(ms)) === closeTime.slice(0, 2)) return ms;
  }
  return Date.parse(`${day}T${closeTime}:00-05:00`);
}

const etClockFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function etClock(nowMs: number): { weekday: string; minutes: number } {
  const parts = etClockFmt.formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  return { weekday: get("weekday"), minutes: hour * 60 + Number(get("minute")) };
}

const PREMARKET_START = 4 * 60;
const REGULAR_START = 9 * 60 + 30;
const AFTERHOURS_END = 20 * 60;
const CLOSING_WINDOW_MIN = 15;

function baseMarketSession(nowMs: number, env: NodeJS.ProcessEnv): MarketSession {
  const { weekday, minutes } = etClock(nowMs);
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  const day = tradingDay(nowMs);
  if (isMarketHoliday(day)) return "closed";
  const closeMin = Math.floor(regularCloseMs(day, env) / 60000) % (24 * 60);
  const closeMinutes = (() => {
    const d = new Date(regularCloseMs(day, env));
    const p = etClockFmt.formatToParts(d);
    const h = Number(p.find((x) => x.type === "hour")?.value ?? 16) % 24;
    const m = Number(p.find((x) => x.type === "minute")?.value ?? 0);
    return h * 60 + m;
  })();
  if (minutes >= REGULAR_START && minutes < closeMinutes) return "regular";
  if (minutes >= PREMARKET_START && minutes < REGULAR_START) return "premarket";
  if (minutes >= closeMinutes && minutes < AFTERHOURS_END) return "afterhours";
  return "closed";
}

export interface SessionGuardResult {
  state: GuardState;
  tradingSessionDate: string;
  regularOpenMs: number;
  regularCloseMs: number;
  optionsSessionState: OptionsSessionState;
  subscriberScanAllowed: boolean;
  subscriberDeliveryAllowed: boolean;
  reason: string;
}

function regularOpenMs(day: string): number {
  for (const off of ["-04:00", "-05:00"]) {
    const ms = Date.parse(`${day}T09:30:00${off}`);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.parse(`${day}T09:30:00-05:00`);
}

export function evaluateMarketSessionGuard(nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): SessionGuardResult {
  const day = tradingDay(nowMs);
  const { weekday, minutes } = etClock(nowMs);
  const closeMs = regularCloseMs(day, env);
  const openMs = regularOpenMs(day);
  const optState = optionsSessionState(nowMs, env);
  const closeClock = etClock(closeMs);
  const closeMinutes = closeClock.minutes;
  const minsToClose = Math.round((closeMs - nowMs) / 60000);

  if (weekday === "Sat" || weekday === "Sun") {
    return {
      state: "CLOSED_WEEKEND",
      tradingSessionDate: day,
      regularOpenMs: openMs,
      regularCloseMs: closeMs,
      optionsSessionState: "CLOSED",
      subscriberScanAllowed: false,
      subscriberDeliveryAllowed: false,
      reason: "US market closed — weekend",
    };
  }
  if (isMarketHoliday(day)) {
    return {
      state: "CLOSED_HOLIDAY",
      tradingSessionDate: day,
      regularOpenMs: openMs,
      regularCloseMs: closeMs,
      optionsSessionState: "CLOSED",
      subscriberScanAllowed: false,
      subscriberDeliveryAllowed: false,
      reason: `US market closed — exchange holiday (${day})`,
    };
  }

  const early = isEarlyCloseDay(day, env);
  let state: GuardState = "UNKNOWN_OR_UNSAFE";
  let reason = "";

  if (minutes < PREMARKET_START || minutes >= AFTERHOURS_END) {
    state = "UNKNOWN_OR_UNSAFE";
    reason = "Outside extended hours window";
  } else if (minutes < REGULAR_START) {
    state = "PREMARKET";
    reason = "Pre-market — subscriber options delivery not allowed";
  } else if (optState === "OPENING_DISCOVERY") {
    state = "OPENING_DISCOVERY";
    reason = `Opening discovery window (first ${openingWindowMinutes(env)} min)`;
  } else if (minutes >= closeMinutes) {
    state = "AFTER_HOURS";
    reason = "After-hours — subscriber options delivery not allowed";
  } else if (minsToClose <= CLOSING_WINDOW_MIN && minsToClose > 0) {
    state = "CLOSING_WINDOW";
    reason = `Within ${CLOSING_WINDOW_MIN} minutes of session close`;
  } else if (optState === "POWER_HOUR") {
    state = "POWER_HOUR";
    reason = "Power hour session";
  } else if (baseMarketSession(nowMs, env) === "regular") {
    state = early ? "EARLY_CLOSE" : "REGULAR_SESSION";
    reason = early ? `Early-close session (closes ${earlyCloseMap(env).get(day)} ET)` : "Regular session";
  }

  const deliveryAllowed =
    state === "OPENING_DISCOVERY"
    || state === "REGULAR_SESSION"
    || state === "EARLY_CLOSE"
    || state === "POWER_HOUR";

  const scanAllowed = deliveryAllowed || state === "CLOSING_WINDOW";

  if (env.MARKET_SESSION_GUARD === "0") {
    return {
      state,
      tradingSessionDate: day,
      regularOpenMs: openMs,
      regularCloseMs: closeMs,
      optionsSessionState: optState,
      subscriberScanAllowed: true,
      subscriberDeliveryAllowed: true,
      reason: `${reason} (guard disabled)`,
    };
  }

  if (env.MARKET_SESSION_GUARD === "shadow") {
    return {
      state,
      tradingSessionDate: day,
      regularOpenMs: openMs,
      regularCloseMs: closeMs,
      optionsSessionState: optState,
      subscriberScanAllowed: scanAllowed,
      subscriberDeliveryAllowed: deliveryAllowed,
      reason,
    };
  }

  return {
    state,
    tradingSessionDate: day,
    regularOpenMs: openMs,
    regularCloseMs: closeMs,
    optionsSessionState: optState,
    subscriberScanAllowed: scanAllowed,
    subscriberDeliveryAllowed: deliveryAllowed,
    reason: deliveryAllowed ? reason : `${reason}; subscriber delivery blocked`,
  };
}

/** Fail-closed check for subscriber Discord delivery. */
export function assertSubscriberDeliveryAllowed(nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): { ok: boolean; guard: SessionGuardResult } {
  const guard = evaluateMarketSessionGuard(nowMs, env);
  const mode = String(env.MARKET_SESSION_GUARD ?? "shadow").toLowerCase();
  if (mode === "0" || mode === "shadow") return { ok: true, guard };
  return { ok: guard.subscriberDeliveryAllowed, guard };
}

/** Hard options-session boundary. Unlike rollout/shadow guards, this cannot be bypassed for a live opening. */
export function assertOptionsOpeningSession(nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): { ok: boolean; guard: SessionGuardResult } {
  const guard = evaluateMarketSessionGuard(nowMs, env);
  const ok = guard.state === "OPENING_DISCOVERY"
    || guard.state === "REGULAR_SESSION"
    || guard.state === "EARLY_CLOSE"
    || guard.state === "POWER_HOUR";
  return { ok, guard };
}

/** Hard quote-session boundary for lifecycle marks. Closing-window quotes remain executable. */
export function isOptionsQuoteSession(nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  const state = evaluateMarketSessionGuard(nowMs, env).state;
  return state === "OPENING_DISCOVERY"
    || state === "REGULAR_SESSION"
    || state === "EARLY_CLOSE"
    || state === "POWER_HOUR"
    || state === "CLOSING_WINDOW";
}

/** Fail-closed check for subscriber scanning / READY promotion. */
export function assertSubscriberScanAllowed(nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): { ok: boolean; guard: SessionGuardResult } {
  const guard = evaluateMarketSessionGuard(nowMs, env);
  const mode = String(env.MARKET_SESSION_GUARD ?? "shadow").toLowerCase();
  if (mode === "0" || mode === "shadow") return { ok: true, guard };
  return { ok: guard.subscriberScanAllowed, guard };
}

/** Session date on a candidate must match current session for revival. */
export function isSameTradingSession(candidateSessionDate: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!candidateSessionDate) return false;
  return candidateSessionDate === tradingDay(nowMs);
}
