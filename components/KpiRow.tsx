"use client";

import type { KpiSnapshot } from "@/hooks/useScanner";
import { Sparkline } from "@/components/ui";

export function KpiRow({
  kpi,
  history,
  universeCount,
}: {
  kpi: KpiSnapshot;
  history: KpiSnapshot[];
  universeCount: number;
}) {
  const series = (key: keyof KpiSnapshot) => history.map((h) => h[key]);

  const cards = [
    { label: "Signals", val: String(kpi.signals), sub: `${kpi.unusual} unusual hits`, key: "signals" as const, color: "#00d68f" },
    { label: "Strong setups", val: String(kpi.strong), sub: "score ≥ 80", key: "strong" as const, color: "#ffb020" },
    { label: "Avg signal", val: String(kpi.avgScore), sub: "momentum quality", key: "avgScore" as const, color: "#3ad0ff" },
    { label: "Avg IV", val: `${kpi.avgIv}%`, sub: "implied volatility", key: "avgIv" as const, color: "#8b7dff" },
    { label: "Scanned", val: String(kpi.scanned), sub: `of ${universeCount} universe`, key: "scanned" as const, color: "#00d68f" },
  ];

  return (
    <div className="kpis">
      {cards.map((c) => (
        <div className="kpi" key={c.label}>
          <div className="spark">
            <Sparkline values={series(c.key)} color={c.color} />
          </div>
          <div className="label">{c.label}</div>
          <div className="val num">{c.val}</div>
          <div className="sub">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
