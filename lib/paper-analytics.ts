/**
 * paper-analytics.ts — pure performance statistics for paper trading.
 *
 * Honest-stats rule applies here too: everything computes from REALIZED
 * entry→exit fills. MFE/MAE are reported as separate learning metrics and
 * never blended into returns.
 */

import { pnlDollars, pnlPct, TERMINAL_STATES, type PaperTrade } from "./paper-trading.ts";

export interface PaperSummary {
  openCount: number;
  closedCount: number;
  gradedCount: number; // closed AND filled (entry+exit prices exist)
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgGainPct: number | null;   // average of winning trades' %
  avgLossPct: number | null;   // average of losing trades' % (negative)
  profitFactor: number | null; // gross win $ / gross loss $
  expectancyDollars: number | null; // avg $ per graded trade
  totalPnlDollars: number;
  maxDrawdownDollars: number;  // peak-to-valley on cumulative realized P/L
  largestWinDollars: number | null;
  largestLossDollars: number | null;
  avgHoldMinutes: number | null;
  avgMfePct: number | null;
  avgMaePct: number | null;
}

function isGraded(t: PaperTrade): boolean {
  return TERMINAL_STATES.has(t.status) && t.entryPrice != null && t.exitPrice != null;
}

export function summarize(trades: PaperTrade[]): PaperSummary {
  const open = trades.filter((t) => !TERMINAL_STATES.has(t.status));
  const closed = trades.filter((t) => TERMINAL_STATES.has(t.status));
  const graded = closed
    .filter(isGraded)
    .sort((a, b) => (a.exitAtMs ?? 0) - (b.exitAtMs ?? 0));

  const pnls = graded.map((t) => pnlDollars(t) ?? 0);
  const pcts = graded.map((t) => pnlPct(t) ?? 0);
  const wins = graded.filter((t) => (pnlDollars(t) ?? 0) > 0);
  const losses = graded.filter((t) => (pnlDollars(t) ?? 0) < 0);

  const grossWin = wins.reduce((s, t) => s + (pnlDollars(t) ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (pnlDollars(t) ?? 0), 0));
  const total = pnls.reduce((s, v) => s + v, 0);

  // Max drawdown on the cumulative realized curve, in exit order.
  let peak = 0, equity = 0, maxDd = 0;
  for (const v of pnls) {
    equity += v;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }

  const holds = graded
    .filter((t) => t.entryAtMs != null && t.exitAtMs != null)
    .map((t) => ((t.exitAtMs as number) - (t.entryAtMs as number)) / 60000);

  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

  const winPcts = wins.map((t) => pnlPct(t) ?? 0);
  const lossPcts = losses.map((t) => pnlPct(t) ?? 0);
  const mfes = graded.map((t) => t.mfePct).filter((v): v is number => v != null);
  const maes = graded.map((t) => t.maePct).filter((v): v is number => v != null);

  return {
    openCount: open.length,
    closedCount: closed.length,
    gradedCount: graded.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: graded.length ? +((wins.length / graded.length) * 100).toFixed(1) : null,
    avgGainPct: avg(winPcts) != null ? +(avg(winPcts) as number).toFixed(1) : null,
    avgLossPct: avg(lossPcts) != null ? +(avg(lossPcts) as number).toFixed(1) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? Infinity : null),
    expectancyDollars: graded.length ? +(total / graded.length).toFixed(2) : null,
    totalPnlDollars: +total.toFixed(2),
    maxDrawdownDollars: +maxDd.toFixed(2),
    largestWinDollars: pnls.length ? +Math.max(...pnls, 0).toFixed(2) : null,
    largestLossDollars: pnls.length ? +Math.min(...pnls, 0).toFixed(2) : null,
    avgHoldMinutes: avg(holds) != null ? +(avg(holds) as number).toFixed(1) : null,
    avgMfePct: avg(mfes) != null ? +(avg(mfes) as number).toFixed(1) : null,
    avgMaePct: avg(maes) != null ? +(avg(maes) as number).toFixed(1) : null,
  };
}

// ── Bucket cuts (performance by …) ──────────────────────────────────────────

export interface BucketRow { bucket: string; count: number; winRatePct: number | null; avgPnlPct: number | null; totalDollars: number }

function cut(trades: PaperTrade[], bucketOf: (t: PaperTrade) => string): BucketRow[] {
  const graded = trades.filter(isGraded);
  const groups = new Map<string, PaperTrade[]>();
  for (const t of graded) {
    const b = bucketOf(t);
    groups.set(b, [...(groups.get(b) ?? []), t]);
  }
  return [...groups.entries()].map(([bucket, ts]) => {
    const wins = ts.filter((t) => (pnlDollars(t) ?? 0) > 0).length;
    const pcts = ts.map((t) => pnlPct(t) ?? 0);
    const dollars = ts.reduce((s, t) => s + (pnlDollars(t) ?? 0), 0);
    return {
      bucket,
      count: ts.length,
      winRatePct: +(wins / ts.length * 100).toFixed(1),
      avgPnlPct: +(pcts.reduce((s, v) => s + v, 0) / pcts.length).toFixed(1),
      totalDollars: +dollars.toFixed(2),
    };
  }).sort((a, b) => b.count - a.count);
}

/** Performance by scanner confidence bucket at entry. */
export function byConfidence(trades: PaperTrade[]): BucketRow[] {
  return cut(trades, (t) => {
    const c = t.confidence ?? 0;
    if (c >= 90) return "90+";
    if (c >= 80) return "80–89";
    if (c >= 70) return "70–79";
    if (c >= 60) return "60–69";
    return "<60";
  });
}

/** Performance by time-to-expiration at entry. */
export function byExpirationLength(trades: PaperTrade[]): BucketRow[] {
  return cut(trades, (t) => {
    const d = t.dteAtEntry;
    if (d == null) return "unknown";
    if (d < 1) return "0DTE";
    if (d <= 5) return "1–5 DTE";
    if (d <= 14) return "1–2 weeks";
    if (d <= 30) return "2–4 weeks";
    return ">4 weeks";
  });
}

/** Performance by option type (the closest v1 proxy for "setup"). */
export function bySetup(trades: PaperTrade[]): BucketRow[] {
  return cut(trades, (t) => `${t.optionType}${t.exitReason?.startsWith("smart") ? " · smart-exit" : ""}`);
}

/** Performance by exit kind — where the money is actually made/lost. */
export function byExitKind(trades: PaperTrade[]): BucketRow[] {
  return cut(trades, (t) => t.status);
}
