import { isOptionsQuoteSession } from "../../market-session-guard.ts";

export const ENTRY_RETURN_MINUTES = [1, 3, 5, 10, 15, 30, 60] as const;
export type LossClassification =
  | "BAD_ENTRY"
  | "LATE_ENTRY"
  | "PREMIUM_CHASE"
  | "THESIS_FAILED_IMMEDIATELY"
  | "PROFIT_GIVEN_BACK"
  | "STOP_TOO_WIDE"
  | "EXIT_TOO_SLOW"
  | "THETA_DECAY"
  | "LIQUIDITY_OR_MARK_ERROR"
  | "UNKNOWN";

export interface ExitResearchMark {
  markAtMs: number;
  bid: number | null;
  ask: number | null;
  quoteAgeMs: number | null;
  createdAtMs?: number | null;
}

export interface ExitResearchUnderlyingObservation {
  observedAtMs: number;
  setupValid?: boolean | null;
  momentumScore?: number | null;
  volume?: number | null;
}

export interface ExitResearchTrade {
  tradeId: number;
  alertId: string | null;
  symbol: string;
  side: "call" | "put" | string;
  optionSymbol: string;
  dte: number | null;
  strategyFamily: string | null;
  marketRegime: string | null;
  timeBucket: string | null;
  entryQuality: string | null;
  entryFill: number;
  enteredAtMs: number;
  targetT1: number | null;
  targetT2: number | null;
  stop: number | null;
  status: string;
  exitFill: number | null;
  exitAtMs: number | null;
  canonicalReturnPct: number | null;
  exitReason: string | null;
  marks: ExitResearchMark[];
  underlyingObservations?: ExitResearchUnderlyingObservation[];
}

export interface PolicyResult {
  policy: string;
  returnPct: number | null;
  exitAtMs: number | null;
  exitBid: number | null;
  reason: string;
  evidenceValid: boolean;
}

export interface TradeExitResearch {
  tradeId: number;
  entryFill: number;
  entryReturns: Record<string, number | null>;
  mfePct: number | null;
  maePct: number | null;
  realizedReturnPct: number | null;
  timeToMfeMs: number | null;
  timeFromMfeToExitMs: number | null;
  captureEfficiencyPct: number | null;
  t1Reached: boolean;
  profitableBeforeStopping: boolean;
  thesisWeakeningAvailable: boolean;
  extendedAtEntry: boolean | null;
  lossClassification: LossClassification;
  bestGainPct: number | null;
  finalResultPct: number | null;
  profitCapturedPct: number | null;
  gaveBackProfit: boolean;
  earliestDefensibleExit: string;
  policies: PolicyResult[];
}

export interface PolicyAggregate {
  policy: string;
  sampleSize: number;
  winRatePct: number | null;
  averageReturnPct: number | null;
  medianReturnPct: number | null;
  profitFactor: number | null;
  totalPnlUsd: number;
  averageMfePct: number | null;
  averageMaePct: number | null;
  captureEfficiencyPct: number | null;
  stopRatePct: number | null;
  t1RatePct: number | null;
  largestLossPct: number | null;
  maximumDrawdownUsd: number;
  supported: boolean;
}

export interface ExitPolicyResearchReport {
  advisoryOnly: true;
  productionBehaviorChanged: false;
  minimumSupportedSample: number;
  trades: TradeExitResearch[];
  policies: PolicyAggregate[];
  profitableThenLostCount: number;
  profitableTradeCount: number;
  bestSupportedPolicy: string | null;
  limitations: string[];
}

type ValidMark = ExitResearchMark & { bid: number; ask: number; returnPct: number };

