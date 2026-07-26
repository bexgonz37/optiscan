/**
 * Honest return vocabulary for subscriber-facing copy and APIs.
 * MFE is peak excursion — never a realized subscriber gain.
 */

export type ReturnMetricKind = "current_unrealized" | "realized" | "mfe_peak" | "mae_worst";

export interface LabeledReturn {
  kind: ReturnMetricKind;
  label: string;
  valuePct: number | null;
  disclaimer: string;
}

export function labelCurrentReturn(pct: number | null): LabeledReturn {
  return {
    kind: "current_unrealized",
    label: "Current return (unrealized)",
    valuePct: pct,
    disclaimer: "Mark vs frozen Discord entry. Not a realized gain until closed.",
  };
}

export function labelRealizedReturn(pct: number | null): LabeledReturn {
  return {
    kind: "realized",
    label: "Realized return",
    valuePct: pct,
    disclaimer: "Closed position return vs frozen Discord entry.",
  };
}

export function labelMfe(pct: number | null): LabeledReturn {
  return {
    kind: "mfe_peak",
    label: "Peak favorable move (MFE)",
    valuePct: pct,
    disclaimer: "Highest mark reached after alert — peak excursion, not a realized subscriber gain.",
  };
}

export function labelMae(pct: number | null): LabeledReturn {
  return {
    kind: "mae_worst",
    label: "Worst adverse move (MAE)",
    valuePct: pct,
    disclaimer: "Lowest mark reached after alert — adverse excursion only.",
  };
}

export function formatPctForCopy(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "n/a";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

/** Guard: reject copy that implies MFE is realized. */
export function assertNotMisleadingPeakAsRealized(kind: ReturnMetricKind, copy: string): boolean {
  if (kind !== "mfe_peak") return true;
  return !/\b(gain|profit|made|earned|returned)\b/i.test(copy);
}
