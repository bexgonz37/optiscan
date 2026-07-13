/**
 * owner-settings.ts — owner-facing controls for signal quality + Discord alerting.
 * PURE (env-driven, no I/O), so every consumer reads the same resolved config and
 * it is trivially unit-testable. Nothing here changes trading math, risk gates,
 * freshness, or contract selection — it only governs WHICH already-valid ideas the
 * portfolio layer ranks and how many reach Discord.
 *
 * All settings are configurable without code changes (Railway variables).
 */

/** Professional-desk core universe: the names that always get first-class ranking. */
export const DEFAULT_CORE_UNIVERSE = [
  "SPY", "QQQ", "NVDA", "META", "AAPL", "MSFT",
  "AMD", "AMZN", "TSLA", "GOOGL", "AVGO", "NFLX",
];

export type AlertCategory = "options" | "stocks" | "puts";

export interface OwnerSettings {
  /** Priority names that receive first-class ranking attention. */
  coreUniverse: string[];
  /** Extra owner-preferred names (added to core priority, deduped). */
  preferredTickers: string[];
  /** Max canonical opportunities allowed to reach Discord per cycle. */
  maxDiscordAlerts: number;
  /** Minimum setup quality (0–100) an idea needs before it can be alerted. */
  minSetupQuality: number;
  /** Whether bullish actionable ideas may alert. */
  bullishEnabled: boolean;
  /** Whether bearish actionable ideas may alert (mirrors BEARISH_ACTIONABLE). */
  bearishEnabled: boolean;
  /** Whether early-stage (DEVELOPING/NEAR_TRIGGER) ideas may alert. */
  earlyAlertsEnabled: boolean;
  /** Which alert categories are allowed to reach Discord. */
  categories: Set<AlertCategory>;
}

function splitTickers(raw: string | undefined | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of String(raw ?? "").split(/[\s,]+/)) {
    const s = t.trim().toUpperCase();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** Resolve all owner settings from env (safe production defaults). */
export function ownerSettings(env: NodeJS.ProcessEnv = process.env): OwnerSettings {
  const core = splitTickers(env.OWNER_CORE_TICKERS);
  const preferred = splitTickers(env.OWNER_PREFERRED_TICKERS);
  const catRaw = splitTickers(env.OWNER_ALERT_CATEGORIES).map((c) => c.toLowerCase());
  const categories = new Set<AlertCategory>(
    (catRaw.length ? catRaw : ["options", "stocks", "puts"]).filter(
      (c): c is AlertCategory => c === "options" || c === "stocks" || c === "puts",
    ),
  );
  return {
    coreUniverse: core.length ? core : DEFAULT_CORE_UNIVERSE,
    preferredTickers: preferred,
    // Cap defaults to 5 strong alerts/cycle — "fewer, higher quality".
    maxDiscordAlerts: clampInt(env.SUPERVISOR_MAX_DISCORD_ALERTS, 1, 50, 5),
    minSetupQuality: clampInt(env.MIN_SETUP_QUALITY, 0, 100, 0),
    // Bullish on by default; bearish reuses the existing BEARISH_ACTIONABLE flag.
    bullishEnabled: env.BULLISH_ENABLED !== "0",
    bearishEnabled: env.BEARISH_ACTIONABLE === "1",
    // Early alerts (DEVELOPING/NEAR_TRIGGER to Discord) are opt-in; default off so
    // the desk sees confirmed entries first.
    earlyAlertsEnabled: env.EARLY_ALERTS_ENABLED === "1",
    categories,
  };
}

/** Whether share/stock callouts are allowed to reach Discord (owner opt-in). */
export function stockAlertsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STOCK_CALLOUTS === "1";
}

/**
 * The exact, owner-readable reason stock alerts are not sending, or null when
 * they can. This makes the "options arrive but stock alerts don't" case
 * diagnosable without reading logs — the gate is a config opt-in, not a bug.
 */
export function stockAlertGateReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!stockAlertsEnabled(env)) {
    return "Stock (share) callouts are OFF: set STOCK_CALLOUTS=1 in Railway to send them to the stocks webhook. Options callouts use a separate path and are unaffected.";
  }
  return null;
}

/** True when a ticker is in the priority set (core universe ∪ preferred). */
export function isPriorityTicker(ticker: string, s: OwnerSettings): boolean {
  const t = String(ticker ?? "").toUpperCase();
  return s.coreUniverse.includes(t) || s.preferredTickers.includes(t);
}

/**
 * Priority rank for a ticker: 0 = highest (core, in listed order), then preferred,
 * then a large constant for everything else. Lower is stronger.
 */
export function tickerPriorityRank(ticker: string, s: OwnerSettings): number {
  const t = String(ticker ?? "").toUpperCase();
  const ci = s.coreUniverse.indexOf(t);
  if (ci >= 0) return ci;
  const pi = s.preferredTickers.indexOf(t);
  if (pi >= 0) return s.coreUniverse.length + pi;
  return 10_000;
}
