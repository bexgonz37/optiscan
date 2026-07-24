/**
 * B5 — portfolio performance, risk, options, exposure, and advisory Kelly analytics.
 * Dollar-ledger based. Never invents Greeks/sector. Kelly is advisory-only.
 */
import type { BrokerDb } from "./audit.ts";
import { roundMoney } from "./ledger.ts";
import { computeAccountEquity } from "./equity.ts";
import {
  ANALYTICS_METHODOLOGY_VERSION,
  ANALYTICS_SURFACE_LABEL,
  KELLY_ADVISORY_ONLY,
  defaultAnalyticsPolicy,
  insufficient,
  metric,
  type AnalyticsPolicyConfig,
  type MetricValue,
} from "./analytics-policy.ts";
import {
  expirationType,
  filterRoundTrips,
  listClosedRoundTrips,
  type RoundTripTrade,
} from "./trades.ts";
import { parseOccSymbol } from "./occ.ts";
import type { BrokerAccountRow } from "./types.ts";

export interface AnalyticsFilters {
  fromMs?: number | null;
  toMs?: number | null;
  strategy?: string | null;
  underlying?: string | null;
  right?: string | null;
  dteBucket?: string | null;
  completeness?: string | null;
  completeSnapshotsOnly?: boolean | null;
  allEquitySnapshots?: boolean | null;
  realizedOnly?: boolean | null;
}

export interface EquityPoint {
  atMs: number;
  netEquity: number;
  highWaterMark: number | null;
  drawdownDollars: number | null;
  drawdownPct: number | null;
  completeness: string | null;
  missingMarkCount: number;
  staleMarkCount: number;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const v = mean(xs.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}

function maxConsecutive(flags: boolean[]): number {
  let best = 0;
  let cur = 0;
  for (const f of flags) {
    if (f) {
      cur += 1;
      best = Math.max(best, cur);
    } else cur = 0;
  }
  return best;
}

function parseMeta(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadEquityPoints(
  db: BrokerDb,
  accountId: string,
  opts: { fromMs?: number | null; toMs?: number | null; completeOnly?: boolean },
): { points: EquityPoint[]; incompleteCount: number; excludedCount: number; missingMarks: number; staleMarks: number } {
  const rows = (db
    .prepare(
      `SELECT id, snapshot_at_ms, net_equity, high_water_mark, drawdown_dollars, drawdown_pct,
              completeness_status, metadata_json
       FROM broker_equity_snapshots
       WHERE account_id = ?
       ORDER BY snapshot_at_ms ASC`,
    )
    .all?.(accountId) ?? []) as Array<Record<string, any>>;

  let incompleteCount = 0;
  let excludedCount = 0;
  let missingMarks = 0;
  let staleMarks = 0;
  const points: EquityPoint[] = [];

  for (const r of rows) {
    const at = Number(r.snapshot_at_ms);
    if (opts.fromMs != null && at < opts.fromMs) continue;
    if (opts.toMs != null && at > opts.toMs) continue;
    const meta = parseMeta(r.metadata_json);
    const miss = typeof meta.missingMarkCount === "number" ? meta.missingMarkCount : 0;
    const stale = typeof meta.staleMarkCount === "number" ? meta.staleMarkCount : 0;
    missingMarks += miss;
    staleMarks += stale;
    const comp = r.completeness_status as string | null;
    const incomplete = comp === "INCOMPLETE" || comp === "PARTIAL";
    if (incomplete) incompleteCount += 1;
    if (opts.completeOnly && incomplete) {
      excludedCount += 1;
      continue;
    }
    points.push({
      atMs: at,
      netEquity: Number(r.net_equity),
      highWaterMark: r.high_water_mark != null ? Number(r.high_water_mark) : null,
      drawdownDollars: r.drawdown_dollars != null ? Number(r.drawdown_dollars) : null,
      drawdownPct: r.drawdown_pct != null ? Number(r.drawdown_pct) : null,
      completeness: comp,
      missingMarkCount: miss,
      staleMarkCount: stale,
    });
  }
  return { points, incompleteCount, excludedCount, missingMarks, staleMarks };
}

/** One equity observation per UTC day (last snapshot). */
export function dailyEquitySeries(points: EquityPoint[]): EquityPoint[] {
  const byDay = new Map<string, EquityPoint>();
  for (const p of points) {
    const day = new Date(p.atMs).toISOString().slice(0, 10);
    byDay.set(day, p);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, p]) => p);
}

