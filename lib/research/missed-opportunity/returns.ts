/**
 * returns.ts — executable return verification.
 *
 * THE ONE RULE. You enter by paying the ASK and exit by hitting the BID. Every
 * other pairing flatters the result: ask→ask pretends you sold into your own
 * offer, midpoint→midpoint pretends a spread does not exist, and last-trade
 * ignores whether anyone would trade with you at all. Those are computed here
 * too, but only as DIAGNOSTICS, and the case shape keeps them in a separate field
 * so no report can accidentally quote one as the result.
 *
 * A "+2,000% day" measured midpoint-to-midpoint on a contract with a 40% spread is
 * a statement about arithmetic, not about money. This module exists to tell those
 * apart.
 *
 * NO FUTURE LEAKAGE. The exit is always chosen from observations strictly AFTER
 * the entry. No observation may inform an entry that preceded it, and an entry is
 * never re-chosen after seeing which one would have worked best — the entry is
 * fixed by the earliest executable timestamp the caller supplies.
 */
import {
  LADDER_PCT,
  LADDER_THRESHOLDS,
  emptyLadder,
  type MeasuredReturn,
  type QuoteObservation,
  type ReturnBasis,
  type ThresholdLadder,
} from "./types.ts";

function pct(from: number, to: number): number {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) return Number.NaN;
  return ((to - from) / from) * 100;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Sorted ascending by time, with unusable observations dropped. */
export function normalizeSeries(series: QuoteObservation[]): QuoteObservation[] {
  return [...series]
    .filter((o) => Number.isFinite(o.atMs))
    .sort((a, b) => a.atMs - b.atMs);
}

/**
 * The entry observation: the FIRST observation at or after `entryAtMs` that has a
 * usable ask. Choosing the first rather than the best is what keeps this
 * non-hindsight.
 */
export function findEntry(
  series: QuoteObservation[],
  entryAtMs: number,
): QuoteObservation | null {
  for (const o of series) {
    if (o.atMs < entryAtMs) continue;
    if (o.ask != null && Number.isFinite(o.ask) && o.ask > 0) return o;
  }
  return null;
}

export interface VerifiedReturns {
  /** Ask-entry to best later bid. The only executable number. */
  executableReturnPct: number | null;
  entryAtMs: number | null;
  entryAsk: number | null;
  exitAtMs: number | null;
  exitBid: number | null;
  maxExecutableBid: number | null;
  /** Diagnostics — never quotable as a result. */
  diagnostics: MeasuredReturn[];
  ladder: ThresholdLadder;
  /** Peak and trough of the executable (bid-based) path, relative to ask entry. */
  mfePct: number | null;
  maePct: number | null;
  entrySpreadPct: number | null;
  entryVolume: number | null;
  entryOpenInterest: number | null;
  /** Count of observations that contributed. Low counts mean weak evidence. */
  observationCount: number;
  /** True when the peak bid rests on a single isolated observation. */
  singleObservationPeak: boolean;
}

export function emptyVerifiedReturns(): VerifiedReturns {
  return {
    executableReturnPct: null, entryAtMs: null, entryAsk: null, exitAtMs: null,
    exitBid: null, maxExecutableBid: null, diagnostics: [], ladder: emptyLadder(),
    mfePct: null, maePct: null, entrySpreadPct: null, entryVolume: null,
    entryOpenInterest: null, observationCount: 0, singleObservationPeak: false,
  };
}

/**
 * Verify what was actually achievable on one contract.
 *
 * `entryAtMs` is supplied by the caller and must be the earliest NON-HINDSIGHT
 * timestamp — typically when the setup first confirmed. Passing the timestamp of
 * the day's low premium would measure a trade nobody could have taken.
 */
