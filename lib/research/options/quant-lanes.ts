/**
 * Lane-labeled quant aggregates for options research — never blend lanes.
 *
 * `owner_validation_paper` is the forward-validation population the private callouts
 * actually produce, and it was missing from this union entirely — so the lane most
 * relevant to whether the callouts work had no row in the quant report at all. It is a
 * lane of its own, never merged into `delivered_alert_paper` (a different audience) or
 * `research_only_paper` (a different gate).
 */
import { buildShadowSoakAggregate } from "./shadow-outcomes.ts";
import { excursionForPaperTradeOnDb } from "../../opportunity-case/excursion.ts";

export type QuantLane =
  | "delivered_alert_paper"
  | "owner_validation_paper"
  | "shadow_would_send"
  | "shadow_would_block"
  | "research_only_paper"
  | "zero_dte_research_paper"
  | "historical_replay"
  | "supervisor_observations";

export interface LaneMetricBundle {
  lane: QuantLane;
  label: string;
  sampleSize: number;
  completenessPct: number;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  alerts: number;
  winners: number;
  losers: number;
  winRate: number | null;
  avgReturn: number | null;
  medianReturn: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  mfeAvg: number | null;
  maeAvg: number | null;
  mfeMaeRatio: number | null;
  t1HitRate: number | null;
  t2HitRate: number | null;
  stopHitRate: number | null;
  decisionQuality?: {
    severeLossesPrevented: number;
    largeWinnersBlocked: number;
    falsePositiveProxy: number | null;
    falseNegativeProxy: number | null;
  };
  segments?: Record<string, { n: number; winRate: number | null; expectancy: number | null }>;
  insufficientEvidence?: boolean;
}

type QuantDb = {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
};

const MIN_SAMPLE = 5;

function hasTable(db: QuantDb, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function profitFactor(wins: number[], losses: number[]): number | null {
  const w = wins.reduce((a, b) => a + b, 0);
  const l = Math.abs(losses.reduce((a, b) => a + b, 0));
  if (l === 0) return wins.length ? Infinity : null;
  return w / l;
}

function confidenceFor(n: number, completenessPct: number): "LOW" | "MEDIUM" | "HIGH" {
  if (n >= 30 && completenessPct >= 80) return "HIGH";
  if (n >= MIN_SAMPLE && completenessPct >= 50) return "MEDIUM";
  return "LOW";
}

/**
 * @param resolveExcursion recompute MFE/MAE from same-contract marks instead of reading
 *   the stored `mfe_pct`/`mae_pct` columns. Those columns are the ones an earlier packet
 *   found contaminated — 36 of 78 delivered cases carry a peak the frozen contract never
 *   printed, from running maxima poisoned by re-selected strikes. The owner lane is new
 *   and starts clean; the older lanes still read the stored columns and are deliberately
 *   left alone here, because moving their published numbers is a separate decision from
 *   repairing owner identity.
 */
function paperLaneMetrics(
  db: QuantDb,
  kind: string,
  lane: QuantLane,
  label: string,
  resolveExcursion = false,
): LaneMetricBundle {
  const empty: LaneMetricBundle = {
    lane, label, sampleSize: 0, completenessPct: 0, confidence: "LOW",
    alerts: 0, winners: 0, losers: 0, winRate: null, avgReturn: null, medianReturn: null,
    expectancy: null, profitFactor: null, avgWin: null, avgLoss: null,
    mfeAvg: null, maeAvg: null, mfeMaeRatio: null, t1HitRate: null, t2HitRate: null, stopHitRate: null,
    insufficientEvidence: true,
  };
  if (!hasTable(db, "options_paper_trades")) return empty;
  const raw = db.prepare(
    `SELECT id, option_symbol, return_pct, mfe_pct, mae_pct, exit_reason, strategy, status
     FROM options_paper_trades WHERE paper_kind=? AND status='EXITED' AND return_pct IS NOT NULL`,
  ).all(kind) as { id: number; option_symbol: string | null; return_pct: number; mfe_pct: number | null; mae_pct: number | null; exit_reason: string | null; strategy: string | null; status: string }[];
  // A trajectory claim needs a same-contract mark series dense enough to have seen the
  // extremes. Where it does not exist the value is null — never the stored number, and
  // never 0, which would assert an observation nobody made.
  const rows = resolveExcursion
    ? raw.map((r) => {
      const e = excursionForPaperTradeOnDb(db as never, Number(r.id), r.option_symbol);
      const verified = e.state === "VERIFIED_EXCURSION";
      return { ...r, mfe_pct: verified ? e.mfePct : null, mae_pct: verified ? e.maePct : null };
    })
    : raw;
  const returns = rows.map((r) => Number(r.return_pct));
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x <= 0);
  const graded = rows.length;
  const withMfe = rows.filter((r) => r.mfe_pct != null).length;
  const completenessPct = graded ? Math.round((withMfe / graded) * 1000) / 10 : 0;
  const t1 = rows.filter((r) => r.exit_reason === "target_hit").length;
  const stop = rows.filter((r) => r.exit_reason === "stop_hit").length;
  const t2 = rows.filter((r) => /t2|second/i.test(String(r.exit_reason ?? ""))).length;
  return {
    lane,
    label,
    sampleSize: graded,
    completenessPct,
    confidence: confidenceFor(graded, completenessPct),
    alerts: graded,
    winners: wins.length,
    losers: losses.length,
    winRate: graded ? wins.length / graded : null,
    avgReturn: avg(returns),
    medianReturn: median(returns),
    expectancy: avg(returns),
    profitFactor: profitFactor(wins, losses),
    avgWin: avg(wins),
    avgLoss: avg(losses),
    mfeAvg: avg(rows.map((r) => r.mfe_pct).filter((x): x is number => x != null)),
    maeAvg: avg(rows.map((r) => r.mae_pct).filter((x): x is number => x != null)),
    mfeMaeRatio: (() => {
      const mfe = avg(rows.map((r) => r.mfe_pct).filter((x): x is number => x != null));
      const mae = avg(rows.map((r) => r.mae_pct).filter((x): x is number => x != null));
      return mfe != null && mae != null && mae !== 0 ? Math.abs(mfe / mae) : null;
    })(),
    t1HitRate: graded ? t1 / graded : null,
    t2HitRate: graded ? t2 / graded : null,
    stopHitRate: graded ? stop / graded : null,
    segments: buildStrategySegments(rows.map((r) => ({ return_pct: Number(r.return_pct), strategy: r.strategy }))),
    insufficientEvidence: graded < MIN_SAMPLE,
  };
}

