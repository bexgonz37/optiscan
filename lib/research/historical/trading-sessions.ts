/**
 * trading-sessions.ts — what counts as ONE independent trading session.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 *
 * Every evidence floor in this system is two-dimensional: a minimum number of
 * observations AND a minimum number of independent sessions. The second number is the
 * one that stops twenty events from one frantic afternoon reading as twenty independent
 * confirmations. It is therefore the number most worth attacking, and the attack does
 * not have to be deliberate — it only has to be a date string that is not a trading day.
 *
 * The failure mode is specific and quiet. `sessionDateOf` returns an Eastern CALENDAR
 * date, and a calendar date is not a trading session. A timestamp that lands on a
 * Saturday, on Christmas, or on a stray epoch value produces a well-formed `YYYY-MM-DD`
 * that a `new Set(...).size` will happily count as independent evidence. Nothing
 * downstream can tell the difference, because by then it is just a string.
 *
 * So independence is counted HERE, against a calendar, and a date that is not a trading
 * session is REJECTED and reported rather than dropped silently. A floor that was
 * cleared by a weekend should say so.
 *
 * ── Rule-based, not a hardcoded list ─────────────────────────────────────────
 *
 * The holiday set is computed from the NYSE rules rather than enumerated per year. A
 * hardcoded list is correct until the year it silently runs out, and then it fails in the
 * permissive direction — every date past the end of the table becomes a valid session.
 * Rules do not expire.
 *
 * ── What this CANNOT know ────────────────────────────────────────────────────
 *
 * Unscheduled closures (a day of mourning, a weather halt) are not computable and are not
 * modelled. That gap cannot inflate an independence count: a closed market produces no
 * quotes, no quotes produce no executable entry, and no executable entry produces no
 * event. The dangerous direction is guarded; the uncomputable direction is inert.
 *
 * Half sessions (the 1pm ET closes around Thanksgiving and Christmas) ARE trading
 * sessions and count as one. They are flagged so a reader can see that a session had
 * three and a half hours rather than six and a half.
 */

export const TRADING_SESSION_CALENDAR_VERSION = "US_EQUITY_SESSION_CAL_V1" as const;

/** `YYYY-MM-DD`, the shape `sessionDateOf` produces. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type SessionRejectReason =
  | "MALFORMED_DATE"
  | "WEEKEND"
  | "MARKET_HOLIDAY"
  | "OUT_OF_RANGE";

export interface SessionClassification {
  date: string;
  isTradingSession: boolean;
  /** Set only when `isTradingSession` is false. */
  reason: SessionRejectReason | null;
  /** Holiday name when the date is a scheduled closure, else null. */
  holiday: string | null;
  /** True for a scheduled early close (1pm ET). Still a trading session. */
  halfSession: boolean;
}

/**
 * Plausible epoch range for a session date, as YEARS.
 *
 * A date outside this is not "an old session", it is a corrupt timestamp — a zero epoch
 * renders as 1969/1970 and would otherwise count as a perfectly good independent session.
 */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** Day of week for a `YYYY-MM-DD` civil date. 0 = Sunday. Timezone-free by construction. */
