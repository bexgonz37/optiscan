/**
 * US/Eastern trading-session helpers (no SQLite — safe for instrumentation imports).
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
