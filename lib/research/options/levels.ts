/**
 * lib/research/options/levels.ts — derive DECISION-TIME levels from the 1-minute bars the monitor
 * already fetches (no extra provider call, no new latency). Wiring these levels is what lets the
 * EARLY, pre-breakout strategies actually fire — breakout_proximity, compression_near_level,
 * opening_range_development, premarket_level_testing, sr_reclaim, and gap behavior — instead of only
 * the momentum/acceleration strategies that key on a move already in progress.
 *
 * PURE. No I/O. Never fabricates: a level with no supporting bars is null (the feature engine already
 * degrades gracefully on null). All time-of-day logic is ET (US options session), DST-aware via a
 * single offset computed from nowMs and applied arithmetically to the compact bar window.
 */
import type { Bar } from "./features.ts";

export interface DecisionLevels {
  prevClose: number | null;
  prevDayHigh: number | null; prevDayLow: number | null;
  premarketHigh: number | null; premarketLow: number | null;
  openingRangeHigh: number | null; openingRangeLow: number | null;
}

const REGULAR_OPEN_MIN = 9 * 60 + 30;   // 09:30 ET
const PREMARKET_OPEN_MIN = 4 * 60;      // 04:00 ET
const DEFAULT_OR_MINUTES = 15;          // opening-range window length

/** ET wall-clock offset (ms) for a timestamp, computed once and applied to the whole bar window. */
function etOffsetMs(t: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(t)) p[part.type] = part.value;
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUTC - t;
}
const pad = (n: number) => String(n).padStart(2, "0");
function etDayMin(t: number, offsetMs: number): { day: string; min: number } {
  const d = new Date(t + offsetMs);
  return { day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/**
 * Derive prev-day, premarket, and opening-range levels from a compact 1-minute bar window (ideally ~2
 * ET days incl. extended hours). Only bars at or before nowMs are used (no look-ahead).
 */
export function deriveDecisionLevels(barsIn: Bar[], nowMs: number, orMinutes: number = DEFAULT_OR_MINUTES): DecisionLevels {
  const empty: DecisionLevels = { prevClose: null, prevDayHigh: null, prevDayLow: null, premarketHigh: null, premarketLow: null, openingRangeHigh: null, openingRangeLow: null };
  const bars = barsIn.filter((b) => b.t <= nowMs && Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c)).sort((a, b) => a.t - b.t);
  if (bars.length === 0) return empty;

  const offsetMs = etOffsetMs(nowMs);
  const todayDay = etDayMin(nowMs, offsetMs).day;

  const prevDayBars: Bar[] = [];
  const premarketToday: Bar[] = [];
  const orToday: Bar[] = [];
  let prevDay: string | null = null;
  for (const b of bars) {
    const { day } = etDayMin(b.t, offsetMs);
    if (day < todayDay) { if (prevDay == null || day > prevDay) prevDay = day; }
  }
  for (const b of bars) {
    const { day, min } = etDayMin(b.t, offsetMs);
    if (prevDay != null && day === prevDay) prevDayBars.push(b);
    else if (day === todayDay) {
      if (min >= PREMARKET_OPEN_MIN && min < REGULAR_OPEN_MIN) premarketToday.push(b);
      if (min >= REGULAR_OPEN_MIN && min < REGULAR_OPEN_MIN + orMinutes) orToday.push(b);
    }
  }

  const hi = (xs: Bar[]) => (xs.length ? Math.max(...xs.map((b) => b.h)) : null);
  const lo = (xs: Bar[]) => (xs.length ? Math.min(...xs.map((b) => b.l)) : null);
  return {
    prevClose: prevDayBars.length ? prevDayBars[prevDayBars.length - 1].c : null,
    prevDayHigh: hi(prevDayBars), prevDayLow: lo(prevDayBars),
    premarketHigh: hi(premarketToday), premarketLow: lo(premarketToday),
    openingRangeHigh: hi(orToday), openingRangeLow: lo(orToday),
  };
}
