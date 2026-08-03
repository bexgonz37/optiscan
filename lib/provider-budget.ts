/**
 * Gate B7 — per-minute provider budget partitions.
 *
 * WHY THIS EXISTS, in one measurement.
 *
 * On 2026-08-03 `asymmetry_mark` ended a full RTH session on **263 admitted
 * requests against 93,792 refusals — a 0.28% admission rate**. Earlier the same
 * day the subscriber grade lane was fixed to read one exact contract per request
 * instead of downloading a 750-contract chain, cutting its cost by roughly two
 * thirds. Marking then admitted **zero** further requests.
 *
 * That is the whole lesson: **cheapness does not buy priority.** The 280/minute
 * cap was first-come-first-served, discovery asks continuously, and a lane that
 * wakes on a horizon schedule loses every race no matter what each of its
 * requests costs. Making the loser cheaper just makes it a cheaper loser.
 *
 * A reserve did exist — `quota-policy.ts` splits `discovery` from `grader`. It
 * had never once fired, for two independent reasons:
 *
 *  1. `recordPolygonCall()` was always called with the default purpose, so the
 *     split never saw a real caller. (Gate B5 fixed attribution; this module is
 *     the first thing to actually read it.)
 *  2. Even threaded, it guards the DAILY cap. The daily cap is 200,000 and the
 *     session used 55,415 — it was never close. The starvation was entirely at
 *     the MINUTE cap, which had no partition at all.
 *
 * THE GUARANTEE. Each consumer gets a per-minute reserve it can always spend,
 * plus fair access to a shared pool. A call is admitted when EITHER the consumer
 * is still inside its own reserve, OR the shared pool has room. Nothing another
 * lane does can take a consumer's reserve away — which is precisely the property
 * that failed above.
 *
 * The cost of a guarantee is that an idle lane's reserve is idle. That is
 * deliberate and bounded: reserves are deliberately small, and everything above
 * them competes in the shared pool.
 *
 * THIS RAISES NO CAP. It only decides who gets the 280 that already exist.
 */
import { PROVIDER_CONSUMERS, providerCategoryFor, type ProviderConsumer } from "./provider-context.ts";

/**
 * Per-minute reserves as a FRACTION of the minute cap.
 *
 * Fractions, not absolute counts, because the cap is configurable and reserves
 * hard-coded for 280 silently become nonsense at any other value: at a cap of 2
 * they would consume the entire budget and refuse every unreserved lane's first
 * call. A reserve must be a share of what exists, not a number that happens to
 * fit today's plan.
 *
 * Priority order is the one declared in `provider-context.ts`: live scanner
 * safety first, optional enrichment last. Only the lanes that must never be
 * starved hold a reserve; the rest live entirely in the shared pool.
 *
 * `asymmetry_mark` holds a reserve of its own rather than sharing one with
 * `options_paper_mark`. They are both `mark` category, and a shared reserve
 * would have been won by the subscriber lane every minute — reproducing the
 * exact failure this module exists to prevent, one level down.
 *
 * At the production cap of 280 these resolve to roughly:
 *   scanner 58 · options_paper_mark 44 · asymmetry_mark 44 · options_discovery 28
 *   · alert_capture 5 · shared pool 101
 */
export const DEFAULT_MINUTE_RESERVE_FRACTIONS: Partial<Record<ProviderConsumer, number>> = {
  scanner: 0.21,
  options_paper_mark: 0.16,
  asymmetry_mark: 0.16,
  options_discovery: 0.10,
  alert_capture: 0.02,
};

/**
 * The shared pool may never be squeezed out entirely. Without a floor, a lane
 * holding no reserve — including `unattributed`, which is a defect bucket but
 * still carries real traffic — could not make a single call, and an
 * over-reserving config would deadlock the provider rather than merely
 * prioritise it.
 */
const MIN_SHARED_FRACTION = 0.15;

/** Env override: `PROVIDER_MINUTE_RESERVE_ASYMMETRY_MARK=60` (absolute requests). Explicit `0` disables. */
function envReserveKey(consumer: ProviderConsumer): string {
  return `PROVIDER_MINUTE_RESERVE_${consumer.toUpperCase()}`;
}