export function dailyReturns(points: EquityPoint[]): number[] {
  const daily = dailyEquitySeries(points);
  const rets: number[] = [];
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1].netEquity;
    const cur = daily[i].netEquity;
    if (!(prev > 0)) continue;
    rets.push(cur / prev - 1);
  }
  return rets;
}

export function computeDrawdownStats(points: EquityPoint[]): {
  maxDrawdownDollars: number;
  maxDrawdownPct: number;
  currentDrawdownDollars: number;
  currentDrawdownPct: number;
  recoveryTimeMs: number | null;
} {
  let peak = 0;
  let maxDd = 0;
  let maxDdPct = 0;
  let troughAtPeakEnd = 0;
  let recoveryTimeMs: number | null = null;
  let openTroughMs: number | null = null;
  let openPeakMs: number | null = null;

  for (const p of points) {
    if (p.netEquity >= peak) {
      if (openTroughMs != null && openPeakMs != null && recoveryTimeMs == null) {
        recoveryTimeMs = p.atMs - openTroughMs;
      }
      peak = p.netEquity;
      openPeakMs = p.atMs;
      openTroughMs = null;
    }
    const dd = peak - p.netEquity;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = ddPct;
      troughAtPeakEnd = p.atMs;
      openTroughMs = p.atMs;
      recoveryTimeMs = null;
    } else if (dd > 0 && openTroughMs == null) {
      openTroughMs = p.atMs;
    }
  }
  void troughAtPeakEnd;
  const last = points[points.length - 1];
  const lastPeak = points.reduce((m, p) => Math.max(m, p.netEquity), 0);
  const currentDrawdownDollars = last ? Math.max(0, lastPeak - last.netEquity) : 0;
  const currentDrawdownPct = lastPeak > 0 ? (currentDrawdownDollars / lastPeak) * 100 : 0;
  return {
    maxDrawdownDollars: roundMoney(maxDd),
    maxDrawdownPct: roundMoney(maxDdPct),
    currentDrawdownDollars: roundMoney(currentDrawdownDollars),
    currentDrawdownPct: roundMoney(currentDrawdownPct),
    recoveryTimeMs,
  };
}

