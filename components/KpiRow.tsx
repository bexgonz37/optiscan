"use client";

import type { KpiSnapshot } from "@/hooks/useScanner";

export function KpiRow({
  kpi,
  universeCount,
  loopLive,
}: {
  kpi: KpiSnapshot;
  universeCount: number;
  loopLive?: boolean;
}) {
  const items = [
    { label: "Strong", val: String(kpi.strong), hint: "score ≥ 80" },
    { label: "Signals", val: String(kpi.signals), hint: `${kpi.unusual} unusual` },
    { label: "Avg score", val: String(kpi.avgScore), hint: "momentum" },
    { label: "Scanned", val: String(kpi.scanned), hint: `of ${universeCount}` },
    { label: "Loop", val: loopLive ? "Live" : "—", hint: loopLive ? "1s tape" : "offline", live: loopLive },
  ];

  return (
    <div className="stat-strip">
      {items.map((c) => (
        <div className="stat-item" key={c.label}>
          <span className="stat-label">{c.label}</span>
          <span className={`stat-val num${c.live ? " live" : ""}`}>{c.val}</span>
          <span className="stat-hint">{c.hint}</span>
        </div>
      ))}
    </div>
  );
}
