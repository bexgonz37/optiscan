/**
 * independence.ts — ANALOG_INDEPENDENCE_V1. How many observations are actually in a
 * result that reports N.
 *
 * ── Why 200 queries were never 200 samples ───────────────────────────────────
 *
 * The previous evaluation reported 200 chronological queries over three symbols and read
 * its Brier as though those were 200 draws. They are not. A 5d label taken at 10:04 and a
 * 5d label taken at 10:41 on the same ticker cover almost the same five days of the same
 * stock; whichever way that week went, both agree. Counting them separately does not make
 * the estimate better, it makes the CONFIDENCE INTERVAL narrower — and narrower in the
 * flattering direction, because correlated errors shrink the apparent variance of a mean
 * that has not actually been measured any more precisely.
 *
 * This module refuses to report a headline count without the concentration figures beside
 * it, and gives the evaluator the cluster labels it needs to resample honestly.
 *
 * ── The independence units, and what each one admits ─────────────────────────
 *
 *   PREDICTION      one row per query. The optimistic count. Reported so the inflation is
 *                   visible, never as the basis for a CI.
 *   SYMBOL_SESSION  one cluster per (ticker, trading day). Two setups on NVDA on the same
 *                   Tuesday are one observation of NVDA's Tuesday.
 *   SESSION         one cluster per trading day, ACROSS symbols. The strictest of the
 *                   three, and the right one when the concern is that correlated mega-caps
 *                   all moved on the same market day — which is exactly the concern here.
 *   SYMBOL          one cluster per ticker. Answers "how much of this is one company".
 *
 * None is uniquely correct; they bound the answer from different directions, so all four
 * are reported and the tightest claim is the one the strictest unit supports.
 *
 * ── Overlapping holding windows ──────────────────────────────────────────────
 *
 * Two 5d labels started three days apart share two days of path. Session clustering does
 * not catch that — the two queries fall on different days — so `overlappingWindowPairs`
 * counts it directly: pairs on the same symbol whose [t0, labelEnd] intervals intersect.
 * It is reported as a share, because the raw pair count grows quadratically and reads as
 * alarming at any sample size.
 */
import { countIndependentSessions } from "../historical/trading-sessions.ts";

export const ANALOG_INDEPENDENCE_VERSION = "ANALOG_INDEPENDENCE_V1";

export type IndependenceUnit = "PREDICTION" | "SYMBOL_SESSION" | "SESSION" | "SYMBOL";

export const INDEPENDENCE_UNITS: readonly IndependenceUnit[] = Object.freeze([
  "PREDICTION", "SYMBOL_SESSION", "SESSION", "SYMBOL",
]);

export interface ObservationWindow {
  id: string;
  symbol: string;
  tradingDay: string;
  t0Ms: number;
  /** When this observation's label finished resolving. */
  labelEndMs: number;
}

/** The cluster label for one observation under one independence unit. */
export function clusterLabel(unit: IndependenceUnit, o: Pick<ObservationWindow, "id" | "symbol" | "tradingDay">): string {
  switch (unit) {
    case "PREDICTION": return o.id;
    case "SYMBOL_SESSION": return `${o.symbol}|${o.tradingDay}`;
    case "SESSION": return o.tradingDay;
    case "SYMBOL": return o.symbol;
  }
}

export interface ConcentrationReport {
  key: string;
  distinct: number;
  /** Share of observations held by the single largest group. */
  topShare: number;
  topLabel: string | null;
  /** Share held by the three largest groups. */
  top3Share: number;
  /**
   * Effective sample size under the group sizes, 1 / sum(share^2) — the inverse Simpson
   * index. Equals `distinct` when every group is the same size and collapses toward 1 as
   * one group takes over. It is a description of the split, NOT a corrected N for a test.
   */
  effectiveGroups: number;
}

function concentration(key: string, labels: readonly string[]): ConcentrationReport {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const n = labels.length;
  const sorted = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const share = (c: number) => (n ? c / n : 0);
  const sumSq = sorted.reduce((a, [, c]) => a + share(c) ** 2, 0);
  return {
    key,
    distinct: counts.size,
    topShare: sorted.length ? +share(sorted[0][1]).toFixed(4) : 0,
    topLabel: sorted.length ? sorted[0][0] : null,
    top3Share: +sorted.slice(0, 3).reduce((a, [, c]) => a + share(c), 0).toFixed(4),
    effectiveGroups: sumSq > 0 ? +(1 / sumSq).toFixed(2) : 0,
  };
}

