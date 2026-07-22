/**
 * lib/research/options/session-state.ts — explicit intraday session states + the opening-window
 * delivery limiter. PURE. Prevents opening-bell spam WITHOUT a long fixed cooldown: the limit is a
 * rolling window that releases naturally, so a genuinely new later setup is never blocked indefinitely.
 */
export type SessionState = "PREMARKET" | "OPENING_DISCOVERY" | "REGULAR_SESSION" | "POWER_HOUR" | "AFTERHOURS" | "CLOSED";

const PREMARKET_OPEN = 4 * 60;      // 04:00 ET
const REGULAR_OPEN = 9 * 60 + 30;   // 09:30 ET
const REGULAR_CLOSE = 16 * 60;      // 16:00 ET
const POWER_HOUR = 15 * 60;         // 15:00 ET
const AFTERHOURS_END = 20 * 60;     // 20:00 ET

function etMinuteOfDay(nowMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(nowMs)) p[part.type] = part.value;
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}
function isWeekend(nowMs: number): boolean {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(nowMs);
  return wd === "Sat" || wd === "Sun";
}

export function openingWindowMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const x = Number(env.OPTIONS_OPENING_WINDOW_MIN); return Number.isFinite(x) && x > 0 ? x : 30;
}

/** Deterministic session state from the ET clock. Weekends → CLOSED (holidays handled upstream). */
export function sessionState(nowMs: number, env: NodeJS.ProcessEnv = process.env): SessionState {
  if (isWeekend(nowMs)) return "CLOSED";
  const m = etMinuteOfDay(nowMs);
  const openEnd = REGULAR_OPEN + openingWindowMinutes(env);
  if (m < PREMARKET_OPEN) return "CLOSED";
  if (m < REGULAR_OPEN) return "PREMARKET";
  if (m < openEnd) return "OPENING_DISCOVERY";
  if (m < POWER_HOUR) return "REGULAR_SESSION";
  if (m < REGULAR_CLOSE) return "POWER_HOUR";
  if (m < AFTERHOURS_END) return "AFTERHOURS";
  return "CLOSED";
}

export interface OpeningLimitCfg { maxAlerts: number; windowMs: number }
export function defaultOpeningLimit(env: NodeJS.ProcessEnv = process.env): OpeningLimitCfg {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };
  return { maxAlerts: n(env.OPTIONS_OPENING_MAX_ALERTS, 2), windowMs: n(env.OPTIONS_OPENING_WINDOW_MS, 10 * 60_000) };
}

/**
 * Rolling-window opening limiter: allow a delivery only if fewer than `maxAlerts` were already sent in
 * the trailing `windowMs`. This is NOT a fixed cooldown — as soon as older sends age out of the window,
 * the next genuinely-new setup is allowed, so later opportunities are never blocked indefinitely.
 */
export function openingWindowAllows(recentSentMs: number[], nowMs: number, cfg: OpeningLimitCfg = defaultOpeningLimit()): boolean {
  const inWindow = recentSentMs.filter((t) => nowMs - t < cfg.windowMs).length;
  return inWindow < cfg.maxAlerts;
}
