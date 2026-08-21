/**
 * chain-admission.ts — WHICH chain request gets the lane's next slot.
 *
 * WHY THIS EXISTS, in one measurement.
 *
 * On 2026-08-21 MRNA had a bullish CALL at score 1.0 with `research_only 0` —
 * the highest-quality thing the options product produces — and its chain fetch
 * was refused with PROVIDER_QUOTA_EXCEEDED.
 *
 * IT WAS NOT STARVED BY ANOTHER LANE. `provider-budget.ts` already guarantees
 * `options_discovery` a per-minute reserve (~28 requests at the production cap
 * of 280) that nothing else can take. That guarantee held. The lane spent its
 * own reserve, first-come-first-served, and MRNA arrived after it was gone —
 * behind requests that included the 802 zero-contract attempts `optionability.ts`
 * now suppresses.
 *
 * So the cross-lane partition was never the problem, and raising it would not
 * have helped. The problem is INSIDE the lane: arrival order is not quality
 * order, and a reserve spent in arrival order protects the lane from other lanes
 * while leaving its best candidate to lose to its worst.
 *
 * WHAT THIS ORDERS, AND WHAT IT DOES NOT. This decides the ORDER and the
 * ADMISSION of chain requests within one lane's existing budget. It does not
 * change the budget, raise a cap, score a setup, choose a contract, set a
 * target, or authorise anything. A request it admits is still subject to every
 * gate downstream; a request it defers is deferred, not rejected.
 *
 * THE FOUR FAILURE MODES IT IS BUILT AGAINST:
 *
 *   RETRY STORM     a refused request that re-queues immediately spends the
 *                   capacity it is waiting for. Attempts are bounded and a
 *                   deferred ticket waits for the next cycle, never spins.
 *   INFINITE RETRY  a ticket that can never be served must LEAVE. Past its
 *                   deadline it expires, with a reason, instead of accumulating.
 *   STARVATION      pure quality order means a merely-good candidate behind a
 *                   stream of excellent ones never runs. Waiting time is part of
 *                   the priority, so every admitted-eligible ticket eventually
 *                   reaches the front or expires cleanly.
 *   DUPLICATION     the same symbol/side/strategy asked twice in one cycle is
 *                   one request. Duplicates are collapsed before admission, not
 *                   after the spend.
 *
 * PURE. No clock (the caller passes `nowMs`), no I/O, no env read beyond the
 * explicit config resolver. It issues no provider call and cannot: it returns a
 * decision, and the caller spends.
 */

const num = (v: string | undefined, d: number, min = -Infinity): number => {
  const x = Number(v);
  return Number.isFinite(x) && x >= min ? x : d;
};
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * A request for one option chain, with everything needed to rank it.
 *
 * `score` and `researchOnly` come from the strategy selection that already
 * happened — this module reads that decision, it does not make or revise it.
 */
export interface ChainTicket {
  symbol: string;
  side: "call" | "put" | null;
  strategyKey: string | null;
  /** Strategy score at decision time, 0..1. */
  score: number;
  /** True when the candidate cannot reach subscribers regardless of outcome. */
  researchOnly: boolean;
  /** 0 = index core, 1 = core liquid, 2 = broad universe. */
  tier: 0 | 1 | 2;
  /** When this request was first raised. Waiting time is measured from here. */
  requestedAtMs: number;
  /**
   * The moment after which serving this is pointless — a decision-time chain
   * fetched too late describes a market that has moved on. Past it the ticket
   * expires rather than being served stale.
   */
  deadlineMs: number;
  /** How many cycles this ticket has already been deferred. */
  attempts?: number;
}

export interface ChainAdmissionConfig {
  /**
   * Priority weight of strategy score. Dominant, because quality is the thing
   * the lane exists to serve.
   */
  scoreWeight: number;
  /**
   * Bonus for a candidate that can actually reach subscribers. An actionable
   * setup and a research-only one are not the same product, and when only one
   * can be served it must be the one that counts.
   */
  actionableBonus: number;
  /** Bonus for the fast index/core tiers, which run on their own tighter cadence. */
  tierBonus: number;
  /**
   * Priority gained per second spent waiting. THE ANTI-STARVATION TERM: without
   * it a merely-good ticket behind a stream of excellent ones never runs.
   * Deliberately small — it should break ties among comparable candidates over
   * time, never let an old weak ticket outrank a fresh strong one.
   */
  agingPerSecond: number;
  /** Most priority that aging alone may contribute, so age cannot dominate quality. */
  maxAgingBonus: number;
  /**
   * Deferrals before a ticket is abandoned. Bounds the queue independently of
   * the deadline, so a ticket with an absurd deadline still leaves.
   */
  maxAttempts: number;
}