function round(value: number, digits = 4): number {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function validMarks(trade: ExitResearchTrade, maxQuoteAgeMs: number): ValidMark[] {
  return trade.marks
    .filter((mark) => {
      if (
        mark.bid == null || !Number.isFinite(mark.bid) || mark.bid <= 0
        || mark.ask == null || !Number.isFinite(mark.ask) || mark.ask <= 0
        || mark.ask < mark.bid
        || mark.quoteAgeMs == null || !Number.isFinite(mark.quoteAgeMs)
        || mark.quoteAgeMs < 0 || mark.quoteAgeMs > maxQuoteAgeMs
        || !Number.isFinite(mark.markAtMs) || mark.markAtMs < trade.enteredAtMs
      ) return false;
      if (!isOptionsQuoteSession(mark.markAtMs)) return false;
      if (mark.createdAtMs != null) {
        const persistedDelay = mark.createdAtMs - mark.markAtMs;
        if (!Number.isFinite(persistedDelay) || persistedDelay < 0 || persistedDelay > maxQuoteAgeMs) return false;
      }
      return true;
    })
    .map((mark) => ({
      ...mark,
      bid: mark.bid as number,
      ask: mark.ask as number,
      returnPct: round((((mark.bid as number) - trade.entryFill) / trade.entryFill) * 100),
    }))
    .sort((a, b) => a.markAtMs - b.markAtMs);
}

function finalCanonical(trade: ExitResearchTrade, marks: ValidMark[]): PolicyResult {
  if (trade.status === "EXITED" && trade.exitFill != null && trade.canonicalReturnPct != null) {
    return {
      policy: "Current policy",
      returnPct: trade.canonicalReturnPct,
      exitAtMs: trade.exitAtMs,
      exitBid: trade.exitFill,
      reason: trade.exitReason ?? "canonical exit",
      evidenceValid: true,
    };
  }
  const last = marks.at(-1);
  return {
    policy: "Current policy",
    returnPct: last?.returnPct ?? null,
    exitAtMs: last?.markAtMs ?? null,
    exitBid: last?.bid ?? null,
    reason: last ? "latest verified open mark" : "no verified mark",
    evidenceValid: Boolean(last),
  };
}

function twoConsecutiveExit(
  marks: ValidMark[],
  startsAt: number,
  predicate: (mark: ValidMark, index: number) => boolean,
): ValidMark | null {
  let consecutive = 0;
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    if (mark.markAtMs < startsAt) continue;
    consecutive = predicate(mark, index) ? consecutive + 1 : 0;
    if (consecutive >= 2) return mark;
  }
  return null;
}

function resultFromMark(policy: string, mark: ValidMark | null, fallback: PolicyResult, reason: string): PolicyResult {
  return mark
    ? {
      policy,
      returnPct: mark.returnPct,
      exitAtMs: mark.markAtMs,
      exitBid: mark.bid,
      reason,
      evidenceValid: true,
    }
    : { ...fallback, policy, reason: "exit condition not confirmed; canonical result retained" };
}

function partialAtT1(trade: ExitResearchTrade, marks: ValidMark[], fallback: PolicyResult): PolicyResult {
  if (!(trade.targetT1 != null && trade.targetT1 > 0)) {
    return { ...fallback, policy: "Partial at T1", reason: "T1 unavailable; canonical result retained" };
  }
  const t1 = marks.find((mark) => mark.bid >= (trade.targetT1 as number));
  if (!t1) return { ...fallback, policy: "Partial at T1", reason: "T1 not reached" };
  const remainder = marks.find((mark) =>
    mark.markAtMs > t1.markAtMs
    && (
      (trade.targetT2 != null && mark.bid >= trade.targetT2)
      || mark.bid <= trade.entryFill
    ));
  const rest = remainder ?? marks.at(-1) ?? t1;
  const firstReturn = ((t1.bid - trade.entryFill) / trade.entryFill) * 100;
  const secondReturn = ((rest.bid - trade.entryFill) / trade.entryFill) * 100;
  return {
    policy: "Partial at T1",
    returnPct: round(firstReturn * 0.5 + secondReturn * 0.5),
    exitAtMs: rest.markAtMs,
    exitBid: round(t1.bid * 0.5 + rest.bid * 0.5),
    reason: remainder ? "50% at T1; remainder at T2 or protected entry" : "50% at T1; remainder at latest verified bid",
    evidenceValid: true,
  };
}

function breakEven(trade: ExitResearchTrade, marks: ValidMark[], fallback: PolicyResult, threshold: number): PolicyResult {
  const activated = marks.find((mark) => mark.returnPct >= threshold);
  if (!activated) return { ...fallback, policy: `Break-even +${threshold}%`, reason: `+${threshold}% activation not reached` };
  const exit = twoConsecutiveExit(marks, activated.markAtMs, (mark) => mark.bid <= trade.entryFill);
  return resultFromMark(`Break-even +${threshold}%`, exit, fallback, "two verified bids at or below entry after activation");
}

