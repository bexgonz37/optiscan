"use client";

export type Tab = "momentum" | "unusual";
export type FilterKey = "strong" | "call" | "put" | "highiv" | "new";

export interface View {
  id: string;
  label: string;
  icon: string;
  tab: Tab;
  filters: FilterKey[];
  countKey?: "momentum" | "unusual" | "strong";
}

/** Two scanners only — views sidebar removed for simpler UX. */
export const VIEWS: View[] = [
  { id: "momentum", label: "Momentum", icon: "⚡", tab: "momentum", filters: [], countKey: "momentum" },
  { id: "unusual", label: "Unusual Flow", icon: "🌊", tab: "unusual", filters: [], countKey: "unusual" },
];

export function Sidebar({
  activeView,
  onSelect,
  counts,
}: {
  activeView: string;
  onSelect: (view: View) => void;
  counts: { momentum: number; unusual: number; strong: number };
}) {
  return (
    <div className="panel side">
      <h3>Scanners</h3>
      {VIEWS.map((v) => (
        <button
          key={v.id}
          className={`scan-item ${activeView === v.id ? "active" : ""}`}
          onClick={() => onSelect(v)}
        >
          <span className="ic">{v.icon}</span>
          {v.label}
          {v.countKey ? <span className="count">{counts[v.countKey]}</span> : null}
        </button>
      ))}
    </div>
  );
}