export const DEFAULT_CHAIN_ADMISSION: Readonly<ChainAdmissionConfig> = Object.freeze({
  scoreWeight: 100,
  actionableBonus: 40,
  tierBonus: 10,
  agingPerSecond: 0.5,
  maxAgingBonus: 30,
  maxAttempts: 5,
});

export function chainAdmissionConfig(env: NodeJS.ProcessEnv = process.env): ChainAdmissionConfig {
  const d = DEFAULT_CHAIN_ADMISSION;
  return {
    scoreWeight: num(env.OPTIONS_ADMISSION_SCORE_WEIGHT, d.scoreWeight, 0),
    actionableBonus: num(env.OPTIONS_ADMISSION_ACTIONABLE_BONUS, d.actionableBonus, 0),
    tierBonus: num(env.OPTIONS_ADMISSION_TIER_BONUS, d.tierBonus, 0),
    agingPerSecond: num(env.OPTIONS_ADMISSION_AGING_PER_SECOND, d.agingPerSecond, 0),
    maxAgingBonus: num(env.OPTIONS_ADMISSION_MAX_AGING_BONUS, d.maxAgingBonus, 0),
    maxAttempts: num(env.OPTIONS_ADMISSION_MAX_ATTEMPTS, d.maxAttempts, 1),
  };
}

/** Identity for de-duplication. The same setup asked twice is one request. */
export function chainTicketKey(t: Pick<ChainTicket, "symbol" | "side" | "strategyKey">): string {
  return `${String(t.symbol).toUpperCase()}|${t.side ?? "both"}|${t.strategyKey ?? "none"}`;
}

/**
 * Priority of one ticket. Higher runs first.
 *
 * Quality dominates by construction: a score-1.0 actionable candidate scores
 * 100 + 40 = 140 before aging, and the aging term is capped at 30 — so no amount
 * of waiting lets a score-0.5 research-only ticket (50) overtake it. Aging
 * decides between comparable candidates, which is the only place it should.
 */
export function chainTicketPriority(
  t: ChainTicket,
  nowMs: number,
  cfg: ChainAdmissionConfig = DEFAULT_CHAIN_ADMISSION,
): number {
  const score = clamp(Number.isFinite(t.score) ? t.score : 0, 0, 1);
  const waitedSec = Math.max(0, (nowMs - t.requestedAtMs) / 1000);
  const aging = Math.min(cfg.maxAgingBonus, waitedSec * cfg.agingPerSecond);
  return +(
    score * cfg.scoreWeight
    + (t.researchOnly ? 0 : cfg.actionableBonus)
    + (t.tier === 2 ? 0 : cfg.tierBonus)
    + aging
  ).toFixed(3);
}

export type AdmissionOutcome = "ADMITTED" | "DEFERRED" | "EXPIRED_DEADLINE" | "EXPIRED_ATTEMPTS" | "DUPLICATE";

export interface AdmissionDecision {
  key: string;
  symbol: string;
  outcome: AdmissionOutcome;
  priority: number;
  waitedMs: number;
  attempts: number;
  reason: string;
}

export interface ChainAdmissionResult {
  /** Tickets to spend on, highest priority first. Never more than `capacity`. */
  admitted: ChainTicket[];
  /** Tickets that keep their place and are re-offered next cycle. */
  deferred: ChainTicket[];
  /** Tickets that left the queue, with why. Bounded defer is a property, not a hope. */
  expired: AdmissionDecision[];
  /** Every decision, for observability. */
  decisions: AdmissionDecision[];
  /** Collapsed duplicates. */
  duplicatesCollapsed: number;
  capacity: number;
  /**
   * Actionable, non-research tickets that could not be served this cycle. THE
   * MRNA COUNTER: if this is persistently non-zero the lane is genuinely short
   * of capacity, rather than merely spending it in the wrong order.
   */
  highPriorityDeferred: number;
}

