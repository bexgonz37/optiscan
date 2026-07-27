"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Card, StatusBadge, EmptyState, LoadingState, type BadgeTone } from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";
import { usePresentationMode } from "@/hooks/usePresentationMode";
import { TradeExplanationCard } from "@/components/TradeExplanationCard";
import type { TradeExplanation } from "@/lib/trade-explanation";
import type { PresentationMode } from "@/lib/dashboard-prefs";

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
  explanation?: TradeExplanation;
};

type Buckets = Record<string, Opp[]>;

type Overview = {
  market_session?: string;
  provider?: { connected?: boolean; configured?: boolean };
  scanner?: { running?: boolean };
  stale_symbol_count?: number;
  discord?: { summary?: { status: string; count: number }[]; webhooks?: Record<string, boolean> };
  supervisor?: { enabled?: boolean };
  paper?: { enabled?: boolean };
  model?: { state?: string };
  independent_options?: {
    ownership?: string;
    independentOwns?: boolean;
    killSwitch?: boolean;
    monitorAlive?: boolean;
    monitorRunning?: boolean;
    session?: string;
    polygonConfigured?: boolean;
    webhookConfigured?: boolean;
    lastCycleAgeMs?: number | null;
    unhealthyReason?: string | null;
    discoveryEnabled?: boolean;
  };
  stock_scanner?: { running?: boolean };
  alert_reliability?: { ownership?: { owner?: string }; kill_switch?: boolean };
};

type AttentionItem = { text: string; tone: "ok" | "warn" | "bad" | "info" };
type AttentionSection = { title: string; items: AttentionItem[] };

/**
 * Plain-English owner summary split by pipeline. When independent owns subscriber Discord,
 * stock/supervisor disabled states are informational — not actionable problems.
 */
function buildAttentionSections(
  ov: Overview | null,
  openTrades: number,
  actionable: number,
  discordFail: number,
): AttentionSection[] {
  if (!ov) return [{ title: "System", items: [{ text: "Checking system status…", tone: "warn" }] }];

  const ind = ov.independent_options;
  const independentOwns = Boolean(ind?.independentOwns ?? ov.alert_reliability?.ownership?.owner === "independent");
  const sections: AttentionSection[] = [];

  // ── Independent Options Pipeline ──
  const optionsItems: AttentionItem[] = [];
  if (ind?.killSwitch ?? ov.alert_reliability?.kill_switch) {
    optionsItems.push({ text: "Options callouts kill switch is ON — no subscriber alerts", tone: "bad" });
  } else {
    optionsItems.push({ text: "Options callouts kill switch is off", tone: "ok" });
  }
  if (ind?.monitorAlive) {
    optionsItems.push({ text: "Independent options monitor is alive (recent tier cycle)", tone: "ok" });
  } else if (ind?.monitorRunning) {
    optionsItems.push({ text: "Independent options monitor is running but no recent tier cycle", tone: "warn" });
  } else if (ind?.discoveryEnabled === false) {
    optionsItems.push({ text: "Independent options discovery is disabled in config", tone: "info" });
  } else {
    optionsItems.push({ text: "Independent options monitor is not running in this process", tone: "warn" });
  }
  const optSession = ind?.session ?? ov.market_session ?? "unknown";
  optionsItems.push({
    text: `Options session (session guard): ${optSession}`,
    tone: optSession === "closed" ? "info" : "ok",
  });
  const polyOk = ind?.polygonConfigured ?? ov.provider?.configured;
  if (!polyOk) optionsItems.push({ text: "Polygon/Massive API key is not configured", tone: "bad" });
  else optionsItems.push({ text: "Polygon/Massive market-data key is configured", tone: "ok" });
  if (ind?.webhookConfigured === false) {
    optionsItems.push({ text: "Discord options webhook is not configured", tone: "bad" });
  } else if (discordFail > 0) {
    optionsItems.push({ text: "Some Discord deliveries need review", tone: "warn" });
  } else {
    optionsItems.push({ text: "Discord options webhook is configured", tone: "ok" });
  }
  if (ind?.unhealthyReason) {
    optionsItems.push({ text: `Options delivery note: ${ind.unhealthyReason}`, tone: "warn" });
  }
  sections.push({ title: "Independent Options Pipeline", items: optionsItems });

  // ── Stock / Supervisor Pipeline ──
  const stockItems: AttentionItem[] = [];
  const stockRunning = ov.stock_scanner?.running ?? ov.scanner?.running;
  if (stockRunning) stockItems.push({ text: "Stock momentum scanner is running", tone: "ok" });
  else stockItems.push({ text: "Stock momentum scanner is stopped (does not affect independent options)", tone: "info" });
  if (ov.supervisor?.enabled) {
    stockItems.push({ text: "Supervisor runtime is enabled", tone: "ok" });
  } else if (independentOwns) {
    stockItems.push({ text: "Supervisor is intentionally disabled — independent path owns subscriber alerts", tone: "info" });
  } else {
    stockItems.push({ text: "Supervisor is disabled — no automatic stock callouts", tone: "warn" });
  }
  if ((ov.stale_symbol_count ?? 0) > 0) {
    stockItems.push({ text: `${ov.stale_symbol_count} stock symbols have stale data`, tone: "warn" });
  }
  if (actionable > 0) {
    stockItems.push({ text: `${actionable} actionable stock setup${actionable === 1 ? "" : "s"} on supervisor path`, tone: "ok" });
  }
  sections.push({ title: "Stock / Supervisor Pipeline", items: stockItems });

  // ── Paper and Grading ──
  const paperItems: AttentionItem[] = [];
  if (ov.paper?.enabled !== false) {
    paperItems.push({ text: `Paper grading engine enabled (${openTrades} open trade${openTrades === 1 ? "" : "s"})`, tone: "ok" });
  } else {
    paperItems.push({ text: "Paper trading is stopped", tone: "info" });
  }
  sections.push({ title: "Paper and Grading", items: paperItems });

  // ── AI and Content Jobs ──
  const aiItems: AttentionItem[] = [];
  const model = ov.model?.state ?? "";
  if (/VALIDATED/.test(model)) aiItems.push({ text: "Prediction model: validated", tone: "ok" });
  else if (/EXPERIMENTAL/.test(model)) aiItems.push({ text: "Prediction model: experimental (research only)", tone: "info" });
  else aiItems.push({ text: "Prediction model is still collecting outcomes", tone: "info" });
  sections.push({ title: "AI and Content Jobs", items: aiItems });

  return sections;
}

