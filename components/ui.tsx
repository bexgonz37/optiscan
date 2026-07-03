import type { Grade } from "@/lib/types";

/** Deterministic vivid color for a ticker badge. */
export function tickerColor(symbol: string | null | undefined): string {
  const s = symbol ?? "";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 62%, 58%)`;
}

export function TickerIcon({ symbol, size = 30 }: { symbol: string | null | undefined; size?: number }) {
  const label = (symbol ?? "?").slice(0, 2).toUpperCase();
  return (
    <div className="ticon" style={{ background: tickerColor(symbol), width: size, height: size }}>
      {label}
    </div>
  );
}

export function SideTag({ side }: { side: string | null | undefined }) {
  if (side === "call") return <span className="tag t-call">CALL</span>;
  if (side === "put") return <span className="tag t-put">PUT</span>;
  return null;
}

export function GradeChip({ grade }: { grade: Grade | string }) {
  const color =
    grade === "STRONG" ? "var(--green)" : grade === "GOOD" ? "var(--cyan)" : grade === "WATCH" ? "var(--amber)" : "var(--dim)";
  return (
    <span className="badge b-strat" style={{ color }}>
      {grade}
    </span>
  );
}

export function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <span className="score">
      <span className="scorebar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="scoreval">{Math.round(score)}</span>
    </span>
  );
}

export function ivColor(v: number | null | undefined): string {
  const n = v ?? 0;
  return n > 90 ? "var(--red)" : n > 55 ? "var(--amber)" : "var(--green)";
}

export function IvBar({ iv }: { iv: number | null | undefined }) {
  const n = iv ?? null;
  if (n == null) return <span className="dim">—</span>;
  const pct = Math.max(0, Math.min(100, n > 5 ? n : n * 100));
  return (
    <span className="ivr">
      <span className="ivbar">
        <i style={{ width: `${pct}%`, background: ivColor(pct) }} />
      </span>
      <span className="num" style={{ width: 26 }}>
        {Math.round(pct)}
      </span>
    </span>
  );
}

export function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div className="stat">
      <div className="l">{label}</div>
      <div className="v" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
    </div>
  );
}

export function Sparkline({
  values,
  color = "#00d68f",
  width = 64,
  height = 26,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (!values || values.length < 2) return null;
  const mn = Math.min(...values);
  const mx = Math.max(...values);
  const r = mx - mn || 1;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * width},${height - ((v - mn) / r) * height}`)
    .join(" ");
  return (
    <svg width={width} height={height}>
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.85}
      />
    </svg>
  );
}
