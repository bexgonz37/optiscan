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

// ── Exchange holidays (audit P1-7/T9) ───────────────────────────────────────
// Full-day NYSE/Nasdaq closures. On these days marketSession() returns
// "closed" so the recap throttle applies, the UI shows the truth, and no
// intraday assumptions run against a flat tape. Half-days (early 13:00
// closes) are NOT modeled — the safe failure mode is a quiet afternoon.
// Extend without a deploy via MARKET_HOLIDAYS=YYYY-MM-DD,YYYY-MM-DD.
const DEFAULT_MARKET_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  // 2026 (Jul 4 falls Saturday -> observed Fri Jul 3)
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027 (Jun 19 Sat -> Fri Jun 18; Jul 4 Sun -> Mon Jul 5; Dec 25 Sat -> Fri Dec 24)
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

/** Full-day US market holiday for a YYYY-MM-DD ET trading day. */
export function isMarketHoliday(day: string): boolean {
  if (DEFAULT_MARKET_HOLIDAYS.has(day)) return true;
  const extra = process.env.MARKET_HOLIDAYS;
  if (!extra) return false;
  return extra.split(",").map((s) => s.trim()).includes(day);
}

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
 * Weekends and full-day exchange holidays are 'closed'; half-days are not
 * modeled (flat afternoon tape = safe failure mode).
 */
export function marketSession(nowMs: number = Date.now()): MarketSession {
  const { weekday, minutes } = etClock(nowMs);
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  if (isMarketHoliday(tradingDay(nowMs))) return "closed";
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
