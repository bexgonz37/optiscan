import { getDb } from "@/lib/db";

export type QuantRecommendation = "trade" | "watch_only" | "avoid";

export type QuantStats = {
  setupType: string;
  assetClass: "options" | "stock";
  sampleSize: number;
  winRate: number | null;
  averageGain: number | null;
  averageLoss: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  maxDrawdown: number | null;
  averageHoldMinutes: number | null;
  bestTimeOfDay: string | null;
  bestMarketRegime: string | null;
  bestTickerTypes: string | null;
  bestVolumeCondition: string | null;
  bestIvCondition: string | null;
  recentExpectancy: number | null;
  confidenceScore: number;
  grade: string;
  recommendation: QuantRecommendation;
  dataQuality: "empty" | "limited" | "developing" | "strong";
  warning: string | null;
};

export type BacktestFilters = {
  setupType?: string;
  ticker?: string;
  assetClass?: "options" | "stock";
  timeOfDay?: string;
  marketRegime?: string;
  minRelativeVolume?: number;
  maxRelativeVolume?: number;
  minDelta?: number;
  maxDelta?: number;
  minIv?: number;
  maxIv?: number;
  maxDte?: number;
  stopLossPct?: number;
  profitTargetPct?: number;
  trailingStopPct?: number;
  maxHoldMinutes?: number;
  since?: string;
  until?: string;
};

type OutcomeRow = {
  ticker: string;
  asset_class: "options" | "stock";
  setup_type: string;
  return_pct: number | null;
  pnl: number | null;
  hold_minutes: number | null;
  mfe_pct: number | null;
  mae_pct: number | null;
  market_regime: string | null;
  session: string | null;
  entry_time: string | null;
};

const MIN_SAMPLE_FOR_HIGH_CONFIDENCE = 30;
const MIN_SAMPLE_FOR_GRADE_A = 50;
const MIN_SAMPLE_FOR_TRADE = 25;

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avg(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(v: number | null): number | null {
  return v == null ? null : Math.round(v * 100) / 100;
}

function timeBucket(iso?: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "unknown";
  const et = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: "America/New_York",
  }).format(d);
  const hour = Number(et);
  if (hour < 9) return "premarket";
  if (hour < 11) return "open";
  if (hour < 14) return "midday";
  if (hour < 16) return "power_hour";
  return "afterhours";
}

function tickerType(ticker: string): string {
  const t = ticker.toUpperCase();
  if (["SPY", "QQQ", "IWM", "DIA", "TQQQ", "SQQQ"].includes(t)) return "index_etf";
  if (["AAPL", "MSFT", "NVDA", "TSLA", "META", "AMZN", "GOOGL", "AMD", "NFLX"].includes(t)) return "mega_cap";
  return "momentum_name";
}

export function inferSetupType(row: any): string {
  const asset = row.asset_class ?? row.assetClass;
  const source = row.source ?? "";
  const session = row.session ?? "";
  const direction = row.direction ?? "";
  const tier = row.alert_tier ?? row.alertTier ?? "";
  const capture = row.capture_action ?? row.captureAction ?? "";
  const moveStatus = row.move_status ?? row.moveStatus ?? "";
  const bias = row.trade_bias ?? row.tradeBias ?? "";

  if (asset === "stock") {
    if (session === "premarket") return direction === "bearish" ? "premarket_stock_short" : "premarket_stock_long";
    if (session === "afterhours") return direction === "bearish" ? "afterhours_stock_short" : "afterhours_stock_long";
    return direction === "bearish" ? "regular_stock_short" : "regular_stock_long";
  }
  if (capture === "TRADE" || tier === "trade") {
    if (bias === "long_put" || row.option_side === "put" || row.optionSide === "put") return "0dte_put_momentum_trade";
    return "0dte_call_momentum_trade";
  }
  if (moveStatus === "exhausted") return "0dte_exhaustion_watch";
  if (source === "unusual") return "unusual_options_flow";
  return direction === "bearish" ? "0dte_put_watch" : "0dte_call_watch";
}

function maxDrawdownFromReturns(returns: number[]): number | null {
  if (!returns.length) return null;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of returns) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
  }
  return maxDd;
}

function modeByAvg(rows: OutcomeRow[], keyFn: (r: OutcomeRow) => string | null): string | null {
  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    const key = keyFn(r);
    const ret = num(r.return_pct);
    if (!key || ret == null) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(ret);
  }
  let best: { key: string; avg: number; n: number } | null = null;
  for (const [key, vals] of buckets) {
    const a = avg(vals);
    if (a == null) continue;
    if (!best || vals.length >= 3 && a > best.avg) best = { key, avg: a, n: vals.length };
  }
  return best?.key ?? null;
}

