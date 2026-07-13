import { DEFAULT_SUPERVISOR_CORE_TICKERS, parseTickerList } from "./supervisor-universe.ts";

/**
 * universe.js — the default set of symbols OptiScan scans.
 *
 * Override without touching code via env:
 *   SCAN_UNIVERSE="AAPL,MSFT,NVDA,..."   (comma/space separated — replaces list)
 *   SCAN_UNIVERSE_EXTRA="TICK1,TICK2"    (append to the default list)
 *
 * Kept deliberately liquid — thin names produce noisy momentum + bad option
 * spreads.
 */

export const LIQUID_ETFS = [
  "SPY", "QQQ", "IWM", "DIA", "VTI", "VOO", "MDY", "RSP",
  "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC",
  "SMH", "SOXX", "XBI", "IBB", "ARKK", "XOP", "XME", "XRT", "KRE", "KWEB", "FXI",
  "GLD", "SLV", "USO", "UNG", "TLT", "HYG", "GDX", "GDXJ",
  "TQQQ", "SQQQ", "SOXL", "SOXS", "SPXL", "SPXS", "TNA", "TZA", "UVXY", "VXX",
];

export const MEGA_LARGE_CAPS = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "AMZN", "META", "TSLA", "AVGO", "BRK.B",
  "LLY", "JPM", "V", "MA", "UNH", "XOM", "COST", "HD", "PG", "JNJ",
  "ABBV", "NFLX", "CRM", "BAC", "WMT", "KO", "PEP", "MRK", "AMD", "ADBE",
  "ORCL", "CSCO", "ACN", "MCD", "DIS", "WFC", "TMO", "ABT", "INTC", "QCOM",
  "TXN", "IBM", "GE", "CAT", "NOW", "INTU", "AMAT", "MU", "LRCX", "KLAC",
  "PANW", "SNPS", "CDNS", "ANET", "MRVL", "DELL", "SMCI", "ARM", "PLTR", "CRWD",
  "GS", "MS", "AXP", "BLK", "SCHW", "C", "SPGI", "BX", "PYPL", "SQ",
  "BA", "HON", "UNP", "LMT", "RTX", "DE", "UPS", "FDX", "GM", "F",
  "NKE", "SBUX", "LOW", "TGT", "BKNG", "MAR", "ABNB", "UBER", "LYFT", "DASH",
  "PFE", "BMY", "AMGN", "GILD", "CVS", "MDT", "ISRG", "VRTX", "REGN", "MRNA",
  "CVX", "COP", "SLB", "EOG", "OXY", "PSX", "MPC", "VLO", "WMB", "KMI",
  "T", "VZ", "TMUS", "CMCSA", "CHTR",
];

export const MOMENTUM_NAMES = [
  "COIN", "MSTR", "HOOD", "SOFI", "RIVN", "LCID", "NIO", "XPEV", "LI", "BABA",
  "PDD", "JD", "SHOP", "SNAP", "PINS", "RBLX", "U", "NET", "DDOG", "SNOW",
  "ZS", "MDB", "OKTA", "TTD", "ROKU", "DOCU", "TWLO", "AFRM", "UPST", "DKNG",
  "CVNA", "CHWY", "ETSY", "W", "PLUG", "FCEL", "RUN", "ENPH", "FSLR", "SEDG",
  "AI", "PATH", "IONQ", "RGTI", "SOUN", "BBAI", "TSM", "ASML", "MPWR", "ON",
  "WDC", "STX", "GME", "AMC", "BB", "DNA", "RKLB", "ACHR", "JOBY", "LUNR",
  "TLRY", "CGC", "RIOT", "MARA", "CLSK", "HUT", "BITF", "WULF", "APP", "HIMS",
  "CELH", "ELF", "DUOL", "TOST", "GTLB", "S", "FUBO", "DJT", "SMR", "OKLO", "SPCX",
];

/** Deduplicated default universe. */
export const DEFAULT_UNIVERSE = Array.from(
  new Set([...LIQUID_ETFS, ...MEGA_LARGE_CAPS, ...MOMENTUM_NAMES]),
);

