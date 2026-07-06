/**
 * signal-outcomes.ts — option contract P&L from stored snapshots.
 *
 * Stock accuracy (did the underlying move the right way) lives in
 * alert-tracker via alert_performance. This adds the second axis the user
 * asked for: did the CONTRACT itself gain, measured from the entry mid at
 * alert time to the best mid seen afterwards (live 7s snapshots + EOD).
 *
 * Pure and unit-tested — DB access stays in alert-store/alert-tracker.
 */

/** 0DTE premiums move fast; +15% on the mid is a meaningful winner. */
export const OPTION_WIN_THRESHOLD_PCT = Number(process.env.ALERT_OPTION_WIN_PCT ?? 15);

export interface SnapshotRow {
  checkpoint: string; // 'alert' | 'live' | 'eod'
  mid: number | null;
}

export interface OptionOutcome {
  entryMid: number;
  bestMid: number;
  /** % change from entry mid to the best mid seen after the alert. */
  returnPct: number;
  win: boolean;
}

/**
 * Compute the contract outcome from an alert's snapshots. Returns null when
 * there is no usable entry mid or no post-alert quotes to measure against.
 */
export function computeOptionOutcome(
  snapshots: SnapshotRow[],
  { winThresholdPct = OPTION_WIN_THRESHOLD_PCT }: { winThresholdPct?: number } = {},
): OptionOutcome | null {
  const entry = snapshots.find((s) => s.checkpoint === "alert" && s.mid != null && s.mid > 0);
  if (!entry) return null;
  const after = snapshots.filter(
    (s) => (s.checkpoint === "live" || s.checkpoint === "eod") && s.mid != null && s.mid > 0,
  );
  if (!after.length) return null;
  const entryMid = entry.mid as number;
  const bestMid = Math.max(...after.map((s) => s.mid as number));
  const returnPct = +(((bestMid - entryMid) / entryMid) * 100).toFixed(1);
  return { entryMid, bestMid, returnPct, win: returnPct >= winThresholdPct };
}