export function computePerformanceMetrics(
  trades: RoundTripTrade[],
  points: EquityPoint[],
  startingCash: number,
): Record<string, MetricValue | number | null> {
  const startEq = points.length ? points[0].netEquity : startingCash;
  const endEq = points.length ? points[points.length - 1].netEquity : startingCash;
  const netProfit = roundMoney(endEq - startEq);
  const totalReturnPct = startEq > 0 ? roundMoney((netProfit / startEq) * 100) : null;

  const pnls = trades.map((t) => t.netPnlDollars);
  const winners = pnls.filter((x) => x > 0);
  const losers = pnls.filter((x) => x < 0);
  const rets = trades.map((t) => t.returnPct);
  const holdings = trades.map((t) => t.holdingMs);

  const grossProfit = roundMoney(winners.reduce((s, x) => s + x, 0));
  const grossLoss = roundMoney(losers.reduce((s, x) => s + x, 0)); // negative or 0
  const absGrossLoss = Math.abs(grossLoss);

  const winRate = trades.length ? winners.length / trades.length : null;
  const lossRate = trades.length ? losers.length / trades.length : null;
  const avgWin = winners.length ? mean(winners) : null;
  const avgLoss = losers.length ? mean(losers) : null;
  const payoff =
    avgWin != null && avgLoss != null && avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null;
  const profitFactor = absGrossLoss > 0 ? grossProfit / absGrossLoss : winners.length ? null : null;
  // profit factor: if no losses but have wins, null with infinite reason handled below

  const realizedFromTrades = roundMoney(pnls.reduce((s, x) => s + x, 0));
  const last = points[points.length - 1];

  return {
    startingEquity: metric(roundMoney(startEq)),
    endingEquity: metric(roundMoney(endEq)),
    netProfitDollars: metric(netProfit),
    totalReturnPct: totalReturnPct == null ? insufficient("starting_equity_non_positive") : metric(totalReturnPct),
    realizedPnl: metric(realizedFromTrades),
    unrealizedPnl: metric(last ? roundMoney(last.netEquity - startEq - realizedFromTrades) : 0),
    // Prefer live unrealized from last snapshot fields when we add them — use equity compute in report
    grossProfit: metric(grossProfit),
    grossLoss: metric(roundMoney(absGrossLoss)),
    winRate: winRate == null ? insufficient("no_closed_trades") : metric(roundMoney(winRate * 100)),
    lossRate: lossRate == null ? insufficient("no_closed_trades") : metric(roundMoney(lossRate * 100)),
    averageWinner: avgWin == null ? insufficient("no_winners") : metric(roundMoney(avgWin)),
    averageLoser: avgLoss == null ? insufficient("no_losers") : metric(roundMoney(avgLoss)),
    payoffRatio: payoff == null ? insufficient("need_winners_and_losers") : metric(roundMoney(payoff)),
    profitFactor:
      absGrossLoss > 0
        ? metric(roundMoney(grossProfit / absGrossLoss))
        : winners.length > 0
          ? insufficient("no_losing_trades_profit_factor_undefined")
          : insufficient("no_closed_trades"),
    expectancyPerTradeDollars: trades.length
      ? metric(roundMoney(mean(pnls)))
      : insufficient("no_closed_trades"),
    expectancyPerTradeReturnPct: trades.length
      ? metric(roundMoney(mean(rets)))
      : insufficient("no_closed_trades"),
    medianTradeReturn: (() => {
      const m = median(rets);
      return m == null ? insufficient("no_closed_trades") : metric(roundMoney(m));
    })(),
    largestWinner: winners.length ? metric(roundMoney(Math.max(...winners))) : insufficient("no_winners"),
    largestLoser: losers.length ? metric(roundMoney(Math.min(...losers))) : insufficient("no_losers"),
    consecutiveWins: metric(maxConsecutive(pnls.map((x) => x > 0))),
    consecutiveLosses: metric(maxConsecutive(pnls.map((x) => x < 0))),
    averageHoldingTimeMs: trades.length ? metric(Math.round(mean(holdings))) : insufficient("no_closed_trades"),
    medianHoldingTimeMs: (() => {
      const m = median(holdings);
      return m == null ? insufficient("no_closed_trades") : metric(Math.round(m));
    })(),
    closedTradeCount: trades.length,
  };
}