export function verifyExecutableReturns(
  rawSeries: QuoteObservation[],
  entryAtMs: number,
): VerifiedReturns {
  const out = emptyVerifiedReturns();
  const series = normalizeSeries(rawSeries);
  out.observationCount = series.length;
  if (series.length === 0) return out;

  const entry = findEntry(series, entryAtMs);
  if (!entry || entry.ask == null) return out;

  const entryAsk = entry.ask;
  out.entryAtMs = entry.atMs;
  out.entryAsk = round(entryAsk, 6);
  out.entryVolume = entry.volume ?? null;
  out.entryOpenInterest = entry.openInterest ?? null;
  if (entry.bid != null && entry.ask != null && entry.ask > 0) {
    const mid = (entry.bid + entry.ask) / 2;
    out.entrySpreadPct = mid > 0 ? round(((entry.ask - entry.bid) / mid) * 100, 4) : null;
  }

  // Strictly-after observations only. An exit at the entry timestamp is not a trade.
  const after = series.filter((o) => o.atMs > entry.atMs);
  if (after.length === 0) return out;

  // --- Executable path: ask entry -> later bid ---
  const bids = after.filter((o) => o.bid != null && Number.isFinite(o.bid) && (o.bid as number) > 0);
  if (bids.length > 0) {
    let best = bids[0];
    for (const o of bids) if ((o.bid as number) > (best.bid as number)) best = o;
    let worst = bids[0];
    for (const o of bids) if ((o.bid as number) < (worst.bid as number)) worst = o;

    out.exitAtMs = best.atMs;
    out.exitBid = round(best.bid as number, 6);
    out.maxExecutableBid = out.exitBid;
    out.executableReturnPct = round(pct(entryAsk, best.bid as number), 4);
    out.mfePct = out.executableReturnPct;
    out.maePct = round(pct(entryAsk, worst.bid as number), 4);

    // A peak that exists in exactly one observation cannot be distinguished from a
    // bad print by this data alone, and the caller must be able to see that.
    const peak = best.bid as number;
    const nearPeak = bids.filter((o) => (o.bid as number) >= peak * 0.98).length;
    out.singleObservationPeak = nearPeak <= 1;

    // Ladder: FIRST time each threshold was reachable on the executable path.
    const ladder = emptyLadder();
    for (const key of LADDER_THRESHOLDS) {
      const need = entryAsk * (1 + LADDER_PCT[key] / 100);
      for (const o of bids) {
        if ((o.bid as number) >= need) { ladder[key] = o.atMs - entry.atMs; break; }
      }
    }
    out.ladder = ladder;
  }

  // --- Diagnostics. Computed, labelled, and never promoted. ---
  const push = (basis: ReturnBasis, exitPrice: number | null, exitAtMs: number | null): void => {
    if (exitPrice == null || !Number.isFinite(exitPrice)) return;
    const r = pct(entryAsk, exitPrice);
    if (!Number.isFinite(r)) return;
    out.diagnostics.push({
      basis, entryAtMs: entry.atMs, entryPrice: round(entryAsk, 6),
      exitAtMs: exitAtMs ?? entry.atMs, exitPrice: round(exitPrice, 6), returnPct: round(r, 4),
    });
  };

  const bestBy = (pick: (o: QuoteObservation) => number | null): { v: number; atMs: number } | null => {
    let acc: { v: number; atMs: number } | null = null;
    for (const o of after) {
      const v = pick(o);
      if (v == null || !Number.isFinite(v) || v <= 0) continue;
      if (!acc || v > acc.v) acc = { v, atMs: o.atMs };
    }
    return acc;
  };

  const bestAsk = bestBy((o) => o.ask);
  if (bestAsk) push("ASK_TO_ASK", bestAsk.v, bestAsk.atMs);
  const bestMid = bestBy((o) => o.midpoint ?? (o.bid != null && o.ask != null ? (o.bid + o.ask) / 2 : null));
  if (bestMid) push("MIDPOINT", bestMid.v, bestMid.atMs);
  const bestLast = bestBy((o) => o.lastTrade);
  if (bestLast) push("LAST_TRADE", bestLast.v, bestLast.atMs);

  return out;
}

/**
 * Notional that could plausibly have been filled near the entry, inferred from
 * displayed size at entry. Returns null when size is unknown — an unknown is
 * reported as an unknown, never as "enough".
 */
export function inferExecutableNotionalUsd(entry: QuoteObservation | null): number | null {
  if (!entry || entry.ask == null || !Number.isFinite(entry.ask)) return null;
  const vol = entry.volume;
  if (vol == null || !Number.isFinite(vol) || vol <= 0) return null;
  // One contract controls 100 shares. A conservative participation assumption:
  // a resting order should not expect more than ~1% of the contract's session
  // volume near a single timestamp.
  const contracts = Math.max(1, Math.floor(vol * 0.01));
  return round(contracts * entry.ask * 100, 2);
}
