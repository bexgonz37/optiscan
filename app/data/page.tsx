"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PageContainer,
  PageHeader,
  ResponsiveGrid,
  Card,
  StatusBadge,
  KeyValue,
  EmptyState,
  LoadingState,
  ErrorState,
  DetailsDisclosure,
  type BadgeTone,
} from "@/components/ui";
import { DiscordDeliveryPanel } from "@/components/DiscordDeliveryPanel";

/**
 * System Health (Phase 2). A human-readable view of provider connection,
 * market session, scanner loop, per-kind data freshness (with the exact max
 * ages), rate limits, symbol counts, Discord, and database health. Raw JSON is
 * available on demand but never shown by default. Provider health is kept
 * separate from per-symbol staleness.
 */

type Overview = {
  ok?: boolean;
  application_time?: string;
  exchange_time?: string;
  trading_day?: string;
  market_session?: string;
  provider?: { configured?: boolean; connected?: boolean; last_latency_ms?: number | null; last_success_at?: string | null; last_failure_reason?: string | null; rate_limit_status?: string };
  scanner?: { running?: boolean; interval_ms?: number; last_tick_age_ms?: number | null; ticks?: number; triggers?: number; alerts?: number; errors?: number; note?: string | null };
  freshness?: { kind: string; label: string; max_age_seconds: number; status: string; symbol: string | null; age_seconds: number | null; reason: string | null }[];
  blocked?: { symbol: string; actionable: boolean; reasons: string[] }[];
  monitored_symbol_count?: number;
  stale_symbol_count?: number;
  rate_limit?: { status?: string; calls_today?: number | null; daily_cap?: number | null; calls_this_minute?: number | null; minute_cap?: number | null; quota_exceeded?: boolean };
  database?: { ok?: boolean; note?: string };
  discord?: { summary?: { status: string; count: number }[] };
  entitlement_limitations?: string[];
};

const GOOD_FRESHNESS = new Set(["LIVE", "DEGRADED", "DELAYED", "MARKET_CLOSED"]);

function freshTone(status: string): BadgeTone {
  if (status === "LIVE") return "live";
  if (status === "DEGRADED" || status === "DELAYED") return "warn";
  if (status === "MARKET_CLOSED") return "muted";
  return "bad";
}

function ms(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v < 1000) return `${v} ms`;
  return `${(v / 1000).toFixed(1)} s`;
}