/**
 * Decide which chain requests this cycle spends on.
 *
 * Ordering is by priority, then by earliest request, then by symbol — the last
 * two so the result is REPRODUCIBLE rather than dependent on arrival order,
 * which is the arbitrariness this module exists to remove.
 */
export function admitChainRequests(
  tickets: readonly ChainTicket[],
  capacity: number,
  nowMs: number,
  cfg: ChainAdmissionConfig = DEFAULT_CHAIN_ADMISSION,
): ChainAdmissionResult {
  const cap = Math.max(0, Math.floor(capacity));

  // 1. DEDUPLICATE before anything is spent. Among duplicates keep the one that
  //    has waited longest, so collapsing never resets a ticket's age.
  const byKey = new Map<string, ChainTicket>();
  let duplicatesCollapsed = 0;
  for (const t of tickets) {
    if (!t?.symbol) continue;
    const key = chainTicketKey(t);
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, t); continue; }
    duplicatesCollapsed += 1;
    const keep = t.requestedAtMs < existing.requestedAtMs ? t : existing;
    const merged: ChainTicket = {
      ...keep,
      score: Math.max(existing.score ?? 0, t.score ?? 0),
      researchOnly: (existing.researchOnly !== false) && (t.researchOnly !== false),
      attempts: Math.max(existing.attempts ?? 0, t.attempts ?? 0),
    };
    byKey.set(key, merged);
  }

  const decisions: AdmissionDecision[] = [];
  const expired: AdmissionDecision[] = [];
  const live: { t: ChainTicket; priority: number }[] = [];

  // 2. EXPIRE anything that must leave. Done before ranking so a dead ticket
  //    never occupies a slot in the comparison, let alone a request.
  for (const t of byKey.values()) {
    const key = chainTicketKey(t);
    const attempts = t.attempts ?? 0;
    const waitedMs = Math.max(0, nowMs - t.requestedAtMs);
    const priority = chainTicketPriority(t, nowMs, cfg);

    if (nowMs > t.deadlineMs) {
      const d: AdmissionDecision = {
        key, symbol: t.symbol, outcome: "EXPIRED_DEADLINE", priority, waitedMs, attempts,
        reason: `deadline passed ${nowMs - t.deadlineMs}ms ago — a decision-time chain fetched now describes a market that moved`,
      };
      decisions.push(d); expired.push(d); continue;
    }
    if (attempts >= cfg.maxAttempts) {
      const d: AdmissionDecision = {
        key, symbol: t.symbol, outcome: "EXPIRED_ATTEMPTS", priority, waitedMs, attempts,
        reason: `deferred ${attempts} times — abandoned rather than retried forever`,
      };
      decisions.push(d); expired.push(d); continue;
    }
    live.push({ t, priority });
  }

  // 3. RANK, then admit down to capacity.
  live.sort((a, b) =>
    b.priority - a.priority
    || a.t.requestedAtMs - b.t.requestedAtMs
    || (a.t.symbol < b.t.symbol ? -1 : a.t.symbol > b.t.symbol ? 1 : 0));

  const admitted: ChainTicket[] = [];
  const deferred: ChainTicket[] = [];
  let highPriorityDeferred = 0;

  for (const { t, priority } of live) {
    const key = chainTicketKey(t);
    const attempts = t.attempts ?? 0;
    const waitedMs = Math.max(0, nowMs - t.requestedAtMs);
    if (admitted.length < cap) {
      admitted.push(t);
      decisions.push({ key, symbol: t.symbol, outcome: "ADMITTED", priority, waitedMs, attempts, reason: `priority ${priority}` });
    } else {
      // Deferred tickets keep their original requestedAtMs, so waiting
      // accumulates and the aging term can eventually promote them.
      deferred.push({ ...t, attempts: attempts + 1 });
      if (!t.researchOnly) highPriorityDeferred += 1;
      decisions.push({
        key, symbol: t.symbol, outcome: "DEFERRED", priority, waitedMs, attempts,
        reason: `capacity ${cap} exhausted — re-offered next cycle as attempt ${attempts + 1}`,
      });
    }
  }

  return { admitted, deferred, expired, decisions, duplicatesCollapsed, capacity: cap, highPriorityDeferred };
}