function dayOfWeek(y: number, m: number, d: number): number {
  // Operate in UTC on a date that carries no time, so no zone conversion can shift it.
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Easter Sunday (Gregorian) for a year — the anchor for Good Friday. */
function easterSunday(year: number): { month: number; day: number } {
  // Anonymous Gregorian computus. Exact for all Gregorian years; no floating point.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** The `n`th `weekday` of a month. */
function nthWeekdayOf(year: number, month: number, weekday: number, n: number): number {
  const first = dayOfWeek(year, month, 1);
  const offset = (weekday - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

/** The last `weekday` of a month. */
function lastWeekdayOf(year: number, month: number, weekday: number): number {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = dayOfWeek(year, month, days);
  return days - ((last - weekday + 7) % 7);
}

/**
 * Shift a fixed-date holiday to the day the market actually closes.
 *
 * Saturday closes the preceding Friday, Sunday closes the following Monday. Without this,
 * July 4th 2026 — a Saturday — would leave Friday July 3rd counted as a trading session.
 */
function observedFixed(year: number, month: number, day: number): { month: number; day: number } {
  const dow = dayOfWeek(year, month, day);
  if (dow === 6) {
    // Saturday → observed Friday. Day 1 of a month cannot be a Saturday holiday in this
    // set (Jan 1 is handled by the previous year's Dec 31), so stepping back is safe.
    return day === 1 ? { month: month - 1, day: 31 } : { month, day: day - 1 };
  }
  if (dow === 0) return { month, day: day + 1 };
  return { month, day };
}

const pad = (n: number): string => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

/** Scheduled NYSE full closures for a year, as `YYYY-MM-DD` → name. */
function marketHolidays(year: number): Map<string, string> {
  const out = new Map<string, string>();
  const put = (m: number, d: number, name: string) => {
    const o = observedFixed(year, m, d);
    out.set(iso(year, o.month, o.day), name);
  };

  put(1, 1, "New Year's Day");
  out.set(iso(year, 1, nthWeekdayOf(year, 1, 1, 3)), "Martin Luther King Jr. Day");
  out.set(iso(year, 2, nthWeekdayOf(year, 2, 1, 3)), "Washington's Birthday");

  // Good Friday is the Friday before Easter Sunday. Market holiday, though not federal.
  const easter = easterSunday(year);
  const gf = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  out.set(iso(gf.getUTCFullYear(), gf.getUTCMonth() + 1, gf.getUTCDate()), "Good Friday");

  out.set(iso(year, 5, lastWeekdayOf(year, 5, 1)), "Memorial Day");
  // Juneteenth became an NYSE holiday in 2022. Before that the market was open.
  if (year >= 2022) put(6, 19, "Juneteenth National Independence Day");
  put(7, 4, "Independence Day");
  out.set(iso(year, 9, nthWeekdayOf(year, 9, 1, 1)), "Labor Day");
  out.set(iso(year, 11, nthWeekdayOf(year, 11, 4, 4)), "Thanksgiving Day");
  put(12, 25, "Christmas Day");

  return out;
}

/** Scheduled 1pm ET early closes. These ARE trading sessions. */
function halfSessions(year: number): Set<string> {
  const out = new Set<string>();
  // Day after Thanksgiving.
  const thanksgiving = nthWeekdayOf(year, 11, 4, 4);
  out.add(iso(year, 11, thanksgiving + 1));
  // Christmas Eve, only when it is a weekday and Christmas itself is not observed on it.
  const dow = dayOfWeek(year, 12, 24);
  if (dow >= 1 && dow <= 5) out.add(iso(year, 12, 24));
  // July 3rd when Independence Day falls on a weekday other than Monday.
  const july4 = dayOfWeek(year, 7, 4);
  if (july4 >= 2 && july4 <= 5) out.add(iso(year, 7, 3));
  return out;
}

const holidayCache = new Map<number, Map<string, string>>();
const halfCache = new Map<number, Set<string>>();

function holidaysFor(year: number): Map<string, string> {
  let h = holidayCache.get(year);
  if (!h) { h = marketHolidays(year); holidayCache.set(year, h); }
  return h;
}
function halfFor(year: number): Set<string> {
  let h = halfCache.get(year);
  if (!h) { h = halfSessions(year); halfCache.set(year, h); }
  return h;
}

/** Classify one `YYYY-MM-DD` as a US equity trading session, or say why it is not. */
export function classifySessionDate(date: unknown): SessionClassification {
  const s = typeof date === "string" ? date.trim() : "";
  const base: SessionClassification = {
    date: s, isTradingSession: false, reason: null, holiday: null, halfSession: false,
  };
  if (!DATE_RE.test(s)) return { ...base, reason: "MALFORMED_DATE" };

  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < MIN_YEAR || y > MAX_YEAR || m < 1 || m > 12 || d < 1 || d > 31) {
    return { ...base, reason: "OUT_OF_RANGE" };
  }
  // Reject a date that does not exist (2026-02-30 parses field-wise but is not a day).
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== d) {
    return { ...base, reason: "MALFORMED_DATE" };
  }

  const dow = probe.getUTCDay();
  if (dow === 0 || dow === 6) return { ...base, reason: "WEEKEND" };

  const holiday = holidaysFor(y).get(s);
  if (holiday) return { ...base, reason: "MARKET_HOLIDAY", holiday };

  return { ...base, isTradingSession: true, halfSession: halfFor(y).has(s) };
}

export interface IndependentSessionCount {
  version: typeof TRADING_SESSION_CALENDAR_VERSION;
  /** THE number an evidence floor may use. Distinct, verified trading sessions. */
  independentSessions: number;
  /** The verified session dates, sorted. */
  sessions: string[];
  /** Distinct date strings seen before validation. Never used as a floor input. */
  distinctDatesSeen: number;
  /** Dates that did not survive validation, with the reason each failed. */
  rejected: Array<{ date: string; reason: SessionRejectReason; holiday: string | null }>;
  /** Verified sessions that were scheduled early closes. */
  halfSessions: string[];
  /** Non-empty when validation removed something. Surfaces to the reader, not the log. */
  warnings: string[];
}

/**
 * Count independent trading sessions from a bag of session dates.
 *
 * Deduplicates first, then validates. Returns the rejected dates rather than discarding
 * them, because "your floor of 5 was cleared using a Saturday" is the single most
 * important thing this function can tell anyone.
 */
export function countIndependentSessions(
  dates: ReadonlyArray<string | null | undefined>,
): IndependentSessionCount {
  const distinct = [...new Set(dates.filter((d): d is string => typeof d === "string" && d.trim() !== "").map((d) => d.trim()))];
  const sessions: string[] = [];
  const rejected: IndependentSessionCount["rejected"] = [];
  const half: string[] = [];

  for (const d of distinct.sort()) {
    const c = classifySessionDate(d);
    if (c.isTradingSession) {
      sessions.push(d);
      if (c.halfSession) half.push(d);
    } else {
      rejected.push({ date: d, reason: c.reason as SessionRejectReason, holiday: c.holiday });
    }
  }

  const warnings: string[] = [];
  if (rejected.length) {
    const byReason = new Map<string, number>();
    for (const r of rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    warnings.push(
      `${rejected.length} of ${distinct.length} distinct session dates are NOT trading sessions `
      + `(${[...byReason.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}) and do not count toward independence`,
    );
  }
  if (half.length) {
    warnings.push(`${half.length} session(s) were scheduled early closes (1pm ET): ${half.join(", ")}`);
  }

  return {
    version: TRADING_SESSION_CALENDAR_VERSION,
    independentSessions: sessions.length,
    sessions,
    distinctDatesSeen: distinct.length,
    rejected,
    halfSessions: half,
    warnings,
  };
}

/**
 * Trading sessions between two dates inclusive, for coverage arithmetic.
 *
 * Answers "this range spans N sessions", which is what makes "6 sessions over a 5-day
 * bars window" recognisable as a dataset mismatch rather than a counting bug.
 */
export function tradingSessionsBetween(fromDate: string, toDate: string): string[] {
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate) || fromDate > toDate) return [];
  const out: string[] = [];
  const end = Date.parse(`${toDate}T00:00:00Z`);
  let cur = Date.parse(`${fromDate}T00:00:00Z`);
  if (!Number.isFinite(cur) || !Number.isFinite(end)) return [];
  // Bounded so a bad pair cannot spin: ~55 years of calendar days.
  for (let guard = 0; cur <= end && guard < 20_000; guard += 1) {
    const d = new Date(cur);
    const s = iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    if (classifySessionDate(s).isTradingSession) out.push(s);
    cur += 86_400_000;
  }
  return out;
}