export function computeRiskMetrics(
  points: EquityPoint[],
  policy: AnalyticsPolicyConfig,
): Record<string, MetricValue> {
  const dd = computeDrawdownStats(points);
  const rets = dailyReturns(points);
  const daily = dailyEquitySeries(points);
  const spanDays =
    daily.length >= 2
      ? (daily[daily.length - 1].atMs - daily[0].atMs) / 86_400_000
      : 0;
  const canAnnualize = spanDays >= policy.minDaysForAnnualization;
  const enoughRets = rets.length >= policy.minReturnObservations;

  const vol = stdev(rets);
  const downside = stdev(rets.filter((r) => r < 0));
  const rfDaily = policy.riskFreeRate / policy.annualizationFactor;
  const excess = rets.map((r) => r - rfDaily);
  const meanExcess = excess.length ? mean(excess) : null;

  const sharpe =
    enoughRets && canAnnualize && vol != null && vol > 0 && meanExcess != null
      ? metric(roundMoney((meanExcess / vol) * Math.sqrt(policy.annualizationFactor)))
      : !enoughRets
        ? insufficient(`need_${policy.minReturnObservations}_daily_returns_have_${rets.length}`)
        : !canAnnualize
          ? insufficient("observation_window_too_short_for_annualization")
          : insufficient("zero_volatility");

  const sortino =
    enoughRets && canAnnualize && downside != null && downside > 0 && meanExcess != null
      ? metric(roundMoney((meanExcess / downside) * Math.sqrt(policy.annualizationFactor)))
      : !enoughRets
        ? insufficient(`need_${policy.minReturnObservations}_daily_returns_have_${rets.length}`)
        : !canAnnualize
          ? insufficient("observation_window_too_short_for_annualization")
          : insufficient("no_downside_deviation");

  const totalRet =
    daily.length >= 2 && daily[0].netEquity > 0
      ? daily[daily.length - 1].netEquity / daily[0].netEquity - 1
      : null;
  const annRet =
    totalRet != null && spanDays > 0 && canAnnualize
      ? (1 + totalRet) ** (policy.annualizationFactor / Math.max(spanDays, 1)) - 1
      : null;
  const calmar =
    annRet != null && dd.maxDrawdownPct > 0
      ? metric(roundMoney(annRet / (dd.maxDrawdownPct / 100)))
      : !canAnnualize
        ? insufficient("observation_window_too_short_for_annualization")
        : insufficient("calmar_requires_drawdown_and_annualized_return");

  // Ulcer index from daily drawdown pct series
  let peak = 0;
  const ddPctSeries: number[] = [];
  for (const p of daily) {
    peak = Math.max(peak, p.netEquity);
    ddPctSeries.push(peak > 0 ? ((peak - p.netEquity) / peak) * 100 : 0);
  }
  const ulcer =
    ddPctSeries.length >= 2
      ? metric(roundMoney(Math.sqrt(mean(ddPctSeries.map((d) => d * d)))))
      : insufficient("need_more_equity_days");

  let varMetric: MetricValue = insufficient("need_more_returns");
  let cvarMetric: MetricValue = insufficient("need_more_returns");
  if (enoughRets) {
    const sorted = [...rets].sort((a, b) => a - b);
    const varIdx = Math.max(0, Math.floor((1 - policy.varConfidence) * sorted.length));
    const varV = sorted[varIdx];
    const tail = sorted.slice(0, varIdx + 1);
    varMetric = metric(roundMoney(varV * 100)); // % return
    cvarMetric = tail.length ? metric(roundMoney(mean(tail) * 100)) : insufficient("empty_tail");
  }

  return {
    maximumDrawdownDollars: metric(dd.maxDrawdownDollars),
    maximumDrawdownPct: metric(dd.maxDrawdownPct),
    currentDrawdownDollars: metric(dd.currentDrawdownDollars),
    currentDrawdownPct: metric(dd.currentDrawdownPct),
    recoveryTimeMs:
      dd.recoveryTimeMs == null
        ? insufficient(dd.currentDrawdownDollars > 0 ? "drawdown_not_yet_recovered" : "no_drawdown_to_recover")
        : metric(dd.recoveryTimeMs),
    volatilityOfAccountReturns: !enoughRets
      ? insufficient(`need_${policy.minReturnObservations}_daily_returns_have_${rets.length}`)
      : canAnnualize && vol != null
        ? metric(roundMoney(vol * Math.sqrt(policy.annualizationFactor) * 100))
        : !canAnnualize
          ? insufficient("observation_window_too_short_for_annualization")
          : vol == null
            ? insufficient("insufficient_variance")
            : metric(roundMoney(vol * 100)),
    downsideDeviation: !enoughRets
      ? insufficient(`need_${policy.minReturnObservations}_daily_returns_have_${rets.length}`)
      : downside == null
        ? insufficient("no_negative_returns")
        : metric(roundMoney(downside * 100)),
    sharpeRatio: sharpe,
    sortinoRatio: sortino,
    calmarRatio: calmar,
    ulcerIndex: ulcer,
    valueAtRisk: varMetric,
    conditionalValueAtRisk: cvarMetric,
    riskOfRuinEstimate: insufficient("computed_in_kelly_block"),
    dailyReturnCount: metric(rets.length),
    observationSpanDays: metric(roundMoney(spanDays)),
  };
}

function bucketSum(
  trades: RoundTripTrade[],
  keyFn: (t: RoundTripTrade) => string,
): Array<{ key: string; netPnl: number; count: number; sampleSize: number }> {
  const map = new Map<string, { netPnl: number; count: number }>();
  for (const t of trades) {
    const k = keyFn(t) || "unknown";
    const cur = map.get(k) ?? { netPnl: 0, count: 0 };
    cur.netPnl = roundMoney(cur.netPnl + t.netPnlDollars);
    cur.count += 1;
    map.set(k, cur);
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, netPnl: v.netPnl, count: v.count, sampleSize: v.count }))
    .sort((a, b) => b.netPnl - a.netPnl);
}

