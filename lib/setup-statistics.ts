/**
 * setup-statistics.ts — the authoritative, deterministic statistics engine.
 *
 * PURE: no I/O, no DB. It aggregates ALREADY-GRADED outcomes (from the Phase-1
 * `paper_trade_outcomes` layer) into honest performance statistics + an explicit
 * evidence state. It NEVER fabricates numbers, never invents a probability, and
 * never claims an edge from a thin sample.
 *
 * Grading rules it relies on (Phase 1):
 *  - Only WIN / LOSS / BREAKEVEN rows are "graded". UNGRADABLE rows are counted
 *    for data-quality coverage but EXCLUDED from performance math.
 *  - P&L is NET of fees (slippage already embedded in the fill price).
 *
 * Ordering: drawdown / rolling windows / streaks use outcomes ordered by exit
 * time (the completion order), so the equity curve is chronologically honest.
 */
export const STATISTICS_VERSION = 1;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export type EvidenceState =
  | "NOT_TRACKED"
  | "INSUFFICIENT_HISTORY"
  | "EARLY_EVIDENCE"
  | "ESTABLISHED_EVIDENCE";

/** One normalized graded/ungradable outcome (subset of paper_trade_outcomes). */
export interface OutcomeStat {
  grade: string;               // WIN | LOSS | BREAKEVEN | UNGRADABLE
  gradingStatus: string;       // GRADED | UNGRADABLE
  dataQualityStatus?: string | null;
  netPnl: number | null;
  grossPnl: number | null;
  returnPct: number | null;
  rMultiple: number | null;
  entryFees: number | null;
  exitFees: number | null;
  entrySlippage: number | null;
  exitSlippage: number | null;
  holdMinutes: number | null;
  mfePct: number | null;
  maePct: number | null;
  exitTimeMs: number | null;   // ordering key
}

export interface EvidenceThresholds {
  earlyMin: number;            // graded ≥ this ⇒ at least EARLY
  establishedMin: number;      // graded ≥ this ⇒ candidate for ESTABLISHED
  establishedMinWins: number;
  establishedMinLosses: number;
  establishedMinCoverage: number; // 0..1 gradable coverage
}

export function defaultEvidenceThresholds(env: NodeJS.ProcessEnv = process.env): EvidenceThresholds {
  const n = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    earlyMin: n(env.EVIDENCE_EARLY_MIN, 20),
    establishedMin: n(env.EVIDENCE_ESTABLISHED_MIN, 100),
    establishedMinWins: n(env.EVIDENCE_ESTABLISHED_MIN_WINS, 20),
    establishedMinLosses: n(env.EVIDENCE_ESTABLISHED_MIN_LOSSES, 20),
    establishedMinCoverage: n(env.EVIDENCE_ESTABLISHED_MIN_COVERAGE, 0.95),
  };
}

export interface WilsonInterval { low: number; high: number; z: number }

/** Wilson score interval for a binomial proportion (95% by default). */
export function wilsonInterval(successes: number, trials: number, z = 1.96): WilsonInterval | null {
  if (!Number.isFinite(successes) || !Number.isFinite(trials) || trials <= 0) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  return { low: +Math.max(0, center - margin).toFixed(4), high: +Math.min(1, center + margin).toFixed(4), z };
}

export interface RollingWindow { window: number; count: number; netPnl: number; winRate: number | null }

