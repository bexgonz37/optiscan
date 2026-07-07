"use client";

import { useCallback, useEffect, useState } from "react";
import { scanHeaders } from "@/hooks/useScanner";
import { fmtIv, fmtPrice } from "@/lib/format";
import { loadDashboardPrefs } from "@/lib/dashboard-prefs";
import { IvBar } from "@/components/ui";

interface StripRow {
  symbol: string;
  price: number | null;
  atmIv: number | null;
  nearestLevelLabel?: string | null;
  nearestLevelDistPct?: number | null;
  nearLevel?: boolean;
  minutesToClose?: number | null;
  error?: string;
}

export function ZeroDteStrip({
  chartSymbol,
  onSelect,
}: {
  chartSymbol?: string | null;
  onSelect?: (symbol: string) => void;
}) {
  const [rows, setRows] = useState<StripRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const prefs = loadDashboardPrefs();
      const override = prefs.zeroDteStripSymbols?.length ? prefs.zeroDteStripSymbols.join(",") : "";
      const q = new URLSearchParams();
      if (chartSymbol) q.set("chart", chartSymbol);
      if (override) q.set("symbols", override);
      const res = await fetch(`/api/context/zero-dte?${q}`, { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d.ok) {
        setRows(d.rows ?? []);
      } else {
        setFetchError(d.error ?? (res.status === 401 ? "Check API token in Settings" : "Failed to load 0DTE context"));
      }
    } catch {
      setFetchError("Network error — check Polygon key / API token");
    } finally {
      setLoading(false);
    }
  }, [chartSymbol]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const minsLabel = (m: number | null | undefined) => {
    if (m == null) return "—";
    if (m < 0) return "Closed";
    return `${m}m`;
  };

  const levelLabel = (r: StripRow) => {
    if (r.nearestLevelLabel == null || r.nearestLevelDistPct == null) return "—";
    return `${r.nearestLevelLabel} ${r.nearestLevelDistPct.toFixed(2)}%`;
  };

  return (
    <section className="zero-dte-strip panel main">
      <div className="zero-dte-strip-head">
        <h2 className="section-title">0DTE context</h2>
        <span className="muted text-xs">
          {loading ? "Updating…" : `${rows.length} symbols · ATM IV · levels · max 6`}
        </span>
      </div>
      {fetchError ? (
        <div className="banner-warn compact-banner-warn zero-dte-strip-error">{fetchError}</div>
      ) : null}
      {!rows.length && !loading && !fetchError ? (
        <p className="muted text-sm zero-dte-strip-empty">Loading 0DTE symbols…</p>
      ) : null}
      <div className="zero-dte-strip-grid">
        {rows.map((r) => (
          <button
            key={r.symbol}
            type="button"
            className={[
              "zero-dte-strip-card pill btn",
              chartSymbol === r.symbol ? "btn-primary" : "",
              r.nearLevel ? "zero-dte-strip-near-level" : "",
            ].filter(Boolean).join(" ")}
            onClick={() => onSelect?.(r.symbol)}
            title={r.error ?? `Open ${r.symbol} chart`}
          >
            <span className="tname">{r.symbol}</span>
            <span className="num">{fmtPrice(r.price)}</span>
            <span className="zero-dte-strip-meta muted text-xs">
              {levelLabel(r)} · {minsLabel(r.minutesToClose)}
            </span>
            <span className="zero-dte-strip-iv">
              {r.atmIv != null ? <IvBar iv={r.atmIv} /> : <span className="muted">IV —</span>}
              {r.atmIv != null ? <span className="muted text-xs">{fmtIv(r.atmIv)}</span> : null}
            </span>
            {r.error ? <span className="zero-dte-strip-err muted text-xs">{r.error}</span> : null}
          </button>
        ))}
      </div>
    </section>
  );
}
