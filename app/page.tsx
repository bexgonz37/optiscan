"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Tab, FilterKey } from "@/components/Sidebar";
import { KpiRow } from "@/components/KpiRow";
import { Toolbar } from "@/components/Toolbar";
import { MomentumTable } from "@/components/MomentumTable";
import { UnusualTable } from "@/components/UnusualTable";
import { DetailPanel } from "@/components/DetailPanel";
import { AlertPopup } from "@/components/AlertPopup";
import { LiveMoversBoard } from "@/components/LiveMoversBoard";
import { AppNav } from "@/components/AppNav";
import { DataAccessBanner } from "@/components/DataAccessBanner";
import { ChartPanel } from "@/components/ChartPanel";
import { useScanner } from "@/hooks/useScanner";
import { useToast } from "@/components/Toasts";
import type { MomentumRow, UnusualRow } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import {
  DEFAULT_REFRESH_SEC,
  REFRESH_CHOICES,
  loadDashboardPrefs,
  saveDashboardPrefs,
} from "@/lib/dashboard-prefs";

function ivPct(iv: number | null | undefined): number {
  if (iv == null) return 0;
  return iv > 5 ? iv : iv * 100;
}

export default function Page() {
  const { push } = useToast();

  const [tab, setTab] = useState<Tab>("momentum");
  const [filters, setFilters] = useState<FilterKey[]>([]);
  const [refreshSec, setRefreshSec] = useState<number>(DEFAULT_REFRESH_SEC);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [clock, setClock] = useState("");
  const [loopLive, setLoopLive] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const p = loadDashboardPrefs();
    if (p.tab === "momentum" || p.tab === "unusual") setTab(p.tab);
    if (typeof p.refreshSec === "number" && (REFRESH_CHOICES as readonly number[]).includes(p.refreshSec)) {
      setRefreshSec(p.refreshSec);
    }
    if (typeof p.desktopAlerts === "boolean") setNotifyEnabled(p.desktopAlerts);
  }, []);

  useEffect(() => {
    saveDashboardPrefs({ tab, refreshSec, desktopAlerts: notifyEnabled });
  }, [tab, refreshSec, notifyEnabled]);

  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZone: "America/New_York",
        }),
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const onLoopStatus = useCallback((running: boolean) => {
    setLoopLive(running);
  }, []);

  const onNewStrong = useCallback(
    (alerts: { title: string; desc: string }[]) => {
      alerts.slice(0, 3).forEach((a) => push(a.title, a.desc, "ok"));
      if (alerts.length > 3) push("More signals", `${alerts.length - 3} additional STRONG signals fired.`, "info");
    },
    [push],
  );

  const { momentum, unusual, meta, loading, error, lastUpdated, kpi, refresh } = useScanner({
    autoRefresh: true,
    intervalSec: refreshSec,
    notifyEnabled,
    onNewStrong,
  });

  const errorShownRef = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== errorShownRef.current) {
      errorShownRef.current = error;
      push("Scan error", error, "err");
    }
  }, [error, push]);

  function toggleFilter(key: FilterKey) {
    setFilters((f) => (f.includes(key) ? f.filter((x) => x !== key) : [...f, key]));
  }

  function clearFilters() {
    setFilters([]);
  }

  const filteredMomentum: MomentumRow[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    return momentum.filter((r) => {
      if (q && !(r.symbol ?? "").toLowerCase().includes(q)) return false;
      if (filters.includes("strong") && r.score < 80) return false;
      if (filters.includes("call") && r.side !== "call") return false;
      if (filters.includes("put") && r.side !== "put") return false;
      if (filters.includes("highiv") && ivPct(r.contract?.iv) <= 55) return false;
      return true;
    });
  }, [momentum, filters, query]);

  const filteredUnusual: UnusualRow[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    return unusual.filter((r) => {
      if (q && !(r.symbol ?? "").toLowerCase().includes(q)) return false;
      if (filters.includes("strong") && r.score < 80) return false;
      if (filters.includes("new") && !r.newPositioning) return false;
      if (filters.includes("highiv") && ivPct(r.iv) <= 55) return false;
      return true;
    });
  }, [unusual, filters, query]);

  const onSelect = useCallback((symbol: string) => {
    setSelected(symbol);
    setDetailOpen(true);
  }, []);

  const onOpenChart = useCallback((symbol: string) => {
    setChartSymbol(symbol);
    setChartOpen(true);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === "Escape") {
        if (chartOpen) setChartOpen(false);
        else if (detailOpen) setDetailOpen(false);
        else if (document.activeElement === searchRef.current) {
          setQuery("");
          searchRef.current?.blur();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailOpen, chartOpen]);

  const rowCount = tab === "momentum" ? filteredMomentum.length : filteredUnusual.length;
  const updatedLabel = loading
    ? "Scanning…"
    : lastUpdated
      ? `Updated ${fmtTime(new Date(lastUpdated).toISOString())}`
      : "Waiting…";

  return (
    <div className="app">
      <AppNav
        status={[
          { label: clock ? `${clock} ET` : "—" },
          { label: updatedLabel, live: loading },
          { label: `Auto ${refreshSec}s`, live: true },
        ]}
        onRefresh={refresh}
      />

      <DataAccessBanner />

      <KpiRow kpi={kpi} universeCount={meta?.universeCount ?? 0} loopLive={loopLive} />

      <LiveMoversBoard loopStatus={onLoopStatus} onOpenChart={onOpenChart} />

      <section className="panel main section-scanner">
        <Toolbar
          tab={tab}
          onTabChange={setTab}
          activeFilters={filters}
          onToggle={toggleFilter}
          onClear={clearFilters}
          loading={loading}
          count={rowCount}
          search={
            <div className="search search-inline">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8798a8" strokeWidth="2">
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4-4" />
              </svg>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search ticker (⌘K)"
              />
            </div>
          }
        />
        {tab === "momentum" ? (
          <MomentumTable rows={filteredMomentum} selected={selected} onSelect={onSelect} />
        ) : (
          <UnusualTable rows={filteredUnusual} selected={selected} onSelect={onSelect} />
        )}
      </section>

      <DetailPanel symbol={selected} open={detailOpen} onClose={() => setDetailOpen(false)} />
      <ChartPanel symbol={chartSymbol} open={chartOpen} onClose={() => setChartOpen(false)} />
      <AlertPopup onOpenChain={onSelect} />

      <div className="footer">
        OptiScan · research signals only, not buy/sell instructions · not financial advice
      </div>
    </div>
  );
}