function trailing(trade: ExitResearchTrade, marks: ValidMark[], fallback: PolicyResult, distancePct: number): PolicyResult {
  let high = trade.entryFill;
  let armedAt: number | null = null;
  const thresholds = new Map<number, number>();
  for (const mark of marks) {
    if (mark.bid > high) {
      high = mark.bid;
      // Arm ONCE, at the first high above entry. Re-arming on every subsequent high moved the
      // scan window forward to the global peak, so the simulation could only ever exit after the
      // best price of the whole trade -- it could not clip a winner, and every winner came back
      // "condition not confirmed". A real trail exits at the FIRST confirmed retracement.
      armedAt ??= mark.markAtMs;
    }
    thresholds.set(mark.markAtMs, high * (1 - distancePct / 100));
  }
  if (armedAt == null) return { ...fallback, policy: `Trail ${distancePct}%`, reason: "trade never became profitable" };
  const exit = twoConsecutiveExit(
    marks,
    armedAt,
    (mark) => mark.bid <= Number(thresholds.get(mark.markAtMs)),
  );
  return resultFromMark(`Trail ${distancePct}%`, exit, fallback, "two verified bids below the trailing profit lock");
}

function timeStop(trade: ExitResearchTrade, marks: ValidMark[], fallback: PolicyResult, minutes: number): PolicyResult {
  const horizon = trade.enteredAtMs + minutes * 60_000;
  const mark = marks.find((candidate) => candidate.markAtMs >= horizon);
  if (!mark || mark.returnPct >= 5) {
    return { ...fallback, policy: `Time stop ${minutes}m`, reason: mark ? "trade progressed at least 5%" : "horizon mark unavailable" };
  }
  return resultFromMark(`Time stop ${minutes}m`, mark, fallback, "less than 5% progress at the configured horizon");
}

function underlyingThesisExit(
  trade: ExitResearchTrade,
  marks: ValidMark[],
  fallback: PolicyResult,
): PolicyResult {
  const observations = (trade.underlyingObservations ?? [])
    .filter((observation) =>
      Number.isFinite(observation.observedAtMs)
      && observation.observedAtMs >= trade.enteredAtMs + 60_000
      && isOptionsQuoteSession(observation.observedAtMs)
    )
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
  let consecutiveInvalid = 0;
  let confirmedAtMs: number | null = null;
  for (const observation of observations) {
    consecutiveInvalid = observation.setupValid === false ? consecutiveInvalid + 1 : 0;
    if (consecutiveInvalid >= 2) {
      confirmedAtMs = observation.observedAtMs;
      break;
    }
  }
  if (confirmedAtMs == null) {
    return {
      ...fallback,
      policy: "Underlying thesis exit",
      reason: observations.length
        ? "no two-observation underlying invalidation"
        : "underlying invalidation observations unavailable",
      evidenceValid: false,
    };
  }
  const mark = marks.find((candidate) => candidate.markAtMs >= confirmedAtMs);
  return resultFromMark(
    "Underlying thesis exit",
    mark ?? null,
    fallback,
    "two consecutive timestamped underlying invalidation observations",
  );
}

function momentumStallExit(
  trade: ExitResearchTrade,
  marks: ValidMark[],
  fallback: PolicyResult,
): PolicyResult {
  const observations = (trade.underlyingObservations ?? [])
    .filter((observation) =>
      Number.isFinite(observation.observedAtMs)
      && observation.observedAtMs >= trade.enteredAtMs + 60_000
      && observation.momentumScore != null
      && Number.isFinite(observation.momentumScore)
      && isOptionsQuoteSession(observation.observedAtMs)
    )
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
  if (observations.length < 3) {
    return {
      ...fallback,
      policy: "Momentum-stall exit",
      reason: "momentum observations unavailable",
      evidenceValid: false,
    };
  }
  const baseline = Number(observations[0].momentumScore);
  let consecutiveWeak = 0;
  let confirmedAtMs: number | null = null;
  for (const observation of observations.slice(1)) {
    const weakened = Number(observation.momentumScore) <= baseline - 15;
    consecutiveWeak = weakened ? consecutiveWeak + 1 : 0;
    if (consecutiveWeak >= 2) {
      confirmedAtMs = observation.observedAtMs;
      break;
    }
  }
  if (confirmedAtMs == null) {
    return {
      ...fallback,
      policy: "Momentum-stall exit",
      reason: "no two-observation momentum deterioration",
      evidenceValid: false,
    };
  }
  const mark = marks.find((candidate) => candidate.markAtMs >= confirmedAtMs);
  return resultFromMark(
    "Momentum-stall exit",
    mark ?? null,
    fallback,
    "momentum score declined at least 15 points for two observations",
  );
}

