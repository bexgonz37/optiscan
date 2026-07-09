"use client";

import type { ReactNode } from "react";
import { InfoTip } from "@/components/InfoTip";
import { CardTip } from "@/components/CardTip";

export function StatTile({ label, value, hint, metric }: { label: string; value: ReactNode; hint?: string; metric?: string }) {
  const tile = (
    <>
      <div className="axiom-stat-k">{metric ? <InfoTip metric={metric}>{label}</InfoTip> : label}</div>
      <div className="axiom-stat-v num">{value}</div>
      {hint ? <div className="axiom-stat-h">{hint}</div> : null}
    </>
  );
  if (metric) {
    return (
      <CardTip metric={metric} className="axiom-stat">
        {tile}
      </CardTip>
    );
  }
  return <div className="axiom-stat">{tile}</div>;
}
