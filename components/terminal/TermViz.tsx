"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/** Compact SVG sparkline from a number series (no network). */
export function TermSpark({
  values,
  width = 72,
  height = 22,
  tone = "ok",
  fill = false,
}: {
  values?: number[] | null;
  width?: number;
  height?: number;
  tone?: "ok" | "bad" | "warn" | "muted" | "info";
  fill?: boolean;
}) {
  if (!values || values.length < 2) {
    return <span className="term-spark-empty" style={{ width, height }} aria-hidden />;
  }
  const mn = Math.min(...values);
  const mx = Math.max(...values);
  const r = mx - mn || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - mn) / r) * (height - 2) - 1;
    return `${x},${y}`;
  });
  const line = pts.join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  const stroke =
    tone === "ok" ? "#34d399" :
    tone === "bad" ? "#f2607a" :
    tone === "warn" ? "#f6c454" :
    tone === "info" ? "#5aa9ff" : "#6f8078";
  const last = values[values.length - 1]!;
  const first = values[0]!;
  const dirTone = last >= first ? "ok" : "bad";
  const color = tone === "muted" ? stroke : (tone === "ok" || tone === "bad" ? (dirTone === "ok" ? "#34d399" : "#f2607a") : stroke);
  return (
    <svg width={width} height={height} className="term-spark" viewBox={`0 0 ${width} ${height}`} aria-hidden>
      {fill ? <polygon points={area} fill={color} opacity={0.12} /> : null}
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TermGauge({
  label,
  value,
  max = 100,
  tone = "ok",
  href,
}: {
  label: string;
  value: number | null;
  max?: number;
  tone?: string;
  href?: string;
}) {
  const pct = value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const inner = (
    <>
      <span className="term-gauge-label">{label}</span>
      <div className="term-gauge-ring" style={{ ["--g" as string]: `${pct}` }}>
        <span className={`term-gauge-val ${tone}`}>{value == null ? "—" : Math.round(value)}</span>
      </div>
    </>
  );
  if (href) return <Link href={href} className="term-gauge clickable">{inner}</Link>;
  return <div className="term-gauge">{inner}</div>;
}

export function TermFunnel({
  stages,
}: {
  stages: { key: string; label: string; count: number | null; href?: string }[];
}) {
  const max = Math.max(1, ...stages.map((s) => Number(s.count ?? 0)));
  return (
    <div className="term-funnel-viz">
      {stages.map((s, i) => {
        const n = Number(s.count ?? 0);
        const w = Math.max(18, Math.round((n / max) * 100));
        const body = (
          <>
            <span className="term-funnel-viz-count">{s.count == null ? "—" : n}</span>
            <div className="term-funnel-viz-bar" style={{ width: `${w}%` }} />
            <span className="term-funnel-viz-label">{s.label}</span>
            {i < stages.length - 1 ? <span className="term-funnel-viz-arrow" aria-hidden>›</span> : null}
          </>
        );
        return s.href ? (
          <Link key={s.key} href={s.href} className="term-funnel-viz-stage clickable">{body}</Link>
        ) : (
          <div key={s.key} className="term-funnel-viz-stage">{body}</div>
        );
      })}
    </div>
  );
}

export function TermHBar({
  rows,
  hrefFor,
}: {
  rows: { key: string; label: string; value: number; tone?: string }[];
  hrefFor?: (key: string) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div className="term-hbar">
      {rows.map((r) => {
        const pct = Math.round((Math.abs(r.value) / max) * 100);
        const tone = r.tone ?? (r.value >= 0 ? "ok" : "bad");
        const inner = (
          <>
            <span className="term-hbar-label">{r.label}</span>
            <div className="term-hbar-track">
              <div className={`term-hbar-fill ${tone}`} style={{ width: `${pct}%` }} />
            </div>
            <span className={`term-hbar-val ${tone}`}>{r.value.toFixed(1)}</span>
          </>
        );
        const href = hrefFor?.(r.key);
        return href ? (
          <Link key={r.key} href={href} className="term-hbar-row clickable">{inner}</Link>
        ) : (
          <div key={r.key} className="term-hbar-row">{inner}</div>
        );
      })}
    </div>
  );
}

export function TermPanel({
  title,
  badge,
  action,
  children,
  className,
  href,
}: {
  title: string;
  badge?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  href?: string;
}) {
  return (
    <section className={`cc-term-panel term-panel ${className ?? ""}`}>
      <header className="cc-term-panel-head">
        {href ? (
          <Link href={href} className="cc-term-panel-title term-panel-title-link">{title}</Link>
        ) : (
          <span className="cc-term-panel-title">{title}</span>
        )}
        <div className="cc-term-panel-right">
          {badge}
          {action}
        </div>
      </header>
      <div className="cc-term-panel-body">{children}</div>
    </section>
  );
}

export function TermPulse({ live }: { live?: boolean }) {
  return <span className={`term-pulse ${live ? "on" : ""}`} title={live ? "Live snapshot" : "Idle"} aria-hidden />;
}

export function actionTone(a: string): string {
  if (a === "SEND") return "ok";
  if (a === "WATCH") return "info";
  if (a === "RESEARCH") return "warn";
  if (a === "BLOCK" || a === "WAIT") return "bad";
  return "muted";
}

export function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3600_000)}h`;
}

export function fmtPct(v: unknown, digits = 1): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return `${Number(v).toFixed(digits)}%`;
}

export function fmtMoney(v: unknown, digits = 2): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return `$${Number(v).toFixed(digits)}`;
}
