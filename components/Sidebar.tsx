"use client";

export type Tab = "momentum" | "unusual";
export type FilterKey = "strong" | "call" | "put" | "highiv" | "new";

export interface View {
  id: string;
  label: string;
  icon: string;
  tab: Tab;
  filters: FilterKey[];
  section: "scanners" | "views";
  countKey?: "momentum" | "unusual" | "strong";
}

export const VIEWS: View[] = [
  { id: "momentum", label: "Momentum", icon: "⚡", tab: "momentum", filters: [], section: "scanners", countKey: "momentum" },
  { id: "unusual", label: "Unusual Flow", icon: "🌊", tab: "unusual", filters: [], section: "scanners", countKey: "unusual" },
  { id: "strong", label: "High-Conviction", icon: "🎯", tab: "momentum", filters: ["strong"], section: "views", countKey: "strong" },
  { id: "calls", label: "Bullish Calls", icon: "📈", tab: "momentum", filters: ["call"], section: "views" },
  { id: "puts", label: "Bearish Puts", icon: "📉", tab: "momentum", filters: ["put"], section: "views" },
  { id: "newpos", label: "New Positioning", icon: "🧨", tab: "unusual", filters: ["new"], section: "views" },
  { id: "highiv", label: "High IV", icon: "🔥", tab: "unusual", filters: ["highiv"], section: "views" },
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
  const scanners = VIEWS.filter((v) => v.section === "scanners");
  const views = VIEWS.filter((v) => v.section === "views");

  const item = (v: View) => (
    <button
      key={v.id}
      className={`scan-item ${activeView === v.id ? "active" : ""}`}
      onClick={() => onSelect(v)}
    >
      <span className="ic">{v.icon}</span>
      {v.label}
      {v.countKey ? <span className="count">{counts[v.countKey]}</span> : null}
    </button>
  );

  return (
    <div className="panel side">
      <h3>Scanners</h3>
      {scanners.map(item)}
      <div className="divider" />
      <h3>Views</h3>
      {views.map(item)}
    </div>
  );
}