export function computeQuantStats(rows: OutcomeRow[], setupType: string, assetClass: "options" | "stock"): QuantStats {
  const returns = rows.map((r) => num(r.return_pct)).filter((v): v is number => v != null);
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const sampleSize = returns.length;
  const winRate = sampleSize ? wins.length / sampleSize : null;
  const averageGain = avg(wins);
  const averageLoss = avg(losses);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : null;
  const expectancy = avg(returns);
  const recentExpectancy = avg(returns.slice(-Math.min(20, returns.length)));
  const maxDrawdown = maxDrawdownFromReturns(returns);
  const averageHoldMinutes = avg(rows.map((r) => num(r.hold_minutes)).filter((v): v is number => v != null));

  const sampleScore = Math.min(35, (sampleSize / MIN_SAMPLE_FOR_HIGH_CONFIDENCE) * 35);
  const expectancyScore = expectancy == null ? 0 : Math.max(0, Math.min(30, (expectancy + 5) * 3));
  const winScore = winRate == null ? 0 : Math.max(0, Math.min(20, (winRate - 0.4) * 100));
  const drawdownScore = maxDrawdown == null ? 0 : Math.max(0, Math.min(15, 15 + maxDrawdown / 2));
  const confidenceScore = Math.round(Math.max(0, Math.min(100, sampleScore + expectancyScore + winScore + drawdownScore)));

  const dataQuality = sampleSize === 0 ? "empty"
    : sampleSize < 10 ? "limited"
    : sampleSize < MIN_SAMPLE_FOR_HIGH_CONFIDENCE ? "developing"
    : "strong";
  const overfitWarning = sampleSize < MIN_SAMPLE_FOR_HIGH_CONFIDENCE
    ? `Only ${sampleSize} measured outcome${sampleSize === 1 ? "" : "s"}; do not treat this as a proven edge.`
    : null;
  const losingWarning = expectancy != null && expectancy <= 0 ? "Historical expectancy is not positive for this setup." : null;
  const warning = overfitWarning ?? losingWarning;

  let grade = "F";
  if (sampleSize >= MIN_SAMPLE_FOR_GRADE_A && confidenceScore >= 85 && (expectancy ?? -1) > 2 && (profitFactor ?? 0) >= 1.8) grade = "A+";
  else if (sampleSize >= MIN_SAMPLE_FOR_HIGH_CONFIDENCE && confidenceScore >= 75 && (expectancy ?? -1) > 1 && (profitFactor ?? 0) >= 1.35) grade = "A";
  else if (sampleSize >= 15 && confidenceScore >= 62 && (expectancy ?? -1) > 0) grade = "B";
  else if (sampleSize >= 8 && confidenceScore >= 45) grade = "C";
  else if (sampleSize > 0) grade = "D";

  const recommendation: QuantRecommendation =
    sampleSize >= MIN_SAMPLE_FOR_TRADE && (expectancy ?? -1) > 0.5 && confidenceScore >= 68 ? "trade"
      : (expectancy ?? 0) < 0 || confidenceScore < 30 ? "avoid"
        : "watch_only";

  return {
    setupType,
    assetClass,
    sampleSize,
    winRate,
    averageGain: pct(averageGain),
    averageLoss: pct(averageLoss),
    profitFactor: profitFactor == null ? null : pct(profitFactor),
    expectancy: pct(expectancy),
    maxDrawdown: pct(maxDrawdown),
    averageHoldMinutes: pct(averageHoldMinutes),
    bestTimeOfDay: modeByAvg(rows, (r) => timeBucket(r.entry_time)),
    bestMarketRegime: modeByAvg(rows, (r) => r.market_regime ?? "unknown"),
    bestTickerTypes: modeByAvg(rows, (r) => tickerType(r.ticker)),
    bestVolumeCondition: null,
    bestIvCondition: null,
    recentExpectancy: pct(recentExpectancy),
    confidenceScore,
    grade,
    recommendation,
    dataQuality,
    warning,
  };
}

function outcomeRows(where = "", params: unknown[] = []): OutcomeRow[] {
  return getDb().prepare(
    `SELECT ticker, asset_class, setup_type, return_pct, pnl, hold_minutes, mfe_pct, mae_pct,
            market_regime, session, entry_time
       FROM trade_outcomes ${where}
       ORDER BY COALESCE(entry_time, created_at) ASC`,
  ).all(...params) as OutcomeRow[];
}