/** Flat list for backward-compatible overall status check. */
function buildAttention(ov: Overview | null, openTrades: number, actionable: number, discordFail: number): AttentionItem[] {
  return buildAttentionSections(ov, openTrades, actionable, discordFail).flatMap((s) => s.items);
}

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

function OpportunityCard({ o, mode }: { o: Opp; mode: PresentationMode }) {
  // Both Simple and Advanced render the SAME explanation object; the mode only
  // selects which fields show. When no explanation is attached, fall back to the
  // compact status/score card.
  if (o.explanation) {
    return (
      <div className="cc-opp">
        <TradeExplanationCard explanation={o.explanation} mode={mode} />
        <div className="cc-opp-foot">
          Score {Math.round(o.current_score)} <span className="cc-opp-dim">/ peak {Math.round(o.highest_score)}</span>
          {o.entry_zone ? <> · entry {o.entry_zone}</> : null} · updated {ago(o.last_updated_at)}
        </div>
      </div>
    );
  }
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

function Section({ title, hint, items, emptyReason, mode }: { title: string; hint: string; items: Opp[]; emptyReason: ReactNode; mode: PresentationMode }) {
  return (
    <section className="ui-section">
      <div className="ui-section-head">
        <span className="ui-section-title">{title}</span>
        <span className="ui-section-count">{items.length}</span>
      </div>
      <div className="ui-section-hint">{hint}</div>
      {items.length ? (
        <div className="cc-opp-grid">
          {items.map((o) => <OpportunityCard key={o.opportunity_id} o={o} mode={mode} />)}
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
  const [mode, setMode] = usePresentationMode();
  const [showStartHere, setShowStartHere] = useState(false);

  useEffect(() => {
    try { setShowStartHere(localStorage.getItem("optiscan:seen-guide") !== "1"); } catch { /* ignore */ }
  }, []);
  const dismissStartHere = useCallback(() => {
    try { localStorage.setItem("optiscan:seen-guide", "1"); } catch { /* ignore */ }
    setShowStartHere(false);
  }, []);

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
  const actionableCount = (buckets?.ACTIONABLE ?? []).length;
  const attentionSections = buildAttentionSections(overview, openTrades.length, actionableCount, discordFail);
  const attention = attentionSections.flatMap((s) => s.items);
  const allOk = attention.every((a) => a.tone === "ok" || a.tone === "info");

  const ind = overview?.independent_options;
  const statusCells: { k: string; v: string; dot: "ok" | "warn" | "bad" | "info" }[] = [
    { k: "Options", v: ind?.monitorAlive ? "alive" : ind?.monitorRunning ? "running" : "idle", dot: ind?.monitorAlive ? "ok" : "warn" },
    { k: "Session", v: ind?.session ?? overview?.market_session ?? "—", dot: (ind?.session ?? overview?.market_session) === "closed" ? "info" : "ok" },
    { k: "Polygon", v: (ind?.polygonConfigured ?? overview?.provider?.configured) ? "configured" : "no key", dot: (ind?.polygonConfigured ?? overview?.provider?.configured) ? "ok" : "bad" },
    { k: "Stock scan", v: (overview?.stock_scanner?.running ?? overview?.scanner?.running) ? "running" : "idle", dot: "info" },
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
      {showStartHere ? (
        <div className="cc-starthere">
          <span className="cc-starthere-badge">Start here</span>
          <span>New to OptiScan? The Guide explains every page in plain English.</span>
          <Link href="/guide" className="ui-btn ui-btn-sm ui-btn-primary" onClick={dismissStartHere}>Open the Guide →</Link>
          <button type="button" className="cc-starthere-x" onClick={dismissStartHere} aria-label="Dismiss">✕</button>
        </div>
      ) : null}

      {/* What needs my attention? */}
      <section className="cc-attention">
        <div className="cc-attention-head">
          <span className="cc-attention-title">What needs my attention?</span>
          <span className={`cc-attention-overall ${allOk ? "ok" : "warn"}`}>
            {allOk ? "Everything is running normally" : "Some items need a look"}
          </span>
        </div>
        <ul className="cc-attention-list">
          {attentionSections.map((section) => (
            <li key={section.title} className="cc-attention-section">
              <div className="cc-attention-section-title">{section.title}</div>
              <ul className="cc-attention-sublist">
                {section.items.map((a, i) => (
                  <li key={`${section.title}-${i}`} className={`cc-attention-item ${a.tone}`}>
                    <span className={`ui-statusdot ${a.tone === "info" ? "ok" : a.tone}`} />{a.text}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <div className="cc-attention-links">
          <Link href="/callouts" className="ui-btn ui-btn-sm">Review callouts →</Link>
          <Link href="/paper" className="ui-btn ui-btn-sm">Paper trades →</Link>
          <Link href="/data" className="ui-btn ui-btn-sm">System health →</Link>
        </div>
      </section>

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
        <div className="cc-toolbar-right">
          <div className="tx-modetoggle" role="group" aria-label="Presentation detail level">
            <button
              type="button"
              className={`ui-btn ui-btn-sm${mode === "simple" ? " tx-modeon" : ""}`}
              aria-pressed={mode === "simple"}
              onClick={() => setMode("simple")}
            >
              Simple
            </button>
            <button
              type="button"
              className={`ui-btn ui-btn-sm${mode === "advanced" ? " tx-modeon" : ""}`}
              aria-pressed={mode === "advanced"}
              onClick={() => setMode("advanced")}
            >
              Advanced
            </button>
          </div>
          <Link href="/scanner" className="ui-btn ui-btn-sm">Open live scanner →</Link>
        </div>
      </div>

      <Section
        title="Actionable Now"
        hint="Confirmed entries on fresh data with a valid contract, non-extended price, and acceptable risk. Bearish setups stay research-only."
        items={actionable}
        emptyReason="No setup is confirmed for entry right now. This fills when a monitored symbol breaks its level with momentum on fresh required data."
        mode={mode}
      />

      <Section
        title="Near Trigger"
        hint="Close to confirmation — watch for the trigger or a pullback into the entry zone."
        items={near}
        emptyReason="Nothing is near a trigger. Setups appear here as they build conviction toward confirmation."
        mode={mode}
      />

      <Section
        title="Developing Setups"
        hint="Still forming — building conviction but not yet near a trigger."
        items={developing}
        emptyReason="No setups are developing yet. The scanner adds them here as momentum and volume build during the session."
        mode={mode}
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
        mode={mode}
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
