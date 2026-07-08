/**
 * near-miss.ts — "why didn't it alert?" observability (audit P1-5/T8).
 *
 * When a symbol is near-trigger but a gate blocks the callout, the loop
 * records WHICH gate failed and the values vs. thresholds into an in-memory
 * ring buffer exposed via /api/scanner/live. Pure helpers — the loop calls
 * them; they never influence trigger decisions (observability only).
 */

export interface NearMissGates {
  persistOk: boolean;
  accelOk: boolean;
  tapeMoving: boolean;
  shouldTrigger: boolean;
  cooldownBlocked: boolean;
}

export interface NearMissEntry {
  t: number;
  symbol: string;
  session: string;
  /** First gate (in evaluation order) that blocked the callout. */
  failedGate: string;
  gates: NearMissGates;
  values: {
    shortRate: number | null;
    accel: number | null;
    surge: number | null;
    efficiency: number | null;
    hodBreak: boolean;
    lodBreak: boolean;
  };
  thresholds: {
    minRate: number;
    minSurge: number;
    minEfficiency: number;
    minAccel: number;
  };
}

export const NEAR_MISS_BUFFER_MAX = 50;
export const NEAR_MISS_THROTTLE_MS = 30_000;

/** First blocking gate in the loop's evaluation order. */
export function firstFailedGate(gates: NearMissGates): string | null {
  if (gates.cooldownBlocked) return "cooldown";
  if (!gates.persistOk) return "persistOk";
  if (!gates.accelOk) return "accelOk";
  if (!gates.tapeMoving) return "tapeMoving";
  if (!gates.shouldTrigger) return "shouldTrigger";
  return null; // nothing failed — it fired
}

/** Throttle: one near-miss row per symbol per window keeps the buffer useful. */
export function shouldRecordNearMiss(
  lastRecordedAt: number | undefined,
  nowMs: number,
  throttleMs: number = NEAR_MISS_THROTTLE_MS,
): boolean {
  return lastRecordedAt == null || nowMs - lastRecordedAt >= throttleMs;
}

/** Push into the ring buffer (newest first), bounded to max entries. */
export function recordNearMiss(
  buffer: NearMissEntry[],
  entry: NearMissEntry,
  max: number = NEAR_MISS_BUFFER_MAX,
): NearMissEntry[] {
  buffer.unshift(entry);
  if (buffer.length > max) buffer.length = max;
  return buffer;
}

// ── Budget-aware deferral (audit P1-8, wired in T8) ──────────────────────────

export const BUDGET_DEFER_FRACTION = 0.9;

/**
 * True when the minute spend is close enough to the cap that NON-CRITICAL
 * provider calls (news enrichment, warm chain prefetch) should be skipped.
 * Trigger-path fetches are never deferred — they are the product.
 */
export function nearMinuteBudget(
  stats: { callsThisMinute: number; minuteCap: number } | null | undefined,
  fraction: number = BUDGET_DEFER_FRACTION,
): boolean {
  if (!stats || !(stats.minuteCap > 0)) return false;
  return stats.callsThisMinute >= stats.minuteCap * fraction;
}