function classifyLoss(
  trade: ExitResearchTrade,
  marks: ValidMark[],
  mfePct: number | null,
  finalPct: number | null,
  timeFromPeakMs: number | null,
): LossClassification {
  if (finalPct == null || marks.length === 0) return "LIQUIDITY_OR_MARK_ERROR";
  if (finalPct >= 0) return "UNKNOWN";
  if ((mfePct ?? 0) >= 10) return "PROFIT_GIVEN_BACK";
  const minute3 = marks.find((mark) => mark.markAtMs >= trade.enteredAtMs + 3 * 60_000);
  if (minute3 && minute3.returnPct <= -20) return "THESIS_FAILED_IMMEDIATELY";
  if (/extended|chase/i.test(trade.entryQuality ?? "")) return "PREMIUM_CHASE";
  if (timeFromPeakMs != null && timeFromPeakMs >= 15 * 60_000) return "EXIT_TOO_SLOW";
  if (trade.exitReason === "time_stop" && (trade.dte ?? 1) === 0) return "THETA_DECAY";
  if (trade.stop != null && ((trade.entryFill - trade.stop) / trade.entryFill) * 100 > 40) return "STOP_TOO_WIDE";
  return "BAD_ENTRY";
}

export function analyzeExitPolicies(
  trades: ExitResearchTrade[],
  opts: { maxQuoteAgeMs?: number; minimumSupportedSample?: number } = {},
): ExitPolicyResearchReport {
  const maxQuoteAgeMs = opts.maxQuoteAgeMs ?? 60_000;
  const minimumSupportedSample = opts.minimumSupportedSample ?? 30;
  const analyzed: TradeExitResearch[] = trades.map((trade) => {
    const marks = validMarks(trade, maxQuoteAgeMs);
    const fallback = finalCanonical(trade, marks);
    const returns = marks.map((mark) => mark.returnPct);
    const best = returns.length ? Math.max(...returns) : null;
    const worst = returns.length ? Math.min(...returns) : null;
    const mfeMark = best == null ? null : marks.find((mark) => mark.returnPct === best) ?? null;
    const finalPct = fallback.returnPct;
    const captureEfficiencyPct = best != null && best > 0 && finalPct != null
      ? round((finalPct / best) * 100)
      : null;
    const entryReturns: Record<string, number | null> = {};
    for (const minute of ENTRY_RETURN_MINUTES) {
      const mark = marks.find((candidate) => candidate.markAtMs >= trade.enteredAtMs + minute * 60_000);
      entryReturns[`${minute}m`] = mark?.returnPct ?? null;
    }
    const t1Reached = trade.targetT1 != null && marks.some((mark) => mark.bid >= (trade.targetT1 as number));
    const policies = [
      fallback,
      partialAtT1(trade, marks, fallback),
      ...[10, 15, 20, 25].map((threshold) => breakEven(trade, marks, fallback, threshold)),
      ...[10, 15, 20, 25].map((distance) => trailing(trade, marks, fallback, distance)),
      ...[5, 10, 15, 30].map((minutes) => timeStop(trade, marks, fallback, minutes)),
    ];
    if (trade.dte === 0) {
      const breakEven10 = policies.find((policy) => policy.policy === "Break-even +10%");
      const trail10 = policies.find((policy) => policy.policy === "Trail 10%");
      const candidates = [breakEven10, trail10].filter((policy): policy is PolicyResult => Boolean(policy?.evidenceValid));
      policies.push(
        candidates.sort((a, b) => Number(a.exitAtMs ?? Infinity) - Number(b.exitAtMs ?? Infinity))[0]
          ? { ...candidates[0], policy: "0DTE protection", reason: "earliest verified +10% break-even or 10% trail" }
          : { ...fallback, policy: "0DTE protection", reason: "insufficient verified marks" },
      );
    }
    policies.push(underlyingThesisExit(trade, marks, fallback));
    policies.push(momentumStallExit(trade, marks, fallback));

    const timeFromPeakMs = mfeMark && trade.exitAtMs != null
      ? Math.max(0, trade.exitAtMs - mfeMark.markAtMs)
      : null;
    const gaveBackProfit = (best ?? 0) >= 10 && (finalPct ?? 0) <= 0;
    return {
      tradeId: trade.tradeId,
      entryFill: trade.entryFill,
      entryReturns,
      mfePct: best,
      maePct: worst,
      realizedReturnPct: trade.canonicalReturnPct,
      timeToMfeMs: mfeMark ? mfeMark.markAtMs - trade.enteredAtMs : null,
      timeFromMfeToExitMs: timeFromPeakMs,
      captureEfficiencyPct,
      t1Reached,
      profitableBeforeStopping: (best ?? 0) > 0 && (finalPct ?? 0) < 0,
      thesisWeakeningAvailable: Boolean(trade.underlyingObservations?.length),
      extendedAtEntry: trade.entryQuality == null ? null : /extended|chase/i.test(trade.entryQuality),
      lossClassification: classifyLoss(trade, marks, best, finalPct, timeFromPeakMs),
      bestGainPct: best,
      finalResultPct: finalPct,
      profitCapturedPct: captureEfficiencyPct,
      gaveBackProfit,
      earliestDefensibleExit: gaveBackProfit
        ? "First shadow policy exit after two verified weakening bids"
        : "No earlier exit is supported by available evidence",
      policies,
    };
  });

  const policyNames = [...new Set(analyzed.flatMap((trade) => trade.policies.map((policy) => policy.policy)))];
  const policyAggregates = policyNames.map((policyName): PolicyAggregate => {
    const rows = analyzed
      .map((trade) => ({
        trade,
        policy: trade.policies.find((candidate) => candidate.policy === policyName),
      }))
      .filter((row) => row.policy?.evidenceValid && row.policy.returnPct != null) as Array<{
        trade: TradeExitResearch;
        policy: PolicyResult & { returnPct: number };
      }>;
    const returns = rows.map((row) => row.policy.returnPct);
    const gains = returns.filter((value) => value > 0);
    const losses = returns.filter((value) => value < 0);
    let equity = 0;
    let peak = 0;
    let maximumDrawdownUsd = 0;
    for (const row of rows) {
      const value = row.trade.entryFill * row.policy.returnPct;
      equity += value;
      peak = Math.max(peak, equity);
      maximumDrawdownUsd = Math.min(maximumDrawdownUsd, equity - peak);
    }
    const avgMfe = mean(rows.map((row) => row.trade.mfePct).filter((value): value is number => value != null));
    const avgMae = mean(rows.map((row) => row.trade.maePct).filter((value): value is number => value != null));
    const avgReturn = mean(returns);
    return {
      policy: policyName,
      sampleSize: rows.length,
      winRatePct: rows.length ? round((gains.length / rows.length) * 100, 2) : null,
      averageReturnPct: avgReturn == null ? null : round(avgReturn),
      medianReturnPct: median(returns),
      profitFactor: losses.length
        ? round(gains.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)))
        : null,
      totalPnlUsd: round(rows.reduce((sum, row) => sum + row.trade.entryFill * row.policy.returnPct, 0)),
      averageMfePct: avgMfe == null ? null : round(avgMfe),
      averageMaePct: avgMae == null ? null : round(avgMae),
      captureEfficiencyPct: avgMfe != null && avgMfe > 0 && avgReturn != null ? round((avgReturn / avgMfe) * 100) : null,
      stopRatePct: rows.length
        ? round((rows.filter((row) => /stop/i.test(row.policy.reason)).length / rows.length) * 100, 2)
        : null,
      t1RatePct: rows.length
        ? round((rows.filter((row) => row.trade.t1Reached).length / rows.length) * 100, 2)
        : null,
      largestLossPct: losses.length ? Math.min(...losses) : null,
      maximumDrawdownUsd: round(maximumDrawdownUsd),
      supported: rows.length >= minimumSupportedSample,
    };
  });
  const supported = policyAggregates
    .filter((policy) => policy.supported && policy.averageReturnPct != null)
    .sort((a, b) => Number(b.averageReturnPct) - Number(a.averageReturnPct));

  return {
    advisoryOnly: true,
    productionBehaviorChanged: false,
    minimumSupportedSample,
    trades: analyzed,
    policies: policyAggregates,
    profitableThenLostCount: analyzed.filter((trade) => trade.gaveBackProfit).length,
    profitableTradeCount: analyzed.filter((trade) => (trade.bestGainPct ?? 0) > 0).length,
    bestSupportedPolicy: supported[0]?.policy ?? null,
    limitations: [
      "Shadow policies never overwrite canonical paper outcomes.",
      "Underlying thesis exits require timestamped underlying/VWAP observations, which may be unavailable.",
      "Momentum-stall exits require timestamped momentum and volume observations, which may be unavailable.",
      "No policy is recommended below the minimum supported sample.",
    ],
  };
}