export function syncQuantOutcomes(): { inserted: number } {
  const db = getDb();
  const paper = db.prepare(
    `INSERT OR IGNORE INTO trade_outcomes (
       alert_id, paper_trade_id, ticker, asset_class, setup_type, side, option_symbol,
       entry_price, exit_price, quantity, entry_time, exit_time, hold_minutes, pnl,
       return_pct, mfe_pct, mae_pct, market_regime, session, entry_reason, exit_reason, source
     )
     SELECT p.alert_id, p.id, p.ticker,
       CASE WHEN p.option_symbol IS NULL THEN 'stock' ELSE 'options' END,
       CASE
         WHEN a.id IS NOT NULL THEN
           CASE
             WHEN a.asset_class='stock' AND a.session='premarket' AND a.direction='bearish' THEN 'premarket_stock_short'
             WHEN a.asset_class='stock' AND a.session='premarket' THEN 'premarket_stock_long'
             WHEN a.asset_class='stock' AND a.session='afterhours' AND a.direction='bearish' THEN 'afterhours_stock_short'
             WHEN a.asset_class='stock' AND a.session='afterhours' THEN 'afterhours_stock_long'
             WHEN COALESCE(a.option_side,p.option_type)='put' THEN '0dte_put_momentum_trade'
             ELSE '0dte_call_momentum_trade'
           END
         WHEN p.option_symbol IS NULL AND p.option_type='put' THEN 'stock_short_scalp'
         WHEN p.option_symbol IS NULL THEN 'stock_long_scalp'
         WHEN p.option_type='put' THEN '0dte_put_momentum_trade'
         ELSE '0dte_call_momentum_trade'
       END,
       p.option_type, p.option_symbol, p.entry_price, p.exit_price, p.contracts,
       CASE WHEN p.entry_at_ms IS NOT NULL THEN datetime(p.entry_at_ms/1000,'unixepoch') END,
       CASE WHEN p.exit_at_ms IS NOT NULL THEN datetime(p.exit_at_ms/1000,'unixepoch') END,
       CASE WHEN p.entry_at_ms IS NOT NULL AND p.exit_at_ms IS NOT NULL THEN (p.exit_at_ms-p.entry_at_ms)/60000.0 END,
       CASE WHEN p.entry_price IS NOT NULL AND p.exit_price IS NOT NULL
            THEN (p.exit_price-p.entry_price)*COALESCE(p.contracts,1)*CASE WHEN p.option_symbol IS NULL THEN 1 ELSE 100 END END,
       CASE WHEN p.entry_price IS NOT NULL AND p.exit_price IS NOT NULL AND p.entry_price > 0
            THEN ((p.exit_price-p.entry_price)/p.entry_price)*100 END,
       p.mfe_pct, p.mae_pct, COALESCE(a.catalyst_type,'unknown'), COALESCE(a.session,'unknown'),
       COALESCE(p.entry_reason,p.thesis), p.exit_reason, 'paper'
     FROM paper_trades p
     LEFT JOIN alerts a ON a.id=p.alert_id
     WHERE p.status IN ('EXITED','STOPPED_OUT','TAKE_PROFIT','EXPIRED')
       AND p.entry_price IS NOT NULL AND p.exit_price IS NOT NULL`,
  ).run().changes;

  const journal = db.prepare(
    `INSERT OR IGNORE INTO trade_outcomes (
       alert_id, journal_id, ticker, asset_class, setup_type, side, option_symbol,
       entry_price, exit_price, quantity, entry_time, exit_time, hold_minutes, pnl,
       return_pct, mfe_pct, mae_pct, market_regime, session, entry_reason, exit_reason, source
     )
     SELECT j.alert_id, j.id, j.ticker,
       CASE WHEN LOWER(COALESCE(j.side,''))='shares' THEN 'stock' ELSE 'options' END,
       CASE
         WHEN a.asset_class='stock' AND a.session='premarket' AND a.direction='bearish' THEN 'premarket_stock_short'
         WHEN a.asset_class='stock' AND a.session='premarket' THEN 'premarket_stock_long'
         WHEN a.asset_class='stock' AND a.session='afterhours' AND a.direction='bearish' THEN 'afterhours_stock_short'
         WHEN a.asset_class='stock' AND a.session='afterhours' THEN 'afterhours_stock_long'
         WHEN LOWER(COALESCE(j.side,a.option_side,''))='put' THEN '0dte_put_momentum_trade'
         WHEN LOWER(COALESCE(j.side,a.option_side,''))='shares' AND a.direction='bearish' THEN 'stock_short_scalp'
         WHEN LOWER(COALESCE(j.side,a.option_side,''))='shares' THEN 'stock_long_scalp'
         ELSE '0dte_call_momentum_trade'
       END,
       j.side, COALESCE(j.contract,a.option_symbol), j.entry_price, j.exit_price, j.quantity,
       j.opened_at, j.closed_at,
       CASE WHEN j.opened_at IS NOT NULL AND j.closed_at IS NOT NULL
            THEN (julianday(j.closed_at)-julianday(j.opened_at))*24*60 END,
       j.pnl, j.outcome_pct, NULL, NULL, COALESCE(a.catalyst_type,'unknown'), COALESCE(a.session,'unknown'),
       j.entry_reason, j.exit_reason, 'journal'
     FROM trade_journal j
     LEFT JOIN alerts a ON a.id=j.alert_id
     WHERE j.entry_price IS NOT NULL AND j.exit_price IS NOT NULL
       AND (j.outcome_pct IS NOT NULL OR j.pnl IS NOT NULL)`,
  ).run().changes;
  return { inserted: paper + journal };
}

