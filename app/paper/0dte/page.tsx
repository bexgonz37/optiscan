"use client";

/**
 * /paper/0dte — Aggressive 0DTE Research live terminal (simulated only).
 */

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { scanHeaders } from "@/hooks/useScanner";
import { TermHBar, TermGauge, TermSpark } from "@/components/terminal/TermViz";

type PerfSeg = {
  key: string;
  n: number;
  winRate: number | null;
  avgReturn: number | null;
  expectancy: number | null;
  captureEfficiency: number | null;
};

type Snapshot = {
  label?: string;
  enabled?: boolean;
  account?: Record<string, number | null>;
  today?: Record<string, number>;
  performance?: Record<string, any>;
  openPositions?: any[];
  recentFills?: any[];
  equityCurve?: { t: number; equity: number }[];
  strategyFamilyPerformance?: PerfSeg[];
  spyVsQqq?: PerfSeg[];
  callsVsPuts?: PerfSeg[];
  moneyness?: PerfSeg[];
  timeOfDay?: PerfSeg[];
  exitPolicyPerformance?: PerfSeg[];
  captureEfficiency?: number | null;
  bestOpen?: { symbol?: string | null; returnPct?: number | null } | null;
  worstOpen?: { symbol?: string | null; returnPct?: number | null } | null;
};

function fmtMoney(v: unknown, digits = 0): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
}

function fmtPct(v: unknown, digits = 1): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  // winRate / capture stored as 0..1 ratios — treat |n|<=1.5 as ratio unless clearly percent
  if (Math.abs(n) <= 1.5) return `${(n * 100).toFixed(digits)}%`;
  return `${n.toFixed(digits)}%`;
}

function fmtRet(v: unknown, digits = 1): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function toneSigned(v: unknown): string {
  if (v == null || !Number.isFinite(Number(v))) return "muted";
  const n = Number(v);
  if (n > 0) return "ok";
  if (n < 0) return "bad";
  return "muted";
}

function toneRate(v: unknown): string {
  if (v == null || !Number.isFinite(Number(v))) return "muted";
  const n = Math.abs(Number(v)) <= 1.5 ? Number(v) : Number(v) / 100;
  if (n >= 0.55) return "ok";
  if (n >= 0.4) return "warn";
  return "bad";
}

function isSpyQqq(sym: string | null | undefined): boolean {
  const s = String(sym ?? "").toUpperCase();
  return s === "SPY" || s === "QQQ";
}

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className={`cc-term-kpi ${tone ?? "muted"}`}>
      <span className="cc-term-kpi-label">{label}</span>
      <span className="cc-term-kpi-value">{value}</span>
      {hint ? <span className="cc-term-kpi-hint">{hint}</span> : null}
    </div>
  );
}

function Panel({
  title,
  badge,
  action,
  children,
  className,
}: {
  title: string;
  badge?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`cc-term-panel ${className ?? ""}`}>
      <header className="cc-term-panel-head">
        <span className="cc-term-panel-title">{title}</span>
        <div className="cc-term-panel-right">
          {badge}
          {action}
        </div>
      </header>
      <div className="cc-term-panel-body">{children}</div>
    </section>
  );
}

