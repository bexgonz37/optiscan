/**
 * lib/research/forward/freshness.ts — entry-freshness / TOO_LATE decision (Phase F). PURE.
 *
 * Immediately before a Discord delivery we re-check the underlying: if it has already run past the
 * intended entry (beyond the chase threshold in the alert's direction), or the entry zone is no
 * longer reachable, or the observation is too stale, the alert is TOO_LATE and must NOT be sent as
 * a live entry. This is what stops a paid product from shipping stale fills.
 */
export interface FreshnessInput {
  side: "call" | "put" | "stock";     // call/bullish moves up favor entry below; put/bearish inverse
  observedPrice: number;
  observedAtMs: number;
  currentPrice: number;
  currentAtMs: number;
  entryZone: [number, number] | null; // [low, high] acceptable entry band on the underlying
  maxChasePct: number;                 // max favorable move already elapsed before it's a chase
  maxAgeMs: number;                    // max age of the observation
}

export interface FreshnessResult {
  state: "FRESH" | "TOO_LATE";
  reason: string | null;
  movedPct: number;        // signed move since observation (+ = up)
  favorableMovePct: number; // move in the alert's PROFIT direction since observation
  ageMs: number;
}

export function checkEntryFreshness(input: FreshnessInput): FreshnessResult {
  const ageMs = input.currentAtMs - input.observedAtMs;
  const movedPct = input.observedPrice > 0 ? ((input.currentPrice - input.observedPrice) / input.observedPrice) * 100 : 0;
  // for calls/bullish, up is favorable; for puts/bearish, down is favorable
  const bullish = input.side === "call" || input.side === "stock";
  const favorableMovePct = bullish ? movedPct : -movedPct;
  const base: Omit<FreshnessResult, "state" | "reason"> = { movedPct: +movedPct.toFixed(4), favorableMovePct: +favorableMovePct.toFixed(4), ageMs };

  if (ageMs > input.maxAgeMs) return { state: "TOO_LATE", reason: `observation stale (${ageMs}ms > ${input.maxAgeMs}ms)`, ...base };
  if (favorableMovePct > input.maxChasePct) return { state: "TOO_LATE", reason: `already moved ${favorableMovePct.toFixed(2)}% in-direction (> ${input.maxChasePct}% chase limit)`, ...base };
  if (input.entryZone) {
    const [lo, hi] = input.entryZone;
    if (input.currentPrice < lo || input.currentPrice > hi) return { state: "TOO_LATE", reason: `current ${input.currentPrice} outside entry zone [${lo}, ${hi}]`, ...base };
  }
  return { state: "FRESH", reason: null, ...base };
}