export interface IndependenceReport {
  version: string;
  observations: number;
  /** Cluster counts per unit — the honest denominators. */
  clusterCounts: Record<IndependenceUnit, number>;
  /**
   * Verified trading sessions among the observation days. Lower than the distinct SESSION
   * cluster count whenever a date was a weekend, a holiday or malformed.
   */
  independentTradingSessions: number;
  rejectedSessionDates: Array<{ date: string; reason: string; holiday: string | null }>;
  concentration: {
    symbol: ConcentrationReport;
    session: ConcentrationReport;
    symbolSession: ConcentrationReport;
  };
  /** Pairs on the same symbol whose label windows intersect, and that share as a fraction of same-symbol pairs. */
  overlappingWindowPairs: number;
  sameSymbolPairs: number;
  overlapShare: number;
  /**
   * observations / SESSION clusters. 1.0 means every prediction was its own market day;
   * 8.0 means the headline count is eight times the number of days it actually observed.
   */
  inflationFactor: number;
  verdict: "INDEPENDENT_ENOUGH" | "CORRELATED";
  note: string;
}

/**
 * Concentration and overlap for a set of observations.
 *
 * `maxOverlapPairs` bounds the pairwise scan. Overlap is computed per symbol on a
 * chronologically sorted list and stops early once an interval starts after the current
 * one ends, so the quadratic case only materialises when the windows genuinely all
 * overlap — which is itself the finding.
 */
export function independenceReport(
  observations: readonly ObservationWindow[],
  opts: { correlatedInflation?: number } = {},
): IndependenceReport {
  const inflationLimit = opts.correlatedInflation ?? 1.5;
  const n = observations.length;
  const sessions = countIndependentSessions(observations.map((o) => o.tradingDay));

  const clusterCounts = Object.fromEntries(
    INDEPENDENCE_UNITS.map((u) => [u, new Set(observations.map((o) => clusterLabel(u, o))).size]),
  ) as Record<IndependenceUnit, number>;

  // Same-symbol overlapping label windows.
  const bySymbol = new Map<string, ObservationWindow[]>();
  for (const o of observations) {
    const b = bySymbol.get(o.symbol);
    if (b) b.push(o); else bySymbol.set(o.symbol, [o]);
  }
  let overlapping = 0;
  let sameSymbolPairs = 0;
  for (const group of bySymbol.values()) {
    const sorted = [...group].sort((a, b) => (a.t0Ms - b.t0Ms) || (a.id < b.id ? -1 : 1));
    sameSymbolPairs += (sorted.length * (sorted.length - 1)) / 2;
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        // Sorted by t0, so once a later start is past this one's end nothing further can overlap.
        if (sorted[j].t0Ms > sorted[i].labelEndMs) break;
        overlapping += 1;
      }
    }
  }

  const inflation = clusterCounts.SESSION ? +(n / clusterCounts.SESSION).toFixed(2) : 0;
  const symbolConc = concentration("symbol", observations.map((o) => o.symbol));

  return {
    version: ANALOG_INDEPENDENCE_VERSION,
    observations: n,
    clusterCounts,
    independentTradingSessions: sessions.independentSessions,
    rejectedSessionDates: sessions.rejected.map((r) => ({ date: r.date, reason: r.reason, holiday: r.holiday })),
    concentration: {
      symbol: symbolConc,
      session: concentration("session", observations.map((o) => o.tradingDay)),
      symbolSession: concentration("symbolSession", observations.map((o) => `${o.symbol}|${o.tradingDay}`)),
    },
    overlappingWindowPairs: overlapping,
    sameSymbolPairs,
    overlapShare: sameSymbolPairs ? +(overlapping / sameSymbolPairs).toFixed(4) : 0,
    inflationFactor: inflation,
    verdict: inflation > inflationLimit || symbolConc.topShare > 0.5 ? "CORRELATED" : "INDEPENDENT_ENOUGH",
    note:
      "Cluster counts are the denominators a confidence interval may use. `observations` is " +
      "reported so the gap between it and the cluster counts is visible, never so it can be " +
      "used as a sample size.",
  };
}