/** The reserve a consumer asks for, before contention with other reserves. */
function rawReserveFor(
  consumer: ProviderConsumer,
  minuteCap: number,
  env: NodeJS.ProcessEnv,
): number {
  const override = env[envReserveKey(consumer)];
  if (override != null && override !== "") {
    const n = Number(override);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const fraction = DEFAULT_MINUTE_RESERVE_FRACTIONS[consumer] ?? 0;
  return Math.floor(fraction * minuteCap);
}

/** The smallest shared pool the partition will ever leave. */
export function minSharedPool(minuteCap: number): number {
  if (minuteCap <= 0) return 0;
  return Math.max(1, Math.ceil(minuteCap * MIN_SHARED_FRACTION));
}

/**
 * Every consumer's effective reserve, scaled down proportionally if the raw
 * reserves would leave less than `minSharedPool`. Scaling rather than truncating
 * keeps the declared priority ratios intact under a tight cap.
 */
function effectiveReserves(
  minuteCap: number,
  env: NodeJS.ProcessEnv,
): Map<ProviderConsumer, number> {
  const out = new Map<ProviderConsumer, number>();
  if (minuteCap <= 0) return out;

  const raw = new Map<ProviderConsumer, number>();
  let rawTotal = 0;
  for (const c of PROVIDER_CONSUMERS) {
    const r = rawReserveFor(c, minuteCap, env);
    if (r > 0) { raw.set(c, r); rawTotal += r; }
  }

  const allowance = Math.max(0, minuteCap - minSharedPool(minuteCap));
  if (rawTotal <= allowance) return raw;

  const scale = rawTotal > 0 ? allowance / rawTotal : 0;
  for (const [c, r] of raw) {
    const scaled = Math.floor(r * scale);
    if (scaled > 0) out.set(c, scaled);
  }
  return out;
}

export function minuteReserveFor(
  consumer: ProviderConsumer,
  env: NodeJS.ProcessEnv = process.env,
  minuteCap = 280,
): number {
  return effectiveReserves(minuteCap, env).get(consumer) ?? 0;
}

/** Total reserved per minute across all consumers. */
export function totalMinuteReserve(env: NodeJS.ProcessEnv = process.env, minuteCap = 280): number {
  let sum = 0;
  for (const r of effectiveReserves(minuteCap, env).values()) sum += r;
  return sum;
}

/**
 * The shared pool: what is left of the minute cap after reserves. Guaranteed to
 * be at least `minSharedPool`, so an unreserved lane is always able to try.
 */
export function sharedMinutePool(minuteCap: number, env: NodeJS.ProcessEnv = process.env): number {
  if (minuteCap <= 0) return 0;
  return Math.max(0, minuteCap - totalMinuteReserve(env, minuteCap));
}

/** Per-minute usage, split into reserve spend and shared-pool spend. */
export interface MinuteBudgetState {
  /** Requests each consumer has spent from its OWN reserve this minute. */
  reserveUsed: Map<ProviderConsumer, number>;
  /** Requests spent from the shared pool this minute, by any consumer. */
  sharedUsed: number;
}

export function emptyMinuteBudgetState(): MinuteBudgetState {
  return { reserveUsed: new Map(), sharedUsed: 0 };
}

export type BudgetDecision =
  | { allowed: true; from: "reserve" | "shared" }
  | { allowed: false; reason: "minute_partition"; consumer: ProviderConsumer };

/**
 * Decide whether one call may proceed. PURE — it does not mutate state; the
 * caller commits with `commitBudget` only once the call is actually admitted, so
 * a refusal never consumes budget.
 */
export function decideBudget(
  consumer: ProviderConsumer,
  state: MinuteBudgetState,
  minuteCap: number,
  env: NodeJS.ProcessEnv = process.env,
): BudgetDecision {
  // No minute cap configured: partitioning is meaningless, admit everything.
  if (minuteCap <= 0) return { allowed: true, from: "shared" };

  const reserve = minuteReserveFor(consumer, env, minuteCap);
  const used = state.reserveUsed.get(consumer) ?? 0;
  // A consumer inside its own reserve is ALWAYS admitted. This is the guarantee.
  if (used < reserve) return { allowed: true, from: "reserve" };

  const pool = sharedMinutePool(minuteCap, env);
  if (state.sharedUsed < pool) return { allowed: true, from: "shared" };

  return { allowed: false, reason: "minute_partition", consumer };
}

/** Commit an admitted call against the state the decision was made on. */
export function commitBudget(
  consumer: ProviderConsumer,
  state: MinuteBudgetState,
  decision: BudgetDecision,
): void {
  if (!decision.allowed) return;
  if (decision.from === "reserve") {
    state.reserveUsed.set(consumer, (state.reserveUsed.get(consumer) ?? 0) + 1);
    return;
  }
  state.sharedUsed += 1;
}

/**
 * Read-only view for `/api/system/provider-usage` and health, so an operator can
 * see who holds what without inferring it from refusal counts.
 */
export function budgetSnapshot(
  state: MinuteBudgetState,
  minuteCap: number,
  env: NodeJS.ProcessEnv = process.env,
): {
  minuteCap: number;
  totalReserved: number;
  sharedPool: number;
  sharedUsed: number;
  reserves: { consumer: ProviderConsumer; reserved: number; used: number; category: string }[];
} {
  const reserves = PROVIDER_CONSUMERS
    .map((consumer) => ({
      consumer,
      reserved: minuteReserveFor(consumer, env, minuteCap),
      used: state.reserveUsed.get(consumer) ?? 0,
      category: providerCategoryFor(consumer) as string,
    }))
    .filter((r) => r.reserved > 0 || r.used > 0);
  return {
    minuteCap,
    totalReserved: totalMinuteReserve(env, minuteCap),
    sharedPool: sharedMinutePool(minuteCap, env),
    sharedUsed: state.sharedUsed,
    reserves,
  };
}
