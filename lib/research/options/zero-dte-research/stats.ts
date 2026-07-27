/**
 * Stats + account snapshot for Aggressive 0DTE Research (read-only).
 */

import { ensureZeroDteAccountState, recomputeZeroDteEquity } from "./ledger.ts";
import { zeroDteResearchConfig } from "./config.ts";

export interface StatsDb {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
}

export interface PerfSegment {
  key: string;
  n: number;
  winRate: number | null;
  avgReturn: number | null;
  expectancy: number | null;
  captureEfficiency: number | null;
}

function dayStartApprox(nowMs: number): number {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
  const [y, m, d] = date.split("-").map(Number);
  const probe = new Date(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00-04:00`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(probe);
  const hourEt = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
  return probe.getTime() - hourEt * 3600_000;
}

function avg(xs: number[]): number | null {
  if (!xs.length) return null;
  return +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4);
}

function occRoot(optionSymbol: unknown): string | null {
  return String(optionSymbol ?? "").match(/^O:([A-Z]+)/)?.[1] ?? null;
}

function captureForRow(r: Record<string, unknown>): number | null {
  const ret = Number(r.return_pct);
  const mfe = Number(r.mfe_pct);
  if (!Number.isFinite(ret) || !Number.isFinite(mfe) || mfe <= 0) return null;
  return ret / mfe;
}

function segmentFromRows(key: string, rows: Record<string, unknown>[]): PerfSegment {
  const rets = rows.map((r) => Number(r.return_pct)).filter(Number.isFinite);
  const wins = rets.filter((x) => x > 0);
  const captures = rows.map(captureForRow).filter((x): x is number => x != null && Number.isFinite(x));
  const mean = avg(rets);
  return {
    key,
    n: rets.length,
    winRate: rets.length ? +(wins.length / rets.length).toFixed(4) : null,
    avgReturn: mean,
    expectancy: mean,
    captureEfficiency: avg(captures),
  };
}

function groupSegments(rows: Record<string, unknown>[], keyFn: (r: Record<string, unknown>) => string): PerfSegment[] {
  const by = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = keyFn(r) || "unknown";
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(r);
  }
  return [...by.entries()]
    .map(([k, rs]) => segmentFromRows(k, rs))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

function buildEquityCurve(
  startingBalanceUsd: number,
  closedChrono: Record<string, unknown>[],
): { t: number; equity: number }[] {
  const points: { t: number; equity: number }[] = [];
  let equity = startingBalanceUsd;
  if (!closedChrono.length) {
    points.push({ t: 0, equity: +equity.toFixed(2) });
    return points;
  }
  const firstT = Number(closedChrono[0]!.exit_at_ms ?? closedChrono[0]!.entered_at_ms ?? 0);
  points.push({ t: Number.isFinite(firstT) ? firstT - 1 : 0, equity: +startingBalanceUsd.toFixed(2) });
  for (const r of closedChrono) {
    const pnl = Number(r.pnl ?? 0);
    equity += Number.isFinite(pnl) ? pnl : 0;
    const t = Number(r.exit_at_ms ?? r.entered_at_ms ?? 0);
    points.push({ t: Number.isFinite(t) ? t : points.length, equity: +equity.toFixed(2) });
  }
  return points;
}

function fillEventTime(r: Record<string, unknown>): number {
  if (String(r.status) === "EXITED") {
    return Number(r.exit_at_ms ?? r.updated_at_ms ?? r.entered_at_ms ?? 0);
  }
  return Number(r.entered_at_ms ?? r.updated_at_ms ?? 0);
}

export function buildZeroDteResearchSnapshot(db: StatsDb, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()) {
  const cfg = zeroDteResearchConfig(env);
  const account = ensureZeroDteAccountState(db as any, env, nowMs);
  const equity = recomputeZeroDteEquity(db as any, nowMs);
  const since = dayStartApprox(nowMs);

  const openRows = db.prepare(
    `SELECT * FROM options_paper_trades WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND status='ENTERED' ORDER BY entered_at_ms DESC`,
  ).all() as Record<string, unknown>[];
  const closedAll = db.prepare(
    `SELECT * FROM options_paper_trades WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND status='EXITED' AND return_pct IS NOT NULL`,
  ).all() as Record<string, unknown>[];
  const todayRows = db.prepare(
    `SELECT * FROM options_paper_trades WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND entered_at_ms >= ?`,
  ).all(since) as Record<string, unknown>[];
  const closedToday = closedAll.filter((r) => Number(r.exit_at_ms ?? 0) >= since);

  const rets = closedAll.map((r) => Number(r.return_pct)).filter((n) => Number.isFinite(n));
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r <= 0);
  const sumWin = wins.reduce((a, b) => a + b, 0);
  const sumLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const pf = sumLoss > 0 ? +(sumWin / sumLoss).toFixed(4) : (wins.length ? null : null);
  const realizedToday = closedToday.reduce((s, r) => s + Number(r.pnl ?? 0), 0);
  const unrealized = openRows.reduce((s, r) => {
    const entry = Number(r.entry_fill ?? 0);
    const ret = Number(r.last_mark_return_pct ?? 0);
    return s + entry * 100 * (ret / 100);
  }, 0);

  const openRiskUsd = +openRows.reduce((s, r) => s + Number(r.account_risk_usd ?? 0), 0).toFixed(2);
  const openExposureUsd = +openRows.reduce((s, r) => s + Number(r.entry_fill ?? 0) * 100, 0).toFixed(2);
  const buyingPowerUsd = +Math.max(0, account.cashUsd - openExposureUsd).toFixed(2);

  const byFamily = new Map<string, number[]>();
  const byBucket = new Map<string, number[]>();
  const byMoney = new Map<string, number[]>();
  for (const r of closedAll) {
    const ret = Number(r.return_pct);
    if (!Number.isFinite(ret)) continue;
    const f = String(r.strategy_family ?? r.strategy ?? "unknown");
    const b = String(r.time_bucket ?? "other");
    const m = String(r.contract_moneyness ?? "ATM");
    if (!byFamily.has(f)) byFamily.set(f, []);
    if (!byBucket.has(b)) byBucket.set(b, []);
    if (!byMoney.has(m)) byMoney.set(m, []);
    byFamily.get(f)!.push(ret);
    byBucket.get(b)!.push(ret);
    byMoney.get(m)!.push(ret);
  }
  const bestFamily = [...byFamily.entries()].sort((a, b) => avg(b[1])! - avg(a[1])!)[0]?.[0] ?? null;
  const worstFamily = [...byFamily.entries()].sort((a, b) => avg(a[1])! - avg(b[1])!)[0]?.[0] ?? null;
  const bestBucket = [...byBucket.entries()].sort((a, b) => avg(b[1])! - avg(a[1])!)[0]?.[0] ?? null;
  const worstBucket = [...byBucket.entries()].sort((a, b) => avg(a[1])! - avg(b[1])!)[0]?.[0] ?? null;

  const openSorted = [...openRows].sort(
    (a, b) => Number(b.last_mark_return_pct ?? 0) - Number(a.last_mark_return_pct ?? 0),
  );

  const captures = closedAll.map(captureForRow).filter((x): x is number => x != null && Number.isFinite(x));
  const captureEfficiency = avg(captures);

  const strategyFamilyPerformance = groupSegments(closedAll, (r) => String(r.strategy_family ?? r.strategy ?? "unknown"));
  const spyVsQqq = groupSegments(closedAll, (r) => {
    const root = occRoot(r.option_symbol);
    if (root === "SPY") return "SPY";
    if (root === "QQQ") return "QQQ";
    return "other";
  });
  const callsVsPuts = groupSegments(closedAll, (r) => {
    const s = String(r.side ?? "").toLowerCase();
    if (s === "call" || s === "c") return "call";
    if (s === "put" || s === "p") return "put";
    return "unknown";
  });
  const moneyness = groupSegments(closedAll, (r) => String(r.contract_moneyness ?? "ATM"));
  const timeOfDay = groupSegments(closedAll, (r) => String(r.time_bucket ?? "other"));
  const exitPolicyPerformance = groupSegments(closedAll, (r) => String(r.exit_policy_version ?? "unknown"));

  const closedChrono = [...closedAll].sort(
    (a, b) => Number(a.exit_at_ms ?? a.entered_at_ms ?? 0) - Number(b.exit_at_ms ?? b.entered_at_ms ?? 0),
  );
  const equityCurve = buildEquityCurve(account.startingBalanceUsd, closedChrono);

  const recentPool = [
    ...openRows,
    ...(db.prepare(
      `SELECT * FROM options_paper_trades WHERE paper_kind='ZERO_DTE_RESEARCH_PAPER' AND status='EXITED' ORDER BY COALESCE(exit_at_ms, updated_at_ms, entered_at_ms) DESC LIMIT 30`,
    ).all() as Record<string, unknown>[]),
  ]
    .sort((a, b) => fillEventTime(b) - fillEventTime(a))
    .slice(0, 15);

  const recentFills = recentPool.map((r) => ({
    id: r.id,
    status: r.status,
    symbol: occRoot(r.option_symbol),
    optionSymbol: r.option_symbol,
    side: r.side,
    family: r.strategy_family ?? r.strategy,
    entry: r.entry_fill,
    exit: r.exit_fill,
    returnPct: r.return_pct ?? r.last_mark_return_pct,
    pnl: r.pnl,
    exitReason: r.exit_reason,
    exitPolicy: r.exit_policy_version,
    moneyness: r.contract_moneyness,
    atMs: fillEventTime(r),
  }));

  return {
    label: "Aggressive 0DTE Research — simulated only",
    enabled: cfg.enabled,
    account: {
      equityUsd: equity,
      cashUsd: account.cashUsd,
      startingBalanceUsd: account.startingBalanceUsd,
      dailyPnlUsd: +realizedToday.toFixed(2),
      unrealizedPnlUsd: +unrealized.toFixed(2),
      realizedPnlUsd: +closedAll.reduce((s, r) => s + Number(r.pnl ?? 0), 0).toFixed(2),
      openRiskUsd,
      buyingPowerUsd,
      openExposureUsd,
    },
    today: {
      trades: todayRows.length,
      spy: todayRows.filter((r) => String(r.option_symbol ?? "").includes(":SPY")).length,
      qqq: todayRows.filter((r) => String(r.option_symbol ?? "").includes(":QQQ")).length,
      open: openRows.length,
    },
    performance: {
      winRate: rets.length ? +(wins.length / rets.length).toFixed(4) : null,
      expectancy: avg(rets),
      profitFactor: pf,
      avgMfePct: avg(closedAll.map((r) => Number(r.mfe_pct)).filter(Number.isFinite)),
      avgMaePct: avg(closedAll.map((r) => Number(r.mae_pct)).filter(Number.isFinite)),
      avgHoldMinutes: avg(
        closedAll
          .map((r) => (Number(r.exit_at_ms) - Number(r.entered_at_ms)) / 60_000)
          .filter((n) => Number.isFinite(n) && n >= 0),
      ),
      captureEfficiency,
      bestFamily,
      worstFamily,
      bestTimeBucket: bestBucket,
      worstTimeBucket: worstBucket,
      byMoneyness: Object.fromEntries([...byMoney.entries()].map(([k, v]) => [k, { n: v.length, avgReturn: avg(v) }])),
      callsVsPuts: {
        calls: closedAll.filter((r) => String(r.side) === "call").length,
        puts: closedAll.filter((r) => String(r.side) === "put").length,
      },
      spyVsQqq: {
        spy: closedAll.filter((r) => String(r.option_symbol ?? "").includes(":SPY")).length,
        qqq: closedAll.filter((r) => String(r.option_symbol ?? "").includes(":QQQ")).length,
      },
      gradedSample: rets.length,
    },
    strategyFamilyPerformance,
    spyVsQqq,
    callsVsPuts,
    moneyness,
    timeOfDay,
    exitPolicyPerformance,
    captureEfficiency,
    equityCurve,
    recentFills,
    openPositions: openRows.map((r) => ({
      id: r.id,
      symbol: occRoot(r.option_symbol),
      optionSymbol: r.option_symbol,
      side: r.side,
      family: r.strategy_family,
      entry: r.entry_fill,
      unrealizedPct: r.last_mark_return_pct,
      mfePct: r.mfe_pct,
      maePct: r.mae_pct,
      exitPolicy: r.exit_policy_version,
      moneyness: r.contract_moneyness,
      accountRiskUsd: r.account_risk_usd,
      enteredAtMs: r.entered_at_ms,
    })),
    bestOpen: openSorted[0]
      ? { symbol: occRoot(openSorted[0].option_symbol), returnPct: openSorted[0].last_mark_return_pct }
      : null,
    worstOpen: openSorted.length
      ? {
          symbol: occRoot(openSorted[openSorted.length - 1]!.option_symbol),
          returnPct: openSorted[openSorted.length - 1]!.last_mark_return_pct,
        }
      : null,
  };
}
