"use client";

import type { ReactNode } from "react";
import type { Tab, FilterKey } from "@/components/Sidebar";

const CHIPS: Record<Tab, { key: FilterKey; label: string }[]> = {
  momentum: [
    { key: "strong", label: "Strong" },
    { key: "call", label: "Calls" },
    { key: "put", label: "Puts" },
    { key: "highiv", label: "High IV" },
  ],
  unusual: [
    { key: "strong", label: "Strong" },
    { key: "new", label: "New positioning" },
    { key: "highiv", label: "High IV" },
  ],
};

export function Toolbar({
  tab,
  onTabChange,
  activeFilters,
  onToggle,
  onClear,
  loading,
  count,
  search,
}: {
  tab: Tab;
  onTabChange: (t: Tab) => void;
  activeFilters: FilterKey[];
  onToggle: (key: FilterKey) => void;
  onClear: () => void;
  loading: boolean;
  count: number;
  search?: ReactNode;
}) {
  const chips = CHIPS[tab];
  const noneActive = activeFilters.length === 0;

  return (
    <div className="toolbar scanner-toolbar">
      <div className="scanner-tabs">
        <button type="button" className={`scanner-tab${tab === "momentum" ? " active" : ""}`} onClick={() => onTabChange("momentum")}>
          Momentum
        </button>
        <button type="button" className={`scanner-tab${tab === "unusual" ? " active" : ""}`} onClick={() => onTabChange("unusual")}>
          Unusual Flow
        </button>
      </div>

      {search}

      <div className="chips">
        <span className={`chip ${noneActive ? "on" : ""}`} onClick={onClear}>
          All
        </span>
        {chips.map((c) => (
          <span
            key={c.key}
            className={`chip ${activeFilters.includes(c.key) ? "on" : ""}`}
            onClick={() => onToggle(c.key)}
          >
            {c.label}
          </span>
        ))}
      </div>

      <div className="right">
        <span className="status-text">
          <span className={`status-dot${loading ? " live" : ""}`} style={{ marginRight: 6 }} />
          {loading ? "scanning…" : `${count} shown`}
        </span>
      </div>
    </div>
  );
}
