/**
 * breakout-latch.ts — deterministic, PURE crossing-latch state machine.
 *
 * THE PROBLEM IT FIXES (evidenced from the deterministic pipeline, not tuning):
 * the forward-looking entry gate (`entry-window.ts`) is a single-instant snapshot,
 * and the supervisor evaluates it only once per cadence (SCHED_SUPERVISOR_MS, ~30s).
 * A fast breakout crosses the entry band BETWEEN evaluations, so the periodic
 * snapshot lands either just BEFORE the trigger (NEAR_TRIGGER) or just AFTER it
 * (WAIT_FOR_PULLBACK) — never inside the instantaneous ACTIONABLE window. The
 * result is the "called too late / missed a clean NVDA breakout" symptom.
 *
 * THE FIX: two consecutive supervisor snapshots BRACKET the crossing. If a prior
 * evaluation saw the candidate developing on the favorable side (NEAR_TRIGGER or
 * ACTIONABLE) within a short TTL, and the current evaluation shows it only just
 * past the band (still confirmed, accelerating, on volume, fresh, and NOT
 * extended), then the entry is still valid — it crossed the zone between our
 * samples. We rescue it to ACTIONABLE exactly ONCE.
 *
 * SAFETY (all preserved — this NEVER widens the always-on VWAP band):
 *  - Requires a prior developing stamp within TTL (proves a genuine crossing, not
 *    a candidate merely sitting at an extended level → no top-of-candle chasing).
 *  - Hard anti-chase: rescue only within `crossToleranceVwapDistPct` beyond the
 *    band, always strictly less than the extended cap (enforced in entry-window).
 *  - Fires once per episode (firedAtMs); a new episode needs a clear + re-form.
 *  - Invalidation (reversed / extended / blocked) clears the latch immediately.
 *  - Stale stamps expire by TTL — no ghost alerts.
 *  - The live latch map is in-memory, so a process restart starts empty: a rescue
 *    can only fire if THIS process observed the prior developing stamp → no
 *    post-restart ghost alerts.
 *  - It adds NO provider calls: it reuses the momentum snapshots the supervisor
 *    already computes each cycle.
 *
 * It is consumed by `entry-window.ts` (the single source of truth for entry state)
 * so every downstream gate — eligibility, portfolio ranking, emission dedup, the
 * actionable-only Discord boundary, the paper bridge — is unchanged.
 */
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface LatchConfig {
  /** How long a developing stamp stays eligible to rescue a crossing (ms). */
  ttlMs: number;
  /** How far past the band (in |VWAP distance %|) a crossing may still be rescued. */
  crossToleranceVwapDistPct: number;
}

export function latchConfig(env: NodeJS.ProcessEnv = process.env): LatchConfig {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    // One or two supervisor cadences of memory — long enough to bracket a
    // between-cycle crossing, short enough that a stale setup cannot be rescued.
    ttlMs: num(env.CROSS_LATCH_TTL_MS, 90_000),
    // Small: a crossing is only rescued a hair past the band, never near the
    // extended/chase cap. Kept well below entry-window's extendedVwapDistPct.
    crossToleranceVwapDistPct: num(env.CROSS_LATCH_TOLERANCE_PCT, 0.6),
  };
}

export interface LatchState {
  /** When we first saw a developing setup for this candidate (null = none). */
  developingSinceMs: number | null;
  /** When a crossing (or a normal ACTIONABLE) last fired — dedup guard. */
  firedAtMs: number | null;
}

export const EMPTY_LATCH: LatchState = { developingSinceMs: null, firedAtMs: null };

export interface CrossingSignal {
  /** A prior developing stamp is active within TTL and no fire happened yet. */
  active: boolean;
  /** True once a fire (normal or rescued) occurred this episode. */
  alreadyFired: boolean;
  /** Passed through to entry-window's anti-chase check (band + this = ceiling). */
  crossToleranceVwapDistPct: number;
}

export interface LatchUpdate {
  /** Current evaluation is a live developing setup on the favorable side. */
  developingNow: boolean;
  /** Current evaluation reversed / extended / blocked → clear the latch. */
  invalidated: boolean;
  nowMs: number;
  cfg: LatchConfig;
}

/**
 * Advance the latch for one evaluation. Pure: prior state in, next state out.
 * Expiry and invalidation clear the stamp; a developing setup (re)arms it.
 */
export function updateLatch(prev: LatchState | undefined, u: LatchUpdate): LatchState {
  const cfg = u.cfg;
  let developingSinceMs = prev?.developingSinceMs ?? null;
  let firedAtMs = prev?.firedAtMs ?? null;

  // Invalidation wipes the episode entirely (reversed/extended/blocked setups
  // must never be rescued).
  if (u.invalidated) return { developingSinceMs: null, firedAtMs: null };

  // Expire a stale stamp (and its fired flag) so a fresh episode can arm later.
  if (developingSinceMs != null && u.nowMs - developingSinceMs > cfg.ttlMs) {
    developingSinceMs = null;
    firedAtMs = null;
  }

  // Arm/keep the stamp while the setup is developing. `since` is set once per
  // episode so TTL measures from the FIRST developing observation.
  if (u.developingNow && developingSinceMs == null) {
    developingSinceMs = u.nowMs;
  }

  return { developingSinceMs, firedAtMs };
}

/** Compute the crossing signal to hand to entry-window this cycle. */
export function crossingSignal(latch: LatchState | undefined, nowMs: number, cfg: LatchConfig): CrossingSignal {
  const since = latch?.developingSinceMs ?? null;
  const fired = latch?.firedAtMs != null;
  const active = since != null && (nowMs - since) <= cfg.ttlMs && !fired;
  return { active, alreadyFired: fired, crossToleranceVwapDistPct: cfg.crossToleranceVwapDistPct };
}

/** Mark a fire (normal ACTIONABLE or a rescued crossing) — dedup for the episode. */
export function markFired(latch: LatchState | undefined, nowMs: number): LatchState {
  const base = latch ?? EMPTY_LATCH;
  return { developingSinceMs: base.developingSinceMs, firedAtMs: nowMs };
}

/** True when the peak figure is a real number (used by callers building updates). */
export function hasMomentum(v: unknown): v is number {
  return isNum(v);
}
