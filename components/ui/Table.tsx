"use client";

import type { ReactNode } from "react";
import { EmptyState } from "./Shell";

/**
 * Shared, responsive data table (Phase 4). Wraps itself in a horizontal-scroll
 * container so wide tables scroll internally instead of overflowing the page.
 * When there are no rows it renders an EmptyState that explains why — never a
 * blank fixed-height box.
 */

export type Column<T> = {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  width?: number | string;
};

export function SimpleTable<T>({
  columns,
  rows,
  rowKey,
  emptyTitle = "Nothing here yet",
  emptyReason,
  className = "",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, i: number) => string;
  emptyTitle?: ReactNode;
  emptyReason: ReactNode;
  className?: string;
}) {
  if (!rows.length) {
    return <EmptyState title={emptyTitle} reason={emptyReason} />;
  }
  return (
    <div className={`ui-table-scroll ${className}`.trim()}>
      <table className="ui-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ textAlign: c.align ?? "left", width: c.width }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)}>
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align ?? "left" }}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
