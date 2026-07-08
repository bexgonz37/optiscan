"use client";

import type { ReactNode } from "react";

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="axiom-stat">
      <div className="axiom-stat-k">{label}</div>
      <div className="axiom-stat-v num">{value}</div>
      {hint ? <div className="axiom-stat-h">{hint}</div> : null}
    </div>
  );
}
