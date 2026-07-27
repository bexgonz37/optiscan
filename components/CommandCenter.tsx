"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, StatusBadge, EmptyState, LoadingState } from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";
import { overviewAuthFailed, primaryWorkingNowLines, type HealthLine } from "@/lib/dashboard/command-center-health";

/**
 * Command Center — owner ops home focused on Independent Options.
 * Uses authenticated /api/command-center (same token as Pipeline Health).
 * Stock/supervisor is collapsed and informational when independent owns alerts.
 */

type Snapshot = {
  ok?: boolean;
  faults?: string[];
  generatedAtMs?: number;
  generatedAtIso?: string;
  sourceEndpoint?: string;
  commitShort?: string | null;
  independent?: Record<string, any> | null;
  pipeline?: Record<string, any> | null;
  readiness?: Record<string, any> | null;
  paper?: Record<string, any> | null;
  content?: Record<string, any> | null;
  stock?: Record<string, any> | null;
  error?: string;
  status?: number;
};

function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3600_000)}h`;
}

function fmtPct(v: unknown): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return `${Number(v).toFixed(2)}%`;
}

function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return "—";
  try {
    return new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
  } catch { return "—"; }
}

function LineList({ items }: { items: HealthLine[] }) {
  return (
    <ul className="cc-attention-list">
      {items.map((a, i) => (
        <li key={`${a.text}-${i}`} className={`cc-attention-item ${a.tone}`}>
          <span className={`ui-statusdot ${a.tone === "info" ? "ok" : a.tone}`} />
          <span>{a.text}</span>
          {a.source ? <span className="cc-attention-source"> · {a.source}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function Kv({ k, v, tone }: { k: string; v: string; tone?: "ok" | "warn" | "bad" | "muted" }) {
  return (
    <div className={`cc-kv ${tone ?? ""}`}>
      <span className="cc-kv-k">{k}</span>
      <span className="cc-kv-v">{v}</span>
    </div>
  );
}

export function CommandCenter() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stockOpen, setStockOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/command-center", { cache: "no-store", headers: scanHeaders() });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setLoadError(json?.error ?? `HTTP ${res.status}`);
        setSnap(json ?? { ok: false, status: res.status, error: "unauthorized" });
        return;
      }
      setLoadError(null);
      setSnap(json);
    } catch (err: any) {
      setLoadError(String(err?.message ?? err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  if (!snap && !loadError) {
    return <div className="ui-page"><Card title="Loading Command Center"><LoadingState rows={4} /></Card></div>;
  }

  const authFailed = overviewAuthFailed(snap as any) || Boolean(loadError);
  const ind = snap?.independent ?? null;
  const pipe = snap?.pipeline ?? null;
  const paper = snap?.paper ?? null;
  const readiness = snap?.readiness ?? null;
  const content = snap?.content ?? null;
  const stock = snap?.stock ?? null;

  const latestRow = paper?.rows?.[0];
  const latestAlertLabel = latestRow
    ? `${latestRow.symbol} · ${fmtTime(latestRow.sentAtMs)} · ${latestRow.graderHealth ?? "—"}`
    : null;

  const workingNow = primaryWorkingNowLines({
    independent: ind,
    authFailed,
    discordFail: 0,
    graderRunning: paper?.grader?.running ?? null,
    graderLastCycleAgeMs: paper?.grader?.lastCycleAgeMs ?? null,
    contentEnabled: content?.enabled ?? null,
    contentWebhook: content?.webhookConfigured ?? null,
    latestAlertLabel,
  });

  const openRows = (paper?.rows ?? []).filter((r: any) => r.paperStatus === "ENTERED");
  const paperCols: Column<any>[] = [
    { key: "symbol", header: "Symbol", render: (r) => r.symbol ?? "—" },
    { key: "entry", header: "Frozen entry", align: "right", render: (r) => (r.frozenEntry != null ? `$${Number(r.frozenEntry).toFixed(2)}` : "—") },
    { key: "unreal", header: "Unrealized", align: "right", render: (r) => fmtPct(r.latestMarkReturnPct) },
    { key: "mfe", header: "MFE", align: "right", render: (r) => fmtPct(r.mfePct) },
    { key: "mae", header: "MAE", align: "right", render: (r) => fmtPct(r.maePct) },
    { key: "status", header: "Status", render: (r) => <StatusBadge tone={r.paperStatus === "ENTERED" ? "live" : "muted"}>{r.paperStatus ?? "—"}</StatusBadge> },
  ];

  const m = readiness?.metrics ?? {};
  const delivery = pipe?.delivery ?? {};
  const candidates = pipe?.candidates ?? {};
  const mon = pipe?.monitor ?? {};

  return (
    <div className="ui-page cc-page">
      <div className="cc-meta">
        <span>Last refreshed: {snap?.generatedAtIso ? new Date(snap.generatedAtIso).toLocaleTimeString() : "—"}</span>
        <span>Source: {snap?.sourceEndpoint ?? "/api/command-center"}</span>
        <span>Commit: {snap?.commitShort ?? "—"}</span>
        <button type="button" className="ui-btn ui-btn-sm" disabled={refreshing} onClick={() => void load()}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {loadError ? (
        <Card title="Auth / load error" tone="warn">
          <p>{loadError}. Open Settings and set your scan token — Command Center uses the same token as Pipeline Health.</p>
        </Card>
      ) : null}

      {/* What is working right now */}
      <section className="cc-attention">
        <div className="cc-attention-head">
          <span className="cc-attention-title">What is working right now</span>
          <span className={`cc-attention-overall ${workingNow.every((x) => x.tone === "ok" || x.tone === "info") ? "ok" : "warn"}`}>
            Independent options path
          </span>
        </div>
        <LineList items={workingNow} />
        <div className="cc-attention-links">
          <Link href="/pipeline-health" className="ui-btn ui-btn-sm">Pipeline health →</Link>
          <Link href="/paper" className="ui-btn ui-btn-sm">Paper trades →</Link>
        </div>
      </section>

      {/* Independent Options */}
      <section className="ui-section">
        <div className="ui-section-head">
          <span className="ui-section-title">Independent Options</span>
        </div>
        <Card>
          <div className="cc-grid">
            <Kv k="Monitor" v={String(ind?.runMode ?? "—")} tone={ind?.monitorAlive ? "ok" : "warn"} />
            <Kv k="Heartbeat age" v={fmtAge(ind?.heartbeatAgeMs ?? ind?.lastCycleAgeMs)} />
            <Kv k="Tier0 / Tier1 age" v={`${fmtAge(ind?.lastTier0CycleMs != null ? Date.now() - ind.lastTier0CycleMs : null)} / ${fmtAge(ind?.lastTier1CycleMs != null ? Date.now() - ind.lastTier1CycleMs : null)}`} />
            <Kv k="Symbols scanned" v={String(mon?.metrics?.symbolsScanned ?? ind?.metrics?.symbolsScanned ?? "—")} />
            <Kv k="Candidates 24h" v={`${candidates.observed24h ?? "—"} observed · ${candidates.ready24h ?? "—"} READY`} />
            <Kv k="Delivered today" v={String(delivery.sent24h ?? paper?.sent24h ?? "—")} />
            <Kv k="Kill switch" v={ind?.killSwitch ? "ON" : "off"} tone={ind?.killSwitch ? "bad" : "ok"} />
            <Kv k="Ownership" v={String(ind?.ownership ?? "—")} />
            <Kv k="Latest block / reject" v={String(pipe?.rejectionReasons?.[0]?.reason ?? pipe?.summary ?? "—")} />
            <Kv k="Latest delivered" v={latestAlertLabel ?? "—"} />
          </div>
        </Card>
      </section>

      {/* Paper Trading */}
      <section className="ui-section">
        <div className="ui-section-head">
          <span className="ui-section-title">Paper Trading (delivered mirrors)</span>
          <span className="ui-section-count">{openRows.length} open</span>
        </div>
        <Card>
          <p className="ui-section-hint">
            Unrealized = latest mark return. MFE/MAE are path extremes. 60-minute and realized closed returns are separate — see Subscriber Readiness for launch-sample 60m stats.
          </p>
          <div className="cc-grid">
            <Kv k="Open delivered" v={String(paper?.openDelivered ?? openRows.length)} />
            <Kv k="Closed in sample" v={String(paper?.closedInSample ?? 0)} />
            <Kv k="Grader heartbeat" v={fmtAge(paper?.grader?.lastCycleAgeMs)} tone={paper?.grader?.running === false ? "warn" : "ok"} />
            <Kv k="Paper-link 24h" v={paper?.paperLinkRate == null ? "—" : `${Math.round(Number(paper.paperLinkRate) * 100)}%`} />
            <Kv k="Unhealthy rows (sample)" v={String(paper?.unhealthy ?? 0)} tone={Number(paper?.unhealthy) > 0 ? "warn" : "muted"} />
            <Kv k="Readiness 60m median" v={fmtPct(m.medianReturn60m)} />
            <Kv k="Readiness expectancy" v={fmtPct(m.expectancy)} />
            <Kv k="Graded (60m/exit)" v={String(m.gradedSample ?? "—")} />
          </div>
          <SimpleTable
            columns={paperCols}
            rows={openRows}
            rowKey={(r, i) => String(r.alertId ?? i)}
            emptyTitle="No open delivered paper trades"
            emptyReason="Open DELIVERED_ALERT_PAPER mirrors appear here after independent Discord sends."
          />
        </Card>
      </section>

      {/* Content Engine */}
      <section className="ui-section">
        <div className="ui-section-head">
          <span className="ui-section-title">Content Engine</span>
        </div>
        <Card>
          <div className="cc-grid">
            <Kv k="Enabled" v={content?.enabled ? "yes" : "no"} tone="muted" />
            <Kv k="Webhook" v={content?.webhookConfigured ? "configured" : "missing"} tone={content?.enabled && !content?.webhookConfigured ? "warn" : "muted"} />
            <Kv k="Pending events" v={String(content?.pendingEvents ?? 0)} />
            <Kv k="Drafts total" v={String(content?.drafts?.total ?? 0)} />
            <Kv k="Drafts delivered" v={String(content?.drafts?.delivered ?? 0)} />
            <Kv k="Drafts skipped" v={String(content?.drafts?.skipped ?? 0)} />
            <Kv k="Latest draft" v={content?.latest ? `${content.latest.category ?? "—"} · ${content.latest.discord_delivery_status ?? content.latest.status ?? "—"}` : "—"} />
          </div>
          <Link href="/content-drafts" className="ui-btn ui-btn-sm">Content drafts →</Link>
        </Card>
      </section>

      {/* Subscriber Readiness */}
      <section className="ui-section">
        <div className="ui-section-head">
          <span className="ui-section-title">Subscriber Readiness</span>
          <StatusBadge tone={readiness?.ready ? "live" : "warn"}>{readiness?.status ?? "—"}</StatusBadge>
        </div>
        <Card tone="warn">
          <p className="ui-section-hint">
            <strong>Future paid-beta readiness — does not mean live scanner is broken.</strong>
            Stripe, Discord role, legal attestations, and 10-day sample gates live here only.
          </p>
          <div className="cc-grid">
            <Kv k="Launch sample" v={`${m.deliveredSent ?? "—"} / ${m.deliveredLinked ?? "—"} linked`} />
            <Kv k="EARLY/TIMELY" v={m.earlyTimelyRate == null ? "—" : `${Math.round(Number(m.earlyTimelyRate) * 100)}%`} />
            <Kv k="Duplicates (launch)" v={String(m.duplicateDeliveredCount ?? 0)} />
            <Kv k="Supervisor/legacy (launch)" v={String(m.supervisorLegacySends ?? 0)} />
            <Kv k="Median 60m" v={fmtPct(m.medianReturn60m)} />
            <Kv k="Profit factor" v={String(m.profitFactor ?? "—")} />
            <Kv k="Stripe / role" v={`${m.stripeReady ? "yes" : "no"} / ${m.discordRoleReady ? "yes" : "no"}`} tone="muted" />
          </div>
          <Link href="/pipeline-health" className="ui-btn ui-btn-sm">Full readiness card →</Link>
        </Card>
      </section>

      {/* Optional stock scanner — collapsed */}
      <section className="ui-section">
        <button type="button" className="cc-collapse-btn" onClick={() => setStockOpen((v) => !v)} aria-expanded={stockOpen}>
          Optional stock scanner {stockOpen ? "▾" : "▸"}
        </button>
        {stockOpen ? (
          <Card>
            <div className="cc-grid">
              <Kv k="Stock momentum scanner" v={stock?.scannerRunning ? "running" : "stopped"} tone="muted" />
              <Kv
                k="Supervisor"
                v={stock?.supervisorEnabled
                  ? "enabled"
                  : stock?.independentOwns
                    ? "intentionally disabled — independent owns options alerts"
                    : "disabled"}
                tone="muted"
              />
            </div>
            <p className="ui-section-hint">These do not affect independent options Discord delivery.</p>
          </Card>
        ) : null}
      </section>
    </div>
  );
}
