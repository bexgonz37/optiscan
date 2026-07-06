"use client";

import type { ReactNode } from "react";
import type { Tab, FilterKey } from "@/components/Sidebar";

export function Toolbar({
  tab,
  onTabChange,
  activeFilters,
  onToggle,
  onClear,
  loading,
  count,
  search,
  onRefresh,
}: {
  tab: Tab;
  onTabChange: (t: Tab) => void;
  activeFilters: FilterKey[];
  onToggle: (key: FilterKey) => void;
  onClear: () => void;
  loading: boolean;
  count: number;
  search?: ReactNode;
  onRefresh?: () => void;
}) {
  const strongOnly = activeFilters.includes("strong");

  return (
    <div className="toolbar scanner-toolbar">
      <div className="scanner-tabs">
        <button type="button" className={`scanner-tab${tab === "momentum" ? " active" : ""}`} onClick={() => onTabChange("momentum")}>
          Momentum
        </button>
        <button type="button" className={`scanner-tab${tab === "unusual" ? " active" : ""}`} onClick={() => onTabChange("unusual")}>
          Unusual flow
        </button>
      </div>

      {search}

      <div className="chips">
        <span
          className={`chip ${strongOnly ? "on" : ""}`}
          onClick={() => {
            if (strongOnly) onClear();
            else onToggle("strong");
          }}
        >
          Strong only
        </span>
      </div>

      <div className="right">
        {onRefresh ? (
          <button type="button" className="pill btn btn-xs" onClick={onRefresh}>
            Refresh
          </button>
        ) : null}
        <span className="status-text">
          <span className={`status-dot status-dot-gap${loading ? " live" : ""}`} />
          {loading ? "scanning…" : `${count} shown`}
        </span>
      </div>
    </div>
  );
}