function splitList(str) {
  return String(str || "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Resolve the scan universe from env, falling back to the default list.
 * SCAN_UNIVERSE replaces the list; SCAN_UNIVERSE_EXTRA appends to the default.
 */
export function getScanUniverse(env = process.env) {
  const override = splitList(env.SCAN_UNIVERSE);
  const extra = splitList(env.SCAN_UNIVERSE_EXTRA);
  const base = override.length ? override : DEFAULT_UNIVERSE;
  return Array.from(new Set([...base, ...extra]));
}

/**
 * ZERO_DTE_UNIVERSE — tickers the every-second 0DTE loop watches.
 * True daily 0DTE lives on the index complex; the single names here have deep
 * weekly chains (0DTE on Fridays). Keep this list SMALL: one bulk snapshot
 * call covers all of it every second. Override: SCANNER_0DTE_UNIVERSE env.
 */
export const ZERO_DTE_UNIVERSE = [
  "SPY", "QQQ", "IWM", "DIA", "TQQQ", "SQQQ", "SOXL", "SOXS", "SPXL", "SPXS", "UVXY", "VXX",
  "TSLA", "NVDA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "AMD", "AVGO", "NFLX",
  "COIN", "MSTR", "PLTR", "HOOD", "SMCI", "ARM", "MU", "MARA", "RIOT", "GME", "AMC", "RDDT",
];

export function getZeroDteUniverse(env = process.env) {
  const override = String(env.SCANNER_0DTE_UNIVERSE || "").split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const extra = String(env.SCANNER_0DTE_UNIVERSE_EXTRA || "").split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  // Core Watch names ride along by default so the default UI is never empty;
  // an explicit SCANNER_0DTE_UNIVERSE override is respected verbatim.
  const base = override.length ? override : [...ZERO_DTE_UNIVERSE, ...getCoreWatchUniverse(env)];
  return Array.from(new Set([...base, ...extra]));
}

/**
 * CORE_WATCH — the default UI universe: the user's core names + liquid mega
 * caps with real 0DTE/weekly chains. These always show WATCH CALL/PUT with
 * near-ATM strikes when the tape is moving; TRADE fires on them when the full
 * gates pass. Extended-universe (discovery) names only surface when a signal
 * is high-confidence enough to pass the full TRADE gates — no clutter.
 * Override: SCANNER_CORE_WATCH env (comma/space separated).
 */
export const CORE_WATCH = [
  "AAPL", "NVDA", "META", "TSLA", "AMZN", "MSFT", "SPY", "QQQ", "HOOD", "SPCX",
  "GOOGL", "AMD", "AVGO", "NFLX", "COIN", "MSTR", "PLTR", "SMCI",
];

export function getOwnerCoreUniverse(env = process.env) {
  return parseTickerList(env.OWNER_CORE_TICKERS ?? env.SUPERVISOR_CORE_TICKERS ?? DEFAULT_SUPERVISOR_CORE_TICKERS);
}

export function getCoreWatchUniverse(env = process.env) {
  const override = String(env.SCANNER_CORE_WATCH || "").split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const ownerCore = getOwnerCoreUniverse(env);
  return override.length ? Array.from(new Set([...ownerCore, ...override])) : Array.from(new Set([...ownerCore, ...CORE_WATCH]));
}

const coreSetCache = { key: "", set: new Set() };
export function isCoreSymbol(symbol, env = process.env) {
  const list = getOwnerCoreUniverse(env);
  const key = list.join(",");
  if (coreSetCache.key !== key) {
    coreSetCache.key = key;
    coreSetCache.set = new Set(list);
  }
  return coreSetCache.set.has(String(symbol ?? "").toUpperCase());
}

/** Slower discovery pool. Top movers are temporarily promoted into the 1s loop. */
export function getZeroDteDiscoveryUniverse(env = process.env) {
  const override = String(env.SCANNER_DISCOVERY_UNIVERSE || "").split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  return override.length ? Array.from(new Set(override)) : DEFAULT_UNIVERSE;
}
