"use client";

/**
 * Options research — momentum + unusual flow tables (collapsed on Live page).
 * Same data as /scanner without the sidebar views clutter.
 */

import { useCallback, useMemo, useState } from "react";
import { MomentumTable } from "@/components/MomentumTable";
import { UnusualTable } from "@/components/UnusualTable";
import { Toolbar } from "@/components/Toolbar";
import type { FilterKey, Tab } from "@/components/Sidebar";
import { useScanner } from "@/hooks/useScanner";
import { DEFAULT_REFRESH_SEC, loadDashboardPrefs } from "@/lib/dashboard-prefs";
import { filterMomentum, filterUnusual } from "@/lib/scanner-filters";

export function OptionsResearchPanel({
  onOpenChart,
  defaultOpen = false,
}: {
  onOpenChart?: (symbol: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [prefs] = useState(() => loadDashboardPrefs());
  const [tab, setTab] = useState<Tab>("momentum");
  const [filters, setFilters] = useState<FilterKey[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const intervalSec = Math.max(15, prefs.refreshSec ?? DEFAULT_REFRESH_SEC);

  const { momentum, unusual, loading, error, refresh } = useScanner({
    autoRefresh: open,
    intervalSec,
    notifyEnabled: false,
  });

  const filteredMomentum = useMemo(() => filterMomentum(momentum, filters), [momentum, filters]);
  const filteredUnusual = useMemo(() => filterUnusual(unusual, filters), [unusual, filters]);
  const rows = tab === "momentum" ? filteredMomentum : filteredUnusual;

  const openChart = useCallback(
    (symbol: string) => {
      setSelected(symbol);
      onOpenChart?.(symbol);
    },
    [onOpenChart],
  );

  function toggleFilter(key: FilterKey) {
    setFilters((prev) => (prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]));
  }

  return (
    <section className="panel main section-options-research" style={{ marginTop: 14 }}>
      <button
        type="button"
        className="guide-toggle"
        onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", textAlign: "left", marginBottom: open ? 12 : 0 }}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>Options research — momentum &amp; unusual flow</span>
        <span className="muted" style={{ marginLeft: 8, fontSize: 12, fontWeight: 400 }}>
          (deeper 0DTE scan — not required for daily use)
        </span>
      </button>

      {open ? (
        <>
          {error ? (
            <div className="kpi" style={{ marginBottom: 14, borderColor: "var(--amber)", background: "rgba(255,176,32,.06)" }}>
              <div className="label" style={{ color: "var(--amber)" }}>Scan error</div>
              <div className="sub">{error}</div>
            </div>
          ) : null}

          <Toolbar
            tab={tab}
            onTabChange={(t) => { setTab(t); setFilters([]); }}
            activeFilters={filters}
            onToggle={toggleFilter}
            onClear={() => setFilters([])}
            loading={loading}
            count={rows.length}
            onRefresh={refresh}
          />

          <div className="table-area" style={{ marginTop: 10 }}>
            {tab === "momentum" ? (
              <MomentumTable rows={filteredMomentum} selected={selected} onSelect={openChart} />
            ) : (
              <UnusualTable rows={filteredUnusual} selected={selected} onSelect={openChart} />
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
