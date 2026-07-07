/**
 * Hysteresis for "Moving now" tape filter — reduces flicker at speed threshold.
 */

import { MIN_SPEED_PCT_PER_MIN } from "./trade-verdict.ts";

export const FAST_ENTER_RATE = MIN_SPEED_PCT_PER_MIN;
export const FAST_EXIT_RATE = 0.12;
export const FAST_HYSTERESIS_MS = 2000;

interface HystEntry {
  inList: boolean;
  pendingSince: number | null;
}

export function applyFastFilterHysteresis<T extends { symbol: string; shortRate?: number | null }>(
  rows: T[],
  state: Map<string, HystEntry>,
  nowMs: number,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];

  for (const r of rows) {
    seen.add(r.symbol);
    const rate = Math.abs(r.shortRate ?? 0);
    let entry = state.get(r.symbol);
    if (!entry) {
      entry = { inList: false, pendingSince: null };
      state.set(r.symbol, entry);
    }

    if (entry.inList) {
      if (rate < FAST_EXIT_RATE) {
        if (entry.pendingSince == null) entry.pendingSince = nowMs;
        else if (nowMs - entry.pendingSince >= FAST_HYSTERESIS_MS) {
          entry.inList = false;
          entry.pendingSince = null;
        }
      } else {
        entry.pendingSince = null;
      }
    } else if (rate >= FAST_ENTER_RATE) {
      if (entry.pendingSince == null) entry.pendingSince = nowMs;
      else if (nowMs - entry.pendingSince >= FAST_HYSTERESIS_MS) {
        entry.inList = true;
        entry.pendingSince = null;
      }
    } else {
      entry.pendingSince = null;
    }

    if (entry.inList) out.push(r);
  }

  for (const sym of [...state.keys()]) {
    if (!seen.has(sym)) state.delete(sym);
  }

  return out;
}