export default function SystemHealthPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/system/overview", { cache: "no-store" });
      const body = (await res.json()) as Overview;
      setData(body);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not load system health.");
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const providerOk = Boolean(data?.provider?.connected);
  const providerConfigured = Boolean(data?.provider?.configured);
  const scannerOk = Boolean(data?.scanner?.running);
  const freshOk = (data?.stale_symbol_count ?? 0) === 0;
  const dbOk = Boolean(data?.database?.ok);
  const discordFailures = (data?.discord?.summary ?? [])
    .filter((s) => ["FAILED", "RETRYING"].includes(s.status))
    .reduce((n, s) => n + Number(s.count ?? 0), 0);

  const statusCells: { k: string; v: string; dot: "ok" | "warn" | "bad" }[] = [
    { k: "Market session", v: data?.market_session ?? "—", dot: data?.market_session === "closed" ? "warn" : "ok" },
    { k: "Provider", v: !providerConfigured ? "NO KEY" : providerOk ? "Connected" : "Disconnected", dot: !providerConfigured ? "bad" : providerOk ? "ok" : "warn" },
    { k: "Scanner loop", v: scannerOk ? "Running" : "Idle", dot: scannerOk ? "ok" : "warn" },
    { k: "Data freshness", v: freshOk ? "OK" : `${data?.stale_symbol_count} stale`, dot: freshOk ? "ok" : "warn" },
    { k: "Discord", v: discordFailures ? `${discordFailures} to review` : "OK", dot: discordFailures ? "warn" : "ok" },
    { k: "Database", v: dbOk ? "OK" : "Fault", dot: dbOk ? "ok" : "bad" },
  ];

  if (error && !data) {
    return (
      <PageContainer>
        <PageHeader title="System Health" subtitle="Data freshness, delivery, and reliability" />
        <ErrorState detail={error} onRetry={load} />
      </PageContainer>
    );
  }

  if (!data) {
    return (
      <PageContainer>
        <PageHeader title="System Health" subtitle="Data freshness, delivery, and reliability" />
        <Card title="Loading system health"><LoadingState label="Reading telemetry…" rows={4} /></Card>
      </PageContainer>
    );
  }

  const blocked = (data.blocked ?? []).filter((b) => b.reasons.length);

  return (
    <PageContainer>
      <PageHeader
        title="System Health"
        subtitle={`${data.exchange_time ?? ""} · ${data.trading_day ?? ""}`}
        actions={<button type="button" className="ui-btn ui-btn-sm" onClick={load}>Refresh</button>}
      />

      {/* Status bar */}
      <div className="ui-statusbar">
        {statusCells.map((c) => (
          <div className="ui-statuscell" key={c.k}>
            <span className="ui-statuscell-k">{c.k}</span>
            <span className="ui-statuscell-v"><span className={`ui-statusdot ${c.dot}`} />{c.v}</span>
          </div>
        ))}
      </div>

      <ResponsiveGrid min={320}>
        {/* Provider connection — independent of per-symbol staleness */}
        <Card title="Provider connection" meta="Independent of individual stale symbols" tone={providerOk ? undefined : "warn"}>
          <KeyValue k="Configured" v={providerConfigured ? "Yes" : "No API key"} tone={providerConfigured ? undefined : "bear"} />
          <KeyValue k="Connection" v={<StatusBadge tone={providerOk ? "live" : "warn"}>{providerOk ? "Connected" : "Disconnected"}</StatusBadge>} />
          <KeyValue k="Last latency" v={ms(data.provider?.last_latency_ms)} />
          <KeyValue k="Rate-limit status" v={data.provider?.rate_limit_status ?? "—"} tone={data.rate_limit?.quota_exceeded ? "warn" : undefined} />
          {data.provider?.last_failure_reason ? <KeyValue k="Last failure" v={data.provider.last_failure_reason} tone="bear" /> : null}
          {data.entitlement_limitations?.length ? (
            <div className="ui-section-hint">Entitlement: {data.entitlement_limitations.join("; ")}</div>
          ) : null}
        </Card>

        {/* Scanner loop */}
        <Card title="Scanner loop" tone={scannerOk ? undefined : "warn"}>
          <KeyValue k="Status" v={<StatusBadge tone={scannerOk ? "live" : "warn"}>{scannerOk ? "Running" : "Idle"}</StatusBadge>} />
          <KeyValue k="Interval" v={ms(data.scanner?.interval_ms)} />
          <KeyValue k="Last tick" v={data.scanner?.last_tick_age_ms == null ? "never" : `${ms(data.scanner.last_tick_age_ms)} ago`} />
          <KeyValue k="Ticks / triggers / alerts" v={`${data.scanner?.ticks ?? 0} · ${data.scanner?.triggers ?? 0} · ${data.scanner?.alerts ?? 0}`} />
          <KeyValue k="Errors" v={data.scanner?.errors ?? 0} tone={data.scanner?.errors ? "warn" : undefined} />
          {data.scanner?.note ? <div className="ui-section-hint">{data.scanner.note}</div> : null}
        </Card>

        {/* Rate limit + counts */}
        <Card title="Rate limit & coverage">
          <KeyValue k="Calls today" v={`${data.rate_limit?.calls_today ?? "—"} / ${data.rate_limit?.daily_cap ?? "—"}`} />
          <KeyValue k="Calls this minute" v={`${data.rate_limit?.calls_this_minute ?? "—"} / ${data.rate_limit?.minute_cap ?? "—"}`} tone={data.rate_limit?.quota_exceeded ? "warn" : undefined} />
          <KeyValue k="Monitored symbols" v={data.monitored_symbol_count ?? 0} />
          <KeyValue k="Stale symbols" v={data.stale_symbol_count ?? 0} tone={(data.stale_symbol_count ?? 0) > 0 ? "warn" : undefined} />
          <KeyValue k="Database" v={<StatusBadge tone={dbOk ? "live" : "bad"}>{data.database?.note ?? (dbOk ? "OK" : "fault")}</StatusBadge>} />
        </Card>
      </ResponsiveGrid>

      {/* Data freshness per kind, with the exact allowed max ages */}
      <Card title="Data freshness" meta={`Max ages shown for the ${data.market_session} session`}>
        {data.freshness?.length ? (
          <div className="ui-table-scroll">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>Data type</th><th>Status</th><th style={{ textAlign: "right" }}>Age</th>
                  <th style={{ textAlign: "right" }}>Max age</th><th>Latest symbol</th>
                </tr>
              </thead>
              <tbody>
                {data.freshness.map((f) => (
                  <tr key={f.kind}>
                    <td>{f.label}</td>
                    <td><StatusBadge tone={freshTone(f.status)}>{f.status}</StatusBadge></td>
                    <td style={{ textAlign: "right" }}>{f.age_seconds == null ? "—" : `${f.age_seconds}s`}</td>
                    <td style={{ textAlign: "right" }}>{f.max_age_seconds}s</td>
                    <td>{f.symbol ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No freshness samples yet" reason="The scanner has not recorded any provider responses in this process yet. Rows appear here after the next successful data fetch." />
        )}
      </Card>

      {/* Blocked setups — exact human-readable reasons */}
      <Card title="Why setups are blocked" meta="Actionable alerts require fresh required data" tone={blocked.length ? "warn" : undefined}>
        {blocked.length ? (
          blocked.map((b) => (
            <div key={b.symbol} style={{ paddingBottom: 8, borderBottom: "1px dashed var(--line)", marginBottom: 4 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{b.symbol} — <span style={{ color: "var(--bear)" }}>Actionable: No</span></div>
              {b.reasons.map((r, i) => (
                <pre key={i} style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: "0.74rem", color: "var(--muted)", fontFamily: "inherit" }}>{r}</pre>
              ))}
            </div>
          ))
        ) : (
          <EmptyState
            icon="✓"
            title="Nothing is blocked right now"
            reason="No monitored symbol currently has stale, missing, or unentitled required data. When a setup is blocked, the exact reason (e.g. a quote older than the allowed max age) appears here."
          />
        )}
      </Card>

      {/* Discord delivery ledger (Phase 3) */}
      <DiscordDeliveryPanel />

      {/* Raw JSON — on demand only, never shown by default */}
      <Card title="Technical details">
        <DetailsDisclosure summary="Show raw system overview JSON">
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </DetailsDisclosure>
        <div className="ui-section-hint">Read-only telemetry. No extra provider calls are made to render this page.</div>
      </Card>
    </PageContainer>
  );
}
