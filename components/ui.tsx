import type { Grade } from "@/lib/types";
import type { ReactNode, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

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
    <div
      className="ticon"
      style={{ background: tickerColor(symbol), width: size, height: size }}
      data-size={size !== 30 ? size : undefined}
    >
      {label}
    </div>
  );
}

export function SideTag({ side }: { side: string | null | undefined }) {
  if (side === "call") return <span className="tag t-call">CALL</span>;
  if (side === "put") return <span className="tag t-put">PUT</span>;
  return null;
}

const GRADE_CLASS: Record<string, string> = {
  STRONG: "grade-strong",
  GOOD: "grade-good",
  WATCH: "grade-watch",
};

export function GradeChip({ grade }: { grade: Grade | string }) {
  const cls = GRADE_CLASS[String(grade)] ?? "grade-dim";
  return <span className={`badge b-strat ${cls}`}>{grade}</span>;
}

export function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <span className="score">
      <span className="scorebar">
        <i className="scorebar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="scoreval">{Math.round(score)}</span>
    </span>
  );
}

export function ivColor(v: number | null | undefined): string {
  const n = v ?? 0;
  return n > 90 ? "var(--bear)" : n > 55 ? "var(--warn)" : "var(--bull)";
}

export function IvBar({ iv }: { iv: number | null | undefined }) {
  const n = iv ?? null;
  if (n == null) return <span className="dim">—</span>;
  const pct = Math.max(0, Math.min(100, n > 5 ? n : n * 100));
  const tone = pct > 90 ? "iv-high" : pct > 55 ? "iv-mid" : "iv-low";
  return (
    <span className="ivr">
      <span className="ivbar">
        <i className={`ivbar-fill ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="num iv-val">{Math.round(pct)}</span>
    </span>
  );
}

export function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: "bull" | "bear" | "warn" }) {
  return (
    <div className="stat">
      <div className="l">{label}</div>
      <div className={`v${accent ? ` stat-accent-${accent}` : ""}`}>{value}</div>
    </div>
  );
}

/** Shared panel wrapper — consistent padding and density. */
export function Panel({
  children,
  className = "",
  title,
  subtitle,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={`ui-panel panel main ${className}`.trim()}>
      {title || subtitle || actions ? (
        <div className="ui-panel-head">
          <div>
            {title ? <h2 className="ui-panel-title">{title}</h2> : null}
            {subtitle ? <p className="ui-panel-sub muted">{subtitle}</p> : null}
          </div>
          {actions ? <div className="ui-panel-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Compact KPI chip for terminal-style stats. */
export function StatChip({
  label,
  value,
  hint,
  tone,
  onClick,
  active,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "bull" | "bear" | "warn";
  onClick?: () => void;
  active?: boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={`stat-chip${tone ? ` stat-chip-${tone}` : ""}${active ? " stat-chip-active" : ""}${onClick ? " stat-chip-clickable" : ""}`}
      onClick={onClick}
    >
      <span className="stat-chip-label">{label}</span>
      <span className="stat-chip-value num">{value}</span>
      {hint ? <span className="stat-chip-hint muted">{hint}</span> : null}
    </Tag>
  );
}

/** Data table primitive — terminal density, tabular nums, right-aligned numeric cols. */
export function DataTable({
  children,
  className = "",
  numericCols,
  ...rest
}: TableHTMLAttributes<HTMLTableElement> & { numericCols?: number[] }) {
  return (
    <div className={`tablewrap ui-table-wrap ${className}`.trim()}>
      <table className="ui-table" data-numeric-cols={numericCols?.join(",") ?? undefined} {...rest}>
        {children}
      </table>
    </div>
  );
}

export function DataTableHead({ children }: { children: ReactNode }) {
  return <thead className="ui-table-head">{children}</thead>;
}

export function DataTableBody({ children }: { children: ReactNode }) {
  return <tbody className="ui-table-body">{children}</tbody>;
}

export function DataTableRow({
  children,
  className = "",
  ...rest
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={`ui-table-row ${className}`.trim()} {...rest}>
      {children}
    </tr>
  );
}

export function DataTableTh({
  children,
  align = "left",
  className = "",
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" | "center" }) {
  return (
    <th className={`ui-table-th ui-align-${align} ${className}`.trim()} {...rest}>
      {children}
    </th>
  );
}

export function DataTableTd({
  children,
  align = "left",
  tone,
  className = "",
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & {
  align?: "left" | "right" | "center";
  tone?: "bull" | "bear" | "muted" | "warn";
}) {
  return (
    <td
      className={`ui-table-td ui-align-${align}${tone ? ` cell-${tone}` : ""} ${className}`.trim()}
      {...rest}
    >
      {children}
    </td>
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
    <svg width={width} height={height} className="sparkline">
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
