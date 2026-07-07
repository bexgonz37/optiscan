"use client";

/**
 * Options research — momentum + unusual flow tables.
 * Collapsed variant on Live tape tab; full variant on Research tab.
 */

import { useCallback, useMemo, useState } from "react";
import { MomentumTable } from "@/components/MomentumTable";
import { UnusualTable } from "@/components/UnusualTable";
import { Toolbar } from "@/components/Toolbar";
import { VerdictPreviewBlock } from "@/components/VerdictPreviewBlock";
import type { FilterKey, Tab } from "@/components/Sidebar";
import { useScanner } from "@/hooks/useScanner";
import { useLiveTapeMap, liveCtxFor } from "@/hooks/useLiveTapeMap";
import { DEFAULT_REFRESH_SEC, loadDashboardPrefs } from "@/lib/dashboard-prefs";
import { filterMomentum, filterUnusual } from "@/lib/scanner-filters";

export function OptionsResearchPanel({
  onOpenChart,
  defaultOpen = false,
  variant = "collapsed",
  active = true,
}: {
  onOpenChart?: (symbol: string) => void;
  defaultOpen?: boolean;
  variant?: "collapsed" | "full";
  active?: boolean;
}) {
  const isFull = variant === "full";
  const [open, setOpen] = useState(isFull || defaultOpen);
  const [prefs] = useState(() => loadDashboardPrefs());
  const [tab, setTab] = useState<Tab>("momentum");
  const [filters, setFilters] = useState<FilterKey[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const intervalSec = Math.max(15, prefs.refreshSec ?? DEFAULT_REFRESH_SEC);

  const expanded = isFull ? active : open;

  const { momentum, unusual, loading, error, refresh } = useScanner({
    autoRefresh: expanded,
    intervalSec,
    notifyEnabled: false,
  });

  const filteredMomentum = useMemo(() => filterMomentum(momentum, filters), [momentum, filters]);
  const filteredUnusual = useMemo(() => filterUnusual(unusual, filters), [unusual, filters]);
  const rows = tab === "momentum" ? filteredMomentum : filteredUnusual;
  const tape = useLiveTapeMap();

  const heroPreview = useMemo(() => {
    const trades = filteredMomentum.filter((r) => r.verdictPreview?.verdict?.action === "TRADE");
    if (trades.length) return trades[0].verdictPreview ?? null;
    return filteredMomentum.find((r) => r.verdictPreview)?.verdictPreview ?? null;
  }, [filteredMomentum]);

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

  const body = (
    <>
      {error ? (
        <div className="banner-warn compact-banner-warn">{error}</div>
      ) : null}

      {tab === "momentum" && heroPreview?.alertInput ? (
        <div className="research-verdict-hero panel-inner">
          <div className="section-sub research-verdict-label">Best setup right now</div>
          <VerdictPreviewBlock
            alertInput={heroPreview.alertInput}
            entryPremium={heroPreview.entryPremium}
            live={heroPreview.alertInput.ticker ? liveCtxFor(tape, heroPreview.alertInput.ticker) : undefined}
          />
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

      <div className="table-area live-research-table">
        {tab === "momentum" ? (
          <MomentumTable rows={filteredMomentum} selected={selected} onSelect={openChart} />
        ) : (
          <UnusualTable rows={filteredUnusual} selected={selected} onSelect={openChart} />
        )}
      </div>
    </>
  );

  if (isFull) {
    return (
      <section className="panel main section-options-research section-options-research-full">
        {body}
      </section>
    );
  }

  return (
    <section className="panel main section-options-research">
      <button
        type="button"
        className="guide-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>Options research — momentum &amp; unusual flow</span>
        <span className="muted section-options-research-hint">
          (deeper 0DTE scan — use Research tab for full view)
        </span>
      </button>

      {open ? body : null}
    </section>
  );
}
