/** Pure helpers for in-place value tick flash (chrome-noir UI). */

export type TickDirection = "up" | "down" | "";

export function tickDirection(
  next: number | null | undefined,
  prev: number | null | undefined,
  minDelta = 0,
): TickDirection {
  if (next == null || prev == null || next === prev) return "";
  if (minDelta > 0 && Math.abs(next - prev) < minDelta) return "";
  return next > prev ? "up" : "down";
}

/** Hysteresis: keep symbols visible briefly after they leave the hot set. */
export function applyHotLinger<T extends { symbol: string }>(
  rows: T[],
  isHot: (row: T) => boolean,
  hotSince: Map<string, number>,
  nowMs: number,
  lingerMs: number,
  getRow: (symbol: string) => T | undefined = (sym) => rows.find((r) => r.symbol === sym),
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (isHot(r)) hotSince.set(r.symbol, nowMs);
    seen.add(r.symbol);
    out.push(r);
  }
  for (const [sym, t] of hotSince) {
    if (seen.has(sym)) continue;
    if (nowMs - t < lingerMs) {
      const prev = getRow(sym);
      if (prev) out.push(prev);
    } else {
      hotSince.delete(sym);
    }
  }
  return out;
}