export interface SetupStatistics {
  statisticsVersion: number;
  // counts
  totalOutcomes: number;
  gradedSampleSize: number;
  ungradableCount: number;
  dataQualityCoverage: number | null; // graded / (graded + ungradable)
  wins: number;
  losses: number;
  breakevens: number;
  decisive: number;                   // wins + losses
  // rates
  winRate: number | null;             // wins / decisive
  winRateInterval: WilsonInterval | null;
  // P&L (net of fees)
  grossPnl: number;
  netPnl: number;
  totalFees: number;
  recordedSlippage: number;
  avgWinner: number | null;
  avgLoser: number | null;
  payoffRatio: number | null;
  profitFactor: number | null;
  expectancyDollars: number | null;
  expectancyR: number | null;
  maxDrawdown: number;
  // excursions / timing
  avgHoldMinutes: number | null;
  medianHoldMinutes: number | null;
  avgMfePct: number | null;
  avgMaePct: number | null;
  // streaks
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  currentStreak: number;              // + wins / − losses
  // rolling
  rolling: RollingWindow[];
  // evidence
  evidenceState: EvidenceState;
  evidenceSummary: string;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round(v: number | null, dp = 2): number | null {
  return v == null ? null : +v.toFixed(dp);
}

function rollingWindow(orderedNet: number[], orderedGrade: string[], n: number): RollingWindow {
  const net = orderedNet.slice(-n);
  const grade = orderedGrade.slice(-n);
  const decisive = grade.filter((g) => g === "WIN" || g === "LOSS").length;
  const wins = grade.filter((g) => g === "WIN").length;
  return {
    window: n,
    count: net.length,
    netPnl: +net.reduce((s, v) => s + v, 0).toFixed(2),
    winRate: decisive > 0 ? +((wins / decisive) * 100).toFixed(1) : null,
  };
}

/** Aggregate graded outcomes into authoritative statistics + evidence. */
export function summarizeOutcomes(outcomes: OutcomeStat[], thresholds = defaultEvidenceThresholds()): SetupStatistics {
  const totalOutcomes = outcomes.length;
  const ungradable = outcomes.filter((o) => o.gradingStatus === "UNGRADABLE");
  const graded = outcomes
    .filter((o) => o.gradingStatus === "GRADED")
    .sort((a, b) => (a.exitTimeMs ?? 0) - (b.exitTimeMs ?? 0));

  const wins = graded.filter((o) => o.grade === "WIN");
  const losses = graded.filter((o) => o.grade === "LOSS");
  const breakevens = graded.filter((o) => o.grade === "BREAKEVEN");
  const decisive = wins.length + losses.length;

  const netOf = (o: OutcomeStat) => (isNum(o.netPnl) ? o.netPnl : 0);
  const orderedNet = graded.map(netOf);
  const orderedGrade = graded.map((o) => o.grade);

  const grossPnl = +graded.reduce((s, o) => s + (isNum(o.grossPnl) ? o.grossPnl : 0), 0).toFixed(2);
  const netPnl = +orderedNet.reduce((s, v) => s + v, 0).toFixed(2);
  const totalFees = +graded.reduce((s, o) => s + (o.entryFees ?? 0) + (o.exitFees ?? 0), 0).toFixed(2);
  const recordedSlippage = +graded.reduce((s, o) => s + (o.entrySlippage ?? 0) + (o.exitSlippage ?? 0), 0).toFixed(4);

  const grossWin = wins.reduce((s, o) => s + netOf(o), 0);
  const grossLoss = Math.abs(losses.reduce((s, o) => s + netOf(o), 0));
  const avgWinner = wins.length ? mean(wins.map(netOf)) : null;
  const avgLoser = losses.length ? mean(losses.map(netOf)) : null;
  const payoffRatio = avgWinner != null && avgLoser != null && avgLoser !== 0 ? Math.abs(avgWinner / avgLoser) : null;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : null; // null when undefined (no losses)
  const expectancyDollars = graded.length ? mean(orderedNet) : null;
  const rVals = graded.map((o) => o.rMultiple).filter((v): v is number => isNum(v));
  const expectancyR = rVals.length ? mean(rVals) : null;

  // Max drawdown on the cumulative NET equity curve, in exit order.
  let equity = 0, peak = 0, maxDd = 0;
  for (const v of orderedNet) { equity += v; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity); }

  // Streaks (decisive only; breakeven does not break a streak).
  let maxW = 0, maxL = 0, curW = 0, curL = 0, current = 0;
  for (const g of orderedGrade) {
    if (g === "WIN") { curW += 1; curL = 0; maxW = Math.max(maxW, curW); current = current >= 0 ? current + 1 : 1; }
    else if (g === "LOSS") { curL += 1; curW = 0; maxL = Math.max(maxL, curL); current = current <= 0 ? current - 1 : -1; }
  }

