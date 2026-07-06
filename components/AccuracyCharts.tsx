"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface AccuracyChartData {
  todayOnTrack?: number;
  todayTotal?: number;
  liveOnTrackPct?: number | null;
  overallHitRate?: number | null;
  dailyTrend?: {
    day: string;
    total: number;
    hitRate: number | null;
    optionWinRate: number | null;
    liveOnTrack: number;
  }[];
  bySide?: { side: string; total: number; wins: number; losses: number }[];
}

const GREEN = "rgba(80, 200, 120, 0.85)";
const RED = "rgba(255, 100, 100, 0.85)";
const AMBER = "rgba(255, 176, 32, 0.85)";
const BLUE = "rgba(100, 160, 255, 0.85)";
const MUTED = "rgba(120, 140, 160, 0.5)";

function fmtDay(day: string) {
  const d = day.slice(5);
  return d.replace("-", "/");
}

function pct(v: number | null | undefined) {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}

export function AccuracyCharts({ data }: { data: AccuracyChartData }) {
  const trend = data.dailyTrend ?? [];
  const calloutBars = trend.map((d) => ({
    day: fmtDay(d.day),
    callouts: d.total,
    onTrack: d.liveOnTrack,
  }));

  const hitLine = trend
    .filter((d) => d.hitRate != null)
    .map((d) => ({ day: fmtDay(d.day), hitRate: Math.round((d.hitRate ?? 0) * 100) }));

  const optLine = trend
    .filter((d) => d.optionWinRate != null)
    .map((d) => ({ day: fmtDay(d.day), winRate: Math.round((d.optionWinRate ?? 0) * 100) }));

  const sideData = (data.bySide ?? []).map((s) => ({
    name: String(s.side ?? "?").toUpperCase().startsWith("P") ? "PUT" : "CALL",
    total: s.total ?? 0,
    wins: s.wins ?? 0,
    losses: s.losses ?? 0,
  }));

  const pieData = sideData.flatMap((s) => [
    { name: `${s.name} wins`, value: s.wins, fill: GREEN },
    { name: `${s.name} losses`, value: s.losses, fill: RED },
  ]).filter((x) => x.value > 0);

  const onTrackPct = data.liveOnTrackPct != null ? Math.round(data.liveOnTrackPct * 100) : 0;
  const gaugeData = [
    { name: "on track", value: onTrackPct, fill: GREEN },
    { name: "other", value: Math.max(0, 100 - onTrackPct), fill: MUTED },
  ];

  if (!trend.length && !sideData.length) {
    return (
      <div className="empty small acc-charts-empty">
        Charts appear once callouts are recorded over multiple sessions.
      </div>
    );
  }

  return (
    <div className="acc-charts-grid">
      <div className="acc-chart-panel">
        <div className="acc-chart-title">Callouts per day</div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={calloutBars} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(120,140,160,0.15)" />
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: "var(--muted)" }} />
            <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} allowDecimals={false} />
            <Tooltip contentStyle={{ background: "var(--panel)", border: "1px solid var(--line)", fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="callouts" name="Callouts" fill={BLUE} radius={[4, 4, 0, 0]} />
            <Bar dataKey="onTrack" name="On track" fill={GREEN} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="acc-chart-panel acc-chart-gauge">
        <div className="acc-chart-title">On-track rate today</div>
        <div className="acc-gauge-center">
          <span className="acc-gauge-num">{data.todayOnTrack ?? 0}</span>
          <span className="acc-gauge-of">of {data.todayTotal ?? 0} callouts</span>
          <span className="acc-gauge-pct">{onTrackPct}%</span>
        </div>
        <ResponsiveContainer width="100%" height={120}>
          <PieChart>
            <Pie data={gaugeData} dataKey="value" innerRadius={36} outerRadius={52} startAngle={90} endAngle={-270}>
              {gaugeData.map((e, i) => (
                <Cell key={i} fill={e.fill} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="muted" style={{ fontSize: 11, textAlign: "center" }}>
          Stock moved ≥1.5% the signal&apos;s way
        </div>
      </div>

      <div className="acc-chart-panel">
        <div className="acc-chart-title">Stock hit rate (final, by day)</div>
        {hitLine.length ? (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={hitLine} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(120,140,160,0.15)" />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: "var(--muted)" }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--muted)" }} unit="%" />
              <Tooltip formatter={(v) => [`${v ?? 0}%`, "Hit rate"]} contentStyle={{ background: "var(--panel)", border: "1px solid var(--line)", fontSize: 12 }} />
              <Line type="monotone" dataKey="hitRate" stroke={GREEN} strokeWidth={2} dot={{ r: 3 }} name="Hit rate" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="empty small" style={{ height: 200 }}>Pending — grades lock at market close</div>
        )}
      </div>

      <div className="acc-chart-panel">
        <div className="acc-chart-title">Option win rate (final, by day)</div>
        {optLine.length ? (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={optLine} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(120,140,160,0.15)" />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: "var(--muted)" }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--muted)" }} unit="%" />
              <Tooltip formatter={(v) => [`${v ?? 0}%`, "Win rate"]} contentStyle={{ background: "var(--panel)", border: "1px solid var(--line)", fontSize: 12 }} />
              <Line type="monotone" dataKey="winRate" stroke={AMBER} strokeWidth={2} dot={{ r: 3 }} name="Option win" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="empty small" style={{ height: 200 }}>Pending — contract grades at close</div>
        )}
      </div>

      {pieData.length > 0 ? (
        <div className="acc-chart-panel acc-chart-wide">
          <div className="acc-chart-title">CALL vs PUT outcomes (completed)</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" label={({ name, value }) => `${name}: ${value}`} labelLine={false}>
                {pieData.map((e, i) => (
                  <Cell key={i} fill={e.fill} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ background: "var(--panel)", border: "1px solid var(--line)", fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="muted" style={{ fontSize: 11 }}>
            Overall hit rate (window): {pct(data.overallHitRate)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
