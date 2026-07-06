/**
 * US/Eastern trading-session helpers (no SQLite — safe for instrumentation
 * imports). Also home of the market-session engine for the stocks/options router.
 */
const etDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/** YYYY-MM-DD in US/Eastern for a timestamp — the "trading day" key. */
export function tradingDay(ms: number = Date.now()): string {
  return etDayFmt.format(new Date(ms));
}

/** Epoch ms of 16:00 US/Eastern on a YYYY-MM-DD trading day (DST-safe). */
export function etCloseMs(day: string): number {
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false });
  for (const off of ["-04:00", "-05:00"]) {
    const ms = Date.parse(`${day}T16:00:00${off}`);
    if (Number.isFinite(ms) && hourFmt.format(new Date(ms)) === "16") return ms;
  }
  return Date.parse(`${day}T16:00:00-05:00`);
}

/** Minutes until today's 16:00 ET close (negative = after close). */
export function minutesToClose(nowMs: number = Date.now()): number {
  return Math.round((etCloseMs(tradingDay(nowMs)) - nowMs) / 60000);
}

// ---------------------------------------------------------------------------
// Market sessions — drives the capture router:
//   premarket / afterhours -> regular-stock callouts (no option chains)
//   regular                -> 0DTE options callouts (existing system)
//   closed                 -> no new callouts (tracker still finishes open ones)
// ---------------------------------------------------------------------------

export type MarketSession = "premarket" | "regular" | "afterhours" | "closed";

const etClockFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});

/** ET weekday + minutes-since-midnight for a timestamp (DST-safe via Intl). */
function etClock(nowMs: number): { weekday: string; minutes: number } {
  const parts = etClockFmt.formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24; // Intl can emit "24" at midnight
  return { weekday: get("weekday"), minutes: hour * 60 + Number(get("minute")) };
}

const PREMARKET_START = 4 * 60;        // 04:00 ET
const REGULAR_START = 9 * 60 + 30;     // 09:30 ET
const REGULAR_END = 16 * 60;           // 16:00 ET
const AFTERHOURS_END = 20 * 60;        // 20:00 ET

/**
 * Which US-equity session a timestamp falls in (US/Eastern, DST-safe).
 * Weekends are 'closed'. Exchange holidays are NOT modeled — on a holiday the
 * tape is flat so nothing triggers, which is the safe failure mode.
 */
export function marketSession(nowMs: number = Date.now()): MarketSession {
  const { weekday, minutes } = etClock(nowMs);
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  if (minutes >= REGULAR_START && minutes < REGULAR_END) return "regular";
  if (minutes >= PREMARKET_START && minutes < REGULAR_START) return "premarket";
  if (minutes >= REGULAR_END && minutes < AFTERHOURS_END) return "afterhours";
  return "closed";
}

/** 0DTE options callouts only fire during regular hours (spreads + theta). */
export function isOptionsSession(nowMs: number = Date.now()): boolean {
  return marketSession(nowMs) === "regular";
}

/** Regular-stock callouts fire in extended hours (news + volume moves). */
export function isStockSession(nowMs: number = Date.now()): boolean {
  const s = marketSession(nowMs);
  return s === "premarket" || s === "afterhours";
}