  const holds = graded.map((o) => o.holdMinutes).filter((v): v is number => isNum(v));
  const mfes = graded.map((o) => o.mfePct).filter((v): v is number => isNum(v));
  const maes = graded.map((o) => o.maePct).filter((v): v is number => isNum(v));

  const winRate = decisive > 0 ? wins.length / decisive : null;
  const winRateInterval = decisive > 0 ? wilsonInterval(wins.length, decisive) : null;
  const dataQualityCoverage = (graded.length + ungradable.length) > 0
    ? +(graded.length / (graded.length + ungradable.length)).toFixed(4)
    : null;

  const rolling = [20, 50, 100]
    .filter((n) => graded.length >= 1) // always show 20; 50/100 populate as data grows
    .map((n) => rollingWindow(orderedNet, orderedGrade, n));

  const summary: SetupStatistics = {
    statisticsVersion: STATISTICS_VERSION,
    totalOutcomes,
    gradedSampleSize: graded.length,
    ungradableCount: ungradable.length,
    dataQualityCoverage,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    decisive,
    winRate: winRate == null ? null : +(winRate * 100).toFixed(1),
    winRateInterval,
    grossPnl,
    netPnl,
    totalFees,
    recordedSlippage,
    avgWinner: round(avgWinner),
    avgLoser: round(avgLoser),
    payoffRatio: round(payoffRatio),
    profitFactor: round(profitFactor),
    expectancyDollars: round(expectancyDollars),
    expectancyR: round(expectancyR, 3),
    maxDrawdown: +maxDd.toFixed(2),
    avgHoldMinutes: round(mean(holds), 1),
    medianHoldMinutes: round(median(holds), 1),
    avgMfePct: round(mean(mfes), 1),
    avgMaePct: round(mean(maes), 1),
    maxConsecutiveWins: maxW,
    maxConsecutiveLosses: maxL,
    currentStreak: current,
    rolling,
    evidenceState: "NOT_TRACKED",
    evidenceSummary: "",
  };

  const ev = evidenceState(summary, thresholds);
  summary.evidenceState = ev.state;
  summary.evidenceSummary = ev.summary;
  return summary;
}

/** Explicit, configurable evidence state. High win rate alone never qualifies. */
export function evidenceState(s: SetupStatistics, t = defaultEvidenceThresholds()): { state: EvidenceState; summary: string } {
  const g = s.gradedSampleSize;
  if (g <= 0) return { state: "NOT_TRACKED", summary: "No graded outcomes yet — nothing to evaluate." };
  if (g < t.earlyMin) {
    return { state: "INSUFFICIENT_HISTORY", summary: `Only ${g} graded outcome${g === 1 ? "" : "s"} — far too few to draw any conclusion.` };
  }
  const established = g >= t.establishedMin
    && s.wins >= t.establishedMinWins
    && s.losses >= t.establishedMinLosses
    && (s.dataQualityCoverage ?? 0) >= t.establishedMinCoverage;
  if (established) {
    return { state: "ESTABLISHED_EVIDENCE", summary: `${g} graded outcomes (${s.wins}W/${s.losses}L, ${Math.round((s.dataQualityCoverage ?? 0) * 100)}% gradable) — an established sample. Past results still do not guarantee future performance.` };
  }
  return { state: "EARLY_EVIDENCE", summary: `${g} graded outcomes — early signal only; uncertainty is still wide (${s.wins}W/${s.losses}L).` };
}

/** Group outcomes by a key and summarize each group. */
export function aggregateBy(outcomes: OutcomeStat[], keyOf: (o: OutcomeStat) => string, thresholds = defaultEvidenceThresholds()): Array<{ key: string; stats: SetupStatistics }> {
  const groups = new Map<string, OutcomeStat[]>();
  for (const o of outcomes) {
    const k = keyOf(o);
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  return [...groups.entries()]
    .map(([key, os]) => ({ key, stats: summarizeOutcomes(os, thresholds) }))
    .sort((a, b) => b.stats.gradedSampleSize - a.stats.gradedSampleSize);
}
