/** Filter momentum / unusual scanner rows for Toolbar + Sidebar views. */

import type { FilterKey } from "@/components/Sidebar";
import type { MomentumRow, UnusualRow } from "@/lib/types";

function ivPct(iv: number | null | undefined): number | null {
  if (iv == null) return null;
  return iv > 5 ? iv : iv * 100;
}

function matchesFilters<T>(
  row: T,
  filters: FilterKey[],
  check: (r: T, f: FilterKey) => boolean,
): boolean {
  if (!filters.length) return true;
  return filters.every((f) => check(row, f));
}

export function filterMomentum(rows: MomentumRow[], filters: FilterKey[]): MomentumRow[] {
  return rows.filter((r) =>
    matchesFilters(r, filters, (row, f) => {
      if (f === "strong") return row.score >= 80;
      if (f === "call") return row.side === "call" || row.bias === "bullish";
      if (f === "put") return row.side === "put" || row.bias === "bearish";
      if (f === "highiv") {
        const iv = ivPct(row.contract?.iv);
        return iv != null && iv >= 80;
      }
      return true;
    }),
  );
}

export function filterUnusual(rows: UnusualRow[], filters: FilterKey[]): UnusualRow[] {
  return rows.filter((r) =>
    matchesFilters(r, filters, (row, f) => {
      if (f === "strong") return row.score >= 80;
      if (f === "new") return row.newPositioning;
      if (f === "highiv") {
        const iv = ivPct(row.iv);
        return iv != null && iv >= 80;
      }
      return true;
    }),
  );
}
