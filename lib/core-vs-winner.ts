/**
 * UI filter — core watch names always; extended universe only when breaking out
 * like a winner. Does not change scanner trigger math.
 */

import type { TapeRow } from "@/lib/watch-score";

/** Stricter than a casual mover — must look like a tradeable breakout. */
export function isWinnerCandidate(r: {
  shortRate?: number | null;
  surge?: number | null;
  efficiency?: number | null;
  hodBreak?: boolean;
  lodBreak?: boolean;
  promoted?: boolean;
}): boolean {
  const speed = Math.abs(r.shortRate ?? 0);
  const surge = r.surge ?? 0;
  const eff = r.efficiency;

  if (r.promoted && speed >= 0.22 && surge >= 1.45 && (eff == null || eff >= 0.35)) {
    return true;
  }
  if ((r.hodBreak || r.lodBreak) && speed >= 0.25 && surge >= 1.5) {
    return true;
  }
  if (speed >= 0.32 && surge >= 1.65 && (eff == null || eff >= 0.42)) {
    return true;
  }
  return false;
}

/** Default live tape: core always; extended only when winner-shaped (with linger). */
export function filterCoreAndWinners(
  rows: TapeRow[],
  hotSince: Map<string, number>,
  nowMs: number,
  lingerMs: number,
): TapeRow[] {
  return rows.filter((r) => {
    if (r.core) return true;
    if (isWinnerCandidate(r)) {
      hotSince.set(r.symbol, nowMs);
      return true;
    }
    const last = hotSince.get(r.symbol);
    if (last != null && nowMs - last < lingerMs) return true;
    hotSince.delete(r.symbol);
    return false;
  });
}

/** Core names first (by best speed), then runners — keeps NVDA/SPY above random promoted junk. */
export function sortCoreFirstThenSpeed(rows: TapeRow[]): TapeRow[] {
  const bestSpeed = (r: TapeRow) => Math.abs(r.instantRate ?? r.shortRate ?? 0);
  const core = rows.filter((r) => r.core).sort((a, b) => bestSpeed(b) - bestSpeed(a));
  const rest = rows.filter((r) => !r.core).sort((a, b) => bestSpeed(b) - bestSpeed(a));
  return [...core, ...rest];
}
