"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppNav } from "@/components/AppNav";
import { DataAccessBanner } from "@/components/DataAccessBanner";
import { ChartPanel } from "@/components/ChartPanel";
import { KpiRow } from "@/components/KpiRow";
import { MomentumTable } from "@/components/MomentumTable";
import { UnusualTable } from "@/components/UnusualTable";
import { Toolbar } from "@/components/Toolbar";
import { Sidebar, type FilterKey, type Tab, type View } from "@/components/Sidebar";
import { UsageGuide } from "@/components/UsageGuide";
import { useScanner } from "@/hooks/useScanner";
import { DEFAULT_REFRESH_SEC, loadDashboardPrefs } from "@/lib/dashboard-prefs";
import { filterMomentum, filterUnusual } from "@/lib/scanner-filters";

export default function ScannerPage() {
  const [prefs] = useState(() => loadDashboardPrefs());
  const [tab, setTab] = useState<Tab>(prefs.tab ?? "momentum");
  const [activeView, setActiveView] = useState("momentum");
  const [filters, setFilters] = useState<FilterKey[]>([]);
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [loopLive, setLoopLive] = useState(false);

  const intervalSec = Math.max(15, prefs.refreshSec ?? DEFAULT_REFRESH_SEC);

  const { momentum, unusual, meta, loading, error, kpi, refresh } = useScanner({
    autoRefresh: true,
    intervalSec,
    notifyEnabled: Boolean(prefs.desktopAlerts),
  });

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/scanner/live?realtimeOnly=1", { cache: "no-store" });
        const d = await res.json();
        if (!cancelled) setLoopLive(Boolean(d?.realtime?.running));
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const filteredMomentum = useMemo(() => filterMomentum(momentum, filters), [momentum, filters]);
  const filteredUnusual = useMemo(() => filterUnusual(unusual, filters), [unusual, filters]);
  const rows = tab === "momentum" ? filteredMomentum : filteredUnusual;

  const counts = useMemo(
    () => ({
      momentum: momentum.length,
      unusual: unusual.length,
      strong:
        momentum.filter((r) => r.score >= 80).length + unusual.filter((r) => r.score >= 80).length,
    }),
    [momentum, unusual],
  );

  const openChart = useCallback((symbol: string) => {
    setSelected(symbol);
    setChartSymbol(symbol);
    setChartOpen(true);
  }, []);

  function selectView(v: View) {
    setActiveView(v.id);
    setTab(v.tab);
    setFilters(v.filters);
  }

  function toggleFilter(key: FilterKey) {
    setFilters((prev) => (prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]));
    setActiveView("custom");
  }

  return (
    <div className="app">
      <AppNav
        status={[
          { label: loopLive ? "Tape live" : "Tape offline", live: loopLive },
          { label: loading ? "Scanning…" : `${rows.length} shown` },
        ]}
        onRefresh={refresh}
      />

      <DataAccessBanner />
      <UsageGuide page="scanner" />

      <KpiRow kpi={kpi} universeCount={meta?.universeCount ?? 0} loopLive={loopLive} />

      {error ? (
        <div className="kpi" style={{ marginBottom: 14, borderColor: "var(--amber)", background: "rgba(255,176,32,.06)" }}>
          <div className="label" style={{ color: "var(--amber)" }}>Scanner error</div>
          <div className="sub">{error}</div>
        </div>
      ) : null}

      <div className="scanner-layout">
        <Sidebar activeView={activeView} onSelect={selectView} counts={counts} />

        <div className="scanner-main">
          <Toolbar
            tab={tab}
            onTabChange={(t) => {
              setTab(t);
              setActiveView(t);
              setFilters([]);
            }}
            activeFilters={filters}
            onToggle={toggleFilter}
            onClear={() => { setFilters([]); setActiveView(tab); }}
            loading={loading}
            count={rows.length}
          />

          <div className="table-area">
            {tab === "momentum" ? (
              <MomentumTable rows={filteredMomentum} selected={selected} onSelect={openChart} />
            ) : (
              <UnusualTable rows={filteredUnusual} selected={selected} onSelect={openChart} />
            )}
          </div>
        </div>
      </div>

      <ChartPanel symbol={chartSymbol} open={chartOpen} onClose={() => setChartOpen(false)} />

      <div className="footer">
        OptiScan scanner · options momentum + unusual flow · trade callouts on Alerts page
      </div>
    </div>
  );
}
