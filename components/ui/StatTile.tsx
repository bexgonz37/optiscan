"use client";

import type { ReactNode } from "react";
import { InfoTip } from "@/components/InfoTip";

export function StatTile({ label, value, hint, metric }: { label: string; value: ReactNode; hint?: string; metric?: string }) {
  return (
    <div className="axiom-stat">
      <div className="axiom-stat-k">{metric ? <InfoTip metric={metric}>{label}</InfoTip> : label}</div>
      <div className="axiom-stat-v num">{value}</div>
      {hint ? <div className="axiom-stat-h">{hint}</div> : null}
    </div>
  );
}
