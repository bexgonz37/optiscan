"use client";

/**
 * /paper — Paper Trading dashboard (v1.3).
 * Autonomous paper trading: deterministic auto-entry + scanner piggyback exits.
 * This does not depend on the read-only /copilot explanation page.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { InfoTip } from "@/components/InfoTip";
import { CardTip } from "@/components/CardTip";
import { Panel } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";
import { fmtPrice } from "@/lib/format";
import { formatOccContract, parseOccContract } from "@/lib/format-contract";

interface Summary {
  openCount: number; closedCount: number; gradedCount: number;
  wins: number; losses: number; winRatePct: number | null;
  avgGainPct: number | null; avgLossPct: number | null;
  profitFactor: number | null; expectancyDollars: number | null;
  totalPnlDollars: number; maxDrawdownDollars: number;
  largestWinDollars: number | null; largestLossDollars: number | null;
  avgHoldMinutes: number | null; avgMfePct: number | null; avgMaePct: number | null;
}

interface BucketRow { bucket: string; count: number; winRatePct: number | null; avgPnlPct: number | null; totalDollars: number }
interface PaperAccount { startingBalance: number; realizedPnl: number; equity: number; buyingPowerNote?: string }

const BUCKET_LABELS: [string, string][] = [
  ["byConfidence", "Confidence at entry"],
  ["byExpirationLength", "Expiration length"],
  ["bySetup", "Setup"],
  ["byExitKind", "Exit kind"],
];

function num(v: number | null | undefined, suffix = "", digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return "∞";
  return `${v.toFixed(digits)}${suffix}`;
}

function dollars(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(0)}`;
}

function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "never";
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function bucketTotal(rows: BucketRow[] | null | undefined): number {
  return (rows ?? []).reduce((s, r) => s + Number(r.count ?? 0), 0);
}

function sortedBuckets(rows: BucketRow[] | null | undefined): BucketRow[] {
  return [...(rows ?? [])].sort((a, b) => Math.abs(b.totalDollars) - Math.abs(a.totalDollars));
}

const STATE_CLASS: Record<string, string> = {
  ENTERED: "up", TAKE_PROFIT: "up", READY: "muted", WATCHING: "muted",
  STOPPED_OUT: "dn", EXITED: "", CANCELLED: "muted", EXPIRED: "muted",
};

type PaperView = "all" | "delivered" | "0dte" | "bearish" | "stock" | "shadow" | "history";
type DeliveredWindow = "7" | "30" | "90" | "all";

function readableContract(optionSymbol: string | null | undefined): string {
  return formatOccContract(optionSymbol) ?? "Contract unavailable";
}

function paperStatusLabel(status: string | null | undefined, auditOnly = false): string {
  if (auditOnly) return "Audit-only row";
  switch (String(status ?? "").toUpperCase()) {
    case "ENTERED": return "Open position";
    case "EXITED": return "Closed trade";
    case "PENDING_DELIVERY": return "Pending delivery";
    case "ABORTED": return "Aborted reservation";
    default: return status ? String(status).replaceAll("_", " ") : "Historical grade";
  }
}

function AccountSummaryCard(props: {
  name: string;
  purpose: string;
  starting: number | null | undefined;
  equity: number | null | undefined;
  todayPnl: number | null | undefined;
  verifiedPnl: number | null | undefined;
  open: number;
  closed: number;
  quality: string;
}) {
  return (
    <section className="panel main">
      <h2 className="section-title">{props.name}</h2>
      <p className="muted text-sm">{props.purpose}</p>
      <div className="axiom-strip paper-strip" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 8 }}>
        <StatTile label="Starting balance" value={dollars(props.starting)} />
        <StatTile label="Current equity" value={dollars(props.equity)} />
        <StatTile label="Today's P&L" value={dollars(props.todayPnl)} />
        <StatTile label="Total verified P&L" value={dollars(props.verifiedPnl)} />
        <StatTile label="Open positions" value={String(props.open)} />
        <StatTile label="Closed trades" value={String(props.closed)} />
        <StatTile label="Data quality" value={props.quality} />
      </div>
    </section>
  );
}

function PaperPageInner() {
  const [tab, setTab] = useState<PaperView>("all");
  const [researchTab, setResearchTab] = useState<"0dte" | "bearish" | "shadow">("0dte");
  const [data, setData] = useState<any>(null);
  const [zeroDte, setZeroDte] = useState<any>(null);
  const [deliveredChain, setDeliveredChain] = useState<any>(null);
  const [bearishResearch, setBearishResearch] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [recentAlerts, setRecentAlerts] = useState<any[]>([]);
  const [createNote, setCreateNote] = useState<string | null>(null);
  const [deliveredWindow, setDeliveredWindow] = useState<DeliveredWindow>("30");

  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("tab");
      if (q === "0dte" || q === "bearish" || q === "shadow") {
        setTab(q);
        setResearchTab(q);
      } else if (q === "all" || q === "delivered" || q === "stock" || q === "history") {
        setTab(q);
      }
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/paper/trades", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d?.ok) { setData(d); setError(null); } else setError(d?.error ?? "load failed");
    } catch (e: any) {
      setError(e?.message ?? "load failed");
    }
  }, []);

  const loadZeroDte = useCallback(async () => {
    try {
      const res = await fetch("/api/research/options/zero-dte-research", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d?.ok) setZeroDte(d);
    } catch { /* best effort */ }
  }, []);

  const loadDelivered = useCallback(async () => {
    try {
      const res = await fetch(`/api/research/options/paper-chain?limit=100&days=${deliveredWindow}`, { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d?.ok) setDeliveredChain(d.diagnostic ?? d);
      else if (d?.rows) setDeliveredChain(d);
    } catch { /* best effort */ }
  }, [deliveredWindow]);

  const loadBearishResearch = useCallback(async () => {
    try {
      const res = await fetch("/api/research/options/bearish-research", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d?.ok) setBearishResearch(d);
    } catch { /* best effort */ }
  }, []);

  const loadAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts?limit=12", { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      setRecentAlerts((d?.alerts ?? []).filter((a: any) => a.option_symbol && a.asset_class !== "stock"));
    } catch { /* best effort */ }
  }, []);

  useEffect(() => {
    load();
    loadAlerts();
    loadZeroDte();
    loadDelivered();
    loadBearishResearch();
    const t = setInterval(() => {
      load();
      if (tab === "0dte") loadZeroDte();
      if (tab === "delivered") loadDelivered();
      if (tab === "bearish") loadBearishResearch();
    }, 7_000);
    return () => clearInterval(t);
  }, [load, loadAlerts, loadZeroDte, loadDelivered, loadBearishResearch, tab]);

  const switchTab = (next: PaperView) => {
    setTab(next);
    if (next === "0dte" || next === "bearish" || next === "shadow") setResearchTab(next);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("tab", next);
      window.history.replaceState({}, "", u.toString());
    } catch { /* ignore */ }
  };

  const act = useCallback(async (id: number, action: "cancel" | "close") => {
    setBusyId(id);
    try {
      await fetch(`/api/paper/trades/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...scanHeaders() },
        body: JSON.stringify({ action }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const paperIt = useCallback(async (alertId: number) => {
    setCreateNote(null);
    const res = await fetch("/api/paper/trades", {
      method: "POST",
      headers: { "content-type": "application/json", ...scanHeaders() },
      body: JSON.stringify({ alertId }),
    });
    const d = await res.json();
    setCreateNote(d.ok ? `Paper trade #${d.id} created — entry order active.` : `Blocked by risk engine: ${d.risk?.failures?.join("; ")}`);
    await load();
  }, [load]);

  const s: Summary | null = data?.stockLane?.summary ?? null;
  const optionsPerf: any = null;
  const challenge: any = data?.challenge ?? null;
  const engine = data?.engine ?? null;
  const account: PaperAccount | null = data?.stockLane?.account ?? null;
  const trades: any[] = data?.stockLane?.trades ?? [];
  const decisions: any[] = data?.decisions ?? [];
  const events: any[] = data?.events ?? [];
  const daily = data?.daily ?? null;
  const buckets = data?.stockLane?.buckets ?? {};
  const open = trades.filter((t) => ["WATCHING", "READY", "ENTERED"].includes(t.status));
  const closed = trades.filter((t) => !["WATCHING", "READY", "ENTERED"].includes(t.status));
  const filledClosed = closed.filter((t) => t.entryPrice != null && t.exitPrice != null);
  const blockedAttempts = closed.filter((t) => t.status === "CANCELLED" && t.entryPrice == null);
  const risk = engine?.risk ?? {};
  const positionDollars = Number(engine?.experimentalPositionDollars ?? 0);
  const profitGoalDollars = Number(engine?.targetProfitDollars ?? 0);
  const experimentOn = Boolean(engine?.experimentalOversize && positionDollars > 0);

  return (
    <div className="page axiom-utility">
      <main className="main-col axiom-live">
        <div className="paper-account-tabs" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          {([
            ["all", "ALL ACCOUNTS"],
            ["delivered", "DELIVERED ALERTS"],
            ["research", "RESEARCH"],
            ["stock", "STOCKS"],
            ["history", "HISTORY"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`ui-btn ui-btn-sm${(id === "research" ? ["0dte", "bearish", "shadow"].includes(tab) : tab === id) ? " ui-btn-primary" : ""}`}
              onClick={() => switchTab(id === "research" ? researchTab : id)}
            >
              {label}
            </button>
          ))}
        </div>
        {["0dte", "bearish", "shadow"].includes(tab) ? (
          <div className="paper-research-tabs" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {([
              ["0dte", "Aggressive 0DTE"],
              ["bearish", "Bearish Research"],
              ["shadow", "Shadow Testing"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`ui-btn ui-btn-sm${tab === id ? " ui-btn-primary" : ""}`}
                onClick={() => switchTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {tab === "all" ? (
          <div style={{ display: "grid", gap: 12 }}>
            <AccountSummaryCard
              name="Delivered Alerts"
              purpose="Paper mirror of subscriber alerts that have verified Discord delivery proof."
              starting={deliveredChain?.account?.startingBalanceUsd}
              equity={deliveredChain?.account?.currentEquityUsd}
              todayPnl={null}
              verifiedPnl={deliveredChain?.verifiedPnlBreakdown?.verifiedTotalPnlUsd}
              open={(deliveredChain?.rows ?? []).filter((r: any) => r.paperStatus === "ENTERED" && r.verifiedPnlEligible).length}
              closed={(deliveredChain?.rows ?? []).filter((r: any) => r.paperStatus === "EXITED" && r.verifiedPnlEligible).length}
              quality={(deliveredChain?.verifiedPnlBreakdown?.invalidOrStaleMarkRowsExcluded ?? 0) > 0 ? "Warnings" : "Verified"}
            />
            <AccountSummaryCard
              name="Aggressive 0DTE Research"
              purpose="Simulated same-day options research. Separate $100,000 account."
              starting={zeroDte?.config?.startingBalanceUsd}
              equity={zeroDte?.snapshot?.account?.equityUsd}
              todayPnl={zeroDte?.snapshot?.account?.dailyPnlUsd}
              verifiedPnl={zeroDte?.snapshot?.account?.realizedPnlUsd}
              open={zeroDte?.snapshot?.openPositions?.length ?? 0}
              closed={zeroDte?.snapshot?.performance?.gradedSample ?? 0}
              quality="Research only"
            />
            <AccountSummaryCard
              name="Bearish Research Paper"
              purpose="Simulated qualified PUT setups not necessarily sent to subscribers."
              starting={bearishResearch?.snapshot?.account?.startingBalanceUsd}
              equity={bearishResearch?.snapshot?.account?.currentEquityUsd}
              todayPnl={null}
              verifiedPnl={bearishResearch?.snapshot?.realizedPnlUsd}
              open={bearishResearch?.snapshot?.open?.length ?? 0}
              closed={(bearishResearch?.snapshot?.recent ?? []).filter((r: any) => r.status === "EXITED").length}
              quality="Research only"
            />
            <AccountSummaryCard
              name="Stock Paper"
              purpose="Separate stock-only simulation."
              starting={account?.startingBalance}
              equity={account?.equity}
              todayPnl={daily?.pnlDollars}
              verifiedPnl={account?.realizedPnl}
              open={open.length}
              closed={filledClosed.length}
              quality="Stock lane"
            />
            <AccountSummaryCard
              name="Shadow Testing"
              purpose="Counterfactual signals only. No paper position or subscriber alert."
              starting={null}
              equity={null}
              todayPnl={null}
              verifiedPnl={null}
              open={0}
              closed={data?.legacyLane?.trades?.length ?? 0}
              quality="Audit only"
            />
          </div>
        ) : null}

        {tab === "0dte" ? (
          <section className="panel main">
            <h2 className="section-title">Aggressive 0DTE Research</h2>
            <p className="muted text-sm">Simulated same-day options research. Separate $100,000 account.</p>
            <p style={{ margin: "10px 0 14px" }}>
              <a href="/paper/0dte" className="ui-btn ui-btn-primary" style={{ textDecoration: "none" }}>
                Open full 0DTE Research terminal →
              </a>
            </p>
            {!zeroDte ? <p className="muted">Loading research account…</p> : (
              <>
                <div className="axiom-strip paper-strip" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))", gap: 8 }}>
                  <StatTile label="Equity" value={dollars(zeroDte.snapshot?.account?.equityUsd)} />
                  <StatTile label="Starting balance" value={dollars(zeroDte.config?.startingBalanceUsd)} />
                  <StatTile label="Daily P&L" value={dollars(zeroDte.snapshot?.account?.dailyPnlUsd)} />
                  <StatTile label="Unrealized" value={dollars(zeroDte.snapshot?.account?.unrealizedPnlUsd)} />
                  <StatTile label="Realized" value={dollars(zeroDte.snapshot?.account?.realizedPnlUsd)} />
                  <StatTile label="Open risk" value={dollars(zeroDte.snapshot?.account?.openRiskUsd)} />
                  <StatTile label="Buying power" value={dollars(zeroDte.snapshot?.account?.buyingPowerUsd)} />
                  <StatTile label="Trades today" value={String(zeroDte.snapshot?.today?.trades ?? 0)} />
                  <StatTile label="SPY / QQQ" value={`${zeroDte.snapshot?.today?.spy ?? 0} / ${zeroDte.snapshot?.today?.qqq ?? 0}`} />
                  <StatTile label="Win rate" value={zeroDte.snapshot?.performance?.winRate == null ? "—" : `${Math.round(zeroDte.snapshot.performance.winRate * 100)}%`} />
                  <StatTile label="Profit factor" value={num(zeroDte.snapshot?.performance?.profitFactor, "", 2)} />
                  <StatTile label="Best family" value={String(zeroDte.snapshot?.performance?.bestFamily ?? "—")} />
                  <StatTile label="Worst family" value={String(zeroDte.snapshot?.performance?.worstFamily ?? "—")} />
                </div>
                <p className="muted text-sm" style={{ marginTop: 8 }}>
                  Research account {zeroDte.config?.enabled ? "active" : "paused"} · {zeroDte.snapshot?.performance?.gradedSample ?? 0} graded outcomes
                </p>
                <div className="paper-table-wrap">
                  <table className="mini-table paper-research-table">
                    <thead>
                      <tr>
                        <th>Symbol</th><th>Contract</th><th>Status</th><th>Entry</th><th>Current / Exit</th><th>P&amp;L</th><th>Return</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(zeroDte.snapshot?.recentFills ?? []).map((r: any) => {
                        const returnPct = r.returnPct;
                        const currentOrExit = r.exit != null
                          ? Number(r.exit)
                          : r.entry != null && returnPct != null
                            ? Number(r.entry) * (1 + Number(returnPct) / 100)
                            : null;
                        return (
                          <tr key={r.id}>
                            <td><a href={`/paper/0dte/${r.id}`}>{r.symbol ?? "—"}</a></td>
                            <td className="paper-contract" title={r.optionSymbol}>{readableContract(r.optionSymbol)}</td>
                            <td>{paperStatusLabel(r.status)}</td>
                            <td>{r.entry != null ? `$${Number(r.entry).toFixed(2)}` : "Unavailable"}</td>
                            <td>{currentOrExit != null ? `$${currentOrExit.toFixed(2)}` : "Unavailable"}</td>
                            <td>{dollars(r.pnl)}</td>
                            <td>{num(returnPct, "%")}</td>
                          </tr>
                        );
                      })}
                      {(zeroDte.snapshot?.recentFills ?? []).length === 0 ? (
                        <tr><td colSpan={7} className="muted">No 0DTE research positions or closed trades in this account.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        ) : null}

        {tab === "delivered" ? (
          <section className="panel main">
            <h2 className="section-title">Delivered Options Paper</h2>
            <p className="muted text-sm">
              Paper mirrors for subscriber alerts with verified Discord delivery. P&amp;L uses one contract and conservative option marks.
            </p>
            <div className="paper-window-controls">
              <label htmlFor="delivered-window">Date window</label>
              <select
                id="delivered-window"
                value={deliveredWindow}
                onChange={(event) => setDeliveredWindow(event.target.value as DeliveredWindow)}
              >
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="all">All available history</option>
              </select>
              <span>{deliveredChain?.dataSourceLabel ?? "Production database"}</span>
            </div>
            <div className="axiom-strip paper-strip" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))", gap: 8, marginBottom: 12 }}>
              <StatTile label="Link rate 24h" value={deliveredChain?.paperLinkRate == null ? "—" : `${Math.round(Number(deliveredChain.paperLinkRate) * 100)}%`} />
              <StatTile label="Starting balance" value={dollars(deliveredChain?.account?.startingBalanceUsd)} />
              <StatTile label="Current equity" value={dollars(deliveredChain?.account?.currentEquityUsd)} />
              <StatTile label="Realized verified P&L" value={dollars(deliveredChain?.verifiedPnlBreakdown?.realizedClosedPnlUsd)} />
              <StatTile label="Open verified P&L" value={dollars(deliveredChain?.verifiedPnlBreakdown?.openMarkToMarketPnlUsd)} />
              <StatTile label="Total verified P&L" value={dollars(deliveredChain?.verifiedPnlBreakdown?.verifiedTotalPnlUsd)} />
              <StatTile label="Excluded rows" value={String(
                (deliveredChain?.verifiedPnlBreakdown?.auditOnlyRowsExcluded ?? 0)
                + (deliveredChain?.verifiedPnlBreakdown?.invalidOrStaleMarkRowsExcluded ?? 0)
              )} />
            </div>
            <div className="paper-table-wrap">
              <table className="mini-table paper-research-table">
                <thead>
                  <tr>
                    <th>Symbol</th><th>Contract</th><th>Status</th><th>Entry</th><th>Current / Exit</th><th>P&amp;L</th><th>Return</th>
                  </tr>
                </thead>
                <tbody>
                  {(deliveredChain?.rows ?? []).slice(0, 100).map((r: any) => (
                    <tr key={r.alertId ?? r.id}>
                      <td><a href={`/alerts/${encodeURIComponent(r.alertId)}`}>{r.symbol ?? "—"}</a></td>
                      <td className="paper-contract" title={r.optionSymbol}>{readableContract(r.optionSymbol)}</td>
                      <td>{paperStatusLabel(r.paperStatus, !r.subscriberDelivered)}</td>
                      <td>{r.frozenEntry != null ? `$${Number(r.frozenEntry).toFixed(2)}` : "Unavailable"}</td>
                      <td>{r.markPrice != null ? `$${Number(r.markPrice).toFixed(2)}` : "Unavailable"}</td>
                      <td>{r.verifiedPnlEligible ? (r.pnlUsd != null ? dollars(Number(r.pnlUsd)) : "Unavailable") : "Excluded"}</td>
                      <td>{r.verifiedPnlEligible ? num(r.latestMarkReturnPct ?? r.returnPct, "%") : "Audit only"}</td>
                    </tr>
                  ))}
                  {(deliveredChain?.rows ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={7} className="paper-empty-cell">
                        <strong>No verified delivered-paper positions are available for this selected window.</strong>
                        <span>Window: {deliveredChain?.selectedWindow?.label ?? (deliveredWindow === "all" ? "All available history" : `Last ${deliveredWindow} days`)}</span>
                        <span>Excluded rows: {
                          (deliveredChain?.verifiedPnlBreakdown?.auditOnlyRowsExcluded ?? 0)
                          + (deliveredChain?.verifiedPnlBreakdown?.invalidOrStaleMarkRowsExcluded ?? 0)
                        }</span>
                        <span>Source: {deliveredChain?.dataSourceLabel ?? "Production database"}</span>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {(deliveredChain?.rows ?? []).length > 0 ? (
              <p className="paper-table-meta">
                Window: {deliveredChain?.selectedWindow?.label ?? (deliveredWindow === "all" ? "All available history" : `Last ${deliveredWindow} days`)}
                {" · "}Excluded rows: {
                  (deliveredChain?.verifiedPnlBreakdown?.auditOnlyRowsExcluded ?? 0)
                  + (deliveredChain?.verifiedPnlBreakdown?.invalidOrStaleMarkRowsExcluded ?? 0)
                }
                {" · "}Source: {deliveredChain?.dataSourceLabel ?? "Production database"}
              </p>
            ) : null}
          </section>
        ) : null}

        {tab === "bearish" ? (
          <section className="panel main">
            <h2 className="section-title">Bearish Research Paper</h2>
            <p className="muted text-sm">
              Simulated qualified PUT setups not necessarily sent to subscribers. This account never contributes to delivered performance.
            </p>
            <div className="axiom-strip paper-strip" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))", gap: 8, marginBottom: 12 }}>
              <StatTile label="Starting balance" value={dollars(bearishResearch?.snapshot?.account?.startingBalanceUsd)} />
              <StatTile label="Current equity" value={dollars(bearishResearch?.snapshot?.account?.currentEquityUsd)} />
              <StatTile label="Realized P&L" value={dollars(bearishResearch?.snapshot?.realizedPnlUsd)} />
              <StatTile label="Unrealized P&L" value={dollars(bearishResearch?.snapshot?.unrealizedPnlUsd)} />
              <StatTile label="Open trades" value={String(bearishResearch?.snapshot?.open?.length ?? 0)} />
              <StatTile label="Account status" value={bearishResearch?.config?.enabled ? "Active" : "Paused"} />
            </div>
            <div className="paper-table-wrap">
              <table className="mini-table paper-research-table">
                <thead><tr><th>Symbol</th><th>Contract</th><th>Status</th><th>Entry</th><th>Current / Exit</th><th>P&amp;L</th><th>Return</th></tr></thead>
                <tbody>
                  {(bearishResearch?.snapshot?.recent ?? []).map((row: any) => {
                    const returnPct = row.last_mark_return_pct ?? row.return_pct;
                    const currentOrExit = row.exit_fill != null
                      ? Number(row.exit_fill)
                      : row.entry_fill != null && returnPct != null
                        ? Number(row.entry_fill) * (1 + Number(returnPct) / 100)
                        : null;
                    return (
                      <tr key={row.id}>
                        <td>{parseOccContract(row.option_symbol)?.symbol ?? "—"}</td>
                        <td className="paper-contract" title={row.option_symbol}>{readableContract(row.option_symbol)}</td>
                        <td>{paperStatusLabel(row.status)}</td>
                        <td>{row.entry_fill == null ? "Unavailable" : `$${Number(row.entry_fill).toFixed(2)}`}</td>
                        <td>{currentOrExit == null ? "Unavailable" : `$${currentOrExit.toFixed(2)}`}</td>
                        <td>{dollars(row.pnl)}</td>
                        <td>{num(returnPct, "%")}</td>
                      </tr>
                    );
                  })}
                  {(bearishResearch?.snapshot?.recent ?? []).length === 0 ? (
                    <tr><td colSpan={7} className="muted">No qualified bearish research-paper positions or closed trades yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {tab === "shadow" ? (
          <section className="panel main">
            <h2 className="section-title">Shadow / Historical</h2>
            <p className="muted text-sm">
              Counterfactual signals only. No paper position or subscriber alert.{" "}
              <a href="/shadow-soak">Open Shadow Testing details</a>.
            </p>
            <div className="axiom-strip paper-strip" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(140px,1fr))", gap: 8, marginTop: 12 }}>
              <StatTile label="Legacy Paper start" value={dollars(data?.legacyLane?.account?.startingBalance)} />
              <StatTile label="Legacy Paper equity" value={dollars(data?.legacyLane?.account?.equity)} />
              <StatTile label="Legacy Paper P&L" value={dollars(data?.legacyLane?.account?.realizedPnl)} />
              <StatTile label="Legacy audit rows" value={String(data?.legacyLane?.trades?.length ?? 0)} />
            </div>
          </section>
        ) : null}

        {tab === "history" ? (
          <section className="panel main">
            <h2 className="section-title">Paper History</h2>
            <p className="muted text-sm">
              Delivered, research, and audit lanes remain separate. Open a delivered row for proof and lifecycle details.
            </p>
            <div className="paper-table-wrap"><table className="mini-table paper-research-table">
              <thead>
                <tr><th>Symbol</th><th>Contract</th><th>Status</th><th>Entry</th><th>Current / Exit</th><th>P&amp;L</th><th>Return</th></tr>
              </thead>
              <tbody>
                {(deliveredChain?.rows ?? []).map((row: any) => (
                  <tr key={`history-${row.alertId}`}>
                    <td><a href={`/alerts/${encodeURIComponent(row.alertId)}`}>{row.symbol ?? "—"}</a></td>
                    <td className="paper-contract" title={row.optionSymbol}>{readableContract(row.optionSymbol)}</td>
                    <td>{paperStatusLabel(row.paperStatus, !row.subscriberDelivered)}</td>
                    <td>{row.frozenEntry == null ? "—" : `$${Number(row.frozenEntry).toFixed(2)}`}</td>
                    <td>{row.markPrice == null ? "—" : `$${Number(row.markPrice).toFixed(2)}`}</td>
                    <td>{row.verifiedPnlEligible ? dollars(row.pnlUsd) : "Excluded"}</td>
                    <td>{row.verifiedPnlEligible ? num(row.latestMarkReturnPct ?? row.returnPct, "%") : "Audit only"}</td>
                  </tr>
                ))}
                {(deliveredChain?.rows ?? []).length === 0 ? (
                  <tr><td colSpan={7} className="muted">No paper history available</td></tr>
                ) : null}
              </tbody>
            </table></div>
          </section>
        ) : null}

        {tab === "stock" ? (
        <>
        <CardTip metric="paperTrading" className="utility-hero">
          <section className="panel main utility-intro">
            <h2 className="section-title"><InfoTip metric="paperTrading">Stock Paper</InfoTip></h2>
            <p className="muted text-sm">
              Fully autonomous stock/legacy paper trading — deterministic rules only. Separate from Delivered Options and Aggressive 0DTE Research.
            </p>
            <div className="utility-badges">
              {account ? <span className="pill badge">Paper account {dollars(account.startingBalance)}</span> : null}
              <span className={`pill badge${engine?.running ? " badge-live" : ""}`}>
                {engine?.running ? "Engine live" : "Engine offline"}
              </span>
              <span className={`pill badge${engine?.autoEntryEnabled ? " badge-live" : ""}`}>
                {engine?.autoEntryEnabled ? "Auto-entry ON" : "Auto-entry off"}
              </span>
              <span className="pill badge">Session {engine?.session ?? "—"}</span>
              {engine?.stockPaperScalpsEnabled ? (
                <span className="pill badge badge-live">Stock paper: {(engine?.stockSessions ?? []).join(", ")}</span>
              ) : null}
              {engine?.autoEntryEnabled && !engine?.allowZeroDte ? (
                <span className="pill badge badge-warn">Needs PAPER_ALLOW_ZERO_DTE=1</span>
              ) : null}
              {risk.killSwitch ? <span className="pill badge badge-warn">Kill switch ON</span> : null}
              {experimentOn ? <span className="pill badge badge-warn">Experimental ${positionDollars.toFixed(0)} position ON</span> : null}
            </div>
            {experimentOn ? (
              <div className="alert-error" style={{ marginTop: 12 }}>
                Paper-only experiment mode is sizing entries to trade about at least {dollars(positionDollars)} at a time
                {profitGoalDollars > 0 ? ` with a rough ${dollars(profitGoalDollars)} profit goal.` : "."}
                This can create larger stock share counts or option contract counts and does not guarantee profit.
              </div>
            ) : null}
            {error ? <div className="alert-error">{error} — is the app running with a token set?</div> : null}
            {s ? (
              <p className="muted text-xs" style={{ marginTop: 10 }}>
                Stats count <b>{filledClosed.length}</b> filled-and-closed paper trade{filledClosed.length === 1 ? "" : "s"} only.
                Blocked/refused attempts ({blockedAttempts.length}) are shown in the decision log but do not count toward win rate.
              </p>
            ) : null}
          </section>
        </CardTip>

        <Panel title="Risk rules the agent cannot override" meta="Beginner guardrails · enforced before every entry" tip="paperTrading">
          <div className="paper-buckets">
            <div className="paper-bucket">
              <h4>Risk profile &amp; sizing</h4>
              <p className="muted text-xs">
                Profile <b>{engine?.sizingProfile ?? "standard"}</b> (PAPER_RISK_PROFILE). Sizes from equity × risk% ÷ loss-at-stop, then clamps to every hard cap.
                {engine?.sizing ? (
                  <> Risk/trade {num(engine.sizing.riskPerTradePct, "%")} · max position {num(engine.sizing.maxPositionPct, "%")} · max exposure {num(engine.sizing.maxTotalExposurePct, "%")} · max {engine.sizing.maxContractsPerTrade} contracts/trade · daily-loss stop {num(engine.sizing.maxDailyLossPct, "%")}.</>
                ) : null}
              </p>
            </div>
            <div className="paper-bucket">
              <h4>Position limits</h4>
              <p className="muted text-xs">
                Max risk {dollars(risk.maxRiskPerTrade)} per trade · max {risk.maxOpenTrades ?? "—"} open trades · max {dollars(risk.maxExposurePerTicker)} per ticker.
                {experimentOn ? ` Experimental paper sizing can widen dollar caps per entry to hold about ${dollars(positionDollars)} per trade.` : ""}
              </p>
            </div>
            <div className="paper-bucket">
              <h4>Loss circuit breakers</h4>
              <p className="muted text-xs">
                Daily loss {dollars(risk.maxDailyLoss)} · weekly loss {dollars(risk.maxWeeklyLoss)} · cooldown after a loss {risk.cooldownAfterLossMinutes ?? 30}m.
              </p>
            </div>
            <div className="paper-bucket">
              <h4>Execution discipline</h4>
              <p className="muted text-xs">
                0DTE {risk.allowZeroDte ? "allowed by env" : "blocked by default"} · averaging down {risk.allowAveragingDown ? "allowed by env" : "blocked"} · kill switch {risk.killSwitch ? "ON" : "off"}.
                Stock momentum paper entries run in {(engine?.stockSessions ?? ["premarket", "regular", "afterhours"]).join(", ")}; options entries only manage/fill when regular-hours option quotes exist.
              </p>
            </div>
          </div>
        </Panel>

        {daily ? (
          <Panel title="Today" meta="Paper-trade readiness" live tip="paperTrading">
            <p className="text-sm">{daily.text}</p>
            <div className="paper-buckets">
              <div className="paper-bucket">
                <h4>Setup flow</h4>
                <p className="muted text-xs">
                  Qualified {daily.qualifyingActionableCallouts ?? 0} · candidates {daily.paperCandidatesCreated ?? 0} · READY {daily.readyOrders ?? 0}
                </p>
              </div>
              <div className="paper-bucket">
                <h4>Execution</h4>
                <p className="muted text-xs">
                  Revalidations {daily.revalidationAttempts ?? 0} · fills {daily.fills ?? 0} · rejected {daily.rejected ?? 0} · expired windows {daily.expiredEntryWindows ?? 0}
                </p>
              </div>
            </div>
          </Panel>
        ) : null}

        {s ? (
          <div className="axiom-strip paper-strip">
            {account ? (
              <>
                <StatTile label="Paper equity" value={dollars(account.equity)} hint="starting balance + realized P/L" metric="paperTrading" />
                <StatTile label="Starting cash" value={dollars(account.startingBalance)} hint="simulated account size" metric="paperTrading" />
              </>
            ) : null}
            <StatTile label="Filled win rate" value={num(s.winRatePct, "%")} hint={`${s.wins}W / ${s.losses}L of ${s.gradedCount} filled trades`} metric="winRate" />
            <StatTile label="Profit factor" value={num(s.profitFactor, "", 2)} hint="gross win ÷ gross loss" metric="profitFactor" />
            <StatTile label="Expectancy" value={dollars(s.expectancyDollars)} hint="per graded trade" metric="expectancy" />
            <StatTile label="Total P/L" value={dollars(s.totalPnlDollars)} hint="realized" metric="paperTrading" />
            <StatTile label="Max drawdown" value={dollars(s.maxDrawdownDollars)} hint="worst stretch" metric="maxDrawdown" />
            <StatTile label="Avg gain / loss" value={`${num(s.avgGainPct, "%")} / ${num(s.avgLossPct, "%")}`} hint="winners vs losers" metric="paperTrading" />
            <StatTile label="Largest win / loss" value={`${dollars(s.largestWinDollars)} / ${dollars(s.largestLossDollars)}`} hint="outliers matter" metric="paperTrading" />
            <StatTile label="Avg hold" value={num(s.avgHoldMinutes, "m", 0)} hint="entry → exit" metric="paperTrading" />
          </div>
        ) : null}

        {s ? (
          <Panel title="Analytics dashboard" meta="Realized fills only; no fabricated history" tip="paperTrading">
            <div className="paper-buckets">
              {BUCKET_LABELS.map(([key, title]) => {
                const rows = sortedBuckets(buckets[key] as BucketRow[] | undefined);
                const total = bucketTotal(rows);
                const best = [...rows].sort((a, b) => b.totalDollars - a.totalDollars)[0] ?? null;
                const worst = [...rows].sort((a, b) => a.totalDollars - b.totalDollars)[0] ?? null;
                return (
                  <div key={key} className="paper-bucket">
                    <h4>{title}</h4>
                    {rows.length ? (
                      <>
                        <p className="muted text-xs">
                          {total} graded trade{total === 1 ? "" : "s"} in this cut. Strongest bucket:{" "}
                          <b>{best?.bucket ?? "n/a"}</b> ({dollars(best?.totalDollars)}). Weakest bucket:{" "}
                          <b>{worst?.bucket ?? "n/a"}</b> ({dollars(worst?.totalDollars)}).
                        </p>
                        <table className="mini-table">
                          <thead><tr><th>Bucket</th><th>N</th><th>Win%</th><th>Avg%</th><th>$</th></tr></thead>
                          <tbody>
                            {rows.slice(0, 4).map((b) => (
                              <tr key={b.bucket}>
                                <td>{b.bucket}</td>
                                <td className="num">{b.count}</td>
                                <td className="num">{num(b.winRatePct, "%")}</td>
                                <td className="num">{num(b.avgPnlPct, "%")}</td>
                                <td className={`num ${b.totalDollars >= 0 ? "up" : "dn"}`}>{dollars(b.totalDollars)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    ) : (
                      <p className="muted text-xs">
                        No filled-and-closed paper trades yet. This cut appears only after real paper outcomes are graded.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="muted text-xs" style={{ marginTop: 10 }}>
              These cuts are for pattern-finding only. They do not place trades, do not change strategy settings, and do not include blocked/refused attempts in win rate.
            </p>
          </Panel>
        ) : null}
        {challenge && challenge.enabled ? (
          <Panel
            title="Aggressive challenge — $10k → $100k"
            meta="Independent options-only portfolio · same signals + exact contracts as Primary · separate P&L, never mixed"
            tip="paperTrading"
          >
            <div className="utility-badges" style={{ marginBottom: 10 }}>
              <span className={`pill badge${challenge.status === "TARGET_REACHED" ? " badge-live" : challenge.status === "FAILED" ? " badge-warn" : ""}`}>
                {challenge.status === "TARGET_REACHED" ? "🎯 TARGET REACHED" : challenge.status === "FAILED" ? "💀 FAILED (no reset)" : "ACTIVE"}
              </span>
              <span className="pill badge">Profile {challenge.riskProfile}</span>
              <span className="pill badge">{challenge.acceptsEntries ? "Taking entries" : "Not taking entries"}</span>
            </div>
            <div className="axiom-strip paper-strip">
              <StatTile label="Challenge equity" value={dollars(challenge.equity)} hint={`start ${dollars(challenge.startingBalanceUsd)} → target ${dollars(challenge.targetUsd)}`} metric="paperTrading" />
              <StatTile label="Progress to $100k" value={num(challenge.progressPct, "%")} hint="0% = start · 100% = target" metric="paperTrading" />
              <StatTile label="Realized P/L" value={dollars(challenge.realizedPnl)} hint="challenge only" metric="paperTrading" />
              <StatTile label="Unrealized P/L" value={dollars(challenge.unrealizedPnl)} hint="open challenge marks" metric="paperTrading" />
              <StatTile label="Open positions" value={String(challenge.openPositions ?? 0)} hint="challenge only" metric="paperTrading" />
              <StatTile label="Failure floor" value={dollars(challenge.failureFloorUsd)} hint="equity here = FAILED, no reset" metric="paperTrading" />
              {challenge.optionsPerformance ? (
                <>
                  <StatTile label="Win rate" value={num(challenge.optionsPerformance.winRatePct, "%")} hint="graded challenge trades" metric="winRate" />
                  <StatTile label="Profit factor" value={num(challenge.optionsPerformance.profitFactor, "", 2)} hint="challenge" metric="profitFactor" />
                  <StatTile label="Return on premium" value={num(challenge.optionsPerformance.returnOnPremiumPct, "%")} hint="challenge" metric="paperTrading" />
                  <StatTile label="Max drawdown" value={dollars(challenge.optionsPerformance.maxDrawdownDollars)} hint="challenge equity curve" metric="maxDrawdown" />
                </>
              ) : null}
            </div>

            {/* Execution proof — last signal → sizing → order, binding cap, live buying power. */}
            <div className="utility-badges" style={{ marginTop: 12, marginBottom: 6 }}>
              <span className="pill badge">Max position {num(challenge.caps?.maxPositionPct, "%")}</span>
              <span className="pill badge">Max loss-at-stop {num(challenge.caps?.maxLossAtStopPct, "%")}</span>
              <span className="pill badge">Max exposure {num(challenge.caps?.maxTotalExposurePct, "%")}</span>
              <span className="pill badge">Max daily loss {num(challenge.caps?.maxDailyLossPct, "%")}</span>
              <span className="pill badge">Max open {String(challenge.caps?.maxOpenPositions ?? "—")}</span>
              <span className="pill badge">0DTE {challenge.caps?.allowZeroDte ? "on" : "off"}</span>
            </div>
            <div className="axiom-strip paper-strip">
              <StatTile label="Available buying power" value={dollars(challenge.availableBuyingPowerDollars)} hint="challenge only" metric="paperTrading" />
              <StatTile label="Open exposure" value={dollars(challenge.openExposureDollars)} hint={`${num(challenge.exposurePctOfEquity, "%")} of equity`} metric="paperTrading" />
              <StatTile label="Daily realized loss" value={dollars(challenge.dailyRealizedLossDollars)} hint="resets each session" metric="paperTrading" />
            </div>

            <div style={{ marginTop: 10 }}>
              <strong className="text-xs">Last challenge execution</strong>
              {challenge.lastExecution ? (
                <div className="muted text-xs" style={{ marginTop: 4 }}>
                  {new Date(challenge.lastExecution.atMs).toLocaleTimeString()} · {challenge.lastExecution.optionSymbol ? readableContract(challenge.lastExecution.optionSymbol) : challenge.lastExecution.ticker ?? "—"} ·{" "}
                  <span className={`pill badge${challenge.lastExecution.result === "filled" ? " badge-live" : challenge.lastExecution.result === "rejected" ? " badge-warn" : ""}`}>{challenge.lastExecution.result}</span>
                  {challenge.lastExecution.bindingConstraint ? <> · binding: {challenge.lastExecution.bindingConstraint}</> : null}
                  {challenge.lastExecution.reason ? <> · {challenge.lastExecution.reason}</> : null}
                </div>
              ) : <div className="muted text-xs" style={{ marginTop: 4 }}>No challenge signal received yet this session.</div>}
            </div>

            {Array.isArray(challenge.sizingExamples) && challenge.sizingExamples.length ? (
              <div style={{ marginTop: 10, overflowX: "auto" }}>
                <strong className="text-xs">Deterministic aggressive sizing @ {dollars(challenge.equity)} equity (30% stop)</strong>
                <table className="text-xs" style={{ marginTop: 4, width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr style={{ textAlign: "left" }}><th>Premium</th><th>Contracts</th><th>Cost basis</th><th>% equity</th><th>Loss @ stop</th><th>Binding</th></tr></thead>
                  <tbody>
                    {challenge.sizingExamples.map((e: any) => (
                      <tr key={e.premium}>
                        <td>{dollars(e.premium)}</td>
                        <td>{e.rejected ? "—" : e.contracts}</td>
                        <td>{e.rejected ? "rejected" : dollars(e.costBasisDollars)}</td>
                        <td>{e.rejected ? "—" : `${e.costBasisPctOfEquity}%`}</td>
                        <td>{e.rejected ? "—" : `${dollars(e.modeledLossAtStopDollars)} (${e.modeledLossAtStopPctOfEquity}%)`}</td>
                        <td>{e.bindingConstraint}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <p className="muted text-xs" style={{ marginTop: 10 }}>
              The challenge takes larger risk but is bounded by hard contract, exposure, buying-power and daily-loss caps, and fails honestly if it loses the account. No automatic reset or replenishment · no broker or real-money path.
            </p>
          </Panel>
        ) : null}

        {optionsPerf ? (
          <Panel title="Options performance" meta="Option-contract P&L only — never blended with stock P&L (Primary account)" tip="paperTrading">
            <div className="axiom-strip paper-strip">
              <StatTile label="Open options" value={String(optionsPerf.openCount ?? 0)} hint="live option positions" metric="paperTrading" />
              <StatTile label="Closed options" value={String(optionsPerf.closedCount ?? 0)} hint="terminal option trades" metric="paperTrading" />
              <StatTile label="Contracts traded" value={String(optionsPerf.contractsTraded ?? 0)} hint={`avg ${num(optionsPerf.avgContractsPerTrade, "", 1)}/trade`} metric="paperTrading" />
              <StatTile label="Realized (opt)" value={dollars(optionsPerf.realizedDollars)} hint="option-contract dollars" metric="paperTrading" />
              <StatTile label="Unrealized (opt)" value={dollars(optionsPerf.unrealizedDollars)} hint="open option marks" metric="paperTrading" />
              <StatTile label="Return on premium" value={num(optionsPerf.returnOnPremiumPct, "%")} hint="realized ÷ premium paid" metric="paperTrading" />
              <StatTile label="Win rate" value={num(optionsPerf.winRatePct, "%")} hint="graded option trades" metric="winRate" />
              <StatTile label="Profit factor" value={num(optionsPerf.profitFactor, "", 2)} hint="gross win ÷ loss" metric="profitFactor" />
              <StatTile label="Expectancy" value={dollars(optionsPerf.expectancyDollars)} hint="per option trade" metric="expectancy" />
              <StatTile label="Max drawdown" value={dollars(optionsPerf.maxDrawdownDollars)} hint="option equity curve" metric="maxDrawdown" />
              <StatTile label="Avg winner / loser" value={`${dollars(optionsPerf.avgWinnerDollars)} / ${dollars(optionsPerf.avgLoserDollars)}`} hint="option $" metric="paperTrading" />
              <StatTile label="Avg premium / pos value" value={`${optionsPerf.avgPremiumPaid != null ? fmtPrice(optionsPerf.avgPremiumPaid) : "—"} / ${dollars(optionsPerf.avgPositionValueDollars)}`} hint="per contract / per position" metric="paperTrading" />
              <StatTile label="Slippage / fees" value={`${dollars(optionsPerf.totalSlippageDollars)} / ${dollars(optionsPerf.totalFeesDollars)}`} hint="simulated costs (separate from P&L)" metric="paperTrading" />
            </div>
            <div className="paper-buckets" style={{ marginTop: 12 }}>
              <div className="paper-bucket">
                <h4>CALL vs PUT research</h4>
                <table className="mini-table">
                  <thead><tr><th>Side</th><th>N</th><th>Win%</th><th>$</th><th>RoP%</th></tr></thead>
                  <tbody>
                    {(["call", "put"]).map((side) => {
                      const g = optionsPerf.byType?.[side];
                      return g ? (
                        <tr key={side}>
                          <td>{side.toUpperCase()}</td><td className="num">{g.count}</td>
                          <td className="num">{num(g.winRatePct, "%")}</td>
                          <td className={`num ${g.realizedDollars >= 0 ? "up" : "dn"}`}>{dollars(g.realizedDollars)}</td>
                          <td className="num">{num(g.returnOnPremiumPct, "%")}</td>
                        </tr>
                      ) : null;
                    })}
                  </tbody>
                </table>
              </div>
              <div className="paper-bucket">
                <h4>0DTE vs weekly vs longer</h4>
                <table className="mini-table">
                  <thead><tr><th>Duration</th><th>N</th><th>Win%</th><th>$</th><th>RoP%</th></tr></thead>
                  <tbody>
                    {(["0DTE", "weekly", "longer"]).map((k) => {
                      const g = optionsPerf.byDuration?.[k];
                      return g && g.count ? (
                        <tr key={k}>
                          <td>{k}</td><td className="num">{g.count}</td>
                          <td className="num">{num(g.winRatePct, "%")}</td>
                          <td className={`num ${g.realizedDollars >= 0 ? "up" : "dn"}`}>{dollars(g.realizedDollars)}</td>
                          <td className="num">{num(g.returnOnPremiumPct, "%")}</td>
                        </tr>
                      ) : null;
                    })}
                  </tbody>
                </table>
              </div>
              <div className="paper-bucket">
                <h4>Opportunity vs realized</h4>
                <p className="muted text-xs">
                  Signal HIT &amp; captured: <b>{optionsPerf.opportunity?.hitAndCaptured ?? 0}</b>.
                  Signal correct but exit failed: <b>{optionsPerf.opportunity?.signalHitExitMissed ?? 0}</b>.
                  Signal itself failed: <b>{optionsPerf.opportunity?.signalFailed ?? 0}</b>.
                  <br />(HIT = the contract offered ≥{optionsPerf.opportunity?.thresholdPct ?? 30}% before expiration.)
                </p>
              </div>
              {optionsPerf.byStrategy?.length ? (
                <div className="paper-bucket">
                  <h4>By strategy</h4>
                  <table className="mini-table">
                    <thead><tr><th>Strategy</th><th>N</th><th>Win%</th><th>$</th></tr></thead>
                    <tbody>
                      {optionsPerf.byStrategy.slice(0, 5).map((g: any) => (
                        <tr key={g.strategy}><td>{g.strategy}</td><td className="num">{g.count}</td><td className="num">{num(g.winRatePct, "%")}</td><td className={`num ${g.realizedDollars >= 0 ? "up" : "dn"}`}>{dollars(g.realizedDollars)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {optionsPerf.byTimeOfDay?.length ? (
                <div className="paper-bucket">
                  <h4>By time of day (entry, ET)</h4>
                  <table className="mini-table">
                    <thead><tr><th>Phase</th><th>N</th><th>Win%</th><th>$</th></tr></thead>
                    <tbody>
                      {optionsPerf.byTimeOfDay.slice(0, 6).map((g: any) => (
                        <tr key={g.phase}><td>{g.phase}</td><td className="num">{g.count}</td><td className="num">{num(g.winRatePct, "%")}</td><td className={`num ${g.realizedDollars >= 0 ? "up" : "dn"}`}>{dollars(g.realizedDollars)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
            <p className="muted text-xs" style={{ marginTop: 10 }}>{optionsPerf.note}</p>
          </Panel>
        ) : null}

        <Panel title="Open trades" meta={`${open.length} active · ~7s marks on hot symbols`} live tip="paperTrading">
          {open.length ? (
            <ul className="ledger axiom-ledger">
              {open.map((t) => (
                <li key={t.id}>
                  <span className="t num">#{t.id}</span>
                  <span className="what">
                    {t.optionSymbol ? (
                      <><b>{t.ticker}</b> ${t.strike} {t.optionType?.toUpperCase()} {t.expiration} × {t.contracts}</>
                    ) : (
                      <><b>{t.ticker}</b> {t.optionType === "put" ? "SHORT" : "LONG"} shares × {t.contracts}</>
                    )}
                    <small>
                      {t.orderState ?? t.status}{t.positionState ? ` · ${t.positionState}` : ""} · entry {t.entryPrice != null ? fmtPrice(t.entryPrice) : `limit ${fmtPrice(t.entryLimit)}`}
                      {t.lastMark != null ? ` · mark ${fmtPrice(t.lastMark)}` : ""}
                      {t.unrealizedPnlDollars != null ? ` · unrealized ${t.unrealizedPnlDollars >= 0 ? "+" : ""}$${Math.abs(t.unrealizedPnlDollars).toFixed(0)} (${t.unrealizedPnlPct > 0 ? "+" : ""}${t.unrealizedPnlPct.toFixed(0)}%)` : ""}
                      {t.status === "ENTERED" && t.mfePct != null ? ` · peak ${t.mfePct.toFixed(0)}% / heat ${t.maePct?.toFixed(0)}%` : ""}
                    </small>
                    {t.entrySnapshot?.delta != null ? (
                      <small className="muted">
                        At entry: Δ {Number(t.entrySnapshot.delta).toFixed(2)}
                        {t.entrySnapshot.iv != null ? ` · IV ${(Number(t.entrySnapshot.iv) * 100).toFixed(0)}%` : ""}
                        {t.entrySnapshot.spreadPct != null ? ` · spread ${Number(t.entrySnapshot.spreadPct).toFixed(1)}%` : ""}
                      </small>
                    ) : null}
                    {t.sizing ? (
                      <small className="muted">
                        Sizing ({t.sizing.profile ?? "manual"}): {t.contracts} contract(s)
                        {t.sizing.bindingConstraint ? ` · binding: ${t.sizing.bindingConstraint}` : ""}
                        {t.sizing.riskBudgetDollars != null ? ` · risk budget $${Number(t.sizing.riskBudgetDollars).toFixed(0)}` : ""}
                        {t.sizing.byRisk != null ? ` · caps[risk ${t.sizing.byRisk}, pos ${t.sizing.byPosition}, exp ${t.sizing.byExposure}, max ${t.sizing.byMaxContracts}]` : ""}
                      </small>
                    ) : null}
                    {t.explanation?.revalidated ? <small className="muted">Revalidation: {t.explanation.revalidated}</small> : null}
                    {t.entryCosts?.slippage != null || t.entryCosts?.fees != null ? (
                      <small className="muted">
                        Fill costs: slippage ${Number(t.entryCosts.slippage ?? 0).toFixed(2)}/unit · fees ${Number(t.entryCosts.fees ?? 0).toFixed(2)}
                        {t.entryCosts.sessionAtEntry ? ` · ${t.entryCosts.sessionAtEntry}` : ""}
                      </small>
                    ) : null}
                    {t.thesis ? <small className="muted">Thesis: {t.thesis.slice(0, 110)}</small> : null}
                  </span>
                  <span className="res">
                    <button className="pill btn btn-xs" disabled={busyId === t.id}
                      onClick={() => act(t.id, t.status === "ENTERED" ? "close" : "cancel")}>
                      {t.status === "ENTERED" ? "Close" : "Cancel"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : <div className="sigwhy muted text-sm">No open paper trades — auto-entry will populate when TRADE callouts fire.</div>}
        </Panel>

        <Panel title="Agent decision log" meta={`${decisions.length} latest · entries, refusals, fills, exits`} tip="paperTrading">
          {decisions.length ? (
            <ul className="ledger axiom-ledger">
              {decisions.slice(0, 16).map((d) => (
                <li key={d.id}>
                  <span className={`t num ${d.allowed ? "up" : "dn"}`}>{d.allowed ? "PASS" : "BLOCK"}</span>
                  <span className="what">
                    <b>{d.ticker ?? "SYSTEM"}</b> {String(d.decision).replaceAll("_", " ")}
                    <small>{d.reason}</small>
                    {d.snapshot?.optionSymbol ? (
                      <small className="muted">
                        Quote: {d.snapshot.optionSymbol} · bid {d.snapshot.bid ?? "—"} · ask {d.snapshot.ask ?? "—"} · spread {d.snapshot.spreadPct ?? "—"}%
                      </small>
                    ) : d.snapshot?.assetClass === "stock" ? (
                      <small className="muted">
                        Stock paper scalp: {d.snapshot.side} × {d.snapshot.shares} @ {d.snapshot.price}
                      </small>
                    ) : d.snapshot?.contracts ? (
                      <small className="muted">
                        Paper option size: {d.snapshot.contracts} contract(s) @ {d.snapshot.entryLimit}
                      </small>
                    ) : d.snapshot?.bindingConstraint ? (
                      <small className="muted">
                        Sizing calc: binding {d.snapshot.bindingConstraint} · risk budget ${Number(d.snapshot.riskBudgetDollars ?? 0).toFixed(0)} · caps[risk {d.snapshot.byRisk}, pos {d.snapshot.byPosition}, exp {d.snapshot.byExposure}]
                      </small>
                    ) : null}
                  </span>
                  <span className="res muted text-xs">{timeAgo(d.createdAtMs)}</span>
                </li>
              ))}
            </ul>
          ) : <div className="sigwhy muted text-sm">No agent decisions logged yet. The first auto-entry, risk refusal, fill, or exit will appear here.</div>}
        </Panel>

        <Panel title="Lifecycle events" meta={`${events.length} latest · immutable, idempotent audit trail`} tip="paperTrading">
          {events.length ? (
            <ul className="ledger axiom-ledger">
              {events.slice(0, 20).map((e) => (
                <li key={e.id}>
                  <span className="t num">#{e.tradeId ?? "—"}</span>
                  <span className="what">
                    <b>{e.ticker ?? "SYSTEM"}</b> {String(e.eventType).replaceAll("_", " ")}
                    {e.fromState || e.toState ? <small className="muted">{e.fromState ?? "—"} → {e.toState ?? "—"}</small> : null}
                    {e.payload?.reason ? <small>{String(e.payload.reason).slice(0, 120)}</small> : null}
                  </span>
                  <span className="res muted text-xs">{timeAgo(e.createdAtMs)}</span>
                </li>
              ))}
            </ul>
          ) : <div className="sigwhy muted text-sm">No lifecycle events yet — candidate/validation/fill/exit events appear here with idempotency keys.</div>}
        </Panel>

        <Panel title="Manual override" meta="Optional — engine runs without this" tip="paperTrading">
          <p className="muted text-xs">Force a paper trade from a recent callout. The risk engine can still refuse.</p>
          {createNote ? <div className="text-sm">{createNote}</div> : null}
          {recentAlerts.length ? (
            <ul className="ledger axiom-ledger">
              {recentAlerts.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <span className="t num">{a.ticker}</span>
                  <span className="what">${a.strike} {String(a.option_side ?? "").toUpperCase()} {a.expiration}
                    <small>setup {Math.round(a.signal_score ?? 0)} · {a.capture_action}</small>
                  </span>
                  <span className="res"><button className="pill btn btn-xs" onClick={() => paperIt(a.id)}>Paper trade it</button></span>
                </li>
              ))}
            </ul>
          ) : <div className="muted text-sm">No recent options callouts with contracts yet today.</div>}
        </Panel>

        <Panel title="Closed trades" meta={`${filledClosed.length} filled · ${blockedAttempts.length} blocked/refused · lessons auto-generated`} tip="paperTrading">
          {closed.length ? (
            <ul className="ledger axiom-ledger">
              {closed.slice(0, 40).map((t) => {
                const stockDir = !t.optionSymbol && t.optionType === "put" ? -1 : 1;
                const multiplier = t.optionSymbol ? 100 : 1;
                const pnl = t.entryPrice != null && t.exitPrice != null
                  ? (t.exitPrice - t.entryPrice) * stockDir * multiplier * (t.contracts ?? 1) : null;
                const pct = t.entryPrice ? ((t.exitPrice - t.entryPrice) * stockDir / t.entryPrice) * 100 : null;
                return (
                  <li key={t.id}>
                    <span className={`t num ${STATE_CLASS[t.status] ?? ""}`}>{t.status}</span>
                    <span className="what">
                      {t.optionSymbol ? (
                        <><b>{t.ticker}</b> ${t.strike} {t.optionType?.toUpperCase()} {t.expiration}</>
                      ) : (
                        <><b>{t.ticker}</b> {t.optionType === "put" ? "SHORT" : "LONG"} shares</>
                      )}
                      <small>{t.closeReason ?? t.exitReason ?? "no exit reason recorded"}</small>
                      {t.explanation?.revalidated && t.entryPrice == null ? <small className="muted">{t.explanation.revalidated}</small> : null}
                      {t.exitCosts?.slippage != null || t.exitCosts?.fees != null ? (
                        <small className="muted">Exit costs: slippage ${Number(t.exitCosts.slippage ?? 0).toFixed(2)}/unit · fees ${Number(t.exitCosts.fees ?? 0).toFixed(2)}</small>
                      ) : null}
                      {t.lessons ? <small className="muted">Lesson: {t.lessons}</small> : null}
                    </span>
                    <span className={`res num ${pnl != null && pnl > 0 ? "pos" : pnl != null ? "neg" : "open"}`}>
                      {pnl != null ? `${pnl > 0 ? "+" : ""}$${Math.abs(pnl).toFixed(0)} (${pct! > 0 ? "+" : ""}${pct!.toFixed(0)}%)` : "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : <div className="sigwhy muted text-sm">Nothing closed yet — exits fire automatically on stops, targets, and thesis breaks.</div>}
        </Panel>

        {data?.buckets ? (
          <Panel title="Bucket detail" meta="Full realized bucket cuts" tip="paperTrading">
            <div className="paper-buckets">
              {BUCKET_LABELS.map(([key, title]) => {
                const rows = data.buckets[key] as BucketRow[] | undefined;
                return (
                <div key={title} className="paper-bucket">
                  <h4>{title}</h4>
                  {rows?.length ? (
                    <table className="mini-table">
                      <thead><tr><th>Bucket</th><th>N</th><th>Win%</th><th>Avg%</th><th>$</th></tr></thead>
                      <tbody>
                        {rows.map((b) => (
                          <tr key={b.bucket}>
                            <td>{b.bucket}</td><td className="num">{b.count}</td>
                            <td className="num">{num(b.winRatePct, "%")}</td>
                            <td className="num">{num(b.avgPnlPct, "%")}</td>
                            <td className={`num ${b.totalDollars >= 0 ? "up" : "dn"}`}>{dollars(b.totalDollars)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <div className="muted text-xs">no data yet</div>}
                </div>
              );})}
            </div>
          </Panel>
        ) : null}
        </>
        ) : null}
      </main>
    </div>
  );
}

export default function PaperPage() {
  return (
    <Suspense fallback={null}>
      <PaperPageInner />
    </Suspense>
  );
}
