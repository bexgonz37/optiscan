/**
 * lib/research/discovery/earnings.ts — EARNINGS discovery source (shadow-only). PURE classifier.
 *
 * Takes an earnings-calendar row + a decision-time snapshot and classifies the candidate; it does
 * NOT fetch. A real earnings-timing feed is NOT wired server-side today (see the audit), so this is
 * inert until a calendar provider supplies rows — but the classification, confirmed-vs-estimated
 * timing, and the STALE-DATE guard are testable now. Nothing here is actionable; puts stay
 * RESEARCH_ONLY; no alert is created.
 */
import { classifyEligibility, defaultEligibilityConfig, type EligibilityConfig } from "./eligibility.ts";

export type EarningsSession = "bmo" | "amc" | "during" | "unknown";
export type EarningsCategory = "earnings_today" | "earnings_bmo" | "earnings_amc" | "earnings_upcoming" | "post_earnings" | "earnings_gap" | "abnormal_premarket_vol";

export interface EarningsCalendarRow {
  symbol: string;
  expectedAtMs: number | null;     // provider's expected report time
  session: EarningsSession;
  confirmed: boolean;              // provider says the date/time is CONFIRMED (vs estimated)
  provenance: string;              // e.g. "provider:zacks", "provider:polygon", "estimate"
}
export interface EarningsSnapshot {
  price: number | null;
  prevClose: number | null;
  dayDollarVolume: number | null;
  relVolume: number | null;        // vs normal
  gapPct: number | null;           // premarket/open gap from prev close
  optionsAvailable: boolean;
  halted?: boolean;
  lastTradeAgeMs?: number | null;
  securityType?: string | null;
}

export interface EarningsConfig {
  upcomingWindowHours: number;     // "upcoming earnings within a configurable window"
  postEarningsWindowHours: number; // how long after the report a name is a post-earnings candidate
  gapPctThreshold: number;         // |gap| that flags an earnings gap
  abnormalRelVol: number;          // relVol that flags abnormal premarket volume
  maxStaleHours: number;           // a date this far in the past that is still "upcoming" is stale
}
export function defaultEarningsConfig(env: NodeJS.ProcessEnv = process.env): EarningsConfig {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  return { upcomingWindowHours: n(env.EARNINGS_UPCOMING_HOURS, 72), postEarningsWindowHours: n(env.EARNINGS_POST_HOURS, 48), gapPctThreshold: n(env.EARNINGS_GAP_PCT, 4), abnormalRelVol: n(env.EARNINGS_ABNORMAL_RELVOL, 3), maxStaleHours: n(env.EARNINGS_MAX_STALE_HOURS, 12) };
}

export interface EarningsCandidate {
  symbol: string;
  categories: EarningsCategory[];
  expectedAtMs: number | null;
  session: EarningsSession;
  timingConfirmed: boolean;
  provenance: string;
  hoursUntil: number | null;       // negative = already reported
  gapPct: number | null;
  relVolume: number | null;
  optionsAvailable: boolean;
  eligible: boolean;               // underlying eligibility (liquidity/price/type/stale)
  exclusions: string[];
  rejectionReason: string | null;  // set when the row itself is unusable (stale/incorrect date, no timing)
}

/** Classify one earnings row + snapshot. Rejects stale/incorrect dates so they can never be trusted. */
export function classifyEarningsCandidate(row: EarningsCalendarRow, snap: EarningsSnapshot, nowMs: number, cfg: EarningsConfig = defaultEarningsConfig(), eligCfg: EligibilityConfig = defaultEligibilityConfig()): EarningsCandidate {
  const hoursUntil = row.expectedAtMs != null ? +(((row.expectedAtMs - nowMs) / 3_600_000)).toFixed(2) : null;
  let rejectionReason: string | null = null;
  if (row.expectedAtMs == null) rejectionReason = "no earnings timing";
  else if (hoursUntil != null && hoursUntil < -cfg.postEarningsWindowHours && row.confirmed === false) {
    rejectionReason = "stale/estimated earnings date (past the post-earnings window and unconfirmed)";
  } else if (hoursUntil != null && hoursUntil < -cfg.maxStaleHours && hoursUntil >= -cfg.postEarningsWindowHours && !row.confirmed) {
    rejectionReason = "unconfirmed earnings date appears stale — do not treat as upcoming";
  }

  const categories: EarningsCategory[] = [];
  if (hoursUntil != null && !rejectionReason) {
    const isToday = hoursUntil >= -6 && hoursUntil <= 18; // same trading day-ish
    if (isToday) categories.push("earnings_today");
    if (row.session === "bmo" && hoursUntil >= -2 && hoursUntil <= cfg.upcomingWindowHours) categories.push("earnings_bmo");
    if (row.session === "amc" && hoursUntil >= -2 && hoursUntil <= cfg.upcomingWindowHours) categories.push("earnings_amc");
    if (hoursUntil > 0 && hoursUntil <= cfg.upcomingWindowHours) categories.push("earnings_upcoming");
    if (hoursUntil < 0 && hoursUntil >= -cfg.postEarningsWindowHours) categories.push("post_earnings");
  }
  if (!rejectionReason && snap.gapPct != null && Math.abs(snap.gapPct) >= cfg.gapPctThreshold && (categories.includes("post_earnings") || categories.includes("earnings_today"))) categories.push("earnings_gap");
  if (!rejectionReason && snap.relVolume != null && snap.relVolume >= cfg.abnormalRelVol && categories.length > 0) categories.push("abnormal_premarket_vol");

  const elig = classifyEligibility({ symbol: row.symbol, securityType: (snap.securityType as any) ?? "unknown", price: snap.price, dayDollarVolume: snap.dayDollarVolume, halted: snap.halted, lastTradeAgeMs: snap.lastTradeAgeMs }, eligCfg);
  return {
    symbol: row.symbol.toUpperCase(), categories, expectedAtMs: row.expectedAtMs, session: row.session,
    timingConfirmed: row.confirmed === true, provenance: row.provenance, hoursUntil,
    gapPct: snap.gapPct, relVolume: snap.relVolume, optionsAvailable: snap.optionsAvailable,
    eligible: elig.eligible && !rejectionReason, exclusions: elig.exclusions, rejectionReason,
  };
}