function SegTable({ title, rows, highlightKeys }: { title: string; rows: PerfSeg[]; highlightKeys?: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="cc-term-panel term-collapse-mobile">
      <button type="button" className="cc-term-collapse" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {title}
        <span className="cc-term-pill muted" style={{ marginLeft: 8 }}>{rows.length}</span>
      </button>
      {open ? (
        <div className="cc-term-panel-body">
          {rows.length === 0 ? (
            <p className="cc-term-empty">No sample</p>
          ) : (
            <TermHBar
              rows={rows.map((r) => ({
                key: r.key,
                label: `${r.key} (n=${r.n})`,
                value: Number(r.expectancy ?? r.avgReturn ?? 0),
                tone: highlightKeys?.includes(r.key) ? "ok" : undefined,
              }))}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}

export default function ZeroDteResearchTerminalPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/research/options/zero-dte-research", {
        cache: "no-store",
        headers: scanHeaders(),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
        return;
      }
      setSnap(json.snapshot ?? null);
      setEnabled(Boolean(json.config?.enabled ?? json.snapshot?.enabled));
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e: any) {
      setError(e?.message ?? "load failed");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  const acct = snap?.account ?? {};
  const today = snap?.today ?? {};
  const perf = snap?.performance ?? {};
  const equityData = (snap?.equityCurve ?? []).map((p, i) => ({
    i,
    t: p.t,
    equity: p.equity,
  }));

  return (
    <div className="ui-page cc-term">
      <div className="cc-term-strip">
        <div className="cc-term-strip-chips">
          <div className={`cc-term-chip ${enabled ? "ok" : "info"}`}>
            <span className="cc-term-chip-label">Lane</span>
            <span className="cc-term-chip-state">{enabled ? "ARMED" : "IDLE"}</span>
          </div>
          <div className="cc-term-chip ok">
            <span className="cc-term-chip-label">Focus</span>
            <span className="cc-term-chip-state">SPY / QQQ</span>
          </div>
          <div className="cc-term-chip muted">
            <span className="cc-term-chip-label">Today</span>
            <span className="cc-term-chip-state">
              SPY {today.spy ?? 0} · QQQ {today.qqq ?? 0}
            </span>
          </div>
        </div>
        <div className="cc-term-strip-meta">
          <span className="cc-term-pill muted">
            {updatedAt ? new Date(updatedAt).toLocaleTimeString() : "—"}
          </span>
          <button type="button" className="cc-term-refresh" disabled={refreshing} onClick={() => void load()}>
            {refreshing ? "…" : "Refresh"}
          </button>
          <Link href="/paper?tab=0dte" className="cc-term-link">Paper tab</Link>
        </div>
      </div>

      <p className="cc-term-disclaimer" style={{ margin: "0 0 12px" }}>
        Aggressive 0DTE Research — simulated only
      </p>

      {enabled === false ? (
        <div className="cc-term-banner info" style={{ marginBottom: 12 }}>
          Idle — PAPER_0DTE_RESEARCH_ENABLED≠1. Showing seeded / historical ledger only; no new research entries.
        </div>
      ) : null}

      {error ? (
        <div className="cc-term-banner bad" style={{ marginBottom: 12 }}>{error}</div>
      ) : null}

      <Panel title="Live account" badge={<span className="cc-term-pill muted">10s poll</span>}>
        <div className="cc-term-kpi-scroll">
          <Kpi label="Equity" value={fmtMoney(acct.equityUsd)} tone="ok" />
          <Kpi label="Daily P&L" value={fmtMoney(acct.dailyPnlUsd)} tone={toneSigned(acct.dailyPnlUsd)} />
          <Kpi label="Realized" value={fmtMoney(acct.realizedPnlUsd)} tone={toneSigned(acct.realizedPnlUsd)} />
          <Kpi label="Unrealized" value={fmtMoney(acct.unrealizedPnlUsd)} tone={toneSigned(acct.unrealizedPnlUsd)} />
          <Kpi label="Open risk" value={fmtMoney(acct.openRiskUsd)} tone="warn" />
          <Kpi label="Buying power" value={fmtMoney(acct.buyingPowerUsd)} />
          <Kpi label="Trades today" value={String(today.trades ?? 0)} />
          <Kpi label="SPY / QQQ" value={`${today.spy ?? 0} / ${today.qqq ?? 0}`} tone="ok" />
          <Kpi label="Open" value={String(today.open ?? 0)} />
          <Kpi label="Win rate" value={fmtPct(perf.winRate)} tone={toneRate(perf.winRate)} />
          <Kpi label="Capture" value={fmtPct(snap?.captureEfficiency ?? perf.captureEfficiency)} tone={toneRate(snap?.captureEfficiency ?? perf.captureEfficiency)} />
          <Kpi label="Expectancy" value={fmtRet(perf.expectancy)} tone={toneSigned(perf.expectancy)} />
        </div>
      </Panel>

      <div className="cc-term-two-col" style={{ marginTop: 14 }}>
        <Panel title="Equity curve" badge={<span className="cc-term-pill muted">closed PnL</span>}>
          <div className="cc-term-chart">
            <span className="cc-term-chart-label">Starting balance + cumulative closed P&L</span>
            {equityData.length >= 2 ? (
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={equityData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(80,120,100,0.15)" />
                  <XAxis dataKey="i" hide />
                  <YAxis tick={{ fontSize: 10, fill: "#6b7a72" }} width={52} domain={["auto", "auto"]} />
                  <Tooltip
                    contentStyle={{ background: "#0a0c0b", border: "1px solid rgba(80,200,120,0.25)", fontSize: 12 }}
                    formatter={(v) => [fmtMoney(v, 2), "Equity"]}
                  />
                  <Line type="monotone" dataKey="equity" stroke="#34d399" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="cc-term-empty">Equity curve needs closed research trades</p>
            )}
          </div>
        </Panel>

        <Panel title="Open highlights">
          <div className="cc-term-grid-2">
            <Kpi
              label="Best open"
              value={snap?.bestOpen ? `${snap.bestOpen.symbol ?? "—"} ${fmtRet(snap.bestOpen.returnPct)}` : "—"}
              tone="ok"
            />
            <Kpi
              label="Worst open"
              value={snap?.worstOpen ? `${snap.worstOpen.symbol ?? "—"} ${fmtRet(snap.worstOpen.returnPct)}` : "—"}
              tone="warn"
            />
            <Kpi label="Best family" value={String(perf.bestFamily ?? "—")} />
            <Kpi label="Worst family" value={String(perf.worstFamily ?? "—")} />
          </div>
          <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}>
            <TermGauge label="Open risk $" value={acct.openRiskUsd != null ? Number(acct.openRiskUsd) : null} max={5000} tone="warn" href="/paper/0dte" />
          </div>
        </Panel>
      </div>

      {/* Visual analytics */}
      <div className="cc-term-two-col term-0dte-viz" style={{ marginTop: 14 }}>
        <Panel title="SPY vs QQQ P&L">
          <TermHBar
            rows={(snap?.spyVsQqq ?? []).map((r) => ({
              key: r.key,
              label: `${r.key} (n=${r.n})`,
              value: Number(r.avgReturn ?? r.expectancy ?? 0),
            }))}
          />
        </Panel>
        <Panel title="Time-of-day P&L">
          <TermHBar
            rows={(snap?.timeOfDay ?? []).map((r) => ({
              key: r.key,
              label: `${r.key} (n=${r.n})`,
              value: Number(r.avgReturn ?? r.expectancy ?? 0),
            }))}
          />
        </Panel>
        <Panel title="Calls vs puts">
          <TermHBar
            rows={(snap?.callsVsPuts ?? []).map((r) => ({
              key: r.key,
              label: `${r.key} (n=${r.n})`,
              value: Number(r.avgReturn ?? 0),
            }))}
          />
        </Panel>
        <Panel title="ATM / ITM / OTM">
          <TermHBar
            rows={(snap?.moneyness ?? []).map((r) => ({
              key: r.key,
              label: `${r.key} (n=${r.n})`,
              value: Number(r.avgReturn ?? 0),
            }))}
          />
        </Panel>
        <Panel title="Strategy family">
          <TermHBar
            rows={(snap?.strategyFamilyPerformance ?? []).slice(0, 8).map((r) => ({
              key: r.key,
              label: r.key,
              value: Number(r.expectancy ?? r.avgReturn ?? 0),
            }))}
          />
        </Panel>
        <Panel title="MFE→realized capture">
          <TermHBar
            rows={(snap?.strategyFamilyPerformance ?? []).slice(0, 6).map((r) => ({
              key: r.key,
              label: r.key,
              value: Number(r.captureEfficiency ?? 0) * (Math.abs(Number(r.captureEfficiency ?? 0)) <= 1.5 ? 100 : 1),
              tone: "info",
            }))}
          />
        </Panel>
      </div>

      <Panel
        title="Open positions"
        badge={<span className="cc-term-pill muted">{(snap?.openPositions ?? []).length}</span>}
        action={<Link href="/quant?lane=zero_dte_research" className="cc-term-link">Quant Lab →</Link>}
        className="term-0dte-positions"
      >
        {(snap?.openPositions ?? []).length === 0 ? (
          <p className="cc-term-empty">No open 0DTE research positions</p>
        ) : (
          <>
            <div className="term-mobile-setups">
              <div className="term-setup-cards term-swipe-row">
                {(snap?.openPositions ?? []).map((r: any) => (
                  <Link key={`card-${r.id}`} href={`/paper/0dte/${r.id}`} className="term-setup-card clickable">
                    <div className="term-setup-card-top">
                      <span className="cc-term-pill ok">{r.symbol}</span>
                      <span className={`num ${toneSigned(r.unrealizedPct)}`}>{fmtRet(r.unrealizedPct)}</span>
                    </div>
                    <TermSpark
                      values={[0, Number(r.maePct ?? 0), Number(r.unrealizedPct ?? 0), Number(r.mfePct ?? 0)]}
                      width={80}
                      height={20}
                      fill
                    />
                    <div className="term-setup-card-meta">{r.side} · {r.family}</div>
                  </Link>
                ))}
              </div>
            </div>
            <div className="term-desktop-only-table">
          <table className="mini-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Family</th>
                <th>Path</th>
                <th>Entry</th>
                <th>Unreal</th>
                <th>MFE</th>
                <th>MAE</th>
                <th>Risk</th>
                <th>Policy</th>
              </tr>
            </thead>
            <tbody>
              {(snap?.openPositions ?? []).map((r: any) => (
                <tr
                  key={r.id}
                  style={isSpyQqq(r.symbol) ? { background: "rgba(52,211,153,0.05)" } : undefined}
                >
                  <td>
                    <Link href={`/paper/0dte/${r.id}`} className="cc-term-link">#{r.id}</Link>
                  </td>
                  <td>
                    {isSpyQqq(r.symbol) ? (
                      <span className="cc-term-pill ok">{r.symbol}</span>
                    ) : (
                      r.symbol ?? "—"
                    )}
                  </td>
                  <td>{r.side}</td>
                  <td>{r.family}</td>
                  <td>
                    <TermSpark
                      values={[0, Number(r.maePct ?? 0), Number(r.unrealizedPct ?? 0), Number(r.mfePct ?? 0)]}
                      width={56}
                      height={16}
                    />
                  </td>
                  <td className="num">{r.entry != null ? `$${Number(r.entry).toFixed(2)}` : "—"}</td>
                  <td className={`num ${toneSigned(r.unrealizedPct)}`}>{fmtRet(r.unrealizedPct)}</td>
                  <td className={`num ${toneSigned(r.mfePct)}`}>{fmtRet(r.mfePct)}</td>
                  <td className={`num ${toneSigned(r.maePct)}`}>{fmtRet(r.maePct)}</td>
                  <td className="num">{fmtMoney(r.accountRiskUsd)}</td>
                  <td>{r.exitPolicy ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
            </div>
          </>
        )}
      </Panel>

      <Panel title="Recent fills" badge={<span className="cc-term-pill muted">last 15</span>}>
        {(snap?.recentFills ?? []).length === 0 ? (
          <p className="cc-term-empty">No fills yet</p>
        ) : (
          <table className="mini-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Family</th>
                <th>Return</th>
                <th>P&L</th>
                <th>Reason</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {(snap?.recentFills ?? []).map((r: any) => (
                <tr key={`${r.id}-${r.status}-${r.atMs}`}>
                  <td>
                    <Link href={`/paper/0dte/${r.id}`} className="cc-term-link">#{r.id}</Link>
                  </td>
                  <td>
                    <span className={`cc-term-pill ${r.status === "EXITED" ? "muted" : "ok"}`}>{r.status}</span>
                  </td>
                  <td>
                    {isSpyQqq(r.symbol) ? (
                      <span className="cc-term-pill ok">{r.symbol}</span>
                    ) : (
                      r.symbol ?? "—"
                    )}
                  </td>
                  <td>{r.side}</td>
                  <td>{r.family ?? "—"}</td>
                  <td className={`num ${toneSigned(r.returnPct)}`}>{fmtRet(r.returnPct)}</td>
                  <td className={`num ${toneSigned(r.pnl)}`}>{fmtMoney(r.pnl, 2)}</td>
                  <td>{r.exitReason ?? "—"}</td>
                  <td className="muted">
                    {r.atMs ? new Date(Number(r.atMs)).toLocaleTimeString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="cc-term-two-col" style={{ marginTop: 14 }}>
        <SegTable title="Strategy family" rows={snap?.strategyFamilyPerformance ?? []} />
        <SegTable title="SPY vs QQQ" rows={snap?.spyVsQqq ?? []} highlightKeys={["SPY", "QQQ"]} />
      </div>
      <div className="cc-term-two-col" style={{ marginTop: 14 }}>
        <SegTable title="Calls vs puts" rows={snap?.callsVsPuts ?? []} />
        <SegTable title="Moneyness" rows={snap?.moneyness ?? []} highlightKeys={["ATM", "ITM", "OTM"]} />
      </div>
      <div className="cc-term-two-col" style={{ marginTop: 14 }}>
        <SegTable title="Time of day" rows={snap?.timeOfDay ?? []} />
        <SegTable title="Exit policy" rows={snap?.exitPolicyPerformance ?? []} />
      </div>
    </div>
  );
}
