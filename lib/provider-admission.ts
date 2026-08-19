/**
 * provider-admission.ts — how many provider calls a consumer may still make
 * THIS minute, read from its own partition rather than from the global counter.
 *
 * WHY THIS EXISTS, in one measurement.
 *
 * On 2026-08-19 `asymmetry_mark` finished the session on **748 admitted requests
 * against 17,483 refusals — a 4.1% admission rate** — while the lanes it was
 * supposedly competing with were barely refused at all (`options_paper_mark`
 * 108 refusals in 32,934 requests). Gate B7's reserve was working: the lane was
 * being served roughly its 44/minute guarantee. It was generating its own
 * refusals.
 *
 * The mark sweep reads up to 500 open cases and marks every elapsed horizon on
 * each, so after the scheduler outage it had ~2,300 owed horizons and fired all
 * of them into a 44/minute reserve on every 60s beat. ~2,000 were refused, each
 * refusal wrote a transient `PROVIDER_BUDGET` mark row, and a transient row is
 * re-offered next sweep — so the identical backlog was re-fired a minute later,
 * forever. Production shows exactly that shape: 1,981 → 1,959 → 1,930 → 1,853
 * quota blocks per minute, draining at the reserve rate.
 *
 * THE CONFUSION THIS FIXES. A consumer has two different questions available:
 *
 *   "is the MINUTE nearly full?"   — `nearMinuteBudget(getCallStats())`
 *   "may *I* still spend?"         — this module
 *
 * They are not the same question and answering the second with the first is
 * wrong in both directions. A reserve-holding lane that defers because some
 * other lane filled the minute has voluntarily surrendered the guarantee that
 * exists to protect it; a lane that fires without asking at all discovers its
 * limit one exception at a time and pays a wasted DB write for each.
 *
 * PURE. No I/O, no clock, no provider call. It reads the snapshot the meter
 * already publishes (`getCallStats().minuteBudget`) and answers in requests.
 *
 * THIS RAISES NO CAP. It only lets a consumer find out what it already has.
 */
import type { ProviderConsumer } from "./provider-context.ts";

/** The shape `budgetSnapshot()` publishes, plus the global counter beside it. */
export interface MinuteBudgetView {
  minuteCap: number;
  sharedPool: number;
  sharedUsed: number;
  reserves: readonly { consumer: ProviderConsumer; reserved: number; used: number }[];
}

export interface MinuteAllowance {
  consumer: ProviderConsumer;
  /** Requests left inside this consumer's OWN reserve — nothing can take these. */
  reserveRemaining: number;
  /** Requests left in the pool every unreserved lane competes for. */
  sharedRemaining: number;
  /** What the GLOBAL minute cap still permits, whoever asks. */
  globalRemaining: number;
  /**
   * What this consumer may actually still spend: its reserve plus the shared
   * pool, never more than the global cap allows. This is exactly the number of
   * consecutive `decideBudget` calls that would be admitted right now.
   */
  remaining: number;
}

const nonNeg = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * Remaining minute allowance for one consumer.
 *
 * `callsThisMinute` is the global counter; pass it so the answer can never
 * promise more than the hard cap permits even if a partition is misconfigured.
 * An unset minute cap (<= 0) means no partitioning, so the allowance is
 * unbounded — reported as `Number.POSITIVE_INFINITY` rather than a large
 * integer, because a caller that pages against it must be able to tell the
 * difference between "lots" and "no limit".
 */
export function minuteAllowanceFor(
  consumer: ProviderConsumer,
  view: MinuteBudgetView | null | undefined,
  callsThisMinute: number,
): MinuteAllowance {
  const cap = Number(view?.minuteCap ?? 0);
  if (!view || !(cap > 0)) {
    return {
      consumer,
      reserveRemaining: Number.POSITIVE_INFINITY,
      sharedRemaining: Number.POSITIVE_INFINITY,
      globalRemaining: Number.POSITIVE_INFINITY,
      remaining: Number.POSITIVE_INFINITY,
    };
  }
  const mine = view.reserves.find((r) => r.consumer === consumer);
  const reserveRemaining = nonNeg(Number(mine?.reserved ?? 0) - Number(mine?.used ?? 0));
  const sharedRemaining = nonNeg(Number(view.sharedPool ?? 0) - Number(view.sharedUsed ?? 0));
  const globalRemaining = nonNeg(cap - Number(callsThisMinute ?? 0));
  return {
    consumer,
    reserveRemaining,
    sharedRemaining,
    globalRemaining,
    remaining: Math.min(reserveRemaining + sharedRemaining, globalRemaining),
  };
}

/**
 * Adapter over the stats object `getCallStats()` returns, so a caller does not
 * have to know that the partition lives under `minuteBudget`. Returns Infinity
 * when stats are unavailable — a missing meter must not silently stop a lane
 * from working, only a present one may stop it.
 */
export function remainingMinuteAllowance(
  consumer: ProviderConsumer,
  stats: { callsThisMinute?: number; minuteBudget?: MinuteBudgetView | null } | null | undefined,
): number {
  if (!stats || !stats.minuteBudget) return Number.POSITIVE_INFINITY;
  return minuteAllowanceFor(consumer, stats.minuteBudget, Number(stats.callsThisMinute ?? 0)).remaining;
}
