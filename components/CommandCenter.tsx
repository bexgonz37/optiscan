"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Card, StatusBadge, EmptyState, LoadingState, type BadgeTone } from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";

/**
 * Command Center (Phase 6). A calm, sectioned main page — NOT one constantly
 * re-ranked card grid. Reads persisted opportunity lifecycle (/api/opportunities),
 * system health (/api/system/overview), paper trades, and recent alerts. Card
 * order is stable (the store returns a deterministic, hysteresis-smoothed order),
 * and there is no flashing/animation. Every empty section explains why.
 */

type Opp = {
  opportunity_id: string;
  ticker: string;
  setup_type: string;
  current_status: string;
  current_score: number;
  highest_score: number;
  trigger_level: number | null;
  entry_zone: string | null;
  last_updated_at: string;
};

type Buckets = Record<string, Opp[]>;

type Overview = {
  market_session?: string;
  provider?: { connected?: boolean; configured?: boolean };
  scanner?: { running?: boolean };
  stale_symbol_count?: number;
  discord?: { summary?: { status: string; count: number }[] };
};

const STATUS_TONE: Record<string, BadgeTone> = {
  ENTRY_CONFIRMED: "live",
  NEAR_TRIGGER: "info",
  WAIT_FOR_PULLBACK: "info",
  BUILDING: "warn",
  WATCHING: "muted",
  EXTENDED: "warn",
  INVALIDATED: "bad",
  DATA_STALE: "bad",
  NO_VALID_CONTRACT: "muted",
  RESEARCH_ONLY: "muted",
};

