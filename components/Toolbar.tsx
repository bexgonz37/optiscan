"use client";

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
  title,
  tab,
  activeFilters,
  onToggle,
  onClear,
  loading,
  count,
}: {
  title: string;
  tab: Tab;
  activeFilters: FilterKey[];
  onToggle: (key: FilterKey) => void;
  onClear: () => void;
  loading: boolean;
  count: number;
}) {
  const chips = CHIPS[tab];
  const noneActive = activeFilters.length === 0;

  return (
    <div className="toolbar">
      <h2>{title}</h2>
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
        <span className="live">
          <span className={`dot ${loading ? "" : "off"}`} style={{ width: 6, height: 6 }} />
          {loading ? "scanning…" : `${count} shown`}
        </span>
      </div>
    </div>
  );
}
