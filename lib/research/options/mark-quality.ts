/**
 * mark-quality.ts — is a horizon mark an INDEPENDENT observation, or the same
 * observation counted again? PURE: no DB, no network, no AI.
 *
 * WHY THIS EXISTS. 84.1 % of verified trades carry one mark reused across all
 * seven horizon buckets. The resulting series looks like a flat time series
 * ("the position did not deteriorate after entry") when it is really a single
 * observation repeated seven times. Every horizon-to-horizon conclusion drawn
 * from that is an artifact.
 *
 * The fix is not to fabricate the missing marks — it is to make the reuse
 * VISIBLE, so an analysis can refuse to treat a repeat as evidence.
 *
 * A REUSED MARK IS NOT WRONG. It is a legitimate carry-forward of the last
 * known price. It is simply not INDEPENDENT EVIDENCE about its horizon, and
 * only independent marks may support a claim about what happened at that time.
 */

export const MARK_VERSION = "MARK_QUALITY_V1" as const;

export type MarkQualityStatus =
  /** Observed at its own horizon, within the freshness budget. */
  | "INDEPENDENT_FRESH"
  /** Observed at its own horizon, but the quote was already old. */
  | "INDEPENDENT_STALE"
  /** Carried forward from an earlier horizon. NOT independent evidence. */
  | "REUSED_PRIOR_MARK"
  /** Written after the fact from stored history. */
  | "BACKFILLED"
  | "NO_QUOTE"
  | "PROVIDER_BUDGET_BLOCKED"
  | "PROVIDER_ERROR"
  | "INVALID_TIMESTAMP"
  | "WRONG_OCC"
  | "UNVERIFIED";

export const MARK_QUALITY_STATUSES: readonly MarkQualityStatus[] = Object.freeze([
  "INDEPENDENT_FRESH", "INDEPENDENT_STALE", "REUSED_PRIOR_MARK", "BACKFILLED",
  "NO_QUOTE", "PROVIDER_BUDGET_BLOCKED", "PROVIDER_ERROR", "INVALID_TIMESTAMP",
  "WRONG_OCC", "UNVERIFIED",
]);

/** Only these two may support a claim about what happened at a horizon. */
export const INDEPENDENT_STATUSES: readonly MarkQualityStatus[] =
  Object.freeze(["INDEPENDENT_FRESH", "INDEPENDENT_STALE"]);

export function isIndependent(status: MarkQualityStatus): boolean {
  return (INDEPENDENT_STATUSES as readonly string[]).includes(status);
}

/** Quote older than this at observation is independent but stale. */
export const DEFAULT_MARK_FRESHNESS_BUDGET_MS = 120_000;

export interface MarkObservation {
  horizonMinutes: number;
  /** When the mark was written. */
  markObservedAtMs: number | null;
  /** Provider timestamp of the quote behind it. */
  quoteAtMs: number | null;
  optionSymbol: string | null;
  expectedOptionSymbol: string;
  bid: number | null;
  ask: number | null;
  /** Rejection recorded by the mark runner, when it failed. */
  rejectedReason?: string | null;
  /** True when written from stored history rather than a live observation. */
  backfilled?: boolean | null;
}

