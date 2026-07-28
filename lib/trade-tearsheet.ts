/**
 * Trade journal tearsheet metrics (quantstats/empyrical-inspired for discrete trades).
 * Pure over PnL series — no broker calls.
 */
export interface JournalTrade {
  pnl: number;
  closedAtMs?: number | null;
}

export interface TearsheetMetrics {
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoffRatio: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  kellyFraction: number | null;
  maxConsecutiveLosses: number;
  sumPnl: number;
  maxDrawdown: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  recoveryFactor: number | null;
  outlierWinRatio: number | null;
  tailRatio: number | null;
  equityCurve: Array<{ i: number; equity: number; pnl: number }>;
  note: string;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

export function buildTearsheet(trades: JournalTrade[]): TearsheetMetrics {
  const pnls = trades.map((t) => Number(t.pnl)).filter((x) => Number.isFinite(x));
  const wins = pnls.filter((x) => x > 0);
  const losses = pnls.filter((x) => x < 0);
  const avgWin = mean(wins);
  const avgLoss = mean(losses.map((x) => Math.abs(x)));
  const payoffRatio = avgWin != null && avgLoss != null && avgLoss > 0 ? avgWin / avgLoss : null;
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : null;
  const winRate = pnls.length ? wins.length / pnls.length : null;
  const expectancy = mean(pnls);
  const kellyFraction =
    winRate != null && payoffRatio != null && payoffRatio > 0
      ? +((winRate - (1 - winRate) / payoffRatio)).toFixed(4)
      : null;

  let maxConsecutiveLosses = 0;
  let streak = 0;
  for (const p of pnls) {
    if (p < 0) {
      streak += 1;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
    } else streak = 0;
  }

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equityCurve: TearsheetMetrics["equityCurve"] = [];
  for (let i = 0; i < pnls.length; i++) {
    equity += pnls[i];
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
    equityCurve.push({ i, equity: +equity.toFixed(2), pnl: pnls[i] });
  }

  const sd = stdev(pnls);
  const sharpe = expectancy != null && sd != null && sd > 0 ? +(expectancy / sd).toFixed(4) : null;
  const downside = pnls.filter((x) => x < 0);
  const dstd = stdev(downside);
  const sortino = expectancy != null && dstd != null && dstd > 0 ? +(expectancy / dstd).toFixed(4) : null;
  const calmar = expectancy != null && maxDrawdown > 0 ? +(expectancy / maxDrawdown).toFixed(4) : null;
  const recoveryFactor = maxDrawdown > 0 ? +(equity / maxDrawdown).toFixed(4) : null;

  const sortedWins = [...wins].sort((a, b) => a - b);
  const sortedAll = [...pnls].sort((a, b) => a - b);
  const p95 = percentile(sortedWins, 0.95);
  const medianWin = percentile(sortedWins, 0.5);
  const outlierWinRatio = p95 != null && medianWin != null && medianWin > 0 ? +(p95 / medianWin).toFixed(4) : null;
  const p95All = percentile(sortedAll, 0.95);
  const p05All = percentile(sortedAll, 0.05);
  const tailRatio =
    p95All != null && p05All != null && Math.abs(p05All) > 0 ? +(p95All / Math.abs(p05All)).toFixed(4) : null;

  return {
    n: pnls.length,
    wins: wins.length,
    losses: losses.length,
    winRate: winRate != null ? +winRate.toFixed(4) : null,
    avgWin: avgWin != null ? +avgWin.toFixed(4) : null,
    avgLoss: avgLoss != null ? +avgLoss.toFixed(4) : null,
    payoffRatio: payoffRatio != null ? +payoffRatio.toFixed(4) : null,
    profitFactor: profitFactor == null ? null : Number.isFinite(profitFactor) ? +profitFactor.toFixed(4) : null,
    expectancy: expectancy != null ? +expectancy.toFixed(4) : null,
    kellyFraction,
    maxConsecutiveLosses,
    sumPnl: +pnls.reduce((a, b) => a + b, 0).toFixed(2),
    maxDrawdown: pnls.length ? +maxDrawdown.toFixed(2) : null,
    sharpe,
    sortino,
    calmar,
    recoveryFactor,
    outlierWinRatio,
    tailRatio,
    equityCurve,
    note: "Discrete-trade tearsheet from journal PnL. Sharpe/Sortino are per-trade, not annualized calendar returns.",
  };
}

type TearDb = {
  prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] };
};

export function loadJournalTradesOnDb(db: TearDb): JournalTrade[] {
  // Schema has pnl + closed_at; no status column — use closed_at or any realized pnl.
  try {
    const rows = db.prepare(
      `SELECT pnl, closed_at AS closedAt FROM trade_journal
       WHERE pnl IS NOT NULL
       ORDER BY COALESCE(closed_at, created_at, id) ASC`,
    ).all() as Array<{ pnl: number; closedAt: string | null }>;
    return rows.map((r) => ({
      pnl: Number(r.pnl),
      closedAtMs: r.closedAt ? Date.parse(String(r.closedAt)) : null,
    }));
  } catch {
    return [];
  }
}