function buildStrategySegments(rows: { return_pct: number; strategy: string | null }[]): Record<string, { n: number; winRate: number | null; expectancy: number | null }> {
  const by: Record<string, number[]> = {};
  for (const r of rows) {
    const k = r.strategy ?? "unknown";
    (by[k] ??= []).push(Number(r.return_pct));
  }
  const out: Record<string, { n: number; winRate: number | null; expectancy: number | null }> = {};
  for (const [k, xs] of Object.entries(by)) {
    out[k] = {
      n: xs.length,
      winRate: xs.length ? xs.filter((x) => x > 0).length / xs.length : null,
      expectancy: avg(xs),
    };
  }
  return out;
}

function shadowLaneMetrics(db: QuantDb, wouldSend: boolean, lane: QuantLane, label: string): LaneMetricBundle {
  const empty: LaneMetricBundle = {
    lane, label, sampleSize: 0, completenessPct: 0, confidence: "LOW",
    alerts: 0, winners: 0, losers: 0, winRate: null, avgReturn: null, medianReturn: null,
    expectancy: null, profitFactor: null, avgWin: null, avgLoss: null,
    mfeAvg: null, maeAvg: null, mfeMaeRatio: null, t1HitRate: null, t2HitRate: null, stopHitRate: null,
    insufficientEvidence: true,
  };
  if (!hasTable(db, "options_shadow_outcomes")) return empty;
  const flag = wouldSend ? 1 : 0;
  const rows = db.prepare(
    `SELECT return_60m, mfe_pct, mae_pct, t1_hit, t2_hit, stop_hit, data_status, strategy, entry_quality_verdict, path
     FROM options_shadow_outcomes WHERE would_send=? AND path IN ('proposed','independent')`,
  ).all(flag) as {
    return_60m: number | null;
    mfe_pct: number | null;
    mae_pct: number | null;
    t1_hit: number | null;
    t2_hit: number | null;
    stop_hit: number | null;
    data_status: string;
    strategy: string | null;
    entry_quality_verdict: string | null;
    path: string;
  }[];
  const graded = rows.filter((r) => r.return_60m != null);
  const returns = graded.map((r) => Number(r.return_60m));
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x <= 0);
  const okRows = rows.filter((r) => r.data_status === "OK" || r.return_60m != null).length;
  const completenessPct = rows.length ? Math.round((okRows / rows.length) * 1000) / 10 : 0;
  const agg = buildShadowSoakAggregate(db as any, process.env, 14);
  return {
    lane,
    label,
    sampleSize: graded.length,
    completenessPct,
    confidence: confidenceFor(graded.length, completenessPct),
    alerts: rows.length,
    winners: wins.length,
    losers: losses.length,
    winRate: graded.length ? wins.length / graded.length : null,
    avgReturn: avg(returns),
    medianReturn: median(returns),
    expectancy: avg(returns),
    profitFactor: profitFactor(wins, losses),
    avgWin: avg(wins),
    avgLoss: avg(losses),
    mfeAvg: avg(graded.map((r) => r.mfe_pct).filter((x): x is number => x != null)),
    maeAvg: avg(graded.map((r) => r.mae_pct).filter((x): x is number => x != null)),
    mfeMaeRatio: (() => {
      const mfe = avg(graded.map((r) => r.mfe_pct).filter((x): x is number => x != null));
      const mae = avg(graded.map((r) => r.mae_pct).filter((x): x is number => x != null));
      return mfe != null && mae != null && mae !== 0 ? Math.abs(mfe / mae) : null;
    })(),
    t1HitRate: graded.length ? graded.filter((r) => r.t1_hit === 1).length / graded.length : null,
    t2HitRate: graded.length ? graded.filter((r) => r.t2_hit === 1).length / graded.length : null,
    stopHitRate: graded.length ? graded.filter((r) => r.stop_hit === 1).length / graded.length : null,
    decisionQuality: wouldSend ? undefined : {
      severeLossesPrevented: agg.severeLossesPrevented,
      largeWinnersBlocked: agg.largeWinnersBlocked,
      falsePositiveProxy: null,
      falseNegativeProxy: null,
    },
    segments: buildStrategySegments(graded.map((r) => ({ return_pct: Number(r.return_60m), strategy: r.strategy }))),
    insufficientEvidence: graded.length < MIN_SAMPLE,
  };
}

