/**
 * watch-score.ts — rank symbols by how worth watching right now (tape quality).
 * Used by the main Dashboard scanner table — separate from trade verdict / alerts.
 */

export interface TapeRow {
  symbol: string;
  price: number | null;
  movePct: number | null;
  volume: number | null;
  shortRate: number | null;
  /** 5s window speed — surfaces spikes before the 7–12s shortRate window. */
  instantRate?: number | null;
  accel: number | null;
  surge: number | null;
  efficiency: number | null;
  relVol: number | null;
  aboveVwap: boolean | null;
  vwapDistPct: number | null;
  hodBreak: boolean;
  lodBreak: boolean;
  direction: string;
  confidence: number;
  promoted?: boolean;
  /** True when the symbol is in the Core Watch universe (default UI list). */
  core?: boolean;
  catalystType?: string | null;
  catalystFresh?: boolean;
  haltStatus?: string | null;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** 0–100: higher = more worth having on your watchlist right now. */
export function computeWatchScore(r: TapeRow): number {
  let s = 0;

  const speed = r.shortRate != null ? Math.abs(r.shortRate) : 0;
  s += clamp(speed / 0.5, 0, 1) * 28;

  if (r.surge != null) s += clamp((r.surge - 1) / 2, 0, 1) * 18;

  if (r.relVol != null) s += clamp(r.relVol / 3, 0, 1) * 18;
  else if (r.volume != null) s += clamp(r.volume / 5_000_000, 0, 1) * 10;

  if (r.movePct != null) s += clamp(Math.abs(r.movePct) / 8, 0, 1) * 12;

  if (r.aboveVwap != null && r.shortRate != null && Math.abs(r.shortRate) >= 0.05) {
    const aligned = r.shortRate > 0 ? r.aboveVwap : !r.aboveVwap;
    if (aligned) s += 8;
  }

  if (r.hodBreak || r.lodBreak) s += 8;
  if (r.efficiency != null) s += r.efficiency * 10;
  if (r.accel != null && r.shortRate != null && Math.sign(r.accel) === Math.sign(r.shortRate)) s += 6;
  if (r.promoted) s += 4;

  return Math.round(clamp(s, 0, 100));
}

export type WatchSortKey = "watch" | "speed" | "volume" | "surge" | "move" | "level" | "rvol" | "vwap" | "symbol";

export function sortTape(rows: TapeRow[], key: WatchSortKey, dir: -1 | 1): TapeRow[] {
  const scored = rows.map((r) => ({ r, watch: computeWatchScore(r) }));
  const num = (r: TapeRow, k: WatchSortKey): number => {
    switch (k) {
      case "watch": return computeWatchScore(r);
      case "speed": return Math.abs(r.shortRate ?? 0);
      case "volume": return r.volume ?? 0;
      case "surge": return r.surge ?? 0;
      case "move": return Math.abs(r.movePct ?? 0);
      case "level": return r.hodBreak || r.lodBreak ? 1 : 0;
      case "rvol": return r.relVol ?? 0;
      case "vwap": return Math.abs(r.vwapDistPct ?? 0);
      default: return 0;
    }
  };
  scored.sort((a, b) => {
    if (key === "symbol") return a.r.symbol.localeCompare(b.r.symbol) * dir;
    const d = (num(a.r, key) - num(b.r, key)) * dir;
    // Stable tie-break by symbol so rows don't jump around between refreshes.
    return d !== 0 ? d : a.r.symbol.localeCompare(b.r.symbol);
  });
  return scored.map((x) => x.r);
}
