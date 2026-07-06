/** Pure helpers for accuracy ratio display — tested independently of SQLite. */

export function formatOnTrackRatio(onTrack: number, total: number): string {
  return `${onTrack} of ${total}`;
}

export function onTrackPct(onTrack: number, total: number): number | null {
  if (total <= 0) return null;
  return onTrack / total;
}

export function mapDailyTrendRow(row: {
  day: string;
  total?: number;
  wins?: number;
  losses?: number;
  option_wins?: number;
  option_losses?: number;
  live_on_track?: number;
  tracking?: number;
  avg_max_move?: number | null;
}) {
  const done = (row.wins ?? 0) + (row.losses ?? 0);
  const optDone = (row.option_wins ?? 0) + (row.option_losses ?? 0);
  return {
    day: row.day,
    total: row.total ?? 0,
    wins: row.wins ?? 0,
    losses: row.losses ?? 0,
    tracking: row.tracking ?? 0,
    liveOnTrack: row.live_on_track ?? 0,
    hitRate: done > 0 ? (row.wins ?? 0) / done : null,
    optionWinRate: optDone > 0 ? (row.option_wins ?? 0) / optDone : null,
    avgMaxMove: row.avg_max_move ?? null,
  };
}