export function computeOptionsBreakdown(trades: RoundTripTrade[]) {
  const fees = roundMoney(trades.reduce((s, t) => s + t.commissionFees, 0));
  const slip = roundMoney(trades.reduce((s, t) => s + t.slippageDollars, 0));
  const spread = trades
    .map((t) => t.spreadCostEstimate)
    .filter((x): x is number => x != null);
  const premiums = trades.map((t) => t.entryPrice);
  const contracts = trades.map((t) => t.contracts);
  const capital = trades.map((t) => t.capitalAtRisk);
  const premiumWeighted =
    capital.length && capital.reduce((s, x) => s + x, 0) > 0
      ? roundMoney(
          trades.reduce((s, t) => s + t.returnPct * t.capitalAtRisk, 0) /
            trades.reduce((s, t) => s + t.capitalAtRisk, 0),
        )
      : null;

  const exitCounts = {
    target: trades.filter((t) => t.exitClass === "target").length,
    stop: trades.filter((t) => t.exitClass === "stop").length,
    timeout: trades.filter((t) => t.exitClass === "timeout" || t.exitClass === "expiration").length,
    worthless: trades.filter((t) => t.expiredWorthless || t.exitClass === "worthless").length,
    unknown: trades.filter((t) => t.exitClass === "unknown").length,
  };
  const n = trades.length || 1;

  const regimeBuckets = bucketSum(trades, (t) => t.marketRegime ?? "");
  const sectorAvailable = trades.some((t) => t.sector != null);
  const regimeAvailable = trades.some((t) => t.marketRegime != null);

  return {
    pnlByCallPut: bucketSum(trades, (t) => t.right ?? "unknown"),
    pnlByStrategy: bucketSum(trades, (t) => t.strategy ?? "unknown"),
    pnlByDteBucket: bucketSum(trades, (t) => t.dteBucket),
    pnlByExpirationType: bucketSum(trades, (t) => expirationType(t.dteAtEntry)),
    pnlByUnderlying: bucketSum(trades, (t) => t.underlying ?? "unknown"),
    pnlByMarketRegime: regimeAvailable
      ? regimeBuckets
      : { unavailable: true, reason: "market_regime_not_present_on_v2_snapshots", buckets: [] as typeof regimeBuckets },
    pnlByEntryHourUtc: bucketSum(trades, (t) => String(t.entryHourUtc)),
    pnlByDayOfWeekUtc: bucketSum(trades, (t) => String(t.entryDowUtc)),
    averagePremiumPaid: premiums.length ? metric(roundMoney(mean(premiums))) : insufficient("no_closed_trades"),
    averageContractsPerPosition: contracts.length
      ? metric(roundMoney(mean(contracts)))
      : insufficient("no_closed_trades"),
    averageCapitalAtRisk: capital.length ? metric(roundMoney(mean(capital))) : insufficient("no_closed_trades"),
    premiumWeightedReturn: premiumWeighted == null
      ? insufficient("no_closed_trades")
      : metric(premiumWeighted),
    spreadCostEstimate: spread.length
      ? metric(roundMoney(spread.reduce((s, x) => s + x, 0)))
      : insufficient("bid_ask_not_available_on_entry_snapshots"),
    slippageCostEstimate: trades.length ? metric(slip) : insufficient("no_closed_trades"),
    commissionsAndFeeImpact: trades.length ? metric(fees) : insufficient("no_closed_trades"),
    pctExpiringWorthless: trades.length
      ? metric(roundMoney((exitCounts.worthless / trades.length) * 100))
      : insufficient("no_closed_trades"),
    pctReachingTarget: trades.length
      ? metric(roundMoney((exitCounts.target / trades.length) * 100))
      : insufficient("no_closed_trades"),
    pctHittingStop: trades.length
      ? metric(roundMoney((exitCounts.stop / trades.length) * 100))
      : insufficient("no_closed_trades"),
    pctExitedByTimeoutOrExpiration: trades.length
      ? metric(roundMoney((exitCounts.timeout / trades.length) * 100))
      : insufficient("no_closed_trades"),
    exitClassificationCounts: exitCounts,
    sectorPnl: sectorAvailable
      ? bucketSum(trades, (t) => t.sector ?? "unknown")
      : { unavailable: true, reason: "sector_not_present_on_v2_records" },
    _n: n,
  };
}

