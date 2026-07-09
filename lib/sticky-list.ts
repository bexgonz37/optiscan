/**
 * sticky-list.ts — membership dwell for watch lists (pure).
 *
 * Problem: list membership recomputes every tick, so a symbol that qualifies
 * for one second flashes in and instantly vanishes ("the watch list flashes
 * symbols"). Ordering stability existed (stable-order.ts); MEMBERSHIP
 * stability did not.
 *
 * Rule: a symbol that qualifies enters immediately, and after it stops
 * qualifying it stays listed for DWELL_MS in a "cooling" state before it
 * drops — so the operator can actually follow what the scanner was watching.
 * Presentation-layer only; trigger math sees none of this.
 */

export const WATCH_DWELL_MS = Number(process.env.NEXT_PUBLIC_WATCH_DWELL_MS ?? 90_000);

export interface StickyState {
  lastQualifiedAt: Map<string, number>;
}

export function makeStickyState(): StickyState {
  return { lastQualifiedAt: new Map() };
}

export interface StickyResult {
  /** Qualifying symbols first (original order), then cooling ones. */
  symbols: string[];
  /** Symbols present only via dwell — render dimmed with a countdown feel. */
  cooling: Set<string>;
}

export function stickyMembership(
  qualified: string[],
  state: StickyState,
  nowMs: number,
  dwellMs: number = WATCH_DWELL_MS,
  maxCooling = 10,
): StickyResult {
  const qualifiedSet = new Set(qualified);
  for (const s of qualified) state.lastQualifiedAt.set(s, nowMs);

  const cooling: { symbol: string; at: number }[] = [];
  for (const [symbol, at] of state.lastQualifiedAt) {
    if (qualifiedSet.has(symbol)) continue;
    if (nowMs - at < dwellMs) cooling.push({ symbol, at });
    else state.lastQualifiedAt.delete(symbol);
  }
  cooling.sort((a, b) => b.at - a.at); // most recently hot first
  const kept = cooling.slice(0, maxCooling).map((c) => c.symbol);

  return { symbols: [...qualified, ...kept], cooling: new Set(kept) };
}