export function refreshSetupStatistics(): QuantStats[] {
  syncQuantOutcomes();
  const rows = outcomeRows();
  const grouped = new Map<string, OutcomeRow[]>();
  for (const row of rows) {
    const key = `${row.asset_class}:${row.setup_type}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }
  const stats = [...grouped.entries()].map(([key, group]) => {
    const [assetClass, setupType] = key.split(":") as ["options" | "stock", string];
    return computeQuantStats(group, setupType, assetClass);
  });
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO setup_statistics (
       setup_type, asset_class, market_regime, time_bucket, sample_size, win_rate,
       average_gain, average_loss, profit_factor, expectancy, max_drawdown,
       average_hold_minutes, best_time_of_day, best_market_regime, best_ticker_types,
       best_volume_condition, best_iv_condition, recent_expectancy, confidence_score,
       grade, recommendation, data_quality, warning, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(setup_type, asset_class, market_regime, time_bucket) DO UPDATE SET
       sample_size=excluded.sample_size, win_rate=excluded.win_rate,
       average_gain=excluded.average_gain, average_loss=excluded.average_loss,
       profit_factor=excluded.profit_factor, expectancy=excluded.expectancy,
       max_drawdown=excluded.max_drawdown, average_hold_minutes=excluded.average_hold_minutes,
       best_time_of_day=excluded.best_time_of_day, best_market_regime=excluded.best_market_regime,
       best_ticker_types=excluded.best_ticker_types, best_volume_condition=excluded.best_volume_condition,
       best_iv_condition=excluded.best_iv_condition, recent_expectancy=excluded.recent_expectancy,
       confidence_score=excluded.confidence_score, grade=excluded.grade,
       recommendation=excluded.recommendation, data_quality=excluded.data_quality,
       warning=excluded.warning, updated_at=excluded.updated_at`,
  );
  for (const s of stats) {
    upsert.run(
      s.setupType, s.assetClass, "all", "all", s.sampleSize, s.winRate,
      s.averageGain, s.averageLoss, s.profitFactor, s.expectancy, s.maxDrawdown,
      s.averageHoldMinutes, s.bestTimeOfDay, s.bestMarketRegime, s.bestTickerTypes,
      s.bestVolumeCondition, s.bestIvCondition, s.recentExpectancy, s.confidenceScore,
      s.grade, s.recommendation, s.dataQuality, s.warning,
    );
  }
  return stats.sort((a, b) => b.confidenceScore - a.confidenceScore);
}

export function listSetupStats(): QuantStats[] {
  const existing = getDb().prepare(
    `SELECT setup_type, asset_class, sample_size, win_rate, average_gain, average_loss,
            profit_factor, expectancy, max_drawdown, average_hold_minutes,
            best_time_of_day, best_market_regime, best_ticker_types,
            best_volume_condition, best_iv_condition, recent_expectancy,
            confidence_score, grade, recommendation, data_quality, warning
       FROM setup_statistics
       ORDER BY confidence_score DESC, sample_size DESC`,
  ).all() as any[];
  if (!existing.length) return refreshSetupStatistics();
  return existing.map((r) => ({
    setupType: r.setup_type,
    assetClass: r.asset_class,
    sampleSize: r.sample_size,
    winRate: r.win_rate,
    averageGain: r.average_gain,
    averageLoss: r.average_loss,
    profitFactor: r.profit_factor,
    expectancy: r.expectancy,
    maxDrawdown: r.max_drawdown,
    averageHoldMinutes: r.average_hold_minutes,
    bestTimeOfDay: r.best_time_of_day,
    bestMarketRegime: r.best_market_regime,
    bestTickerTypes: r.best_ticker_types,
    bestVolumeCondition: r.best_volume_condition,
    bestIvCondition: r.best_iv_condition,
    recentExpectancy: r.recent_expectancy,
    confidenceScore: r.confidence_score,
    grade: r.grade,
    recommendation: r.recommendation,
    dataQuality: r.data_quality,
    warning: r.warning,
  }));
}