function statusText(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function OpportunityCard({ o }: { o: Opp }) {
  return (
    <div className="cc-opp">
      <div className="cc-opp-top">
        <span className="cc-opp-ticker">{o.ticker}</span>
        <StatusBadge tone={STATUS_TONE[o.current_status] ?? "muted"}>{statusText(o.current_status)}</StatusBadge>
      </div>
      <div className="cc-opp-meta">{o.setup_type.replace(/_/g, " ")}</div>
      <div className="cc-opp-row">
        <span>Score</span>
        <span className="cc-opp-num">{Math.round(o.current_score)}<span className="cc-opp-dim"> / peak {Math.round(o.highest_score)}</span></span>
      </div>
      {o.entry_zone ? (
        <div className="cc-opp-row"><span>Entry zone</span><span className="cc-opp-num">{o.entry_zone}</span></div>
      ) : null}
      <div className="cc-opp-foot">updated {ago(o.last_updated_at)}</div>
    </div>
  );
}

function Section({ title, hint, items, emptyReason }: { title: string; hint: string; items: Opp[]; emptyReason: ReactNode }) {
  return (
    <section className="ui-section">
      <div className="ui-section-head">
        <span className="ui-section-title">{title}</span>
        <span className="ui-section-count">{items.length}</span>
      </div>
      <div className="ui-section-hint">{hint}</div>
      {items.length ? (
        <div className="cc-opp-grid">
          {items.map((o) => <OpportunityCard key={o.opportunity_id} o={o} />)}
        </div>
      ) : (
        <EmptyState title="Nothing here right now" reason={emptyReason} />
      )}
    </section>
  );
}

export function CommandCenter() {
  const [buckets, setBuckets] = useState<Buckets | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [trades, setTrades] = useState<any[] | null>(null);
  const [alerts, setAlerts] = useState<any[] | null>(null);

  const load = useCallback(async () => {
    const h = { cache: "no-store" as const, headers: scanHeaders() };
    const [opp, ov, paper, al] = await Promise.all([
      fetch("/api/opportunities", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/system/overview", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/paper/trades", h).then((r) => r.json()).catch(() => null),
      fetch("/api/alerts?limit=15", h).then((r) => r.json()).catch(() => null),
    ]);
    if (opp?.buckets) setBuckets(opp.buckets);
    else if (opp) setBuckets({});
    if (ov) setOverview(ov);
    if (paper) setTrades(Array.isArray(paper.trades) ? paper.trades : []);
    if (al) setAlerts(Array.isArray(al.alerts) ? al.alerts : []);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const openTrades = (trades ?? []).filter((t) => t.status === "ENTERED" || t.status === "READY");
  const discordFail = (overview?.discord?.summary ?? []).filter((s) => ["FAILED", "RETRYING"].includes(s.status)).reduce((n, s) => n + Number(s.count ?? 0), 0);

  const statusCells: { k: string; v: string; dot: "ok" | "warn" | "bad" }[] = [
    { k: "Session", v: overview?.market_session ?? "—", dot: overview?.market_session === "closed" ? "warn" : "ok" },
    { k: "Provider", v: !overview?.provider?.configured ? "no key" : overview?.provider?.connected ? "connected" : "down", dot: !overview?.provider?.configured ? "bad" : overview?.provider?.connected ? "ok" : "warn" },
    { k: "Freshness", v: (overview?.stale_symbol_count ?? 0) === 0 ? "OK" : `${overview?.stale_symbol_count} stale`, dot: (overview?.stale_symbol_count ?? 0) === 0 ? "ok" : "warn" },
    { k: "Scanner", v: overview?.scanner?.running ? "running" : "idle", dot: overview?.scanner?.running ? "ok" : "warn" },
    { k: "Discord", v: discordFail ? `${discordFail} review` : "OK", dot: discordFail ? "warn" : "ok" },
    { k: "Paper", v: `${openTrades.length} open`, dot: "ok" },
  ];

  const b = buckets ?? {};
  const actionable = b.ACTIONABLE ?? [];
  const near = b.NEAR_TRIGGER ?? [];
  const developing = b.DEVELOPING ?? [];
  const extendedInvalid = b.EXTENDED_OR_INVALID ?? [];

  const tradeCols: Column<any>[] = [
    { key: "ticker", header: "Ticker", render: (t) => t.ticker ?? "—" },
    { key: "contract", header: "Contract", render: (t) => t.optionSymbol ?? t.optionType ?? "—" },
    { key: "status", header: "Status", render: (t) => <StatusBadge tone={t.status === "ENTERED" ? "live" : "info"}>{statusText(String(t.status ?? ""))}</StatusBadge> },
    { key: "contracts", header: "Qty", align: "right", render: (t) => String(t.contracts ?? 1) },
    { key: "entry", header: "Entry", align: "right", render: (t) => (t.entryPrice != null ? `$${Number(t.entryPrice).toFixed(2)}` : t.entryLimit != null ? `$${Number(t.entryLimit).toFixed(2)}` : "—") },
  ];

  const alertCols: Column<any>[] = [
    { key: "time", header: "Time", render: (a) => (a.alert_time ? new Date(a.alert_time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) : "—") },
    { key: "ticker", header: "Ticker", render: (a) => a.ticker ?? "—" },
    { key: "side", header: "Side", render: (a) => <StatusBadge tone={String(a.option_side).toLowerCase() === "put" ? "bear" : "bull"}>{a.option_side ?? a.direction ?? "—"}</StatusBadge> },
    { key: "source", header: "Source", render: (a) => a.source ?? "—" },
    { key: "score", header: "Signal", align: "right", render: (a) => (a.signal_score != null ? Math.round(a.signal_score) : "—") },
  ];

  if (!buckets && !overview) {
    return <div className="ui-page"><Card title="Loading Command Center"><LoadingState rows={4} /></Card></div>;
  }

  return (
    <div className="ui-page cc-page">
      {/* Status Bar */}
      <div className="ui-statusbar">
        {statusCells.map((c) => (
          <div className="ui-statuscell" key={c.k}>
            <span className="ui-statuscell-k">{c.k}</span>
            <span className="ui-statuscell-v"><span className={`ui-statusdot ${c.dot}`} />{c.v}</span>
          </div>
        ))}
      </div>

      <div className="cc-toolbar">
        <span className="ui-section-hint">Calm view of what matters right now. Opportunities evolve in place — cards do not re-rank on every tick.</span>
        <Link href="/scanner" className="ui-btn ui-btn-sm">Open live scanner →</Link>
      </div>

      <Section
        title="Actionable Now"
        hint="Confirmed entries on fresh data with a valid contract, non-extended price, and acceptable risk. Bearish setups stay research-only."
        items={actionable}
        emptyReason="No setup is confirmed for entry right now. This fills when a monitored symbol breaks its level with momentum on fresh required data."
      />

      <Section
        title="Near Trigger"
        hint="Close to confirmation — watch for the trigger or a pullback into the entry zone."
        items={near}
        emptyReason="Nothing is near a trigger. Setups appear here as they build conviction toward confirmation."
      />

      <Section
        title="Developing Setups"
        hint="Still forming — building conviction but not yet near a trigger."
        items={developing}
        emptyReason="No setups are developing yet. The scanner adds them here as momentum and volume build during the session."
      />

      {/* Open Paper Trades */}
      <section className="ui-section">
        <div className="ui-section-head">
          <span className="ui-section-title">Open Paper Trades</span>
          <span className="ui-section-count">{openTrades.length}</span>
        </div>
        <Card>
          <SimpleTable
            columns={tradeCols}
            rows={openTrades}
            rowKey={(t, i) => String(t.id ?? i)}
            emptyTitle="No open paper trades"
            emptyReason="The paper engine has no open simulated positions. Trades appear here when a confirmed setup passes the risk engine."
          />
        </Card>
      </section>

      <Section
        title="Extended or Invalidated"
        hint="No longer valid entries — price ran past the zone or the invalidation level was broken."
        items={extendedInvalid}
        emptyReason="Nothing has extended or invalidated today. Setups move here once they run too far or break their invalidation level."
      />

      {/* Recent Alerts */}
      <section className="ui-section">
        <div className="ui-section-head">
          <span className="ui-section-title">Recent Alerts</span>
          <span className="ui-section-count">{alerts?.length ?? 0}</span>
        </div>
        <Card>
          <SimpleTable
            columns={alertCols}
            rows={alerts ?? []}
            rowKey={(a, i) => String(a.id ?? i)}
            emptyTitle="No alerts yet today"
            emptyReason="No callouts have fired in this session. This is a stable chronological feed — the newest alerts appear at the top as they happen."
          />
        </Card>
      </section>
    </div>
  );
}
