/**
 * Instrument-aware US options session authority.
 *
 * The scanner currently trades equity/ETF OCC contracts, but delivery and
 * grading boundaries also need to classify extended-hours index products
 * truthfully. Unknown roots fail closed. Strategy eligibility remains a
 * separate decision: an open extended session does not make a regular-session
 * strategy actionable.
 */
import { isMarketHoliday, tradingDay } from "./trading-session.ts";
import { regularCloseMs } from "./market-session-guard.ts";

export type UnderlyingSessionState =
  | "UNDERLYING_RTH_OPEN"
  | "UNDERLYING_EXTENDED_HOURS"
  | "UNDERLYING_CLOSED"
  | "SESSION_UNKNOWN";

export type OptionsInstrumentSessionState =
  | "OPTIONS_REGULAR_OPEN"
  | "OPTIONS_EXTENDED_SESSION_OPEN"
  | "OPTIONS_CLOSED"
  | "SESSION_UNKNOWN";

export type OptionsInstrumentClass =
  | "EQUITY_OPTION"
  | "ETF_415_OPTION"
  | "INDEX_GTH_OPTION"
  | "UNKNOWN";

export interface InstrumentSessionInput {
  symbol?: string | null;
  optionSymbol?: string | null;
  expiration?: string | null;
}

export interface InstrumentSessionResult {
  symbol: string | null;
  optionRoot: string | null;
  expiration: string | null;
  instrumentClass: OptionsInstrumentClass;
  underlyingState: UnderlyingSessionState;
  optionsState: OptionsInstrumentSessionState;
  tradingSessionDate: string;
  reason: string;
}

// Nasdaq's published 4:15 ET classes. Keep this explicit: treating every ETF
// as a 4:15 product would be less safe than closing an unknown class early.
export const ETF_OPTION_ROOTS_415 = Object.freeze(new Set([
  "DBA", "DBB", "DBC", "DBO", "DIA", "EEM", "EFA", "EWZ", "FXI", "GLD",
  "HYG", "IEF", "IWM", "IWN", "IWO", "IYR", "KBE", "KWEB", "KRE", "LQD",
  "MDY", "MOO", "OEF", "QQQ", "RSP", "SLV", "SMH", "SOXL", "SOXX", "SPY",
  "SVIX", "SVXY", "TLT", "UNG", "UUP", "UVIX", "UVXY", "VIXM", "VIXY",
  "VXX", "VXZ", "XHB", "XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP",
  "XLRE", "XLU", "XLV", "XLY", "XME", "XND", "XRT",
]));

// Cboe Rule 5.1 GTH classes approved as of 2026-08-04. The application does
// not currently scan these roots; classifying them here prevents a future
// caller from silently inheriting equity-option hours.
export const INDEX_OPTION_ROOTS_GTH = Object.freeze(new Set([
  "SPX", "SPXW", "XSP", "VIX", "RUT", "MRUT", "MGTN", "CBTX", "MBTX",
]));

const OCC_RE = /^(?:O:)?([A-Z]{1,6})(\d{2})(\d{2})(\d{2})[CP]\d{8}$/;
const etFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function etParts(nowMs: number): { day: string; weekday: string; minutes: number } {
  const p = Object.fromEntries(
    etFmt.formatToParts(new Date(nowMs))
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, x.value]),
  );
  const hour = Number(p.hour) % 24;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    minutes: hour * 60 + Number(p.minute),
  };
}

function occFacts(raw: string | null | undefined): { root: string | null; expiration: string | null } {
  const m = OCC_RE.exec(String(raw ?? "").trim().toUpperCase());
  if (!m) return { root: null, expiration: null };
  return { root: m[1], expiration: `20${m[2]}-${m[3]}-${m[4]}` };
}

function closeMinutes(day: string, env: NodeJS.ProcessEnv): number {
  const p = etParts(regularCloseMs(day, env));
  return p.minutes;
}

function nextIsoDay(day: string): string {
  const ms = Date.parse(`${day}T12:00:00Z`);
  return new Date(ms + 86_400_000).toISOString().slice(0, 10);
}

function isOpenTradingDay(day: string, weekday: string): boolean {
  return weekday !== "Sat" && weekday !== "Sun" && !isMarketHoliday(day);
}

function underlyingState(nowMs: number, env: NodeJS.ProcessEnv): UnderlyingSessionState {
  const et = etParts(nowMs);
  if (!isOpenTradingDay(et.day, et.weekday)) return "UNDERLYING_CLOSED";
  const close = closeMinutes(et.day, env);
  if (et.minutes >= 9 * 60 + 30 && et.minutes < close) return "UNDERLYING_RTH_OPEN";
  if (et.minutes >= 4 * 60 && et.minutes < 20 * 60) return "UNDERLYING_EXTENDED_HOURS";
  return "UNDERLYING_CLOSED";
}

