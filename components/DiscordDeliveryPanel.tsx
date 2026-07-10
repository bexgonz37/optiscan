"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, StatusBadge, SimpleTable, EmptyState, LoadingState, ErrorState, type BadgeTone, type Column } from "@/components/ui";

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
    { key: "status", header: "Status", render: (d) => <StatusBadge tone={tone(d.status)}>{d.status.replace("_", " ")}</StatusBadge> },
    { key: "alert", header: "Alert", render: (d) => (d.alert_id != null ? `#${d.alert_id}` : "—") },
    { key: "ticker", header: "Ticker", render: (d) => d.ticker ?? "—" },
    {
      key: "setup",
      header: "Setup",
      render: (d) => (d.setup_type ? `${d.setup_type}${d.option_side ? ` · ${d.option_side}` : ""}` : d.payload_type),
    },
    { key: "channel", header: "Channel", render: (d) => d.channel_type || d.webhook_name },
    { key: "created", header: "Created", render: (d) => timeShort(d.created_at) },
    { key: "sent", header: "Sent", render: (d) => timeShort(d.sent_at) },
    { key: "retries", header: "Retries", align: "right", render: (d) => String(d.retry_count ?? 0) },
    {
      key: "reason",
      header: "Failure reason",
      render: (d) =>
        d.failure_reason ? <span title={d.failure_reason} style={{ color: "var(--bear)" }}>{d.failure_reason}</span> : "—",
    },
    {
      key: "action",
      header: "",
      render: (d) =>
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

  return (
    <Card title="Discord delivery" meta="Delivery ledger · retries · test messages" actions={actions}>
      {/* webhook configuration — recap NOT CONFIGURED is informational, not a failure */}
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
            rowKey={(d) => d.delivery_id}
            emptyTitle="No Discord deliveries yet"
            emptyReason="Nothing has been sent to Discord in this process. Deliveries appear here once an alert fires or you send a test message above."
          />
        </>
      )}
    </Card>
  );
}
