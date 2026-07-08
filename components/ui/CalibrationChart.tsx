"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface PerfRow {
  checkpoint?: string | null;
  percent_move_from_alert?: number | null;
}

const GREEN = "#20e39a";
const CHECKPOINTS = ["1m", "3m", "5m", "eod"] as const;

export function CalibrationChart({ rows }: { rows: PerfRow[] }) {
  const data = CHECKPOINTS.map((checkpoint) => {
    const pts = rows.filter(
      (r) => r.checkpoint === checkpoint && r.percent_move_from_alert != null,
    );
    const avg =
      pts.length > 0
        ? pts.reduce((s, r) => s + (r.percent_move_from_alert ?? 0), 0) / pts.length
        : null;
    return {
      checkpoint: checkpoint.toUpperCase(),
      avgMove: avg != null ? Math.round(avg * 10) / 10 : 0,
      count: pts.length,
    };
  }).filter((d) => d.count > 0);

  if (!data.length) {
    return (
      <div className="empty small acc-charts-empty">
        Checkpoint calibration appears once alerts are tracked through 1m / 5m / EOD.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(70,180,232,0.12)" />
        <XAxis dataKey="checkpoint" tick={{ fontSize: 10, fill: "var(--dim)" }} />
        <YAxis tick={{ fontSize: 10, fill: "var(--dim)" }} unit="%" />
        <Tooltip
          formatter={(v, _n, item: any) => [
            `${v ?? 0}% avg · ${item?.payload?.count ?? 0} samples`,
            "Move from alert",
          ]}
          contentStyle={{
            background: "rgba(7, 12, 20, 0.96)",
            border: "1px solid rgba(70, 180, 232, 0.2)",
            fontSize: 12,
          }}
        />
        <Bar dataKey="avgMove" name="Avg move" fill={GREEN} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
