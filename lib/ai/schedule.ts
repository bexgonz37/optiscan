/**
 * ai/schedule.ts — PURE scheduling predicates for the AI jobs (America/New_York).
 *
 * Nightly runs only AFTER extended-hours finalization (default ≥ 20:15 ET) on a
 * weekday that was not a full-day holiday. Weekly runs Friday night / Saturday.
 * These return the RUN KEY (trading day or ISO week) that is due, or null when it
 * is not yet time. Idempotency (has this key already run?) is enforced by the
 * caller against the ai_reports table, so a key returned here is safe to act on.
 */
import { tradingDay, isMarketHoliday } from "../trading-session.ts";

const etPartsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});

export interface EtParts { weekday: string; hour: number; minute: number; minutes: number; }

/** ET weekday + clock for a timestamp (DST-safe via Intl). */
export function etParts(nowMs: number): EtParts {
  const parts = etPartsFmt.formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { weekday: get("weekday"), hour, minute, minutes: hour * 60 + minute };
}

/** Extended-hours finalization cutoff (minutes since ET midnight). Default 20:15. */
const NIGHTLY_CUTOFF_MIN = 20 * 60 + 15;

/**
 * The trading day the nightly job should report, or null if it is not yet time.
 * Only fires after the extended session has finalized on a real trading weekday.
 */
export function nightlyRunKey(nowMs: number, cutoffMin: number = NIGHTLY_CUTOFF_MIN): string | null {
  const { weekday, minutes } = etParts(nowMs);
  if (weekday === "Sat" || weekday === "Sun") return null;
  const day = tradingDay(nowMs);
  if (isMarketHoliday(day)) return null;
  if (minutes < cutoffMin) return null; // extended hours not finalized yet
  return day;
}

/** ISO-8601 year-week key ("YYYY-Www") for a YYYY-MM-DD date string. */
export function isoWeekKey(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  // ISO week: Thursday-anchored. Work in UTC to avoid TZ drift (date-only math).
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * The next timestamp (ms) at which the nightly window OPENS after the current one —
 * i.e. the next rising edge of `nightlyRunKey`. If a window is open now, this returns
 * the NEXT day's opening (so the dashboard can show "next eligible run" distinct from
 * "due now"). Bounded forward scan in 5-minute steps; null if none within 14 days.
 * PURE. Whether that run actually fires still depends on config + idempotency.
 */
export function nextNightlyEligibleMs(nowMs: number, cutoffMin: number = NIGHTLY_CUTOFF_MIN): number | null {
  const STEP = 5 * 60_000;
  let prevDue = nightlyRunKey(nowMs, cutoffMin) != null;
  for (let t = nowMs + STEP; t <= nowMs + 14 * 24 * 3600_000; t += STEP) {
    const due = nightlyRunKey(t, cutoffMin) != null;
    if (due && !prevDue) return t;
    prevDue = due;
  }
  return null;
}

/** Friday-night cutoff (minutes since ET midnight) for the weekly job. Default 21:00. */
const WEEKLY_FRIDAY_CUTOFF_MIN = 21 * 60;

/**
 * The ISO year-week the weekly proposal job should run for, or null if not yet
 * time. Runs Friday after the cutoff, or any time Saturday (a slack window in case
 * Friday's beat was missed). Sunday is left to the following week.
 */
export function weeklyRunKey(nowMs: number, fridayCutoffMin: number = WEEKLY_FRIDAY_CUTOFF_MIN): string | null {
  const { weekday, minutes } = etParts(nowMs);
  const okFriday = weekday === "Fri" && minutes >= fridayCutoffMin;
  const okSaturday = weekday === "Sat";
  if (!okFriday && !okSaturday) return null;
  return isoWeekKey(tradingDay(nowMs));
}

/** Next rising edge of the weekly window after the current one. PURE; null within 14 days ⇒ null. */
export function nextWeeklyEligibleMs(nowMs: number, fridayCutoffMin: number = WEEKLY_FRIDAY_CUTOFF_MIN): number | null {
  const STEP = 5 * 60_000;
  let prevDue = weeklyRunKey(nowMs, fridayCutoffMin) != null;
  for (let t = nowMs + STEP; t <= nowMs + 14 * 24 * 3600_000; t += STEP) {
    const due = weeklyRunKey(t, fridayCutoffMin) != null;
    if (due && !prevDue) return t;
    prevDue = due;
  }
  return null;
}
