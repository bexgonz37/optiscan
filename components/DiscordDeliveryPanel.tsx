"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, StatusBadge, EmptyState, LoadingState, ErrorState, KeyValue, ResponsiveGrid, type BadgeTone } from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";

/**
 * Discord delivery UI (Phase 3). Renders the existing delivery ledger + health
 * from /api/discord/*. Shows status, alert id, ticker, setup, channel, timing,
 * retries, and failure reason; supports retry + test message.
 *
 * Security: webhook URLs and secrets never reach this component — the APIs
 * return only ledger metadata (ticker/setup via a join), never payload secrets.
 * A recap webhook that is not set shows "NOT CONFIGURED" and is NOT counted as
 * an options/stock delivery failure.
 */

type Delivery = {
  delivery_id: string;
  status: string;
  alert_id: number | null;
  ticker: string | null;
  setup_type: string | null;
  option_side: string | null;
  channel_type: string;
  webhook_name: string;
  payload_type: string;
  created_at: string;
  sent_at: string | null;
  retry_count: number;
  failure_reason: string | null;
};

type Health = {
  webhooks?: Record<string, boolean>;
  summary?: { status: string; count: number }[];
  metrics?: {
    total24h?: number;
    sent24h?: number;
    failed24h?: number;
    retrying24h?: number;
    suppressed24h?: number;
    notConfigured24h?: number;
    stuckInFlight?: number;
    lastSentAt?: string | null;
    lastFailureAt?: string | null;
  };
  readiness?: {
    status: "READY" | "NEEDS_REVIEW" | "BLOCKED";
    betaVerdict: string;
    blockers: string[];
    reviewItems: string[];
    channels: {
      options: { configured: boolean; required: boolean; ready: boolean; blockedBy: string[] };
      stocks: { configured: boolean; required: boolean; ready: boolean; blockedBy: string[] };
      recap: { configured: boolean; subscriberDelivery: false; note: string };
    };
  };
};

const STATUS_TONE: Record<string, BadgeTone> = {
  SENT: "live",
  PENDING: "info",
  SENDING: "info",
  RETRYING: "warn",
  FAILED: "bad",
  SUPPRESSED: "muted",
  NOT_CONFIGURED: "muted",
};

function tone(status: string): BadgeTone {
  return STATUS_TONE[status] ?? "muted";
}

function readinessTone(status?: string): BadgeTone {
  if (status === "READY") return "live";
  if (status === "NEEDS_REVIEW") return "warn";
  if (status === "BLOCKED") return "bad";
  return "muted";
}

function timeShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "America/New_York" });
}