export function computeExposureMetrics(
  db: BrokerDb,
  accountId: string,
  trades: RoundTripTrade[],
  points: EquityPoint[],
) {
  const equity = computeAccountEquity(db, accountId);
  const grossExposure = equity.grossPositionValue;
  const starting = points[0]?.netEquity ?? equity.cash;
  const capitalUtilization =
    starting > 0 ? roundMoney((grossExposure / Math.max(equity.totalEquity, 1)) * 100) : null;

  // Concurrent positions from snapshots metadata or reconstruct from trades timeline
  let peakConcurrent = 0;
  let sumConcurrent = 0;
  let concurrentSamples = 0;
  const open = new Map<string, number>(); // symbol -> count open
  const events: Array<{ t: number; delta: number; symbol: string }> = [];
  for (const tr of trades) {
    events.push({ t: tr.entryAtMs, delta: 1, symbol: tr.symbol });
    events.push({ t: tr.exitAtMs, delta: -1, symbol: tr.symbol });
  }
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let concurrent = 0;
  for (const e of events) {
    concurrent += e.delta;
    open.set(e.symbol, (open.get(e.symbol) ?? 0) + e.delta);
    peakConcurrent = Math.max(peakConcurrent, concurrent);
    sumConcurrent += concurrent;
    concurrentSamples += 1;
  }

  const byUnderlying = new Map<string, number>();
  for (const p of equity.positions) {
    const u = parseOccSymbol(p.symbol).underlying ?? p.symbol;
    byUnderlying.set(u, roundMoney((byUnderlying.get(u) ?? 0) + p.marketValueDollars));
  }
  const concentrationByUnderlying = [...byUnderlying.entries()]
    .map(([key, marketValue]) => ({
      key,
      marketValue,
      pctOfGross: grossExposure > 0 ? roundMoney((marketValue / grossExposure) * 100) : 0,
    }))
    .sort((a, b) => b.marketValue - a.marketValue);

  const strategyCap = new Map<string, number>();
  for (const t of trades) {
    const k = t.strategy ?? "unknown";
    strategyCap.set(k, roundMoney((strategyCap.get(k) ?? 0) + t.capitalAtRisk));
  }
  const concentrationByStrategy = [...strategyCap.entries()]
    .map(([key, capital]) => ({ key, capital }))
    .sort((a, b) => b.capital - a.capital);

  const sameUnderlyingOverlap = concentrationByUnderlying.filter((c) => {
    const openCount = equity.positions.filter(
      (p) => (parseOccSymbol(p.symbol).underlying ?? p.symbol) === c.key,
    ).length;
    return openCount > 1;
  });

  const largestSingle = equity.positions.reduce(
    (m, p) => Math.max(m, p.marketValueDollars),
    0,
  );

  const daily = dailyEquitySeries(points);
  let largestDailyLoss: number | null = null;
  let largestDailyGain: number | null = null;
  for (let i = 1; i < daily.length; i++) {
    const d = roundMoney(daily[i].netEquity - daily[i - 1].netEquity);
    if (largestDailyLoss == null || d < largestDailyLoss) largestDailyLoss = d;
    if (largestDailyGain == null || d > largestDailyGain) largestDailyGain = d;
  }

  const greeksAvailable = trades.some((t) => t.delta != null) || equity.positions.some(() => false);

  return {
    grossExposure: metric(roundMoney(grossExposure)),
    netDirectionalExposure: greeksAvailable
      ? insufficient("net_delta_aggregation_not_wired_for_open_positions")
      : insufficient("greeks_unavailable"),
    capitalUtilizationPct:
      capitalUtilization == null ? insufficient("no_equity_base") : metric(capitalUtilization),
    peakConcurrentPositions: metric(peakConcurrent),
    averageConcurrentPositions:
      concurrentSamples > 0
        ? metric(roundMoney(sumConcurrent / concurrentSamples))
        : insufficient("no_closed_trade_timeline"),
    concentrationByUnderlying,
    concentrationByStrategy,
    concentrationBySector: {
      unavailable: true as const,
      reason: "sector_not_present_on_v2_records",
    },
    sameUnderlyingOverlap,
    correlatedPositionOverlap: {
      unavailable: true as const,
      reason: "correlation_matrix_not_available",
    },
    largestSinglePositionRisk: metric(roundMoney(largestSingle)),
    largestDailyLoss:
      largestDailyLoss == null ? insufficient("need_multi_day_equity") : metric(largestDailyLoss),
    largestDailyGain:
      largestDailyGain == null ? insufficient("need_multi_day_equity") : metric(largestDailyGain),
  };
}

