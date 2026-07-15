/**
 * paper-options-analytics.ts — PURE options-specific performance analytics.
 *
 * The general paper analytics (lib/paper-analytics.ts) blends every asset class.
 * This module answers "how is the OPTIONS system doing?" and deliberately keeps
 * option-contract P&L SEPARATE from underlying-stock P&L — they are never summed
 * into one misleading number. Everything is realized from entry→exit fills; a
 * metric with no data reports null, never a fabricated value. No I/O, no clock
 * beyond the ET bucketing of a passed-in timestamp.
 */

const OPTION_MULTIPLIER = 100;

export interface OptionTradeLike {
  optionSymbol: string | null;
  optionType: "call" | "put";
  status: string;
  dteAtEntry: number | null;
  contracts: number;
  entryPrice: number | null;
  exitPrice: number | null;
  lastMark: number | null;
  entryAtMs: number | null;
  exitAtMs: number | null;
  strategy: string | null;
  entrySlippage?: number | null;
  exitSlippage?: number | null;
  entryFees?: number | null;
  exitFees?: number | null;
  /** Lifetime peak favorable % after entry, tracked to expiration (opportunity HIT). */
  opportunityPeakPct?: number | null;
}

const TERMINAL = new Set(["EXITED", "STOPPED_OUT", "TAKE_PROFIT", "CANCELLED", "EXPIRED"]);

const isOption = (t: OptionTradeLike) => t.optionSymbol != null;
const isGraded = (t: OptionTradeLike) => TERMINAL.has(t.status) && t.entryPrice != null && t.exitPrice != null;
const isOpen = (t: OptionTradeLike) => t.status === "ENTERED" && t.entryPrice != null;