export function DiscordDeliveryPanel() {
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, h] = await Promise.all([
        fetch("/api/discord/deliveries?limit=100", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/discord/health", { cache: "no-store" }).then((r) => r.json()),
      ]);
      setDeliveries(Array.isArray(d?.deliveries) ? d.deliveries : []);
      setHealth(h);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not load the Discord ledger.");
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  const sendTest = useCallback(async (kind: "options" | "stocks") => {
    setBusy(`test-${kind}`);
    setFlash(null);
    try {
      const res = await fetch("/api/discord/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const body = await res.json().catch(() => ({}));
      setFlash(res.ok ? `Test ${kind} message sent.` : `Test failed: ${body?.error ?? res.statusText}`);
      load();
    } catch (err: any) {
      setFlash(`Test failed: ${err?.message ?? "network error"}`);
    } finally {
      setBusy(null);
    }
  }, [load]);

  const retry = useCallback(async (id: string) => {
    setBusy(`retry-${id}`);
    setFlash(null);
    try {
      const res = await fetch(`/api/discord/deliveries/${id}/retry`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      setFlash(res.ok ? "Retry queued." : `Retry failed: ${body?.error ?? res.statusText}`);
      load();
    } catch (err: any) {
      setFlash(`Retry failed: ${err?.message ?? "network error"}`);
    } finally {
      setBusy(null);
    }
  }, [load]);

  const recapConfigured = health?.webhooks?.recap ?? false;

  const columns: Column<Delivery>[] = [
    { key: "status", header: "Status", render: (d: Delivery) => <StatusBadge tone={tone(d.status)}>{d.status.replace("_", " ")}</StatusBadge> },
    { key: "alert", header: "Alert", render: (d: Delivery) => (d.alert_id != null ? `#${d.alert_id}` : "—") },
    { key: "ticker", header: "Ticker", render: (d: Delivery) => d.ticker ?? "—" },
    {
      key: "setup",
      header: "Setup",
      render: (d: Delivery) => (d.setup_type ? `${d.setup_type}${d.option_side ? ` · ${d.option_side}` : ""}` : d.payload_type),
    },
    { key: "channel", header: "Channel", render: (d: Delivery) => d.channel_type || d.webhook_name },
    { key: "created", header: "Created", render: (d: Delivery) => timeShort(d.created_at) },
    { key: "sent", header: "Sent", render: (d: Delivery) => timeShort(d.sent_at) },
    { key: "retries", header: "Retries", align: "right", render: (d: Delivery) => String(d.retry_count ?? 0) },
    {
      key: "reason",
      header: "Failure reason",
      render: (d: Delivery) =>
        d.failure_reason ? <span title={d.failure_reason} style={{ color: "var(--bear)" }}>{d.failure_reason}</span> : "—",
    },
    {
      key: "action",
      header: "",
      render: (d: Delivery) =>
        ["FAILED", "RETRYING"].includes(d.status) ? (
          <button type="button" className="ui-btn ui-btn-sm" disabled={busy === `retry-${d.delivery_id}`} onClick={() => retry(d.delivery_id)}>
            {busy === `retry-${d.delivery_id}` ? "…" : "Retry"}
          </button>
        ) : (
          "—"
        ),
    },
  ];

  const actions = (
    <>
      <button type="button" className="ui-btn ui-btn-sm" disabled={busy === "test-options"} onClick={() => sendTest("options")}>
        Test options
      </button>
      <button type="button" className="ui-btn ui-btn-sm" disabled={busy === "test-stocks"} onClick={() => sendTest("stocks")}>
        Test stocks
      </button>
    </>
  );

  const recent = deliveries ?? [];
  const successes = recent.filter((d) => d.status === "SENT");
  const failures = recent.filter((d) => ["FAILED", "RETRYING", "SUPPRESSED"].includes(d.status));
  const readiness = health?.readiness;
  const metrics = health?.metrics;
  const review24h = (metrics?.failed24h ?? 0) + (metrics?.retrying24h ?? 0) + (metrics?.suppressed24h ?? 0) + (metrics?.notConfigured24h ?? 0);

  return (
    <Card title="Discord delivery" meta="Delivery ledger · retries · test messages" actions={actions}>
      {/* webhook configuration — recap NOT CONFIGURED is informational, not a failure */}
      <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
        <div className="ui-section-head" style={{ marginTop: 0 }}>
          <span className="ui-section-title" style={{ fontSize: "0.82rem" }}>Paid beta readiness</span>
          <StatusBadge tone={readinessTone(readiness?.status)}>{readiness?.status?.replace("_", " ") ?? "CHECKING"}</StatusBadge>
        </div>
        <ResponsiveGrid min={150}>
          <KeyValue k="Subscriber surface" v="Discord only" />
          <KeyValue k="Verdict" v={readiness?.betaVerdict ?? "Reading Discord health..."} tone={readiness?.status === "BLOCKED" ? "bear" : readiness?.status === "NEEDS_REVIEW" ? "warn" : undefined} />
          <KeyValue k="Sent 24h" v={metrics?.sent24h ?? 0} />
          <KeyValue k="Needs review 24h" v={review24h} tone={review24h > 0 ? "warn" : undefined} />
          <KeyValue k="Stuck sends" v={metrics?.stuckInFlight ?? 0} tone={(metrics?.stuckInFlight ?? 0) > 0 ? "bear" : undefined} />
          <KeyValue k="Last sent" v={timeShort(metrics?.lastSentAt ?? null)} />
        </ResponsiveGrid>
        {readiness?.blockers?.length ? (
          <div className="ui-section-hint" style={{ color: "var(--bear)" }}>
            Blockers: {readiness.blockers.join("; ")}
          </div>
        ) : readiness?.reviewItems?.length ? (
          <div className="ui-section-hint" style={{ color: "var(--warn)" }}>
            Review: {readiness.reviewItems.join("; ")}
          </div>
        ) : (
          <div className="ui-section-hint">Discord is the subscriber product surface. Webhook presence and delivery health are shown without exposing raw URLs or tokens.</div>
        )}
      </div>

      <div className="ui-statusbar" style={{ marginBottom: 4 }}>
        {(["options", "stocks", "recap"] as const).map((kind) => {
          const on = health?.webhooks?.[kind] ?? false;
          const isRecap = kind === "recap";
          return (
            <div className="ui-statuscell" key={kind}>
              <span className="ui-statuscell-k">{kind} webhook</span>
              <span className="ui-statuscell-v">
                <span className={`ui-statusdot ${on ? "ok" : isRecap ? "" : "warn"}`} />
                {on ? "Configured" : "NOT CONFIGURED"}
              </span>
            </div>
          );
        })}
      </div>
      {!recapConfigured ? (
        <div className="ui-section-hint">
          Recap webhook is <b>NOT CONFIGURED</b> — daily/weekly scoreboards are skipped. This does not affect options or stock alert delivery.
        </div>
      ) : null}

      {flash ? <div className="ui-section-hint" style={{ color: "var(--accent)" }}>{flash}</div> : null}

      {error ? (
        <ErrorState detail={error} onRetry={load} />
      ) : deliveries == null ? (
        <LoadingState label="Loading delivery ledger…" />
      ) : (
        <>
          <div className="ui-section-head" style={{ marginTop: 6 }}>
            <span className="ui-section-title" style={{ fontSize: "0.82rem" }}>Recent deliveries</span>
            <span className="ui-section-count">{successes.length} sent · {failures.length} need review</span>
          </div>
          <SimpleTable
            columns={columns}
            rows={recent}
            rowKey={(d: Delivery) => d.delivery_id}
            emptyTitle="No Discord deliveries yet"
            emptyReason="Nothing has been sent to Discord in this process. Deliveries appear here once an alert fires or you send a test message above."
          />
        </>
      )}
    </Card>
  );
}