export function computeKellyInputs(
  trades: RoundTripTrade[],
  policy: AnalyticsPolicyConfig,
  startingEquity: number,
) {
  const warnings: string[] = [];
  const n = trades.length;
  if (n < policy.minTradesForAdvanced) {
    warnings.push(`sample_too_small_for_kelly_need_${policy.minTradesForAdvanced}_have_${n}`);
  }
  if (n < 30) warnings.push("kelly_unstable_sample_below_30");

  const winners = trades.filter((t) => t.netPnlDollars > 0);
  const losers = trades.filter((t) => t.netPnlDollars < 0);
  const p = n > 0 ? winners.length / n : null;
  const avgWin = winners.length ? mean(winners.map((t) => t.netPnlDollars)) : null;
  const avgLossAbs = losers.length ? Math.abs(mean(losers.map((t) => t.netPnlDollars))) : null;
  const b = avgWin != null && avgLossAbs != null && avgLossAbs > 0 ? avgWin / avgLossAbs : null;

  let fullKelly: MetricValue = insufficient("need_win_rate_and_payoff");
  if (p != null && b != null && n >= policy.minTradesForAdvanced) {
    const f = p - (1 - p) / b;
    fullKelly = metric(roundMoney(Math.max(0, f)));
  } else if (n < policy.minTradesForAdvanced) {
    fullKelly = insufficient(`need_${policy.minTradesForAdvanced}_closed_trades_have_${n}`);
  }

  const half =
    fullKelly.value != null ? metric(roundMoney(fullKelly.value / 2)) : insufficient(fullKelly.reason ?? "n/a");
  const quarter =
    fullKelly.value != null ? metric(roundMoney(fullKelly.value / 4)) : insufficient(fullKelly.reason ?? "n/a");

  const shrink = n >= 30 ? 1 : n / 30;
  const confAdj =
    fullKelly.value != null
      ? metric(roundMoney(fullKelly.value * shrink))
      : insufficient(fullKelly.reason ?? "n/a");

  // Wilson-ish crude CI on win rate
  let ciLow: MetricValue = insufficient("need_trades");
  let ciHigh: MetricValue = insufficient("need_trades");
  if (p != null && n > 0) {
    const z = 1.96;
    const se = Math.sqrt((p * (1 - p)) / n);
    ciLow = metric(roundMoney(Math.max(0, p - z * se) * 100));
    ciHigh = metric(roundMoney(Math.min(1, p + z * se) * 100));
  }

  // Risk of ruin estimate
  let ror: MetricValue = insufficient("need_win_rate_and_payoff");
  if (p != null && b != null && avgLossAbs != null && avgLossAbs > 0 && startingEquity > 0) {
    const edge = p * b - (1 - p);
    if (edge <= 0) ror = metric(1);
    else {
      const units = Math.max(1, Math.floor(startingEquity / avgLossAbs));
      const q = ((1 - p) / p) * (1 / b);
      const est = Math.min(1, q ** Math.min(units, 50));
      ror = metric(roundMoney(est));
    }
  }

  return {
    advisoryOnly: KELLY_ADVISORY_ONLY,
    warning:
      "Kelly inputs are research/advisory only. They never size positions or affect live delivery.",
    warnings,
    empiricalWinProbability: p == null ? insufficient("no_closed_trades") : metric(roundMoney(p * 100)),
    averageWinLossRatio: b == null ? insufficient("need_winners_and_losers") : metric(roundMoney(b)),
    fullKellyFraction: fullKelly,
    halfKelly: half,
    quarterKelly: quarter,
    confidenceAdjustedKelly: confAdj,
    sampleSize: n,
    winRateConfidenceIntervalPct: { low: ciLow, high: ciHigh },
    riskOfRuinEstimate: ror,
  };
}

