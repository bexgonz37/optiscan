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
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const prefs = loadDashboardPrefs();
      const override = prefs.zeroDteStripSymbols?.length ? prefs.zeroDteStripSymbols.join(",") : "";
      const q = new URLSearchParams();
      if (chartSymbol) q.set("chart", chartSymbol);
      if (override) q.set("symbols", override);
      const res = await fetch(`/api/context/zero-dte?${q}`, { cache: "no-store", headers: scanHeaders() });
      const d = await res.json();
      if (d.ok) setRows(d.rows ?? []);
    } catch { /* best effort */ }
    finally { setLoading(false); }
  }, [chartSymbol]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!rows.length && !loading) return null;

  return (
    <section className="zero-dte-strip panel main">
      <div className="zero-dte-strip-head">
        <h2 className="section-title">0DTE context</h2>
        <span className="muted text-xs">{loading ? "Updating…" : "ATM IV · cached · max 6"}</span>
      </div>
      <div className="zero-dte-strip-grid">
        {rows.map((r) => (
          <button
            key={r.symbol}
            type="button"
            className={`zero-dte-strip-card pill btn${chartSymbol === r.symbol ? " btn-primary" : ""}`}
            onClick={() => onSelect?.(r.symbol)}
            title={r.error ?? "Open chart"}
          >
            <span className="tname">{r.symbol}</span>
            <span className="num">{fmtPrice(r.price)}</span>
            <span className="zero-dte-strip-iv">
              {r.atmIv != null ? <IvBar iv={r.atmIv} /> : <span className="muted">IV —</span>}
              {r.atmIv != null ? <span className="muted text-xs">{fmtIv(r.atmIv)}</span> : null}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