export function scoreAlert(alertId: number) {
  const alert: any = getDb().prepare("SELECT * FROM alerts WHERE id=?").get(alertId);
  if (!alert) return null;
  const setupType = inferSetupType(alert);
  const assetClass = (alert.asset_class === "stock" ? "stock" : "options") as "options" | "stock";
  let stat = listSetupStats().find((s) => s.setupType === setupType && s.assetClass === assetClass);
  if (!stat) stat = computeQuantStats([], setupType, assetClass);
  const stopPct = assetClass === "stock"
    ? (alert.direction === "bearish" ? 2 : -2)
    : -35;
  const targetPct = stat.expectancy != null && stat.expectancy > 0 ? Math.max(15, Math.round(stat.expectancy * 2)) : assetClass === "stock" ? 4 : 50;
  const prediction = {
    alertId,
    ticker: alert.ticker,
    setupType,
    assetClass,
    grade: stat.grade,
    historicalWinRate: stat.winRate,
    expectancy: stat.expectancy,
    confidenceScore: stat.confidenceScore,
    recommendation: stat.recommendation,
    suggestedStop: `${stopPct}%`,
    suggestedTarget: `+${targetPct}%`,
    bestHoldTimeMinutes: stat.averageHoldMinutes,
    warning: stat.warning ?? "Historical/statistical analysis only; not financial advice.",
  };
  getDb().prepare(
    `INSERT INTO model_predictions (alert_id, setup_type, prediction_json, grade, confidence_score, recommendation)
     VALUES (?,?,?,?,?,?)`,
  ).run(alertId, setupType, JSON.stringify(prediction), stat.grade, stat.confidenceScore, stat.recommendation);
  return prediction;
}

export function bestSetupPlan() {
  const stats = listSetupStats();
  const top = stats.filter((s) => s.recommendation !== "avoid").slice(0, 5);
  const avoid = stats.filter((s) => s.recommendation === "avoid" || s.grade === "F").slice(0, 5);
  const dataRows: any = getDb().prepare(
    `SELECT
       (SELECT COUNT(*) FROM historical_alerts) AS historical_alerts,
       (SELECT COUNT(*) FROM trade_outcomes) AS trade_outcomes,
       (SELECT COUNT(*) FROM alerts) AS alerts,
       (SELECT COUNT(*) FROM paper_trades) AS paper_trades`,
  ).get();
  return {
    generatedAt: new Date().toISOString(),
    disclaimer: "This is historical/statistical analysis, not financial advice.",
    dataCoverage: {
      historicalAlerts: dataRows?.historical_alerts ?? 0,
      tradeOutcomes: dataRows?.trade_outcomes ?? 0,
      liveAlerts: dataRows?.alerts ?? 0,
      paperTrades: dataRows?.paper_trades ?? 0,
      status: (dataRows?.historical_alerts ?? 0) >= 1000 ? "historical_connected" : "needs_5y_history_adapter",
      note: "Connect five years of historical alerts/options outcomes into historical_alerts and trade_outcomes for institutional-grade confidence.",
    },
    focusToday: top.map((s) => ({
      setupType: s.setupType,
      grade: s.grade,
      confidenceScore: s.confidenceScore,
      winRate: s.winRate,
      expectancy: s.expectancy,
      idealEntry: s.assetClass === "stock"
        ? "Directional tape, relative volume expansion, clean VWAP/HOD/LOD structure."
        : "Fresh 0DTE momentum with aligned speed, tight spread, usable delta, and not exhausted.",
      suggestedStop: s.assetClass === "stock" ? "2% adverse move or VWAP failure" : "35% option premium loss or thesis invalidation",
      suggestedTarget: s.expectancy != null && s.expectancy > 0 ? `${Math.round(s.expectancy * 2)}%+ expected edge target` : "Take partials quickly until more samples exist",
      idealHoldTime: s.averageHoldMinutes != null ? `${Math.round(s.averageHoldMinutes)} min` : "Unknown until more outcomes close",
      riskLevel: s.dataQuality === "strong" && (s.maxDrawdown ?? -99) > -20 ? "moderate" : "experimental",
      reason: s.warning ?? `${s.sampleSize} samples with positive expectancy.`,
    })),
    ignoreToday: avoid.map((s) => ({
      setupType: s.setupType,
      grade: s.grade,
      reason: s.warning ?? "Weak historical edge.",
    })),
  };
}

