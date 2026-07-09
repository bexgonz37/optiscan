/**
 * paper-risk.ts — configurable risk engine for paper trading (pure).
 *
 * Every new paper trade must pass ALL checks. Each rejection explains itself
 * — teaching risk discipline is the point of paper mode.
 *
 * Defaults are intentionally conservative; every knob is env-tunable and can
 * later be surfaced in Settings.
 */

import { dollarsAtRisk, TERMINAL_STATES, type PaperTrade } from "./paper-trading.ts";

export interface RiskConfig {
  maxRiskPerTrade: number;    // $ at risk per trade (premium × stop distance)
  maxDailyLoss: number;       // $ realized loss cap per trading day
  maxWeeklyLoss: number;      // $ realized loss cap per rolling 7 days
  maxOpenTrades: number;
  maxExposurePerTicker: number; // $ premium committed per underlying
  allowAveragingDown: boolean;  // default false — a second entry on a losing open position is blocked
  allowZeroDte: boolean;        // default false — 0DTE excluded from paper mode
}

export function defaultRiskConfig(): RiskConfig {
  return {
    maxRiskPerTrade: Number(process.env.PAPER_MAX_RISK_PER_TRADE ?? 200),
    maxDailyLoss: Number(process.env.PAPER_MAX_DAILY_LOSS ?? 500),
    maxWeeklyLoss: Number(process.env.PAPER_MAX_WEEKLY_LOSS ?? 1500),
    maxOpenTrades: Number(process.env.PAPER_MAX_OPEN_TRADES ?? 3),
    maxExposurePerTicker: Number(process.env.PAPER_MAX_TICKER_EXPOSURE ?? 400),
    allowAveragingDown: process.env.PAPER_ALLOW_AVERAGING_DOWN === "1",
    allowZeroDte: process.env.PAPER_ALLOW_ZERO_DTE === "1",
  };
}

export interface RiskContext {
  /** All non-terminal trades (WATCHING/READY/ENTERED). */
  openTrades: PaperTrade[];
  /** Realized P/L in dollars for today's ET trading day. */
  realizedTodayDollars: number;
  /** Realized P/L in dollars over the trailing 7 calendar days. */
  realizedWeekDollars: number;
}

export interface RiskVerdict {
  allowed: boolean;
  failures: string[]; // every failed rule, in plain English
}

export interface ProposedTrade {
  ticker: string;
  optionType: "call" | "put";
  dte: number | null;
  entryLimit: number;   // premium
  contracts: number;
  stopLossPct: number | null;
}

export function checkRisk(proposed: ProposedTrade, ctx: RiskContext, cfg: RiskConfig = defaultRiskConfig()): RiskVerdict {
  const failures: string[] = [];
  const open = ctx.openTrades.filter((t) => !TERMINAL_STATES.has(t.status));

  // 0DTE ban (default): same-day expiries are a different, faster game.
  if (!cfg.allowZeroDte && proposed.dte != null && proposed.dte < 1) {
    failures.push("0DTE contracts are excluded from paper mode by default (PAPER_ALLOW_ZERO_DTE=1 to enable)");
  }

  // Per-trade risk.
  const risk = dollarsAtRisk(proposed.entryLimit, proposed.contracts, proposed.stopLossPct);
  if (risk > cfg.maxRiskPerTrade) {
    failures.push(`risk $${risk.toFixed(0)} exceeds max $${cfg.maxRiskPerTrade} per trade — reduce contracts or tighten the stop`);
  }

  // Open-trade count.
  if (open.length >= cfg.maxOpenTrades) {
    failures.push(`already ${open.length} open trades (max ${cfg.maxOpenTrades}) — close something first`);
  }

  // Per-ticker exposure (committed premium).
  const tickerExposure = open
    .filter((t) => t.ticker === proposed.ticker)
    .reduce((s, t) => s + (t.entryPrice ?? t.entryLimit ?? 0) * 100 * t.contracts, 0);
  const newExposure = proposed.entryLimit * 100 * proposed.contracts;
  if (tickerExposure + newExposure > cfg.maxExposurePerTicker) {
    failures.push(`${proposed.ticker} exposure would be $${(tickerExposure + newExposure).toFixed(0)} (max $${cfg.maxExposurePerTicker})`);
  }

  // No averaging down: block a same-ticker same-direction add while an open
  // position on it is underwater.
  if (!cfg.allowAveragingDown) {
    const losingOpen = open.find(
      (t) => t.ticker === proposed.ticker
        && t.optionType === proposed.optionType
        && t.status === "ENTERED"
        && t.entryPrice != null && t.lastMark != null && t.lastMark < t.entryPrice,
    );
    if (losingOpen) {
      failures.push(`no averaging down: an open ${proposed.ticker} ${proposed.optionType} is underwater — adding to losers is how accounts die`);
    }
  }

  // Daily / weekly realized-loss circuit breakers.
  if (ctx.realizedTodayDollars <= -cfg.maxDailyLoss) {
    failures.push(`daily loss limit hit ($${Math.abs(ctx.realizedTodayDollars).toFixed(0)} >= $${cfg.maxDailyLoss}) — done for the day`);
  }
  if (ctx.realizedWeekDollars <= -cfg.maxWeeklyLoss) {
    failures.push(`weekly loss limit hit ($${Math.abs(ctx.realizedWeekDollars).toFixed(0)} >= $${cfg.maxWeeklyLoss}) — step back and review`);
  }

  return { allowed: failures.length === 0, failures };
}