function indexGthOpen(et: ReturnType<typeof etParts>): boolean {
  if (et.minutes < 9 * 60 + 25) return isOpenTradingDay(et.day, et.weekday);
  if (et.minutes < 20 * 60 + 15) return false;
  if (!["Sun", "Mon", "Tue", "Wed", "Thu"].includes(et.weekday)) return false;
  return !isMarketHoliday(nextIsoDay(et.day));
}

export function classifyOptionsInstrument(input: InstrumentSessionInput): {
  symbol: string | null;
  optionRoot: string | null;
  expiration: string | null;
  instrumentClass: OptionsInstrumentClass;
} {
  const parsed = occFacts(input.optionSymbol);
  const symbol = String(input.symbol ?? parsed.root ?? "").trim().toUpperCase() || null;
  const root = parsed.root ?? symbol;
  const expiration = input.expiration ?? parsed.expiration;
  if (!root) return { symbol, optionRoot: null, expiration, instrumentClass: "UNKNOWN" };
  if (INDEX_OPTION_ROOTS_GTH.has(root)) return { symbol, optionRoot: root, expiration, instrumentClass: "INDEX_GTH_OPTION" };
  if (ETF_OPTION_ROOTS_415.has(root)) return { symbol, optionRoot: root, expiration, instrumentClass: "ETF_415_OPTION" };
  if (/^[A-Z][A-Z0-9.]{0,9}$/.test(root)) return { symbol, optionRoot: root, expiration, instrumentClass: "EQUITY_OPTION" };
  return { symbol, optionRoot: root, expiration, instrumentClass: "UNKNOWN" };
}

export function evaluateInstrumentSession(
  input: InstrumentSessionInput,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): InstrumentSessionResult {
  const facts = classifyOptionsInstrument(input);
  const et = etParts(nowMs);
  const base = {
    ...facts,
    underlyingState: underlyingState(nowMs, env),
    tradingSessionDate: tradingDay(nowMs),
  };
  if (facts.instrumentClass === "UNKNOWN") {
    return { ...base, underlyingState: "SESSION_UNKNOWN", optionsState: "SESSION_UNKNOWN", reason: "Instrument class is unknown." };
  }
  if (!isOpenTradingDay(et.day, et.weekday)) {
    if (facts.instrumentClass === "INDEX_GTH_OPTION" && indexGthOpen(et)) {
      return { ...base, optionsState: "OPTIONS_EXTENDED_SESSION_OPEN", reason: "Cboe index Global Trading Hours are open." };
    }
    return { ...base, optionsState: "OPTIONS_CLOSED", reason: "Options market is closed for the trading day." };
  }

  const open = 9 * 60 + 30;
  const ordinaryClose = closeMinutes(et.day, env);
  if (facts.instrumentClass === "INDEX_GTH_OPTION") {
    // Expiring PM-settled index weeklies stop at the underlying close. Failing
    // closed here avoids treating a stale 0DTE quote as a curb-session market.
    const expiresToday = facts.expiration === et.day;
    if (et.minutes >= open && et.minutes < (expiresToday ? ordinaryClose : ordinaryClose + 15)) {
      return { ...base, optionsState: "OPTIONS_REGULAR_OPEN", reason: "Index option regular session is open." };
    }
    if (!expiresToday && et.minutes >= ordinaryClose + 15 && et.minutes < 17 * 60) {
      return { ...base, optionsState: "OPTIONS_EXTENDED_SESSION_OPEN", reason: "Cboe index curb session is open." };
    }
    if (indexGthOpen(et)) {
      return { ...base, optionsState: "OPTIONS_EXTENDED_SESSION_OPEN", reason: "Cboe index Global Trading Hours are open." };
    }
    return { ...base, optionsState: "OPTIONS_CLOSED", reason: "Index options session is closed." };
  }

  const close = facts.instrumentClass === "ETF_415_OPTION" ? ordinaryClose + 15 : ordinaryClose;
  if (et.minutes >= open && et.minutes < ordinaryClose) {
    return { ...base, optionsState: "OPTIONS_REGULAR_OPEN", reason: "Regular options session is open." };
  }
  if (et.minutes >= ordinaryClose && et.minutes < close) {
    return { ...base, optionsState: "OPTIONS_EXTENDED_SESSION_OPEN", reason: "Designated 4:15 ET option class remains open." };
  }
  return { ...base, optionsState: "OPTIONS_CLOSED", reason: "Applicable options session is closed." };
}

export function optionsSessionAllowsStrategy(
  session: InstrumentSessionResult,
  strategySessions: readonly string[] = ["regular"],
): boolean {
  if (session.optionsState === "OPTIONS_REGULAR_OPEN") return strategySessions.includes("regular");
  if (session.optionsState === "OPTIONS_EXTENDED_SESSION_OPEN") return strategySessions.includes("extended");
  return false;
}

export const OPTIONS_CLOSED_OWNER_LANGUAGE =
  "UNDERLYING MOVE ONLY - The options market is closed. The referenced option does not have a fresh executable quote, so this is not a live options entry.";
