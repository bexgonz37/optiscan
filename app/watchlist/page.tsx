"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PageContainer,
  PageHeader,
  Card,
  StatusBadge,
  EmptyState,
  LoadingState,
  ErrorState,
  type BadgeTone,
} from "@/components/ui/Shell";
import { SimpleTable, type Column } from "@/components/ui/Table";
import { scanHeaders } from "@/hooks/useScanner";
import { openLiveChart } from "@/lib/open-chart";

/**
 * Watchlist (Phase 5). The set of symbols the scanner is actively monitoring
 * this session, with their live tape reads. Read-only view over the existing
 * loop state (/api/scanner/live?realtimeOnly=1) — no new provider calls, no
 * behavior change to the scanner.
 */

type Row = {
  symbol: string;
  price?: number | null;
  movePct?: number | null;
  shortRate?: number | null;
  direction?: string | null;
  confidence?: number | null;
  relVol?: number | null;
  aboveVwap?: boolean;
  core?: boolean;
};

function dirTone(direction?: string | null): BadgeTone {
  const d = String(direction ?? "").toLowerCase();
  if (d === "bullish") return "bull";
  if (d === "bearish") return "bear";
  return "muted";
}

function fmtPct(v?: number | null): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export default function WatchlistPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/scanner/live?realtimeOnly=1", { cache: "no-store", headers: scanHeaders() });
      const body = await res.json();
      const rt = body?.realtime ?? {};
      const tape: Row[] = Array.isArray(rt.tape) ? rt.tape : Array.isArray(rt.movers) ? rt.movers : [];
      setRows(tape);
      setRunning(Boolean(rt.running));
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not load the watchlist.");
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [load]);

  const columns: Column<Row>[] = [
    { key: "symbol", header: "Symbol", render: (r: Row) => (
      <button type="button" className="ui-btn ui-btn-sm" onClick={() => openLiveChart(r.symbol)} title="Open chart">
        {r.symbol}{r.core ? " ★" : ""}
      </button>
    ) },
    { key: "price", header: "Price", align: "right", render: (r: Row) => (r.price != null ? `$${Number(r.price).toFixed(2)}` : "—") },
    { key: "move", header: "Day move", align: "right", render: (r: Row) => (
      <span style={{ color: (r.movePct ?? 0) > 0 ? "var(--bull)" : (r.movePct ?? 0) < 0 ? "var(--bear)" : undefined }}>{fmtPct(r.movePct)}</span>
    ) },
    { key: "rate", header: "Speed", align: "right", render: (r: Row) => (r.shortRate != null ? `${r.shortRate > 0 ? "+" : ""}${r.shortRate.toFixed(2)}%/m` : "—") },
    { key: "rvol", header: "RVOL", align: "right", render: (r: Row) => (r.relVol != null ? `${r.relVol.toFixed(1)}×` : "—") },
    { key: "vwap", header: "VWAP", render: (r: Row) => (r.aboveVwap == null ? "—" : r.aboveVwap ? "above" : "below") },
    { key: "dir", header: "Bias", render: (r: Row) => <StatusBadge tone={dirTone(r.direction)}>{r.direction ?? "—"}</StatusBadge> },
  ];

  const sorted = (rows ?? []).slice().sort((a, b) => Math.abs(b.movePct ?? 0) - Math.abs(a.movePct ?? 0));

  return (
    <PageContainer>
      <PageHeader
        title="Watchlist"
        subtitle="Symbols the scanner is actively monitoring this session"
        actions={
          <>
            {running != null ? <StatusBadge tone={running ? "live" : "warn"}>{running ? "Scanner live" : "Scanner idle"}</StatusBadge> : null}
            <button type="button" className="ui-btn ui-btn-sm" onClick={load}>Refresh</button>
          </>
        }
      />
      <Card title="Monitored symbols" meta={rows ? `${rows.length} tracked` : undefined}>
        {error ? (
          <ErrorState detail={error} onRetry={load} />
        ) : rows == null ? (
          <LoadingState label="Loading watchlist…" rows={5} />
        ) : (
          <SimpleTable
            columns={columns}
            rows={sorted}
            rowKey={(r: Row) => r.symbol}
            emptyTitle="No symbols on the tape yet"
            emptyReason={
              running === false
                ? "The scanner loop is idle. It usually starts within ~2 minutes of the server booting; symbols appear here once it begins streaming quotes."
                : "The scanner is running but has not produced a tape read yet. Monitored symbols appear here after the first provider responses."
            }
          />
        )}
      </Card>
    </PageContainer>
  );
}