export function buildQuantLaneReport(db: QuantDb, env: NodeJS.ProcessEnv = process.env): {
  generatedAtMs: number;
  minSample: number;
  lanes: LaneMetricBundle[];
} {
  return {
    generatedAtMs: Date.now(),
    minSample: MIN_SAMPLE,
    lanes: [
      paperLaneMetrics(db, "DELIVERED_ALERT_PAPER", "delivered_alert_paper", "Real delivered subscriber"),
      paperLaneMetrics(db, "OWNER_VALIDATION_PAPER", "owner_validation_paper", "Owner validation (private callouts)", true),
      shadowLaneMetrics(db, true, "shadow_would_send", "Shadow would-send"),
      shadowLaneMetrics(db, false, "shadow_would_block", "Shadow would-block"),
      paperLaneMetrics(db, "RESEARCH_ONLY_PAPER", "research_only_paper", "Research-only paper"),
      paperLaneMetrics(db, "ZERO_DTE_RESEARCH_PAPER", "zero_dte_research_paper", "0DTE research paper"),
      {
        lane: "historical_replay",
        label: "Historical replay",
        sampleSize: 0,
        completenessPct: 0,
        confidence: "LOW",
        alerts: 0,
        winners: 0,
        losers: 0,
        winRate: null,
        avgReturn: null,
        medianReturn: null,
        expectancy: null,
        profitFactor: null,
        avgWin: null,
        avgLoss: null,
        mfeAvg: null,
        maeAvg: null,
        mfeMaeRatio: null,
        t1HitRate: null,
        t2HitRate: null,
        stopHitRate: null,
        insufficientEvidence: true,
      },
      {
        lane: "supervisor_observations",
        label: "Supervisor observations",
        sampleSize: hasTable(db, "options_shadow_decisions")
          ? Number((db.prepare("SELECT COUNT(*) n FROM options_shadow_decisions WHERE path='supervisor'").get() as { n: number })?.n ?? 0)
          : 0,
        completenessPct: 0,
        confidence: "LOW",
        alerts: 0,
        winners: 0,
        losers: 0,
        winRate: null,
        avgReturn: null,
        medianReturn: null,
        expectancy: null,
        profitFactor: null,
        avgWin: null,
        avgLoss: null,
        mfeAvg: null,
        maeAvg: null,
        mfeMaeRatio: null,
        t1HitRate: null,
        t2HitRate: null,
        stopHitRate: null,
        insufficientEvidence: true,
      },
    ],
  };
}
