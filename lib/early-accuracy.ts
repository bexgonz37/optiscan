/**
 * Early-move accuracy — measures whether the stock moved the right way
 * right after the call (1m / 5m checkpoints), not just peak move by EOD.
 */

export const EARLY_CHECKPOINT_PRIMARY = "5m";
export const EARLY_CHECKPOINT_FAST = "1m";

/** Min favorable % at 5m to count as "worked right after the call". */
export const EARLY_MOVE_WIN_PCT = Number(process.env.EARLY_MOVE_WIN_PCT ?? 0.75);

/** Min favorable % at 5m (or 1m if 5m not yet) to show as live on-track. */
export const EARLY_ON_TRACK_MIN_PCT = Number(process.env.EARLY_ON_TRACK_MIN_PCT ?? 0.5);

/** Min favorable % at 1m when 5m checkpoint doesn't exist yet. */
export const EARLY_1M_ON_TRACK_MIN_PCT = Number(process.env.EARLY_1M_ON_TRACK_MIN_PCT ?? 0.25);

export function earlyMoveWin(movePct: number | null | undefined): boolean | null {
  if (movePct == null || !Number.isFinite(movePct)) return null;
  return movePct >= EARLY_MOVE_WIN_PCT;
}

/** Best early checkpoint move available: prefer 5m, then 3m, then 1m. */
export function pickEarlyMove(row: {
  move_5m?: number | null;
  move_3m?: number | null;
  move_1m?: number | null;
}): { checkpoint: string; move: number } | null {
  if (row.move_5m != null && Number.isFinite(row.move_5m)) return { checkpoint: "5m", move: row.move_5m };
  if (row.move_3m != null && Number.isFinite(row.move_3m)) return { checkpoint: "3m", move: row.move_3m };
  if (row.move_1m != null && Number.isFinite(row.move_1m)) return { checkpoint: "1m", move: row.move_1m };
  return null;
}

export function isEarlyOnTrack(row: {
  move_5m?: number | null;
  move_3m?: number | null;
  move_1m?: number | null;
}): boolean {
  const early = pickEarlyMove(row);
  if (!early) return false;
  const min =
    early.checkpoint === "1m" ? EARLY_1M_ON_TRACK_MIN_PCT : EARLY_ON_TRACK_MIN_PCT;
  return early.move >= min;
}