export function runBacktest(filters: BacktestFilters = {}) {
  syncQuantOutcomes();
  const where: string[] = ["return_pct IS NOT NULL"];
  const params: unknown[] = [];
  if (filters.setupType) { where.push("setup_type=?"); params.push(filters.setupType); }
  if (filters.ticker) { where.push("ticker=?"); params.push(filters.ticker.toUpperCase()); }
  if (filters.assetClass) { where.push("asset_class=?"); params.push(filters.assetClass); }
  if (filters.marketRegime) { where.push("market_regime=?"); params.push(filters.marketRegime); }
  if (filters.since) { where.push("COALESCE(entry_time, created_at) >= ?"); params.push(filters.since); }
  if (filters.until) { where.push("COALESCE(entry_time, created_at) <= ?"); params.push(filters.until); }
  let rows = outcomeRows(`WHERE ${where.join(" AND ")}`, params);
  if (filters.timeOfDay) rows = rows.filter((r) => timeBucket(r.entry_time) === filters.timeOfDay);

  const stop = num(filters.stopLossPct);
  const target = num(filters.profitTargetPct);
  const simulated = rows.map((r) => {
    let ret = num(r.return_pct) ?? 0;
    if (target != null && num(r.mfe_pct) != null && (r.mfe_pct as number) >= target) ret = target;
    if (stop != null && num(r.mae_pct) != null && (r.mae_pct as number) <= -Math.abs(stop)) ret = -Math.abs(stop);
    return ret;
  });
  const wins = simulated.filter((r) => r > 0);
  const losses = simulated.filter((r) => r < 0);
  const result = {
    totalTrades: simulated.length,
    winRate: simulated.length ? wins.length / simulated.length : null,
    averageReturn: pct(avg(simulated)),
    medianReturn: pct(median(simulated)),
    expectancy: pct(avg(simulated)),
    sharpeLike: (() => {
      const a = avg(simulated);
      if (a == null || simulated.length < 2) return null;
      const variance = avg(simulated.map((r) => Math.pow(r - a, 2))) ?? 0;
      const sd = Math.sqrt(variance);
      return sd > 0 ? pct(a / sd) : null;
    })(),
    maxDrawdown: pct(maxDrawdownFromReturns(simulated)),
    bestPeriods: [],
    worstPeriods: [],
    equityCurve: simulated.reduce((acc, r, i) => {
      const prev = (i ? acc[i - 1].equity : 0) ?? 0;
      acc.push({ trade: i + 1, equity: pct(prev + r) });
      return acc;
    }, [] as Array<{ trade: number; equity: number | null }>),
    recommendedParameters: {
      stopLossPct: stop ?? (filters.assetClass === "stock" ? 2 : 35),
      profitTargetPct: target ?? pct(Math.max(10, (avg(wins) ?? 10))),
      maxHoldMinutes: filters.maxHoldMinutes ?? pct(avg(rows.map((r) => num(r.hold_minutes)).filter((v): v is number => v != null))),
    },
    warning: simulated.length < MIN_SAMPLE_FOR_HIGH_CONFIDENCE
      ? `Only ${simulated.length} trades matched. Treat this as research, not proof.`
      : null,
  };
  getDb().prepare(
    `INSERT INTO backtest_results (filters_json, result_json, total_trades, win_rate, expectancy, max_drawdown, sharpe_like)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(JSON.stringify(filters), JSON.stringify(result), result.totalTrades, result.winRate, result.expectancy, result.maxDrawdown, result.sharpeLike);
  return result;
}

export function performanceDashboard() {
  const stats = refreshSetupStatistics();
  const backtests = getDb().prepare("SELECT * FROM backtest_results ORDER BY id DESC LIMIT 10").all();
  return {
    plan: bestSetupPlan(),
    stats,
    backtests,
    disclaimer: "This is historical/statistical analysis, not financial advice.",
  };
}