export function buildAnalyticsReport(
  db: BrokerDb,
  account: BrokerAccountRow,
  filters: AnalyticsFilters = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const policy = defaultAnalyticsPolicy(env);
  const completeOnly =
    filters.completeSnapshotsOnly === true ||
    (filters.completeness != null && String(filters.completeness).toUpperCase() === "COMPLETE") ||
    (filters.completeSnapshotsOnly !== false &&
      policy.excludeIncompleteSnapshotsByDefault &&
      filters.allEquitySnapshots !== true);

  const equityLoad = loadEquityPoints(db, account.id, {
    fromMs: filters.fromMs,
    toMs: filters.toMs,
    completeOnly,
  });
  const allLoad = loadEquityPoints(db, account.id, {
    fromMs: filters.fromMs,
    toMs: filters.toMs,
    completeOnly: false,
  });

  let trades = listClosedRoundTrips(db, account.id);
  const beforeFilter = trades.length;
  trades = filterRoundTrips(trades, {
    fromMs: filters.fromMs,
    toMs: filters.toMs,
    strategy: filters.strategy,
    underlying: filters.underlying,
    right: filters.right,
    dteBucket: filters.dteBucket,
  });
  if (filters.realizedOnly) {
    // already closed only
  }
  const excludedTrades = beforeFilter - trades.length;

  const startingCashRow = db
    .prepare(
      `SELECT SUM(cash_delta) AS s FROM broker_ledger_entries
       WHERE account_id = ? AND entry_kind IN ('DEPOSIT','ACCOUNT_OPEN')`,
    )
    .get(account.id) as { s: number | null };
  const startingCash = startingCashRow?.s != null && startingCashRow.s > 0 ? startingCashRow.s : 0;

  const live = computeAccountEquity(db, account.id);
  const performance = computePerformanceMetrics(trades, equityLoad.points, startingCash || live.cash);
  performance.unrealizedPnl = metric(live.unrealizedPnl);
  performance.realizedPnl = metric(live.realizedPnl);

  const risk = computeRiskMetrics(equityLoad.points, policy);
  const kelly = computeKellyInputs(
    trades,
    policy,
    (performance.startingEquity as MetricValue).value ?? startingCash,
  );
  risk.riskOfRuinEstimate = kelly.riskOfRuinEstimate;

  const options = computeOptionsBreakdown(trades);
  const exposure = computeExposureMetrics(db, account.id, trades, equityLoad.points);

  const warnings: string[] = [...kelly.warnings];
  if (equityLoad.incompleteCount > 0 && completeOnly) {
    warnings.push(`excluded_${equityLoad.excludedCount}_incomplete_snapshots_from_risk_series`);
  }
  if (equityLoad.points.length < 2) {
    warnings.push("insufficient_equity_snapshots_for_return_series");
  }
  if (trades.length < policy.minTradesForAdvanced) {
    warnings.push(`advanced_trade_metrics_limited_sample_${trades.length}`);
  }

  const dateRange = {
    fromMs: equityLoad.points[0]?.atMs ?? filters.fromMs ?? null,
    toMs: equityLoad.points[equityLoad.points.length - 1]?.atMs ?? filters.toMs ?? null,
  };

  return {
    label: ANALYTICS_SURFACE_LABEL,
    brokerageLabel: "Research / Brokerage V2 — Not Yet Authoritative",
    authoritative: false,
    advisoryKellyOnly: KELLY_ADVISORY_ONLY,
    methodologyVersion: ANALYTICS_METHODOLOGY_VERSION,
    aggregationLabel: `single_account:${account.account_key}:${account.account_type}`,
    policy: {
      returnInterval: policy.returnInterval,
      annualizationFactor: policy.annualizationFactor,
      riskFreeRate: policy.riskFreeRate,
      minTradesForAdvanced: policy.minTradesForAdvanced,
      minReturnObservations: policy.minReturnObservations,
      minDaysForAnnualization: policy.minDaysForAnnualization,
      varConfidence: policy.varConfidence,
      completeSnapshotsOnly: completeOnly,
    },
    dataQuality: {
      sampleSizeTrades: trades.length,
      sampleSizeEquityPoints: equityLoad.points.length,
      sampleSizeDailyReturns: dailyReturns(equityLoad.points).length,
      dateRange,
      completenessStatus: completeOnly ? "complete_filtered" : "includes_incomplete",
      missingMarkCount: allLoad.missingMarks,
      staleMarkCount: allLoad.staleMarks,
      incompleteSnapshotCount: allLoad.incompleteCount,
      excludedSnapshotCount: equityLoad.excludedCount,
      excludedTradeCount: excludedTrades,
      warnings,
    },
    performance,
    risk,
    options,
    exposure,
    kelly,
  };
}