export interface MarkQualityResult {
  horizonMinutes: number;
  status: MarkQualityStatus;
  markIsIndependent: boolean;
  markFreshnessMs: number | null;
  /** When reused, the horizon whose observation this repeats. */
  markReuseSourceHorizon: number | null;
  markSource: "LIVE_OBSERVATION" | "CARRY_FORWARD" | "BACKFILL" | "NONE";
  reason: string;
  version: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Classify a full horizon series for ONE position, in horizon order.
 *
 * Reuse is detected by an identical quote timestamp, not by an identical price.
 * Two genuinely separate observations can legitimately carry the same price on
 * a quiet contract; only a repeated PROVIDER TIMESTAMP proves the same quote
 * was counted twice. Detecting on price would wrongly discard real evidence.
 */
export function classifyMarkSeries(
  observations: readonly MarkObservation[],
  opts: { freshnessBudgetMs?: number } = {},
): MarkQualityResult[] {
  const budget = opts.freshnessBudgetMs ?? DEFAULT_MARK_FRESHNESS_BUDGET_MS;
  const seenQuoteAt = new Map<number, number>(); // quoteAtMs -> first horizon
  const out: MarkQualityResult[] = [];

  for (const o of [...observations].sort((a, b) => a.horizonMinutes - b.horizonMinutes)) {
    const base = {
      horizonMinutes: o.horizonMinutes,
      markReuseSourceHorizon: null as number | null,
      version: MARK_VERSION,
    };
    const fail = (status: MarkQualityStatus, reason: string): MarkQualityResult => ({
      ...base, status, markIsIndependent: false, markFreshnessMs: null,
      markSource: "NONE", reason,
    });

    // Provider-side failures first: they say nothing about the contract.
    const rr = String(o.rejectedReason ?? "").toUpperCase();
    if (rr === "PROVIDER_BUDGET") return_push(out, fail("PROVIDER_BUDGET_BLOCKED", "request refused for budget; retryable"));
    else if (rr === "PROVIDER_ERROR") return_push(out, fail("PROVIDER_ERROR", "provider failed; retryable"));
    else if (rr === "WRONG_OCC") return_push(out, fail("WRONG_OCC", "mark belongs to a different contract"));
    else if (rr === "FUTURE_QUOTE" || rr === "INVALID_TIMESTAMP") return_push(out, fail("INVALID_TIMESTAMP", "quote timestamp is not usable"));
    else if (rr === "NO_QUOTE" || rr === "NO_TWO_SIDED_MARKET") return_push(out, fail("NO_QUOTE", "no usable two-sided quote"));
    else {
      const occ = String(o.optionSymbol ?? "").toUpperCase();
      const want = String(o.expectedOptionSymbol ?? "").toUpperCase();
      const quoteAt = num(o.quoteAtMs);
      const observedAt = num(o.markObservedAtMs);
      const bid = num(o.bid), ask = num(o.ask);

      if (occ && want && occ !== want) return_push(out, fail("WRONG_OCC", `mark is ${occ}, expected ${want}`));
      else if (quoteAt == null) return_push(out, fail("INVALID_TIMESTAMP", "no provider timestamp on the mark"));
      else if (bid == null || ask == null) return_push(out, fail("NO_QUOTE", "mark carries no bid/ask"));
      else if (o.backfilled === true) {
        return_push(out, { ...base, status: "BACKFILLED", markIsIndependent: false, markFreshnessMs: null, markSource: "BACKFILL", reason: "written from stored history, not observed live" });
      } else {
        const priorHorizon = seenQuoteAt.get(quoteAt);
        if (priorHorizon != null) {
          return_push(out, {
            ...base, status: "REUSED_PRIOR_MARK", markIsIndependent: false,
            markFreshnessMs: observedAt != null ? observedAt - quoteAt : null,
            markReuseSourceHorizon: priorHorizon, markSource: "CARRY_FORWARD",
            reason: `same provider quote as the ${priorHorizon}m horizon — not independent evidence`,
          });
        } else {
          seenQuoteAt.set(quoteAt, o.horizonMinutes);
          const freshness = observedAt != null ? observedAt - quoteAt : null;
          const stale = freshness != null && freshness > budget;
          return_push(out, {
            ...base,
            status: stale ? "INDEPENDENT_STALE" : "INDEPENDENT_FRESH",
            markIsIndependent: true, markFreshnessMs: freshness, markSource: "LIVE_OBSERVATION",
            reason: stale ? `observed independently but the quote was ${Math.round((freshness ?? 0) / 1000)}s old` : "independently observed within the freshness budget",
          });
        }
      }
    }
  }
  return out;
}

function return_push<T>(arr: T[], v: T): void { arr.push(v); }

export interface MarkSeriesQuality {
  horizons: number;
  independent: number;
  reused: number;
  failed: number;
  independentRate: number | null;
  /** True when horizon-to-horizon comparison is defensible. */
  horizonsComparable: boolean;
  degenerate: boolean;
  note: string;
}

/** Below this independent rate, horizon comparisons are not defensible. */
export const MIN_INDEPENDENT_RATE_FOR_HORIZON_ANALYSIS = 0.5;

export function summarizeMarkSeries(results: readonly MarkQualityResult[]): MarkSeriesQuality {
  const horizons = results.length;
  const independent = results.filter((r) => r.markIsIndependent).length;
  const reused = results.filter((r) => r.status === "REUSED_PRIOR_MARK").length;
  const failed = horizons - independent - reused - results.filter((r) => r.status === "BACKFILLED").length;
  const rate = horizons > 0 ? Math.round((independent / horizons) * 10_000) / 10_000 : null;
  const degenerate = independent <= 1 && horizons > 1;
  return {
    horizons, independent, reused, failed, independentRate: rate,
    horizonsComparable: rate != null && rate >= MIN_INDEPENDENT_RATE_FOR_HORIZON_ANALYSIS && independent >= 2,
    degenerate,
    note: horizons === 0
      ? "No marks."
      : degenerate
        ? "One independent observation repeated across horizons — no horizon claim is supportable."
        : rate != null && rate >= MIN_INDEPENDENT_RATE_FOR_HORIZON_ANALYSIS
          ? "Enough independent observations to compare horizons."
          : `Independent rate ${(rate ?? 0) * 100}% is below the ${MIN_INDEPENDENT_RATE_FOR_HORIZON_ANALYSIS * 100}% needed for horizon analysis.`,
  };
}

/**
 * MFE/MAE computed ONLY from independent observations, with the count that
 * produced it. A maximum over one repeated mark is not a maximum.
 */
export function excursionsFromIndependent(
  results: readonly MarkQualityResult[],
  returnsByHorizon: ReadonlyMap<number, number | null>,
): { mfePct: number | null; maePct: number | null; independentObservations: number; supported: boolean } {
  const vals: number[] = [];
  for (const r of results) {
    if (!r.markIsIndependent) continue;
    const v = returnsByHorizon.get(r.horizonMinutes);
    if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length === 0) return { mfePct: null, maePct: null, independentObservations: 0, supported: false };
  return {
    mfePct: Math.max(...vals),
    maePct: Math.min(...vals),
    independentObservations: vals.length,
    // One observation gives a point, not an excursion.
    supported: vals.length >= 2,
  };
}
