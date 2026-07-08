"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface JournalPoint {
  created_at?: string | null;
  pnl?: number | null;
}

const GREEN = "#20e39a";
const CYAN = "#46b4e8";

function fmtDay(iso: string) {
  return iso.slice(5, 10).replace("-", "/");
}

export function EquityCurve({ journal }: { journal: JournalPoint[] }) {
  const sorted = [...journal]
    .filter((j) => j.pnl != null && j.created_at)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  let cumulative = 0;
  const data = sorted.map((j, i) => {
    cumulative += j.pnl ?? 0;
    return {
      idx: i + 1,
      day: fmtDay(String(j.created_at)),
      equity: Math.round(cumulative * 100) / 100,
    };
  });

  if (data.length < 2) {
    return (
      <div className="empty small acc-charts-empty">
        Log trades or import Robinhood CSV — equity curve needs at least two closed entries.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(70,180,232,0.12)" />
        <XAxis dataKey="day" tick={{ fontSize: 10, fill: "var(--dim)" }} />
        <YAxis tick={{ fontSize: 10, fill: "var(--dim)" }} />
        <Tooltip
          formatter={(v) => [`$${v ?? 0}`, "Cumulative P&L"]}
          contentStyle={{
            background: "rgba(7, 12, 20, 0.96)",
            border: "1px solid rgba(70, 180, 232, 0.2)",
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="equity"
          stroke={cumulative >= 0 ? GREEN : "#ff5162"}
          strokeWidth={2}
          dot={{ r: 3, fill: CYAN }}
          name="Equity"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