function realizedDollars(t: OptionTradeLike): number {
  if (t.entryPrice == null || t.exitPrice == null) return 0;
  return +((t.exitPrice - t.entryPrice) * OPTION_MULTIPLIER * (t.contracts ?? 1)).toFixed(2);
}
function realizedPct(t: OptionTradeLike): number | null {
  if (t.entryPrice == null || t.exitPrice == null || t.entryPrice <= 0) return null;
  return +(((t.exitPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(2);
}
function unrealizedDollars(t: OptionTradeLike): number {
  if (t.entryPrice == null || t.lastMark == null) return 0;
  return +((t.lastMark - t.entryPrice) * OPTION_MULTIPLIER * (t.contracts ?? 1)).toFixed(2);
}
function premiumPaid(t: OptionTradeLike): number {
  if (t.entryPrice == null) return 0;
  return t.entryPrice * OPTION_MULTIPLIER * (t.contracts ?? 1);
}
const avg = (xs: number[]) => (xs.length ? +(xs.reduce((s, v) => s + v, 0) / xs.length).toFixed(2) : null);

export type DurationBucket = "0DTE" | "weekly" | "longer" | "unknown";
export function durationBucket(dte: number | null): DurationBucket {
  if (dte == null) return "unknown";
  if (dte < 1) return "0DTE";
  if (dte <= 9) return "weekly";
  return "longer";
}

export interface OptionsGroupStats {
  count: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  realizedDollars: number;
  avgWinnerDollars: number | null;
  avgLoserDollars: number | null;
  profitFactor: number | null;
  expectancyDollars: number | null;
  returnOnPremiumPct: number | null;  // realized $ ÷ premium paid $
}

function groupStats(trades: OptionTradeLike[]): OptionsGroupStats {
  const graded = trades.filter(isGraded);
  const pnls = graded.map(realizedDollars);
  const wins = graded.filter((t) => realizedDollars(t) > 0);
  const losses = graded.filter((t) => realizedDollars(t) < 0);
  const grossWin = wins.reduce((s, t) => s + realizedDollars(t), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + realizedDollars(t), 0));
  const total = pnls.reduce((s, v) => s + v, 0);
  const premium = graded.reduce((s, t) => s + premiumPaid(t), 0);
  return {
    count: graded.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: graded.length ? +((wins.length / graded.length) * 100).toFixed(1) : null,
    realizedDollars: +total.toFixed(2),
    avgWinnerDollars: avg(wins.map(realizedDollars)),
    avgLoserDollars: avg(losses.map(realizedDollars)),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? Infinity : null),
    expectancyDollars: graded.length ? +(total / graded.length).toFixed(2) : null,
    returnOnPremiumPct: premium > 0 ? +((total / premium) * 100).toFixed(1) : null,
  };
}

/** ET session phase from a fill timestamp (deterministic, no external deps). */
export function etSessionPhase(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const t = h * 60 + m;
  if (t < 9 * 60 + 30) return "premarket";
  if (t < 10 * 60 + 30) return "open (9:30–10:30)";
  if (t < 12 * 60) return "morning (10:30–12:00)";
  if (t < 14 * 60) return "midday (12:00–14:00)";
  if (t < 15 * 60) return "afternoon (14:00–15:00)";
  if (t < 16 * 60) return "power hour (15:00–16:00)";
  return "after-hours";
}

export interface OpportunityAudit {
  hitAndCaptured: number;        // realized win — signal right, exit right
  signalHitExitMissed: number;   // contract offered ≥ threshold but we booked ≤ 0 (exit failed)
  signalFailed: number;          // never offered the threshold and lost (signal itself wrong)
  thresholdPct: number;
}

export interface OptionsPerformance {
  openCount: number;
  closedCount: number;
  contractsTraded: number;
  avgContractsPerTrade: number | null;
  avgPremiumPaid: number | null;       // per-contract premium
  avgPositionValueDollars: number | null;
  realizedDollars: number;
  unrealizedDollars: number;
  returnOnPremiumPct: number | null;
  winRatePct: number | null;
  profitFactor: number | null;
  expectancyDollars: number | null;
  maxDrawdownDollars: number;
  avgWinnerDollars: number | null;
  avgLoserDollars: number | null;
  totalSlippageDollars: number;
  totalFeesDollars: number;
  overall: OptionsGroupStats;
  byType: { call: OptionsGroupStats; put: OptionsGroupStats };
  byDuration: Record<DurationBucket, OptionsGroupStats>;
  byStrategy: Array<{ strategy: string } & OptionsGroupStats>;
  byTimeOfDay: Array<{ phase: string } & OptionsGroupStats>;
  opportunity: OpportunityAudit;
  note: string;
}

/**
 * Full options-performance rollup. `opportunityThresholdPct` defines what counts
 * as the contract having "offered" a real profit at any point after entry
 * (opportunity HIT), used to separate a failed EXIT from a failed SIGNAL.
 */
export function optionsPerformance(trades: OptionTradeLike[], opportunityThresholdPct = 30): OptionsPerformance {
  const options = trades.filter(isOption);
  const graded = options.filter(isGraded);
  const open = options.filter(isOpen);

  const contractsTraded = graded.reduce((s, t) => s + (t.contracts ?? 0), 0);
  const premiums = graded.map((t) => t.entryPrice ?? 0).filter((v) => v > 0);
  const positionValues = graded.map(premiumPaid).filter((v) => v > 0);

  // Max drawdown on the realized option-only equity curve (exit order).
  const closedSorted = [...graded].sort((a, b) => (a.exitAtMs ?? 0) - (b.exitAtMs ?? 0));
  let peak = 0, equity = 0, maxDd = 0;
  for (const t of closedSorted) { equity += realizedDollars(t); peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity); }

  const overall = groupStats(options);
  const strategies = [...new Set(graded.map((t) => t.strategy ?? "unknown"))];
  const phases = [...new Set(graded.map((t) => (t.entryAtMs != null ? etSessionPhase(t.entryAtMs) : "unknown")))];

  const opp: OpportunityAudit = { hitAndCaptured: 0, signalHitExitMissed: 0, signalFailed: 0, thresholdPct: opportunityThresholdPct };
  for (const t of graded) {
    const pnl = realizedDollars(t);
    const peakPct = t.opportunityPeakPct ?? null;
    if (pnl > 0) opp.hitAndCaptured += 1;
    else if (peakPct != null && peakPct >= opportunityThresholdPct) opp.signalHitExitMissed += 1;
    else opp.signalFailed += 1;
  }

  return {
    openCount: open.length,
    closedCount: options.filter((t) => TERMINAL.has(t.status)).length,
    contractsTraded,
    avgContractsPerTrade: graded.length ? +(contractsTraded / graded.length).toFixed(2) : null,
    avgPremiumPaid: avg(premiums),
    avgPositionValueDollars: avg(positionValues),
    realizedDollars: overall.realizedDollars,
    unrealizedDollars: +open.reduce((s, t) => s + unrealizedDollars(t), 0).toFixed(2),
    returnOnPremiumPct: overall.returnOnPremiumPct,
    winRatePct: overall.winRatePct,
    profitFactor: overall.profitFactor,
    expectancyDollars: overall.expectancyDollars,
    maxDrawdownDollars: +maxDd.toFixed(2),
    avgWinnerDollars: overall.avgWinnerDollars,
    avgLoserDollars: overall.avgLoserDollars,
    totalSlippageDollars: +graded.reduce((s, t) => s + ((t.entrySlippage ?? 0) + (t.exitSlippage ?? 0)) * OPTION_MULTIPLIER * (t.contracts ?? 1), 0).toFixed(2),
    totalFeesDollars: +graded.reduce((s, t) => s + (t.entryFees ?? 0) + (t.exitFees ?? 0), 0).toFixed(2),
    overall,
    byType: {
      call: groupStats(options.filter((t) => t.optionType === "call")),
      put: groupStats(options.filter((t) => t.optionType === "put")),
    },
    byDuration: {
      "0DTE": groupStats(options.filter((t) => durationBucket(t.dteAtEntry) === "0DTE")),
      weekly: groupStats(options.filter((t) => durationBucket(t.dteAtEntry) === "weekly")),
      longer: groupStats(options.filter((t) => durationBucket(t.dteAtEntry) === "longer")),
      unknown: groupStats(options.filter((t) => durationBucket(t.dteAtEntry) === "unknown")),
    },
    byStrategy: strategies.map((strategy) => ({ strategy, ...groupStats(graded.filter((t) => (t.strategy ?? "unknown") === strategy)) })).sort((a, b) => b.count - a.count),
    byTimeOfDay: phases.map((phase) => ({ phase, ...groupStats(graded.filter((t) => (t.entryAtMs != null ? etSessionPhase(t.entryAtMs) : "unknown") === phase)) })).sort((a, b) => b.count - a.count),
    opportunity: opp,
    note: "Option-contract P&L only — underlying stock P&L is tracked separately and never blended.",
  };
}
