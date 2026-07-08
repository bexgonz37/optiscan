/**
 * Customizable per-user STOCK scanners (Market tab only).
 * Client-side, localStorage-persisted. Applies as a POST-FETCH filter on the
 * live tape — it NEVER changes server-side gates or signal math.
 */

export type StockScanFilters = {
  minMovePct?: number; // |% move| >=
  minSurge?: number; // volume surge x >=
  minAbsShortRate?: number; // |%/min| speed >=
  minPrice?: number;
  maxPrice?: number;
  requireBreak?: boolean; // HOD or LOD break
};

export type StockScanPreset = {
  id: string;
  name: string;
  filters: StockScanFilters;
};

export const DEFAULT_STOCK_SCANNERS: StockScanPreset[] = [
  { id: "rs-breakout", name: "RS Breakouts", filters: { minMovePct: 3, minSurge: 2, requireBreak: true, minPrice: 5 } },
  { id: "gap-go", name: "Gap & Go", filters: { minMovePct: 4, minSurge: 3, minPrice: 2, maxPrice: 80 } },
  { id: "rvol-spike", name: "RVOL Spike", filters: { minSurge: 4, minAbsShortRate: 0.3 } },
  { id: "fast-movers", name: "Fast Movers", filters: { minAbsShortRate: 0.4, minMovePct: 1.5 } },
];

const KEY = "optiscan:stock-scanners";

export function loadStockScanners(): StockScanPreset[] {
  if (typeof window === "undefined") return DEFAULT_STOCK_SCANNERS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_STOCK_SCANNERS;
    const parsed = JSON.parse(raw) as StockScanPreset[];
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_STOCK_SCANNERS;
  } catch {
    return DEFAULT_STOCK_SCANNERS;
  }
}

export function saveStockScanners(list: StockScanPreset[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore quota */
  }
}

/** Apply a preset's filters to tape-like rows. Pure, no side effects. */
export function applyStockScan<
  T extends { movePct?: number | null; surge?: number | null; shortRate?: number | null; price?: number | null; hodBreak?: boolean; lodBreak?: boolean },
>(rows: T[], f: StockScanFilters | null | undefined): T[] {
  if (!f) return rows;
  return rows.filter((r) => {
    if (f.minMovePct != null && Math.abs(r.movePct ?? 0) < f.minMovePct) return false;
    if (f.minSurge != null && (r.surge ?? 0) < f.minSurge) return false;
    if (f.minAbsShortRate != null && Math.abs(r.shortRate ?? 0) < f.minAbsShortRate) return false;
    if (f.minPrice != null && (r.price ?? 0) < f.minPrice) return false;
    if (f.maxPrice != null && (r.price ?? Infinity) > f.maxPrice) return false;
    if (f.requireBreak && !(r.hodBreak || r.lodBreak)) return false;
    return true;
  });
}

/** Human-readable one-line summary of a preset's criteria. */
export function summarizeFilters(f: StockScanFilters): string {
  const parts: string[] = [];
  if (f.minMovePct != null) parts.push(`move ≥ ${f.minMovePct}%`);
  if (f.minSurge != null) parts.push(`RVOL ≥ ${f.minSurge}×`);
  if (f.minAbsShortRate != null) parts.push(`speed ≥ ${f.minAbsShortRate}%/m`);
  if (f.requireBreak) parts.push("HOD/LOD break");
  if (f.minPrice != null) parts.push(`≥ $${f.minPrice}`);
  if (f.maxPrice != null) parts.push(`≤ $${f.maxPrice}`);
  return parts.join(" · ") || "no filters";
}
